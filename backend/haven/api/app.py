"""HTTP + WebSocket surface. Every route is either a view of the world or a mutator of it."""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ..integrations import actions, cartesia, fetch
from ..integrations.tiger import TigerSink

from ..world.engine import ReplayActiveError, WorldEngine
from ..world.events import AgentToggle, EquipmentCommand, ManagerRule, PlanDecision, SensorReading
from ..world.state import agent_label
from ..world.store import EventStore


def create_app(store: EventStore | None = None, run_loop: bool = True) -> FastAPI:
    store = store or EventStore(os.environ.get("HAVEN_DB", "data/haven.db"))
    engine = WorldEngine(store)
    sensor_token = os.environ.get("HAVEN_SENSOR_TOKEN")
    tiger = TigerSink()
    society = fetch.Society(engine.ctx)          # the residents' agents on Fetch.ai (local or Agentverse)
    engine.plan_listeners.append(society.offer)

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
        """Cartesia voice for a message in the plan (the plumber call, the manager alert)."""
        audio = await cartesia.speak(body.text, body.lang)
        if audio is None:
            raise HTTPException(503, "voice not configured (set CARTESIA_API_KEY); use browser speech")
        return Response(content=audio, media_type="audio/mpeg")

    @app.get("/api/integrations")
    async def integrations():
        return {
            "cartesia": cartesia.configured(),
            "tiger": tiger.configured,
            "llm": bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")),
            "sensor_token": bool(sensor_token),
            "fetch": society.running,
            "agentverse": fetch.agentverse() and society.running,
            **actions.providers(),
        }

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
        return [{"id": a, "label": agent_label(engine.ctx, a), "enabled": on}
                for a, on in engine.state.agents.items()]

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
        return await _submit(decision)

    @app.get("/api/plan/brief")
    async def plan_brief():
        """Two spoken sentences for the manager: Claude-polished when a key is set, templated otherwise."""
        from ..agents.llm import narrate

        st = engine.state
        plan = st.approved_plan or st.plan
        if plan.status == "none":
            return {"text": "No incident. Blackwell Hall is quiet.", "source": "template"}
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
