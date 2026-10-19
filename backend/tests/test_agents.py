"""Phase 3: agents negotiate a plan under hard constraints; the Maya toggle changes the plan."""

from fastapi.testclient import TestClient

from haven.api.app import create_app
from haven.world.context import build_context
from haven.world.events import AgentToggle, ManagerRule, PlanDecision, SensorReading
from haven.world.state import DT, advance, apply_input, initial_state
from haven.world.store import EventStore

CTX = build_context()
SENSOR = "basement_mech_1"


def incident():
    s = initial_state("run", "test", CTX)
    apply_input(s, SensorReading(sensor_id=SENSOR, value=0.9), CTX)
    return s


def step_ids(plan):
    return [st.id for st in plan.steps]


def stance_of(plan, agent, n=2):
    rnd = plan.rounds[n - 1]
    return next((s for s in rnd.stances if s.agent == agent), None)


# ---- at rest -------------------------------------------------------------------------------


def test_no_incident_no_plan():
    s = initial_state("run", "test", CTX)
    assert s.plan.status == "none" and not s.plan.steps
    assert "resident:maya" in s.agents and s.agents["resident:maya"]
    assert 40 <= len(s.agents) <= 70          # specialists + people with a need or a story


# ---- the negotiation -----------------------------------------------------------------------


def test_naive_plan_is_vetoed_and_the_revised_plan_holds_every_hard_constraint():
    s = incident()
    p = s.plan
    assert p.status == "draft" and p.version == 1
    r1, r2 = p.rounds
    assert not r1.feasible and r2.feasible
    vetoers = {st.agent for st in r1.stances if st.stance == "veto"}
    assert {"resident:maya", "resident:dana", "capacity"} <= vetoers
    assert stance_of(p, "safety", 1).stance == "propose"
    assert all(st.stance != "veto" for st in r2.stances)
    assert stance_of(p, "resident:maya").stance == "support"
    assert stance_of(p, "resident:jordan").stance == "support"      # not woken, not moved
    assert p.left_behind == []


def test_revised_plan_holds_the_lifts_for_maya_then_cuts_before_the_water():
    s = incident()
    p = s.plan
    ids = step_ids(p)
    assert "escort_maya" in ids and "hold_power" in ids and "isolate_ats_eq" in ids
    escort = next(st for st in p.steps if st.id == "escort_maya")
    cut = next(st for st in p.steps if st.id == "isolate_ats_eq")
    contact = p.metrics["water_contact_min"] * 60
    assert escort.deadline_s <= cut.at_s <= contact - 120          # escort done, then cut, 2 min margin
    assert cut.command == {"equipment_id": "ats_eq", "command": "off"}
    assert ids.index("escort_maya") < ids.index("isolate_ats_eq")
    # Everyone with a specific need has a step with their name on it.
    people = {pid for st in p.steps for pid in st.people}
    for rid in ("maya", "dana", "grace", "sam", "theo", "nora", "ahmed", "jordan"):
        assert rid in people, rid
    # Capacity is respected: nobody off campus, every destination within its capacity.
    assert p.metrics["off_campus"] == 0
    assert stance_of(p, "capacity").stance == "support"


def test_the_maya_moment():
    s = incident()
    on = s.plan
    apply_input(s, AgentToggle(agent="resident:maya", enabled=False), CTX)
    off = s.plan
    assert off.version == on.version + 1
    assert "escort_maya" in step_ids(on) and "escort_maya" not in step_ids(off)
    assert "hold_power" in step_ids(on) and "hold_power" not in step_ids(off)
    cut_on = next(st for st in on.steps if st.id == "isolate_ats_eq").at_s
    cut_off = next(st for st in off.steps if st.id == "isolate_ats_eq").at_s
    assert cut_on > 0 and cut_off == 0                      # power cut now: she is stranded
    assert off.left_behind == ["maya"] and on.left_behind == []
    assert "Maya" in off.headline and "left behind" in off.headline
    assert stance_of(off, "resident:maya") is None          # nobody speaks for her
    assert any(t.kind == "agent_toggle" for t in s.timeline)
    apply_input(s, AgentToggle(agent="resident:maya", enabled=True), CTX)
    assert s.plan.left_behind == [] and "escort_maya" in step_ids(s.plan)


def test_plan_version_is_stable_while_nothing_changes():
    s = incident()
    v = s.plan.version
    for _ in range(int(120 / DT)):
        advance(s, CTX)
    assert s.plan.version == v


def test_when_it_is_too_late_for_the_lift_the_fallback_is_staff_at_her_door():
    s = incident()
    for _ in range(int(9 * 60 / DT)):
        advance(s, CTX)
    p = s.plan
    assert "escort_maya" not in step_ids(p) and "shelter_maya" in step_ids(p)
    assert stance_of(p, "resident:maya").stance == "support"
    assert p.left_behind == []


def test_manager_rule_no_off_campus_removes_the_hotel():
    s = incident()
    apply_input(s, ManagerRule(text="Nobody gets moved off campus", code="no_off_campus"), CTX)
    p = s.plan
    assert p.rules and p.rules[0].code == "no_off_campus"
    assert not any(st.target == "hotel_rooms" for st in p.steps)
    assert p.metrics["off_campus"] == 0


def test_approval_binds_to_a_plan_version():
    s = incident()
    v = s.plan.version
    apply_input(s, PlanDecision(plan_version=v + 5, decision="approve"), CTX)
    assert s.approved_plan_version is None and s.timeline[-1].kind == "command_rejected"
    apply_input(s, PlanDecision(plan_version=v, decision="approve"), CTX)
    assert s.approved_plan_version == v and s.plan.status == "approved"
    apply_input(s, AgentToggle(agent="resident:maya", enabled=False), CTX)
    assert s.plan.version == v + 1 and s.plan.status == "draft"


def test_api_toggle_and_decision():
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        client.post("/api/sensor", json={"sensor_id": SENSOR, "value": 0.9})
        agents = client.get("/api/agents").json()
        maya = next(a for a in agents if a["id"] == "resident:maya")
        assert maya["enabled"] and maya["label"] == "Maya's agent"
        assert client.post("/api/agent", json={"agent": "resident:nobody", "enabled": False}).status_code == 404
        assert client.post("/api/agent", json={"agent": "resident:maya", "enabled": False}).status_code == 200
        plan = client.get("/api/state").json()["state"]["plan"]
        assert plan["left_behind"] == ["maya"]
        # A decision on a plan the agents have since replaced is refused out loud, not logged as rejected.
        stale = client.post("/api/plan/decision", json={"plan_version": plan["version"] - 1, "decision": "approve"})
        assert stale.status_code == 409 and "changed" in stale.json()["detail"]
        r = client.post("/api/plan/decision", json={"plan_version": plan["version"], "decision": "approve"})
        assert r.status_code == 200
        assert client.get("/api/state").json()["state"]["plan"]["status"] == "approved"


def test_checker_verifies_the_facts_not_the_speakers():
    s = incident()
    p = s.plan
    assert p.metrics["violations"] == 0 and p.metrics["checks"] >= 8
    assert stance_of(p, "checker").stance == "support"
    codes = {c.code for c in p.checks}
    assert {"deenergise_before_contact", "no_lift_after_cut", "capacity", "step_free:maya", "meds:dana"} <= codes
    apply_input(s, AgentToggle(agent="resident:maya", enabled=False), CTX)
    p = s.plan
    bad = [c for c in p.checks if not c.ok]
    assert [c.code for c in bad] == ["step_free:maya"] and p.metrics["violations"] == 1
    assert stance_of(p, "checker").stance == "veto" and not p.rounds[1].feasible
    apply_input(s, ManagerRule(text="nobody off campus", code="no_off_campus"), CTX)
    assert any(c.code == "no_off_campus" and c.ok for c in s.plan.checks)
