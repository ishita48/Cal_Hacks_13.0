"""The replay fallback: a recorded run imports on any machine and re-derives the whole demo."""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from haven.api.app import create_app
from haven.world.context import build_context
from haven.world.state import replay_events
from haven.world.store import EventStore

DEMO = Path(__file__).resolve().parents[1] / "demo" / "blackwell_leak.json"


def test_import_then_replay_endpoint():
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        events = [
            {"step": 10, "event": {"type": "sensor_reading", "sensor_id": "basement_mech_1", "value": 0.9, "source": "esp32"}},
            {"step": 40, "event": {"type": "agent_toggle", "agent": "resident:maya", "enabled": False}},
            {"step": 80, "event": {"type": "agent_toggle", "agent": "resident:maya", "enabled": True}},
        ]
        r = client.post("/api/runs/import", json={"label": "test", "events": events}).json()
        assert r["event_count"] == 3
        run_id = r["run_id"]
        assert any(x["id"] == run_id and x["event_count"] == 3 for x in client.get("/api/runs").json())
        assert client.post("/api/replay", json={"run_id": run_id, "speed": 5}).json()["mode"] == "replay"
        state = client.get("/api/state").json()["state"]
        assert state["mode"] == "replay" and state["run_id"] == run_id


def test_recorded_demo_run_replays_the_whole_story():
    if not DEMO.exists():
        return  # recorded by tools/record_demo.py; optional in CI
    from pydantic import TypeAdapter

    from haven.world.events import InputEvent, LoggedEvent

    adapter: TypeAdapter[InputEvent] = TypeAdapter(InputEvent)
    data = json.loads(DEMO.read_text(encoding="utf-8"))
    kinds = [e["event"]["type"] for e in data["events"]]
    assert kinds[0] == "sensor_reading" and "agent_toggle" in kinds and "manager_rule" in kinds
    assert "plan_decision" in kinds and "action" in kinds and "equipment_command" in kinds
    logged = [LoggedEvent(seq=i, run_id="demo", step=e["step"], wall_time=0.0, event=adapter.validate_python(e["event"]))
              for i, e in enumerate(data["events"])]
    last = max(e.step for e in logged)
    state = replay_events("demo", "blackwell_basement_leak", logged, last + 5, build_context())
    assert state.approved_plan is not None and state.approved_plan.status == "done"
    assert state.approved_plan.left_behind == []
    assert state.moved.get("maya") == "L1-lobby"
    assert state.equipment["main_valve"].status == "closed"
    assert any(t.kind == "agent_toggle" for t in state.timeline)
    assert state.rules and state.rules[0].code == "no_off_campus"


def test_one_click_demo_load_starts_a_replay():
    if not DEMO.exists():
        return
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        r = client.post("/api/demo/load").json()
        assert r["mode"] == "replay" and r["event_count"] >= 30
        assert client.get("/api/state").json()["state"]["mode"] == "replay"
        assert client.post("/api/sensor", json={"sensor_id": "x", "value": 1.0}).status_code == 409
