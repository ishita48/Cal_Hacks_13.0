"""Buds answers from the world state, points at the right thing, and never acts without approval."""

import asyncio

from fastapi.testclient import TestClient

from haven.agents import buds
from haven.api.app import create_app
from haven.world.engine import WorldEngine
from haven.world.events import AgentToggle, PlanDecision, SensorReading
from haven.world.state import DT, advance
from haven.world.store import EventStore

SENSOR = "basement_mech_1"


def _leaky_engine() -> WorldEngine:
    eng = WorldEngine(EventStore())
    asyncio.run(eng.submit(SensorReading(sensor_id=SENSOR, value=0.9)))
    return eng


def test_quiet_building_and_help():
    eng = WorldEngine(EventStore())
    r = buds.answer(eng.ctx, eng.state, "hey, what can you do?")
    assert r is not None and r.intent == "help" and "Buds" in r.speech
    r = buds.answer(eng.ctx, eng.state, "status")
    assert r is not None and "quiet" in r.speech
    assert buds.answer(eng.ctx, eng.state, "what is the airspeed of a swallow") is None
    assert buds.fallback("x").intent == "unknown"


def test_grounded_answers_point_at_the_screen():
    eng = _leaky_engine()
    st = eng.state
    r = buds.answer(eng.ctx, st, "where is Maya?")
    assert r is not None and r.intent == "where" and "Maya Reyes" in r.speech and "L4" in r.speech
    assert {f.kind for f in r.focus} >= {"level", "resident", "agent"}
    assert any(f.id == "resident:maya" for f in r.focus)

    r = buds.answer(eng.ctx, st, "why are the lifts held?")
    assert r is not None and r.intent == "why_hold" and "escort" in r.speech.lower()
    assert any(f.kind == "step" and f.id == "hold_power" for f in r.focus)

    r = buds.answer(eng.ctx, st, "what happens if nobody acts?")
    assert r is not None and r.intent == "forecast" and "+" in r.speech and r.focus[0].id == "cascade"

    r = buds.answer(eng.ctx, st, "how many people are affected?")
    assert r is not None and r.intent == "counts" and "affected" in r.speech

    r = buds.answer(eng.ctx, st, "who gets a message?")
    assert r is not None and r.intent == "messages" and r.focus[0].id == "messages"

    r = buds.answer(eng.ctx, st, "who is left behind?")
    assert r is not None and "Nobody is left behind" in r.speech and r.actions == []


def test_the_maya_moment_through_buds():
    eng = _leaky_engine()
    r = buds.answer(eng.ctx, eng.state, "turn Maya's agent off")
    assert r is not None and r.intent == "toggle" and r.actions and r.actions[0].kind == "toggle_agent"
    assert r.actions[0].payload == {"agent": "resident:maya", "enabled": False}
    # Buds only proposed: nothing changed until the human approves.
    assert eng.state.agents["resident:maya"] is True
    asyncio.run(eng.submit(AgentToggle(agent="resident:maya", enabled=False)))
    r = buds.answer(eng.ctx, eng.state, "is anyone left behind?")
    assert r is not None and "Maya Reyes" in r.speech
    assert r.actions and r.actions[0].payload == {"agent": "resident:maya", "enabled": True}
    assert any(f.id == "resident:maya" for f in r.focus)


def test_rules_approval_and_plumber():
    eng = _leaky_engine()
    r = buds.answer(eng.ctx, eng.state, "Fine, but nobody gets moved off campus")
    assert r is not None and r.intent == "rule" and r.actions[0].payload["code"] == "no_off_campus"
    r = buds.answer(eng.ctx, eng.state, "approve the plan")
    assert r is not None and r.intent == "approve" and r.actions[0].kind == "approve"
    assert r.actions[0].payload["plan_version"] == eng.state.plan.version
    r = buds.answer(eng.ctx, eng.state, "where is the plumber?")
    assert r is not None and r.intent == "plumber" and "not on site yet" in r.speech
    asyncio.run(eng.submit(PlanDecision(plan_version=eng.state.plan.version, decision="approve")))
    for _ in range(int(22 * 60 / DT)):
        advance(eng.state, eng.ctx)
        asyncio.run(eng._execute_due())
    r = buds.answer(eng.ctx, eng.state, "plumber?")
    assert r is not None and ("on the way" in r.speech or "done" in r.speech)
    r = buds.answer(eng.ctx, eng.state, "approve")
    assert r is not None and "already approved" in r.speech


def test_buds_endpoints_and_the_human_gate(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("HAVEN_FETCH", "0")
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        r = client.post("/api/buds/ask", json={"text": "simulate the leak"}).json()
        assert r["actions"][0]["kind"] == "leak"
        assert client.get("/api/state").json()["state"]["leaks"] == {}
        client.post("/api/buds/act", json={"kind": "leak", "payload": r["actions"][0]["payload"]})
        st = client.get("/api/state").json()["state"]
        assert st["leaks"] and st["plan"]["status"] != "none"
        r = client.post("/api/buds/ask", json={"text": "switch maya's agent off"}).json()
        client.post("/api/buds/act", json={"kind": "toggle_agent", "payload": r["actions"][0]["payload"]})
        assert "maya" in client.get("/api/state").json()["state"]["plan"]["left_behind"]
        r = client.post("/api/buds/ask", json={"text": "tell me about the weather on mars"}).json()
        assert r["source"] == "template" and r["intent"] == "unknown"
        assert client.post("/api/buds/act", json={"kind": "nope"}).status_code == 400
        assert client.get("/api/voice/agent").json()["configured"] is False
        rep = client.get("/api/sponsors").json()
        ids = {s["id"] for s in rep["sponsors"]}
        assert {"fetch", "anthropic", "elevenlabs", "cartesia", "tiger", "twilio", "linear", "hardware"} <= ids
        assert all(s["state"] in ("live", "off", "error") for s in rep["sponsors"])
        flags = client.get("/api/integrations").json()
        assert flags["elevenlabs"] is False and flags["voice_agent"] is False
