"""The story so far is a derived view: plain words every screen shares, read from the state."""

from haven.agents.registry import agent_info, agent_label
from haven.agents.rules import parse_rule
from haven.world.context import build_context
from haven.world.events import AgentToggle, ManagerRule, PlanDecision, SensorReading
from haven.world.state import DT, advance, apply_input, initial_state

CTX = build_context()
HERO = CTX.story_order[0]


def _leak():
    s = initial_state("run", "test", CTX)
    apply_input(s, SensorReading(sensor_id=CTX.sensor_ids[0], value=0.9), CTX)
    return s


def test_quiet_building_tells_you_what_to_do():
    s = initial_state("run", "test", CTX)
    n = s.narrative
    assert n.stage == "quiet"
    assert CTX.short_name in n.headline
    assert "Simulate leak" in n.ask
    assert n.contact_in_s is None and n.affected_if_nothing_done == 0


def test_leak_names_the_chain_the_people_and_the_plan():
    s = _leak()
    n = s.narrative
    assert n.stage == "negotiate"
    assert "L/s" in n.headline
    assert n.contact_name and n.contact_in_s is not None and 0 < n.contact_in_s < 3600
    assert n.contact_name in n.detail and "lifts stop" in n.detail
    first = CTX.roster.by_id()[HERO].name.split()[0]
    assert first in n.detail and HERO in n.people
    assert n.next.startswith("The agents propose")
    assert n.affected_if_nothing_done >= n.affected_by_plan > 0
    assert "Approve" in n.ask


def test_the_maya_moment_is_in_words():
    s = _leak()
    apply_input(s, AgentToggle(agent=f"resident:{HERO}", enabled=False), CTX)
    n = s.narrative
    first = CTX.roster.by_id()[HERO].name.split()[0]
    assert f"leaves {first} behind" in n.next and "agent is off" in n.next
    assert first in n.ask and "back on" in n.ask
    apply_input(s, AgentToggle(agent=f"resident:{HERO}", enabled=True), CTX)
    assert "behind" not in s.narrative.next or "Nobody left behind" in s.narrative.next


def test_rule_approval_and_action_move_the_stage():
    s = _leak()
    rule = parse_rule("Nobody gets moved off campus")
    apply_input(s, ManagerRule(text="Nobody gets moved off campus", code=rule.code), CTX)
    assert s.narrative.stage == "govern"
    apply_input(s, PlanDecision(plan_version=s.plan.version, decision="approve"), CTX)
    assert s.narrative.stage == "act" and "acting on plan" in s.narrative.next
    for _ in range(int(60 / DT)):
        advance(s, CTX)
    assert s.narrative.stage == "act" and s.narrative.contact_in_s is not None


def test_agent_registry_reads_the_roster():
    r = CTX.roster.by_id()[HERO]
    info = agent_info(CTX, f"resident:{HERO}", True)
    assert info["label"] == f"{r.name.split()[0]}'s agent" == agent_label(CTX, f"resident:{HERO}")
    assert info["kind"] == "resident" and info["named"] and info["level"] == r.level
    assert info["description"] == r.story
    for a in ("safety", "housing", "capacity", "checker", "redteam"):
        i = agent_info(CTX, a, True)
        assert i["description"] and i["kind"] in ("specialist", "checker", "redteam")
    assert agent_info(CTX, "checker", True)["fixed"] and not agent_info(CTX, "safety", True)["fixed"]
