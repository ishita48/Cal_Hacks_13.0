"""Sponsor integrations are optional and key-gated: without keys the demo still runs."""

import asyncio

from fastapi.testclient import TestClient

from haven.agents.llm import parse_rule_llm
from haven.api.app import create_app
from haven.integrations import cartesia
from haven.integrations.tiger import TigerSink
from haven.world.store import EventStore


def test_everything_degrades_gracefully_without_keys(monkeypatch):
    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CARTESIA_API_KEY", "TIGER_DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    assert asyncio.run(parse_rule_llm("whatever")) is None
    assert asyncio.run(cartesia.speak("hello")) is None
    sink = TigerSink(url=None)
    assert not sink.configured
    asyncio.run(sink.record("basement_mech_1", "run", 0, 0.9, True, "manual"))
    assert asyncio.run(sink.history("basement_mech_1")) == []


def test_history_falls_back_to_the_event_log_and_speak_reports_unconfigured(monkeypatch):
    for var in ("CARTESIA_API_KEY", "TIGER_DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        client.post("/api/sensor", json={"sensor_id": "basement_mech_1", "value": 0.2})
        client.post("/api/sensor", json={"sensor_id": "basement_mech_1", "value": 0.9, "source": "esp32"})
        h = client.get("/api/sensor/basement_mech_1/history").json()
        assert h["source"] == "event_log" and [r["value"] for r in h["readings"]] == [0.2, 0.9]
        assert h["readings"][-1]["wet"] is True and h["readings"][-1]["source"] == "esp32"
        assert client.post("/api/speak", json={"text": "hi"}).status_code == 503
        flags = client.get("/api/integrations").json()
        assert flags["cartesia"] is False and flags["tiger"] is False


def test_agent_explanation_has_a_template_fallback(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    app = create_app(store=EventStore(), run_loop=False)
    with TestClient(app) as client:
        client.post("/api/sensor", json={"sensor_id": "basement_mech_1", "value": 0.9})
        r = client.post("/api/agents/explain", json={"agent": "resident:maya", "round": 1}).json()
        assert r["stance"] == "veto" and r["source"] == "template"
        assert r["text"].startswith("I cannot accept") and "wheelchair" in r["text"]
        r = client.post("/api/agents/explain", json={"agent": "resident:maya"}).json()
        assert r["stance"] == "support"
        assert client.post("/api/agents/explain", json={"agent": "resident:nobody"}).status_code == 404


def test_outward_actions_are_simulated_without_providers(monkeypatch):
    from haven.agents.models import Plan, PlanStep
    from haven.integrations import actions, linear, twilio

    for var in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "LINEAR_API_KEY", "LINEAR_TEAM_ID"):
        monkeypatch.delenv(var, raising=False)
    assert not twilio.configured() and not linear.configured()
    assert asyncio.run(twilio.call("+15550100", "hello")) is None
    assert asyncio.run(linear.create_issue("t", "b")) is None
    plan = Plan(version=1, headline="h")
    call = PlanStep(id="call_plumber", order=1, kind="call", actor="haven", title="Call the plumber", reason="")
    ticket = PlanStep(id="ticket", order=2, kind="ticket", actor="haven", title="Open the ticket", reason="")
    d1 = asyncio.run(actions.perform("run-x", call, plan, "plumber dispatched, ETA ~20 min"))
    d2 = asyncio.run(actions.perform("run-x", ticket, plan, "ticket opened"))
    assert "simulated" in d1 and "TWILIO" in d1 and "simulated" in d2 and "LINEAR" in d2
    # Idempotent per step: a late tick never dials twice.
    assert asyncio.run(actions.perform("run-x", call, plan, "again")) == "again"


def test_cross_incident_memory_remembers_rules_from_earlier_runs():
    store = EventStore()
    app = create_app(store=store, run_loop=False)
    with TestClient(app) as client:
        assert client.get("/api/memory").json() == []
        client.post("/api/sensor", json={"sensor_id": "basement_mech_1", "value": 0.9})
        client.post("/api/rule/parse", json={"text": "Fine, but nobody gets moved off campus."})
        assert client.get("/api/memory").json() == []            # this run's own rules are not "memory"
        client.post("/api/scenario/reset")
        mem = client.get("/api/memory").json()
        assert len(mem) == 1 and mem[0]["code"] == "no_off_campus" and mem[0]["times"] == 1 and not mem[0]["active"]
        client.post("/api/sensor", json={"sensor_id": "basement_mech_1", "value": 0.9})
        r = client.post("/api/memory/apply", json={"code": "no_off_campus"})
        assert r.status_code == 200
        state = client.get("/api/state").json()["state"]
        assert state["rules"][0]["code"] == "no_off_campus" and "remembered" in state["rules"][0]["source"]
        assert client.get("/api/memory").json()[0]["active"] is True
        assert client.post("/api/memory/apply", json={"code": "nope"}).status_code == 404
        flags = client.get("/api/integrations").json()
        assert {"fetch", "twilio", "linear", "agentverse"} <= set(flags)
