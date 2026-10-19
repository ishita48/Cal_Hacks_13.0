"""HTTP + WebSocket surface. Every route is either a view of the world or a mutator of it."""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ..integrations import actions, cartesia, elevenlabs, fetch
from ..integrations.sponsors import SponsorHealth
from ..integrations.tiger import TigerSink

from ..world.engine import ReplayActiveError, WorldEngine
from ..agents.negotiation import Negotiator
from ..agents.registry import agent_info
from ..world.events import ActionEvent, AgentToggle, EquipmentCommand, ManagerRule, PlanDecision, SensorReading
from ..world.store import EventStore


def create_app(store: EventStore | None = None, run_loop: bool = True) -> FastAPI:
    store = store or EventStore(os.environ.get("HAVEN_DB", "data/haven.db"))
    engine = WorldEngine(store)
    sensor_token = os.environ.get("HAVEN_SENSOR_TOKEN")
    tiger = TigerSink()
    society = fetch.Society(engine.ctx)          # the residents' agents on Fetch.ai (local or Agentverse)
    engine.plan_listeners.append(society.offer)
    negotiator = Negotiator(engine.ctx, engine.submit, lambda: engine.state)   # agents reason with Claude when keyed
    negotiator.ask_resident = society.ask_resident        # residents speak through their Fetch.ai identity
    society.on_model_stance = negotiator.accept_from_network
    engine.plan_listeners.append(negotiator.on_plan)
    sponsors = SponsorHealth(engine, society, tiger)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if run_loop:
            await engine.start()
            await society.start()
        yield
        await society.stop()
        await engine.stop()

    app = FastAPI(title="HAVEN world-state service", lifespan=lifespan)
    app.state.engine = engine
    app.add_middleware(
        CORSMiddleware,
        allow_origins=os.environ.get("HAVEN_CORS_ORIGINS", "*").split(","),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health():
        return {"ok": True, "run_id": engine.state.run_id, "step": engine.state.step}

    @app.get("/api/state")
    async def get_state():
        return engine.snapshot()

    @app.get("/api/building")
    async def get_building():
        return engine.building.model_dump(mode="json")

    @app.get("/api/people")
    async def get_people():
        return engine.roster.model_dump(mode="json")

    @app.get("/api/graph")
    async def get_graph():
        """The dependency graph the cascade walks: equipment nodes with positions, typed edges.
        Static for the life of the process (the live status of every node is in the state frame)."""
        G = engine.graph
        nodes = [{"id": n, "type": d.get("node_type"), "kind": d.get("kind"), "name": d.get("name", n),
                  "level": d.get("level"), "x": d.get("x"), "y": d.get("y"), "z": d.get("z"),
                  "flood_height": d.get("flood_height")}
                 for n, d in G.nodes(data=True) if d.get("node_type") == "equipment"]
        edges = [{"src": u, "dst": v, "rel": d["rel"]}
                 for u, v, d in G.edges(data=True) if d.get("rel") in ("powers", "backs_up", "controls", "feeds_water", "monitors")]
        lifts = [{"id": v.id, "kind": v.kind, "step_free": v.step_free, "requires": v.equipment, "spaces": v.spaces}
                 for v in engine.building.verticals]
        return {"nodes": nodes, "edges": edges, "verticals": lifts}

    @app.post("/api/sensor")
    async def post_sensor(reading: SensorReading, x_haven_token: str | None = Header(default=None)):
        if sensor_token and reading.source == "esp32" and x_haven_token != sensor_token:
            raise HTTPException(401, "bad sensor token")
        try:
            logged = await engine.submit(reading)
        except ReplayActiveError as e:
            raise HTTPException(409, str(e)) from e
        wet = engine.state.sensors[reading.sensor_id].wet
        await tiger.record(reading.sensor_id, logged.run_id, logged.step, reading.value, wet, reading.source)
        return {"seq": logged.seq, "step": logged.step}

    @app.get("/api/sensor/{sensor_id}/history")
    async def sensor_history(sensor_id: str, limit: int = 200):
        """Readings over time: from Tiger Data when configured, otherwise from this run's event log."""
        if tiger.configured:
            rows = await tiger.history(sensor_id, limit)
            if rows:
                return {"source": "tiger", "readings": rows}
        rows = [
            {"time": e.wall_time, "value": e.event.value, "wet": e.event.value >= 0.5, "source": e.event.source,
             "run_id": e.run_id, "step": e.step}
            for e in store.events(engine.state.run_id)
            if e.event.type == "sensor_reading" and e.event.sensor_id == sensor_id
        ][-limit:]
        return {"source": "event_log", "readings": rows}

    class SpeakBody(BaseModel):
        text: str
        lang: str = "en"

    @app.post("/api/speak")
    async def speak(body: SpeakBody):
        """A voice for a line the plan already contains: ElevenLabs first, Cartesia next, else the browser's."""
        provider = "elevenlabs"
        audio = await elevenlabs.speak(body.text, body.lang)
        if audio is None:
            provider = "cartesia"
            audio = await cartesia.speak(body.text, body.lang)
        if audio is None:
            raise HTTPException(503, "voice not configured (set ELEVENLABS_API_KEY or CARTESIA_API_KEY); use browser speech")
        return Response(content=audio, media_type="audio/mpeg",
                        headers={"X-Voice-Provider": provider, "Access-Control-Expose-Headers": "X-Voice-Provider"})

    @app.get("/api/voice/agent")
    async def voice_agent():
        """Config for a live ElevenLabs Conversational AI session grounded in the current world (key-gated)."""
        from ..agents.buds import NAME, context_for_llm

        if not elevenlabs.agent_configured():
            return {"configured": False, "provider": None}
        facts = context_for_llm(engine.ctx, engine.state)
        return {
            "configured": True, "provider": "elevenlabs", "agent_id": elevenlabs.agent_id(),
            "signed_url": await elevenlabs.agent_signed_url(),
            "dynamic_variables": {"headline": facts["headline"], "status": facts["status"],
                                  "left_behind": ", ".join(facts["left_behind"]) or "nobody",
                                  "residents_affected": str(int(facts["metrics"].get("residents_affected", 0)))},
            "overrides": {"agent": {"firstMessage": f"Hi, I'm {NAME}. {facts['status']} What do you want to know?",
                                    "prompt": {"prompt": f"You are {NAME}, the on-screen companion in HAVEN. Answer only from these facts: "
                                                         + str(facts)[:6000]}}},
        }

    @app.get("/api/sponsors")
    async def sponsor_health(fresh: bool = False):
        """Live round-trip proof for every sponsor integration (memoised 30 s; ?fresh=true re-checks)."""
        return await sponsors.report(fresh=fresh)

    class AskBody(BaseModel):
        text: str

    @app.post("/api/buds/ask")
    async def buds_ask(body: AskBody):
        """Buds answers from the world state (deterministic), Claude only as the fallback paraphraser."""
        from ..agents import buds

        text = body.text.strip()[:500]
        if not text:
            raise HTTPException(400, "say something")
        reply = buds.answer(engine.ctx, engine.state, text, engine.clock()["time_of_day"])
        if reply is None:
            reply = await buds.answer_llm(engine.ctx, engine.state, text) or buds.fallback(text)
        return reply.model_dump()

    class ActBody(BaseModel):
        kind: str
        payload: dict = Field(default_factory=dict)
        actor: str = "manager (buds)"

    @app.post("/api/buds/act")
    async def buds_act(body: ActBody):
        """The human approved something Buds offered: it becomes the same input event a button sends."""
        p = body.payload
        if body.kind == "toggle_agent":
            if p.get("agent") not in engine.state.agents:
                raise HTTPException(404, "unknown agent")
            return await _submit(AgentToggle(agent=p["agent"], enabled=bool(p.get("enabled", True))))
        if body.kind == "approve":
            # The person approved "the plan" out loud a moment ago: the plan on the table now is the one they mean.
            return await _submit(PlanDecision(plan_version=engine.state.plan.version, decision="approve", actor=body.actor))
        if body.kind == "rule":
            return await _submit(ManagerRule(text=str(p.get("text", "")), code=str(p.get("code", "")), actor=body.actor))
        if body.kind == "leak":
            sensor = p.get("sensor_id") or (engine.ctx.sensor_ids[0] if engine.ctx.sensor_ids else None)
            if not sensor:
                raise HTTPException(409, "no water sensor in the spec")
            return await _submit(SensorReading(sensor_id=str(sensor), value=float(p.get("value", 0.9)), source="manual"))
        if body.kind == "clock":
            await engine.set_clock(p.get("playing"), p.get("speed"))
            return engine.clock()
        if body.kind == "reset":
            state = await engine.reset()
            return {"run_id": state.run_id}
        if body.kind == "demo":
            return await load_demo()
        raise HTTPException(400, f"unknown action {body.kind}")

    @app.get("/api/integrations")
    async def integrations():
        return {
            "cartesia": cartesia.configured(),
            "elevenlabs": elevenlabs.configured(),
            "voice_agent": elevenlabs.agent_configured(),
            "tiger": tiger.configured,
            "llm": bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")),
            "sensor_token": bool(sensor_token),
            "fetch": society.running,
            "negotiation": negotiator.enabled,
            "agentverse": fetch.agentverse() and society.running,
            **actions.providers(),
        }

    @app.get("/api/negotiation")
    async def negotiation_status():
        """Who has spoken for the current situation, who is still thinking, and whether a model is in the loop."""
        return negotiator.status(engine.state)

    class ActionBody(BaseModel):
        step_id: str
        status: str = "done"
        actor: str
        detail: str = ""

    @app.post("/api/action")
    async def post_action(body: ActionBody):
        """A responder acknowledges a step from their phone: a real human in the loop, logged as an input."""
        plan = engine.state.approved_plan
        if plan is None:
            raise HTTPException(409, "no approved plan")
        step = next((s for s in plan.steps if s.id == body.step_id), None)
        if step is None:
            raise HTTPException(404, "unknown step")
        actors = [a.strip() for a in step.actor.split(",")]
        if body.actor not in actors and body.actor not in ("staff", "manager", "facilities"):
            raise HTTPException(403, f"{body.actor} is not on this step ({step.actor})")
        if body.status not in ("done", "failed"):
            raise HTTPException(400, "status must be done or failed")
        cur = engine.state.actions.get(step.id)
        if cur is not None and cur.status == "done":
            raise HTTPException(409, "already done")
        detail = body.detail or f"{body.actor} confirmed from the phone"
        return await _submit(ActionEvent(step_id=step.id, status=body.status, actor=body.actor, detail=detail))

    @app.post("/api/twilio/answer/{step_id}")
    async def twilio_answer(step_id: str, request: Request):
        """Twilio posts what the plumber said. Yes: the step is confirmed. No or silence: the next vendor
        on the list is dialled with the same script; when the list runs out the step is marked failed."""
        from ..integrations import twilio as tw

        form = await request.form()
        verdict = tw.parse_answer(str(form.get("SpeechResult", "")), str(form.get("Digits", "")))
        vendor = int(request.query_params.get("vendor", "0") or 0)
        timed_out = request.query_params.get("timeout") == "1"
        plan = engine.state.approved_plan
        step = next((s for s in plan.steps if s.id == step_id), None) if plan else None
        who = form.get("To") or "the plumber"
        if step is None:
            return Response(content="<Response><Say>Thank you.</Say></Response>", media_type="application/xml")
        if verdict == "yes":
            await engine.submit(ActionEvent(step_id=step.id, status="done", actor="plumber",
                                            detail=f"{who} said yes on the phone (vendor {vendor + 1})"))
            return Response(content=f"<Response><Say>Thank you. Facilities will meet you at the service door of {engine.ctx.spec.name}.</Say></Response>",
                            media_type="application/xml")
        nxt = vendor + 1
        vendors = tw.vendors()
        if nxt < len(vendors):
            base = tw.public_url()
            text = next((m.text for m in plan.messages if m.to == "plumber"), step.title)
            sid = await tw.call(vendors[nxt], text, answer_url=f"{base}/api/twilio/answer/{step.id}?vendor={nxt}" if base else None)
            await engine.submit(ActionEvent(step_id=step.id, status="assigned", actor="haven",
                                            detail=f"vendor {vendor + 1} said {'nothing' if timed_out or verdict == 'unknown' else 'no'}; dialling vendor {nxt + 1}" + (f" ({sid})" if sid else "")))
            return Response(content="<Response><Say>Understood. Thank you.</Say></Response>", media_type="application/xml")
        await engine.submit(ActionEvent(step_id=step.id, status="failed", actor="haven",
                                        detail=f"no plumber on the list could take the job ({len(vendors)} called)"))
        return Response(content="<Response><Say>Understood. Thank you.</Say></Response>", media_type="application/xml")

    @app.get("/api/fetch")
    async def fetch_status():
        """The residents' agents on Fetch.ai: addresses, and what each said about the current plan."""
        return society.status(engine.state)

    @app.get("/api/memory")
    async def memory():
        """Cross-incident memory: rules the manager imposed in earlier runs, grouped by code."""
        grouped: dict[str, dict] = {}
        for row in store.rule_history(exclude_run=engine.state.run_id):
            g = grouped.setdefault(row["code"], {"code": row["code"], "text": row["text"], "times": 0,
                                                  "last_used": row["time"], "last_run": row["run_id"]})
            g["times"] += 1
        active = {r.code for r in engine.state.rules}
        return [dict(g, active=g["code"] in active) for g in grouped.values()]

    @app.get("/api/memory/incidents")
    async def memory_incidents():
        """How earlier incidents ended, and how this one compares: the measured improvement across runs."""
        past = [o for o in store.outcomes() if o["run_id"] != engine.state.run_id]
        now = engine.outcome()
        comparison = None
        if now is not None and past:
            prev = past[0]
            comparison = {"previous_run": prev["run_id"], "minutes_faster": round(prev["minutes_to_done"] - now["minutes_to_done"], 1),
                          "left_behind_delta": now["left_behind"] - prev["left_behind"],
                          "violations_delta": now["violations"] - prev["violations"]}
        return {"incidents": past, "current": now, "comparison": comparison, "count": len(past) + (1 if now else 0)}

    class MemoryApply(BaseModel):
        code: str
        actor: str = "manager"

    @app.post("/api/memory/apply")
    async def memory_apply(body: MemoryApply):
        row = next((r for r in store.rule_history(exclude_run=engine.state.run_id) if r["code"] == body.code), None)
        if row is None:
            raise HTTPException(404, "no remembered rule with that code")
        return await _submit(ManagerRule(text=row["text"], code=row["code"], actor=f"{body.actor} (remembered)"))

    @app.post("/api/command")
    async def post_command(cmd: EquipmentCommand):
        if cmd.equipment_id not in engine.ctx.equipment:
            raise HTTPException(404, f"unknown equipment {cmd.equipment_id}")
        try:
            logged = await engine.submit(cmd)
        except ReplayActiveError as e:
            raise HTTPException(409, str(e)) from e
        return {"seq": logged.seq, "step": logged.step}

    async def _submit(event):
        try:
            logged = await engine.submit(event)
        except ReplayActiveError as e:
            raise HTTPException(409, str(e)) from e
        return {"seq": logged.seq, "step": logged.step}

    @app.get("/api/agents")
    async def get_agents():
        """Every agent in the society with its label, kind and description (from the roster); the live
        on/off state is in the state frame, this is who they are."""
        return [agent_info(engine.ctx, a, on) for a, on in engine.state.agents.items()]

    @app.post("/api/agent")
    async def post_agent(toggle: AgentToggle):
        if toggle.agent not in engine.state.agents:
            raise HTTPException(404, f"unknown agent {toggle.agent}")
        return await _submit(toggle)

    @app.post("/api/rule")
    async def post_rule(rule: ManagerRule):
        return await _submit(rule)

    class RuleText(BaseModel):
        text: str
        actor: str = "manager"
        submit: bool = True

    @app.post("/api/rule/parse")
    async def parse_rule_text(body: RuleText):
        from ..agents.rules import parse_rule

        parsed = parse_rule(body.text)
        if not parsed.confident:
            from ..agents.llm import parse_rule_llm

            llm = await parse_rule_llm(body.text)
            if llm is not None:
                parsed = llm
        result = {"code": parsed.code, "summary": parsed.summary, "confident": parsed.confident, "text": body.text}
        if body.submit and parsed.confident:
            logged = await _submit(ManagerRule(text=body.text, code=parsed.code, actor=body.actor))
            result.update(logged)
        return result

    @app.post("/api/plan/decision")
    async def post_decision(decision: PlanDecision):
        """The human gate. A decision names the plan version the person saw; if the agents have re-planned
        since, say so instead of logging a rejected decision nobody notices."""
        current = engine.state.plan.version
        if decision.plan_version != current:
            raise HTTPException(409, f"The plan changed while you looked: v{decision.plan_version} is gone, v{current} is on the table. Approve again.")
        return await _submit(decision)

    @app.get("/api/plan/brief")
    async def plan_brief():
        """Two spoken sentences for the manager: Claude-polished when a key is set, templated otherwise."""
        from ..agents.llm import narrate

        st = engine.state
        plan = st.approved_plan or st.plan
        if plan.status == "none":
            return {"text": f"No incident. {engine.ctx.short_name} is quiet.", "source": "template"}
        m = plan.metrics
        summary = (f"{plan.headline} {int(m.get('residents_affected', 0))} residents affected, "
                   f"{int(m.get('relocated', 0))} relocated on campus, {int(m.get('escorted', 0))} escorted, "
                   f"{int(m.get('left_behind', 0))} left behind, {int(m.get('violations', 0))} safety violations. "
                   f"Water reaches the switchgear in {m.get('water_contact_min', 0):.0f} minutes; "
                   f"the plumber can close the valve by minute {m.get('valve_closed_min', 0):.0f}.")
        polished = await narrate(summary)
        return {"text": polished or summary, "source": "llm" if polished else "template", "version": plan.version}

    class ExplainBody(BaseModel):
        agent: str
        round: int = 2

    @app.post("/api/agents/explain")
    async def explain_agent(body: ExplainBody):
        """An agent explains its stance in first person: Claude when a key is set, a template otherwise."""
        from ..agents.llm import explain_stance, template_explanation

        st = engine.state
        plan = st.approved_plan or st.plan
        rounds = {r.n: r for r in plan.rounds}
        rnd = rounds.get(body.round) or (plan.rounds[-1] if plan.rounds else None)
        stance = next((s for s in (rnd.stances if rnd else []) if s.agent == body.agent), None)
        if stance is None:
            raise HTTPException(404, f"{body.agent} has no stance in round {body.round}")
        story = None
        if stance.resident:
            r = engine.ctx.roster.by_id().get(stance.resident)
            story = r.story if r else None
        rule = stance.constraint.rule if stance.constraint else None
        text = await explain_stance(stance.label, stance.stance, stance.reason, rule, story, plan.headline)
        source = "llm" if text else "template"
        return {"agent": body.agent, "label": stance.label, "stance": stance.stance, "source": source,
                "text": text or template_explanation(stance.label, stance.stance, stance.reason, rule, story)}

    class ClockBody(BaseModel):
        playing: bool | None = None
        speed: float | None = Field(default=None, gt=0)

    @app.post("/api/clock")
    async def post_clock(body: ClockBody):
        await engine.set_clock(body.playing, body.speed)
        return engine.clock()

    @app.post("/api/scenario/reset")
    async def reset():
        state = await engine.reset()
        return {"run_id": state.run_id}

    @app.get("/api/runs")
    async def runs():
        return store.runs()

    @app.get("/api/runs/{run_id}/events")
    async def run_events(run_id: str):
        return [e.model_dump(mode="json") for e in store.events(run_id)]

    class ImportBody(BaseModel):
        scenario: str = "blackwell_basement_leak"
        label: str | None = None
        events: list[dict]       # [{"step": int, "event": InputEvent payload}]

    @app.post("/api/runs/import")
    async def import_run(body: ImportBody):
        """Load a recorded run (e.g. demo/blackwell_leak.json) so it can be replayed on this machine."""
        from pydantic import TypeAdapter

        from ..world.events import InputEvent

        adapter: TypeAdapter[InputEvent] = TypeAdapter(InputEvent)
        parsed = [(int(e["step"]), adapter.validate_python(e["event"])) for e in body.events]
        run_id = store.create_run(body.scenario + (f":{body.label}" if body.label else ""))
        for step, event in sorted(parsed, key=lambda x: x[0]):
            store.append(run_id, step, event)
        return {"run_id": run_id, "event_count": len(parsed)}

    @app.post("/api/demo/load")
    async def load_demo():
        """Import the bundled canonical run (backend/demo/blackwell_leak.json) and start replaying it."""
        import json
        from pathlib import Path

        path = Path(__file__).resolve().parents[2] / "demo" / "blackwell_leak.json"
        if not path.exists():
            raise HTTPException(404, "no recorded demo; run tools/record_demo.py")
        data = json.loads(path.read_text(encoding="utf-8"))
        imported = await import_run(ImportBody(scenario=data.get("scenario", "blackwell_basement_leak"),
                                               label=data.get("label", "demo"), events=data["events"]))
        state = await engine.start_replay(imported["run_id"], 5.0)
        return {"run_id": state.run_id, "mode": state.mode, "event_count": imported["event_count"]}

    class ReplayBody(BaseModel):
        run_id: str
        speed: float | None = Field(default=None, gt=0)

    @app.post("/api/replay")
    async def replay(body: ReplayBody):
        if not any(r["id"] == body.run_id for r in store.runs(limit=10_000)):
            raise HTTPException(404, "unknown run")
        state = await engine.start_replay(body.run_id, body.speed)
        return {"run_id": state.run_id, "mode": state.mode}

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        q = engine.subscribe()
        try:
            while True:
                msg = await q.get()
                await socket.send_json(msg)
        except (WebSocketDisconnect, asyncio.CancelledError, RuntimeError):
            pass
        finally:
            engine.unsubscribe(q)

    return app
