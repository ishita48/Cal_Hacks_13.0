"""The residents' agents on Fetch.ai say, on the network, exactly what the planner used, and only when on."""

import asyncio

import pytest

from haven.integrations import fetch
from haven.world.engine import WorldEngine
from haven.world.events import AgentToggle, SensorReading
from haven.world.store import EventStore

uagents = pytest.importorskip("uagents")

SENSOR = "basement_mech_1"


def test_resident_stance_on_the_network_equals_the_planner(monkeypatch):
    monkeypatch.setenv("HAVEN_FETCH", "1")
    monkeypatch.setenv("HAVEN_FETCH_PORT", "8031")
    monkeypatch.delenv("AGENTVERSE_API_KEY", raising=False)

    async def scenario():
        eng = WorldEngine(EventStore())
        society = fetch.Society(eng.ctx)
        eng.plan_listeners.append(society.offer)
        await society.start()
        assert society.running and society.table is not None and "maya" in society.agents
        try:
            await eng.submit(SensorReading(sensor_id=SENSOR, value=0.9))
            await eng._broadcast(force=True)
            v = eng.state.plan.version
            for _ in range(60):                        # the agents poll every 0.5 s
                await asyncio.sleep(0.1)
                if len(society.ledger.get(v, {})) >= 2 * len(society.agents) - 4:
                    break
            status = society.status(eng.state)
            maya = next(a for a in status["agents"] if a["resident"] == "maya")
            assert maya["address"].startswith("agent1q") and maya["enabled"]
            r1, r2 = maya["receipts"]["1"], maya["receipts"]["2"]
            assert r1["stance"] == "veto" and r1["verified"] and r1["agrees"]
            assert r2["stance"] == "support" and r2["agrees"]
            assert status["agreeing"] == status["received"] > 0

            # Off: Maya's agent does not speak on the network either; the ledger for the new plan has no Maya.
            await eng.submit(AgentToggle(agent="resident:maya", enabled=False))
            await eng._broadcast(force=True)
            v2 = eng.state.plan.version
            assert v2 != v
            await asyncio.sleep(1.5)
            assert not any(k.startswith("resident:maya#") for k in society.ledger.get(v2, {}))
            assert "maya" in eng.state.plan.left_behind
        finally:
            await society.stop()

    asyncio.run(scenario())


def test_society_is_inert_when_disabled(monkeypatch):
    monkeypatch.setenv("HAVEN_FETCH", "0")
    eng = WorldEngine(EventStore())
    society = fetch.Society(eng.ctx)
    asyncio.run(society.start())
    assert not society.running and society.table is None
    society.offer(eng.state)
    st = society.status(eng.state)
    assert st["configured"] is False and st["agents"] == []
