"""The same engine, agents and gate handle a grid outage and a generator failure, not only water."""

from haven.world.context import build_context
from haven.world.events import AgentToggle, EquipmentCommand
from haven.world.state import apply_input, initial_state

CTX = build_context()
FEED = next(e.id for e in CTX.spec.equipment if e.kind == "utility_feed")
GEN = next(e.id for e in CTX.spec.equipment if e.kind == "generator")
HERO = CTX.story_order[0]


def _grid_down():
    s = initial_state("run", "test", CTX)
    apply_input(s, EquipmentCommand(equipment_id=FEED, command="off", actor="grid"), CTX)
    return s


def test_grid_outage_is_an_incident_the_generator_carries_the_lifts():
    s = _grid_down()
    assert s.impact.dark_levels and not s.impact.lifts_down          # floor panels have no standby; lifts do
    assert s.plan.status == "draft" and s.narrative.stage != "quiet"
    ids = [st.id for st in s.plan.steps]
    assert "call_utility" in ids and "call_plumber" not in ids and "close_valve" not in ids
    assert f"escort_{HERO}" in ids                                   # down by lift while the generator runs
    assert s.plan.left_behind == [] and not [c for c in s.plan.checks if not c.ok]
    assert "generator" in s.narrative.headline.lower()
    assert any(m.role == "external" and "utility" in m.name.lower() for m in s.plan.messages)


def test_generator_failure_strands_the_wheelchair_users_unless_their_agents_speak():
    s = _grid_down()
    apply_input(s, EquipmentCommand(equipment_id=GEN, command="off", actor="fault"), CTX)
    assert s.impact.lifts_down
    ids = [st.id for st in s.plan.steps]
    assert "call_generator" in ids and f"shelter_{HERO}" in ids
    assert s.plan.left_behind == []
    apply_input(s, AgentToggle(agent=f"resident:{HERO}", enabled=False), CTX)
    assert s.plan.left_behind == [HERO]
    assert "behind" in s.plan.headline and "Cut the power" not in s.plan.headline


def test_power_is_restored_and_the_incident_clears():
    s = _grid_down()
    apply_input(s, EquipmentCommand(equipment_id=FEED, command="on", actor="grid"), CTX)
    assert s.impact.dark_levels == [] and s.narrative.stage == "quiet"
