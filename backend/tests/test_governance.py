"""Phase 5: spoken rules become constraints, every person gets their own message, approval acts."""

import asyncio

from fastapi.testclient import TestClient

from haven.agents.rules import parse_rule
from haven.api.app import create_app
from haven.world.context import build_context
from haven.world.engine import WorldEngine
from haven.world.events import ManagerRule, PlanDecision, SensorReading
from haven.world.state import DT, advance, apply_input, initial_state, replay_events
from haven.world.store import EventStore

CTX = build_context()
SENSOR = "basement_mech_1"


def incident():
    s = initial_state("run", "test", CTX)
    apply_input(s, SensorReading(sensor_id=SENSOR, value=0.9), CTX)
    return s


# ---- voice -> constraint --------------------------------------------------------------------


def test_spoken_rules_parse_to_codes():
    assert parse_rule("Fine, but nobody gets moved off campus.").code == "no_off_campus"
    assert parse_rule("keep everyone on campus, no hotels").code == "no_off_campus"
    assert parse_rule("No one moves after midnight").code == "no_moves_after:00:00"
    assert parse_rule("nobody gets relocated after 1am").code == "no_moves_after:01:00"
    assert parse_rule("don't wake anyone who is asleep").code == "no_wake"
    assert parse_rule("everyone shelters in place").code == "shelter_in_place"
    assert parse_rule("wheelchair users come down first").code == "lifts_first"
    bad = parse_rule("order pizza for the lobby")
    assert bad.code == "unparsed" and not bad.confident


def test_no_moves_after_midnight_turns_relocation_into_shelter():
    s = incident()                                   # 23:41; relocation would run until ~00:03
    apply_input(s, ManagerRule(text="nobody moves after midnight", code="no_moves_after:00:00"), CTX)
    p = s.plan
    ids = [st.id for st in p.steps]
    assert "shelter_floors" in ids and not any(i.startswith("relocate_L") for i in ids)
    assert "escort_maya" in ids and "power_first" in ids          # hard needs still move
    housing = next(st for st in p.rounds[1].stances if st.agent == "housing")
    assert "rule" in housing.reason.lower()
    assert any(m.to.startswith("group_shelter") for m in p.messages)


# ---- messages --------------------------------------------------------------------------------


def test_every_affected_person_has_a_message_in_their_language():
    p = incident().plan
    by_to = {m.to: m for m in p.messages}
    assert "lift" in by_to["maya"].text and by_to["maya"].channel == "call"
    assert "medication" in by_to["dana"].text
    assert by_to["sam"].channel == "text_only" and "light" in by_to["sam"].text
    assert "Nothing is needed from you now" in by_to["jordan"].text
    assert by_to["grace"].lang == "zh"
    langs = {m.lang for m in p.messages if m.to.startswith("group_")}
    assert {"en", "es", "zh"} <= langs
    es = next(m for m in p.messages if m.to.startswith("group_") and m.lang == "es")
    assert "pisos 3 y 4" in es.text
    staff = {m.to for m in p.messages if m.role != "resident"}
    assert {"ra_3", "ra_4", "luis", "devon", "plumber", "dean", "rosa"} <= staff
    covered = sum(m.count for m in p.messages if m.role == "resident")
    assert covered >= p.metrics["residents_affected"]
    assert len(p.messages) < 60


# ---- approval -> action ----------------------------------------------------------------------


def test_approved_plan_executes_in_the_world_and_replays():
    async def scenario():
        eng = WorldEngine(EventStore())
        await eng.submit(SensorReading(sensor_id=SENSOR, value=0.9))
        v = eng.state.plan.version
        await eng.submit(PlanDecision(plan_version=v, decision="approve"))
        assert eng.state.approved_plan is not None and eng.state.approved_plan.version == v

        async def run(minutes: float):
            for _ in range(int(minutes * 60 / DT)):
                advance(eng.state, eng.ctx)
                await eng._execute_due()

        await run(1)
        st = eng.state
        assert st.actions["call_plumber"].status == "done"
        assert st.approved_plan.status == "executing"
        # Responders are a derived view of the plan + action reports: facilities is heading to the
        # switchgear to hold the cut, desk staff are still at the front desk, the plumber is off site.
        acts = eng.state.actors
        assert acts["facilities"].status == "moving" and acts["facilities"].heading == "B1-elec"
        assert acts["staff"].status == "idle" and acts["staff"].at == "L1-lobby"
        assert acts["plumber"].status == "offsite" and acts["plumber"].at is None
        await run(1.5)
        staff = eng.state.actors["staff"]
        assert staff.status == "moving" and staff.step_id == "escort_maya" and staff.heading == "room_412"
        await run(5)                                      # escort done at +6, then the cut
        st = eng.state
        assert st.actions["escort_maya"].status == "done"
        assert st.moved["maya"] == "L1-lobby"
        assert st.actors["facilities"].at == "B1-elec" and st.actors["facilities"].status == "done"
        assert st.equipment["msb_b"].status == "isolated" and not st.power.lifts["lift_1"]
        assert st.impact.dark_levels == ["L3", "L4"]
        assert "maya" not in {r.id for r in st.impact.residents if "stranded" in r.impacts}
        assert any(t.kind == "command" and "haven:plan" in t.message for t in st.timeline)
        await run(22)
        st = eng.state
        assert st.equipment["main_valve"].status == "closed"
        assert st.approved_plan.status == "done"
        assert all(a.status == "done" for a in st.actions.values())
        assert len(st.moved) >= 200 and st.moved["maya"] == "L1-lobby"
        assert st.actors["plumber"].at == "B1-mech" and st.actors["plumber"].status == "done"
        # The relocated are no longer on dark floors; the ledger reflects where people are now.
        assert st.impact.counts["on_dark_floors"] < 40
        # Replay reproduces the executed world exactly: the actions were inputs.
        rebuilt = replay_events(st.run_id, st.scenario, eng.store.events(st.run_id), st.step, eng.ctx)
        assert rebuilt.model_dump(exclude={"mode"}) == st.model_dump(exclude={"mode"})

    asyncio.run(scenario())


def test_api_rule_parse_and_approval():
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        client.post("/api/sensor", json={"sensor_id": SENSOR, "value": 0.9})
        r = client.post("/api/rule/parse", json={"text": "Fine, but nobody gets moved off campus."}).json()
        assert r["code"] == "no_off_campus" and r["confident"] and "seq" in r
        state = client.get("/api/state").json()["state"]
        assert state["rules"][0]["code"] == "no_off_campus"
        r = client.post("/api/rule/parse", json={"text": "bring snacks"}).json()
        assert r["code"] == "unparsed" and "seq" not in r
        plan = client.get("/api/state").json()["state"]["plan"]
        assert plan["messages"] and any(m["to"] == "maya" for m in plan["messages"])
        client.post("/api/plan/decision", json={"plan_version": plan["version"], "decision": "approve"})
        state = client.get("/api/state").json()["state"]
        assert state["approved_plan"]["version"] == plan["version"]
