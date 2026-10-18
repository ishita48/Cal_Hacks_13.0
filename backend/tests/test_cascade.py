"""Phase 2: the cascade — water physics, derived failures, per-resident impact, forecast, replay."""

import asyncio

from fastapi.testclient import TestClient

from haven.api.app import create_app
from haven.world.context import build_context
from haven.world.engine import WorldEngine
from haven.world.events import EquipmentCommand, SensorReading
from haven.world.state import DT, advance, apply_input, initial_state, replay_events
from haven.world.store import EventStore

CTX = build_context()
SENSOR = "basement_mech_1"


def fresh():
    return initial_state("run", "test", CTX)


def leak(state):
    apply_input(state, SensorReading(sensor_id=SENSOR, value=0.9), CTX)


def run(state, seconds: float):
    for _ in range(int(seconds / DT)):
        advance(state, CTX)


def eta_min(forecast, kind: str, id_: str) -> float | None:
    for e in forecast.events:
        if e.kind == kind and e.id == id_:
            return e.eta_s / 60
    return None


# ---- at rest -------------------------------------------------------------------------------


def test_initial_world_is_dry_powered_and_unaffected():
    s = fresh()
    assert not s.water and not s.leaks and not s.flooded
    assert all(s.power.levels.values()) and all(s.power.lifts.values())
    assert all(e.status == "online" for e in s.equipment.values())
    assert s.impact.counts["affected"] == 0 and s.forecast.settled
    assert s.impact.routes["maya"] is not None


# ---- the forecast: the chain is computed the instant the sensor fires ----------------------


def test_wet_sensor_starts_the_leak_at_the_monitored_riser_and_forecasts_the_chain():
    s = fresh()
    leak(s)
    assert "water_riser" in s.leaks and s.leaks["water_riser"].space == "B1-mech"
    f = s.forecast
    assert not f.settled
    t_msb = eta_min(f, "flooded", "msb_b")
    assert t_msb is not None and 8 <= t_msb <= 15, t_msb
    assert eta_min(f, "flooded", "ats_eq") == t_msb
    assert eta_min(f, "lifts_down", "lifts") == t_msb
    assert eta_min(f, "level_dark", "L3") == t_msb and eta_min(f, "level_dark", "L4") == t_msb
    assert eta_min(f, "stranded", "maya") == t_msb
    assert eta_min(f, "medication_at_risk", "dana") == t_msb
    # Escalation: the original switchgear on its pad goes later, taking the whole building.
    t_msb_a = eta_min(f, "flooded", "msb_a")
    assert t_msb_a is not None and t_msb_a > t_msb + 10
    assert eta_min(f, "level_dark", "L7") == t_msb_a
    # Nothing has physically happened yet.
    assert not s.flooded and s.impact.counts["affected"] == 0


def test_forecast_impact_lists_the_story_residents_with_the_right_impacts():
    s = fresh()
    leak(s)
    by_id = {r.id: r for r in s.forecast.impact.residents}
    assert "stranded" in by_id["maya"].impacts and by_id["maya"].severity == "critical"
    assert "stranded" in by_id["ahmed"].impacts            # lifts are building-wide
    assert "medication_at_risk" in by_id["dana"].impacts
    assert "device_power_lost" in by_id["grace"].impacts
    assert "needs_visual_alert" in by_id["sam"].impacts
    assert "stairs_only_slow" in by_id["theo"].impacts
    assert "needs_escort" in by_id["nora"].impacts
    assert "jordan" in s.forecast.impact.others          # away, room dark: informed, not relocated
    assert len(s.forecast.impact.others) + len(s.forecast.impact.residents) == s.forecast.impact.counts["affected"]


def test_repeated_wet_readings_do_not_restart_the_leak():
    s = fresh()
    leak(s)
    started = s.leaks["water_riser"].started_step
    run(s, 30)
    apply_input(s, SensorReading(sensor_id=SENSOR, value=0.95, source="esp32"), CTX)
    assert s.leaks["water_riser"].started_step == started
    assert sum(1 for t in s.timeline if t.kind == "leak") == 1


# ---- the live cascade: physics makes it real, in the same order ----------------------------


def test_water_physically_reaches_the_switchgear_and_the_lifts_die():
    s = fresh()
    leak(s)
    t_msb = eta_min(s.forecast, "flooded", "msb_b")
    run(s, t_msb * 60 + 60)
    assert "msb_b" in s.flooded and "ats_eq" in s.flooded
    assert s.equipment["msb_b"].status == "flooded"
    assert s.equipment["lift_1"].status == "offline" and not s.power.lifts["lift_1"]
    assert s.power.levels["L3"] is False and s.power.levels["L4"] is False and s.power.levels["L5"] is True
    assert s.impact.dark_levels == ["L3", "L4"]
    assert s.impact.routes["maya"] is None
    kinds = [t.kind for t in s.timeline]
    assert kinds.index("wet") < kinds.index("flooded") < kinds.index("lifts_down")
    assert "level_dark" in kinds and "stranded" in kinds
    # Fire alarm stays up: ATS-EM is wall-mounted higher and still has the generator.
    assert s.equipment["fire_alarm"].status == "online"
    # Equipment that flooded is reported once, as flooded, never also as "lost power".
    assert not any(t.kind == "offline" and t.data.get("id") == "msb_b" for t in s.timeline)


def test_live_run_matches_its_own_forecast():
    s = fresh()
    leak(s)
    predicted = {(e.kind, e.id): e.eta_s for e in s.forecast.events if e.kind in ("flooded", "lifts_down", "level_dark")}
    run(s, 15 * 60)
    actual = {(t.kind, t.data.get("id")): t.step * DT for t in s.timeline if (t.kind, t.data.get("id")) in predicted}
    assert ("flooded", "msb_b") in actual
    for key, t in actual.items():
        assert abs(t - predicted[key]) <= 15, (key, t, predicted[key])   # forecast runs at a coarser dt


def test_closing_the_main_valve_stops_the_leak_and_saves_the_switchgear():
    s = fresh()
    leak(s)
    apply_input(s, EquipmentCommand(equipment_id="main_valve", command="close", actor="plumber"), CTX)
    assert s.equipment["main_valve"].status == "closing"
    run(s, 7 * 60 + 5)
    assert s.equipment["main_valve"].status == "closed"
    assert s.leaks["water_riser"].active is False
    assert any(t.kind == "valve_closed" for t in s.timeline)
    run(s, 20 * 60)
    assert "msb_b" not in s.flooded and s.power.lifts["lift_1"]
    assert s.forecast.settled or eta_min(s.forecast, "flooded", "msb_b") is None


def test_isolating_section_b_early_is_the_safety_agents_lever():
    s = fresh()
    leak(s)
    apply_input(s, EquipmentCommand(equipment_id="msb_b", command="off", actor="agent:safety"), CTX)
    assert s.equipment["msb_b"].status == "isolated"
    assert s.power.levels["L3"] is False
    assert s.power.lifts["lift_1"], "the lifts ride through on the generator via ATS-EQ"
    assert s.impact.routes["maya"] is not None
    apply_input(s, EquipmentCommand(equipment_id="msb_b", command="on"), CTX)
    assert s.power.levels["L3"] is True


# ---- replay + API --------------------------------------------------------------------------


def test_replay_re_derives_the_cascade_exactly():
    async def scenario():
        engine = WorldEngine(EventStore())
        await engine.submit(SensorReading(sensor_id=SENSOR, value=0.9))
        for _ in range(int(13 * 60 / DT)):
            advance(engine.state, engine.ctx)
        await engine.submit(EquipmentCommand(equipment_id="main_valve", command="close"))
        for _ in range(500):
            advance(engine.state, engine.ctx)
        live = engine.state
        assert "msb_b" in live.flooded
        rebuilt = replay_events(live.run_id, live.scenario, engine.store.events(live.run_id), live.step, engine.ctx)
        assert rebuilt.model_dump(exclude={"mode"}) == live.model_dump(exclude={"mode"})

    asyncio.run(scenario())


def test_state_frame_carries_the_cascade_and_commands_are_validated():
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        client.post("/api/sensor", json={"sensor_id": SENSOR, "value": 0.9})
        frame = client.get("/api/state").json()["state"]
        assert frame["leaks"]["water_riser"]["active"] is True
        assert any(e["kind"] == "lifts_down" for e in frame["forecast"]["events"])
        assert client.post("/api/command", json={"equipment_id": "nope", "command": "off"}).status_code == 404
        assert client.post("/api/command", json={"equipment_id": "main_valve", "command": "close"}).status_code == 200
        assert client.get("/api/state").json()["state"]["equipment"]["main_valve"]["status"] == "closing"
