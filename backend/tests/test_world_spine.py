"""Phase 0: one authoritative world, an append-only log, identical broadcast, deterministic replay."""

import asyncio

from fastapi.testclient import TestClient

from haven.api.app import create_app
from haven.world.context import build_context
from haven.world.engine import WorldEngine
from haven.world.events import SensorReading
from haven.world.state import advance, replay_events
from haven.world.store import EventStore


def test_sensor_event_is_logged_and_applied():
    async def scenario():
        engine = WorldEngine(EventStore())
        for _ in range(7):
            advance(engine.state, engine.ctx)
        logged = await engine.submit(SensorReading(sensor_id="basement_1", value=0.9))
        assert logged.step == 7
        assert engine.state.sensors["basement_1"].wet
        assert engine.state.timeline[-1].kind == "sensor_wet"
        assert engine.store.events(engine.state.run_id)[0].event.sensor_id == "basement_1"

    asyncio.run(scenario())


def test_replay_reproduces_live_world():
    async def scenario():
        engine = WorldEngine(EventStore())
        for value, steps in [(0.1, 3), (0.8, 10), (0.2, 4), (0.95, 1)]:
            for _ in range(steps):
                advance(engine.state, engine.ctx)
            await engine.submit(SensorReading(sensor_id="basement_1", value=value))
        for _ in range(5):
            advance(engine.state, engine.ctx)

        live = engine.state
        rebuilt = replay_events(live.run_id, live.scenario, engine.store.events(live.run_id), live.step, engine.ctx)
        assert rebuilt.model_dump(exclude={"mode"}) == live.model_dump(exclude={"mode"})

    asyncio.run(scenario())


def test_two_clients_receive_identical_state():
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
            a.receive_json(), b.receive_json()  # initial snapshots
            r = client.post("/api/sensor", json={"sensor_id": "basement_1", "value": 0.9, "source": "esp32"})
            assert r.status_code == 200
            msg_a, msg_b = a.receive_json(), b.receive_json()
            assert msg_a == msg_b
            assert msg_a["state"]["sensors"]["basement_1"]["wet"] is True


def test_replay_endpoint_rejects_live_inputs_until_reset():
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        client.post("/api/sensor", json={"sensor_id": "basement_1", "value": 0.9})
        run_id = client.get("/api/health").json()["run_id"]
        assert client.post("/api/replay", json={"run_id": run_id}).json()["mode"] == "replay"
        assert client.post("/api/sensor", json={"sensor_id": "x", "value": 1.0}).status_code == 409
        client.post("/api/scenario/reset")
        assert client.post("/api/sensor", json={"sensor_id": "x", "value": 1.0}).status_code == 200


def test_responders_start_at_home_and_are_in_every_frame():
    """`state.actors` is a derived view every client draws from: quiet world = everyone idle at home."""
    eng = WorldEngine(EventStore())
    actors = eng.state.actors
    assert actors["ra_4"].at == "room_415" and actors["ra_4"].status == "idle"
    assert actors["facilities"].at == "L1-facilities" and actors["staff"].at == "L1-lobby"
    assert actors["plumber"].status == "offsite" and actors["plumber"].at is None
    frame = eng.snapshot()["state"]
    assert set(frame["actors"]) == set(actors)
    # A leak alone moves nobody: responders move only on approved, executed steps.
    asyncio.run(eng.submit(SensorReading(sensor_id="basement_mech_1", value=0.9)))
    assert all(a.status in ("idle", "offsite") for a in eng.state.actors.values())
