"""The red team attacks every plan; a landed attack changes the plan; incidents remember their outcome;
the plumber call takes a yes or no and moves down the vendor list."""

import asyncio

from fastapi.testclient import TestClient

from haven.agents import redteam
from haven.api.app import create_app
from haven.integrations import twilio
from haven.world.context import build_context
from haven.world.engine import WorldEngine
from haven.world.events import PlanDecision, SensorReading
from haven.world.state import DT, advance, apply_input, initial_state
from haven.world.store import EventStore

CTX = build_context()
SENSOR = "basement_mech_1"


def test_the_red_team_attacks_every_plan_and_its_fix_changes_the_plan():
    s = initial_state("run", "test", CTX)
    apply_input(s, SensorReading(sensor_id=SENSOR, value=0.9), CTX)
    p = s.plan
    codes = {a.code: a for a in p.attacks}
    assert {"surge", "double_booked", "stair_load", "plumber_late", "forgotten"} <= set(codes)
    # Two escorts on the two desk staff overlapped: the second one now belongs to that floor's RA.
    assert codes["double_booked"].fixed and codes["double_booked"].ok
    escorts = {st.id: st.actor for st in p.steps if st.kind == "escort"}
    assert escorts["escort_maya"] == "staff" and escorts["escort_stairs"].startswith("ra_")
    # A 30 % faster leak still leaves the six-minute hold standing, with a margin the attack reports.
    assert codes["surge"].ok and "to spare" in codes["surge"].detail
    assert codes["plumber_late"].ok and "cannot save" in codes["plumber_late"].detail
    assert codes["forgotten"].ok and codes["stair_load"].ok
    rt = next(st for st in p.stances if st.agent == "redteam")
    assert rt.stance == "critique" and "two escorts" in rt.reason.lower()
    assert p.metrics["attacks"] == len(p.attacks) and p.metrics["attacks_landed"] >= 1
    # The red team is always on the roster and never asked a model.
    assert "redteam" in s.agents and s.agents["redteam"] is True


def test_surge_pulls_the_cut_forward_when_the_hold_is_too_long():
    """Make the forecast tight: with contact at 8 min, a 6-minute hold breaks under a 30 % faster leak."""
    from haven.agents.planner import PlanStep, Situation

    sit = Situation(now_step=0, lifts_up=True, eta_lifts_s=8 * 60.0, eta_cut_s=6 * 60.0, dark_now=[], dark_planned=["L3", "L4"],
                    valve_closed_at_s=21 * 60.0, stage2_averted=False, movers=[], away=[], flagged={}, rules=set(), enabled=set())
    steps = [PlanStep(id="hold_power", order=1, kind="hold", actor="facilities", title="Hold", reason="", at_s=0, deadline_s=360),
             PlanStep(id="isolate_ats_eq", order=2, kind="isolate", actor="facilities", title="Cut", reason="", at_s=360, target="ats_eq")]
    v = redteam.attack(CTX, sit, steps)
    surge = next(a for a in v.attacks if a.code == "surge")
    assert surge.fixed and v.eta_cut_s is not None and v.eta_cut_s < 360
    assert abs(v.eta_cut_s - (8 * 60 / redteam.STRESS_FLOW - redteam.HOLD_MARGIN_S)) < 1e-6


def test_incidents_remember_their_outcome_and_compare(monkeypatch):
    monkeypatch.setenv("HAVEN_FETCH", "0")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    store = EventStore()
    app = create_app(store=store, run_loop=False)
    with TestClient(app) as client:
        eng = app.state.engine
        assert client.get("/api/memory/incidents").json()["count"] == 0

        def run_to_done():
            client.post("/api/sensor", json={"sensor_id": SENSOR, "value": 0.9})
            v = client.get("/api/state").json()["state"]["plan"]["version"]
            client.post("/api/plan/decision", json={"plan_version": v, "decision": "approve"})
            for _ in range(int(30 * 60 / DT)):
                advance(eng.state, eng.ctx)
                asyncio.run(eng._execute_due())
                eng._remember_outcome()
                if eng.state.approved_plan.status == "done":
                    break
            assert eng.state.approved_plan.status == "done"

        run_to_done()
        out = eng.outcome()
        assert out is not None and out["left_behind"] == 0 and out["minutes_to_done"] > 5
        rep = client.get("/api/memory/incidents").json()
        assert rep["current"]["run_id"] if "run_id" in rep["current"] else True
        assert rep["count"] == 1 and rep["comparison"] is None
        client.post("/api/scenario/reset")
        rep = client.get("/api/memory/incidents").json()
        assert len(rep["incidents"]) == 1 and rep["current"] is None
        run_to_done()
        rep = client.get("/api/memory/incidents").json()
        assert rep["count"] == 2 and rep["comparison"] is not None
        assert abs(rep["comparison"]["minutes_faster"]) < 1.0 and rep["comparison"]["left_behind_delta"] == 0


def test_twilio_answer_webhook_moves_down_the_vendor_list(monkeypatch):
    monkeypatch.setenv("HAVEN_FETCH", "0")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    for var in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HAVEN_PLUMBER_NUMBER", "+15550100")
    monkeypatch.setenv("HAVEN_PLUMBER_NUMBER_2", "+15550101")
    assert twilio.vendors() == ["+15550100", "+15550101"]
    assert twilio.parse_answer("Yeah, on my way", "") == "yes" and twilio.parse_answer("", "2") == "no"
    assert twilio.parse_answer("not tonight, busy", "") == "no" and twilio.parse_answer("", "") == "unknown"
    assert "<Gather" in twilio.gather_twiml("Come now", "https://x/answer") and "press 1 for yes" in twilio.gather_twiml("c", "a")
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        eng = app.state.engine
        client.post("/api/sensor", json={"sensor_id": SENSOR, "value": 0.9})
        v = client.get("/api/state").json()["state"]["plan"]["version"]
        client.post("/api/plan/decision", json={"plan_version": v, "decision": "approve"})
        for _ in range(int(0.5 * 60 / DT)):
            advance(eng.state, eng.ctx)
            asyncio.run(eng._execute_due())
        assert eng.state.actions["call_plumber"].status == "done"      # simulated call: done at once
        # The first vendor says no: HAVEN dials the second (no Twilio keys, so the dial is recorded, not placed).
        r = client.post("/api/twilio/answer/call_plumber?vendor=0", data={"SpeechResult": "no, busy tonight", "To": "+15550100"})
        assert r.status_code == 200 and "Understood" in r.text
        a = eng.state.actions["call_plumber"]
        assert a.status == "assigned" and "dialling vendor 2" in a.detail
        # The second says yes.
        r = client.post("/api/twilio/answer/call_plumber?vendor=1", data={"Digits": "1", "To": "+15550101"})
        assert "Facilities will meet you" in r.text
        a = eng.state.actions["call_plumber"]
        assert a.status == "done" and "said yes" in a.detail and "vendor 2" in a.detail
        # Silence from the last vendor on the list: the step fails, honestly.
        r = client.post("/api/twilio/answer/call_plumber?vendor=1&timeout=1", data={})
        assert eng.state.actions["call_plumber"].status == "failed"
        assert client.post("/api/twilio/answer/nope?vendor=0", data={}).status_code == 200
