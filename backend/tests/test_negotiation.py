"""The negotiation is real: what an agent says is a logged input that shapes the plan, a model can be the
one saying it, the checker still verifies the facts, and replay needs no model."""

import asyncio

from fastapi.testclient import TestClient

from haven.agents import negotiation
from haven.agents.models import Stance
from haven.api.app import create_app
from haven.world.context import build_context
from haven.world.engine import WorldEngine
from haven.world.events import AgentStance, PlanDecision, SensorReading
from haven.world.state import DT, advance, apply_input, initial_state, replay_events
from haven.world.store import EventStore

CTX = build_context()
SENSOR = "basement_mech_1"


def _incident():
    s = initial_state("run", "test", CTX)
    apply_input(s, SensorReading(sensor_id=SENSOR, value=0.9), CTX)
    return s


def test_a_logged_stance_overrides_the_rule_function_and_the_checker_still_judges_the_facts():
    s = _incident()
    key = s.plan.situation
    assert len(key) == 15
    r1 = next(st for st in s.plan.rounds[0].stances if st.agent == "resident:maya")
    assert r1.stance == "veto" and r1.source == "rules"

    # Maya's agent (say, a model) fails to object in round 1: nobody speaks for her, so the revised plan
    # has no escort, she is left behind, and the checker reports it. Honest, not patched over.
    apply_input(s, AgentStance(agent="resident:maya", situation=key, round=1, stance="support",
                               reason="Looks fine to me.", source="claude"), CTX)
    assert s.plan.situation == key                      # the facts did not move: same situation
    r1 = next(st for st in s.plan.rounds[0].stances if st.agent == "resident:maya")
    assert r1.stance == "support" and r1.source == "claude" and r1.reason == "Looks fine to me."
    assert "maya" in s.plan.left_behind
    assert any(not c.ok for c in s.plan.checks)
    assert any(t.kind == "agent_spoke" for t in s.timeline)

    # It vetoes after all (with the constraint code its role allows): the escort is back.
    apply_input(s, AgentStance(agent="resident:maya", situation=key, round=1, stance="veto",
                               reason="The lifts go dark before I am down.", constraint_type="hard",
                               constraint_rule="Maya keeps a feasible step-free route", constraint_code="step_free:maya",
                               step_ids=["isolate_ats_eq", "bogus_step"], source="fetch:claude"), CTX)
    r1 = next(st for st in s.plan.rounds[0].stances if st.agent == "resident:maya")
    assert r1.stance == "veto" and r1.source == "fetch:claude" and r1.step_ids == ["isolate_ats_eq"]
    assert r1.constraint is not None and r1.constraint.code == "step_free:maya"
    assert "maya" not in s.plan.left_behind
    assert any(st.id == "escort_maya" for st in s.plan.steps)

    # A stance for another situation is kept but does not apply here.
    apply_input(s, AgentStance(agent="safety", situation="deadbeef", round=1, stance="veto", reason="x"), CTX)
    assert next(st for st in s.plan.rounds[0].stances if st.agent == "safety").source == "rules"


def test_validation_only_accepts_what_the_role_may_demand():
    s = _incident()
    steps = s.plan.rounds[0].steps
    ok = negotiation.validate(CTX, "resident:maya", steps, {"stance": "veto", "reason": "Strands me.",
                                                               "constraint_code": "step_free:maya", "step_ids": ["isolate_ats_eq", "nope"]})
    assert ok is not None and ok.constraint.code == "step_free:maya" and ok.step_ids == ["isolate_ats_eq"]
    # A resident may not demand the safety code; the stance survives, the constraint is dropped.
    st = negotiation.validate(CTX, "resident:maya", steps, {"stance": "veto", "reason": "r", "constraint_code": "deenergise_before_contact", "step_ids": []})
    assert st is not None and st.constraint is None
    assert negotiation.validate(CTX, "safety", steps, {"stance": "maybe", "reason": "r", "constraint_code": "", "step_ids": []}) is None
    assert negotiation.validate(CTX, "safety", steps, {"stance": "veto", "reason": "", "constraint_code": "", "step_ids": []}) is None
    facts = negotiation.facts_for_agent(CTX, negotiation._situation(CTX, s), steps, "resident:maya")
    assert facts["you_speak_for"]["name"] == "Maya Reyes" and facts["lifts_running_now"] is True
    assert facts["plan_cuts_switchgear_at_min"] == 0.0 and facts["you_speak_for"]["escort_finishes_before_cut"] is False


def test_the_negotiator_runs_both_rounds_with_a_model_and_replay_needs_none(monkeypatch):
    """A fake model: vetoes for Maya in round 1 (as her rule function would), supports in round 2."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("HAVEN_NEGOTIATION", "claude")
    calls: list[tuple[str, int]] = []

    async def fake_stance(ctx, sit, steps, agent, round_n):
        calls.append((agent, round_n))
        from haven.agents.planner import _capacity, _housing, _resident, _safety

        if agent == "safety":
            st = _safety(ctx, sit, steps)
        elif agent == "housing":
            st = _housing(ctx, sit, steps)
        elif agent == "capacity":
            st = _capacity(sit, steps)
        else:
            st = _resident(ctx, sit, ctx.roster.by_id()[agent.split(":", 1)[1]], steps)
        if st is None:
            return None
        return negotiation.validate(ctx, agent, steps, {"stance": st.stance, "reason": f"(model) {st.reason}",
                                                        "constraint_code": st.constraint.code if st.constraint else "",
                                                        "step_ids": st.step_ids})

    monkeypatch.setattr(negotiation, "stance_llm", fake_stance)

    async def scenario():
        store = EventStore()
        eng = WorldEngine(store)
        neg = negotiation.Negotiator(eng.ctx, eng.submit, lambda: eng.state)
        assert neg.enabled
        eng.plan_listeners.append(neg.on_plan)
        await eng.submit(SensorReading(sensor_id=SENSOR, value=0.9))
        await eng._broadcast(force=True)
        for _ in range(200):
            await asyncio.sleep(0.05)
            if not neg.pending and not neg._tasks and neg.answered > 0 and f"{eng.state.plan.situation}#2" in eng.state.spoken:
                break
        key = eng.state.plan.situation
        spoken1, spoken2 = eng.state.spoken.get(f"{key}#1", {}), eng.state.spoken.get(f"{key}#2", {})
        assert "resident:maya" in spoken1 and "safety" in spoken1 and spoken1["resident:maya"].stance == "veto"
        assert "resident:maya" in spoken2 and spoken2["resident:maya"].stance == "support"
        assert all(s.source == "claude" for s in list(spoken1.values()) + list(spoken2.values()))
        assert any(r == 2 for _, r in calls) and neg.failed == 0
        plan = eng.state.plan
        maya = next(s for s in plan.stances if s.agent == "resident:maya")
        assert maya.source == "claude" and maya.reason.startswith("(model)")
        assert plan.left_behind == [] and any(st.id == "escort_maya" for st in plan.steps)
        status = neg.status(eng.state)
        assert status["mode"] == "claude" and status["pending"] == [] and status["answered"] >= 2
        # The checker never asked a model and is still in the final round.
        assert any(s.agent == "checker" and s.source == "rules" for s in plan.stances)

        # Replay: the logged stances rebuild the identical plan with no model (calls do not grow).
        n_calls = len(calls)
        events = store.events(eng.state.run_id)
        assert any(e.event.type == "agent_stance" for e in events)
        replayed = replay_events(eng.state.run_id, eng.scenario, events, eng.state.step + 1, eng.ctx)
        assert replayed.plan.signature == plan.signature and replayed.plan.stances[-1].agent == "checker"
        assert next(s for s in replayed.plan.stances if s.agent == "resident:maya").reason == maya.reason
        assert len(calls) == n_calls

    asyncio.run(scenario())


def test_without_a_key_the_rule_functions_stand(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    eng = WorldEngine(EventStore())
    neg = negotiation.Negotiator(eng.ctx, eng.submit)
    assert not neg.enabled
    asyncio.run(eng.submit(SensorReading(sensor_id=SENSOR, value=0.9)))
    neg.on_plan(eng.state)
    assert neg.pending == {} and eng.state.spoken == {}
    assert all(s.source == "rules" for s in eng.state.plan.stances)
    assert neg.status(eng.state)["mode"] == "rules"


def test_a_responder_acknowledges_from_the_phone_and_silence_is_labelled(monkeypatch):
    monkeypatch.setenv("HAVEN_FETCH", "0")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        eng = app.state.engine
        assert client.post("/api/action", json={"step_id": "escort_maya", "actor": "staff"}).status_code == 409
        client.post("/api/sensor", json={"sensor_id": SENSOR, "value": 0.9})
        v = client.get("/api/state").json()["state"]["plan"]["version"]
        client.post("/api/plan/decision", json={"plan_version": v, "decision": "approve"})

        async def run(minutes: float):
            for _ in range(int(minutes * 60 / DT)):
                advance(eng.state, eng.ctx)
                await eng._execute_due()

        asyncio.run(run(2.5))                                   # escort_maya assigned at +2 min
        assert eng.state.actions["escort_maya"].status == "assigned"
        # The wrong person cannot close the step; the RA on floor 4 is not on it either.
        assert client.post("/api/action", json={"step_id": "escort_maya", "actor": "ra_4"}).status_code == 403
        assert client.post("/api/action", json={"step_id": "nope", "actor": "staff"}).status_code == 404
        r = client.post("/api/action", json={"step_id": "escort_maya", "actor": "staff", "detail": "Maya is in the lobby"})
        assert r.status_code == 200
        st = client.get("/api/state").json()["state"]
        assert st["actions"]["escort_maya"]["status"] == "done" and "Maya is in the lobby" in st["actions"]["escort_maya"]["detail"]
        assert st["moved"]["maya"] == "L1-lobby"
        assert client.post("/api/action", json={"step_id": "escort_maya", "actor": "staff"}).status_code == 409
        # A step nobody acknowledged is closed by the clock and says so.
        asyncio.run(run(5))
        meds = eng.state.actions["move_meds_L3"]
        assert meds.status == "done" and "auto-confirmed" in meds.detail and "no acknowledgement" in meds.detail
        assert client.get("/api/negotiation").json()["mode"] == "rules"
