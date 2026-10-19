"""Authorization at the transport boundary and a real resident → staff → resident workflow."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from haven.api.app import create_app
from haven.api.auth import Viewer
from haven.api.portal import snapshot
from haven.world.store import EventStore


@pytest.fixture
def env(monkeypatch):
    monkeypatch.delenv("CLERK_SECRET_KEY", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    app = create_app(EventStore(), run_loop=False)
    with TestClient(app) as client:
        yield client, app.state.engine


def identity(role, person=None):
    return {"X-Haven-Role": role, **({"X-Haven-Person": person} if person else {})}


def resident(engine):
    return next(p for p in engine.ctx.roster.residents if p.role == "resident" and p.story)


def raise_request(client, p):
    result = client.post("/api/portal/requests", headers=identity("resident", p.id),
                         json={"title": "AC needs repair", "room": p.room, "category": "ac"})
    assert result.status_code == 200, result.text
    return result.json()


def test_legacy_data_and_mutations_are_denied_to_residents(env):
    client, engine = env
    headers = identity("resident", resident(engine).id)
    for path in ("/api/state", "/api/people", "/api/runs", "/api/graph", "/api/ops", "/api/memory"):
        assert client.get(path, headers=headers).status_code == 403, path
    assert client.post("/api/command", headers=headers, json={"equipment_id": "x", "command": "off"}).status_code == 403
    assert client.post("/api/buds/ask", headers=headers, json={"text": "list people"}).status_code == 403


def test_scoped_snapshot_contains_no_other_private_rooms_or_profiles(env):
    client, engine = env
    p = resident(engine)
    result = client.get("/api/portal/snapshot", headers=identity("resident", p.id)).json()
    assert {s["id"] for s in result["building"]["spaces"] if s["kind"] == "room"} == {p.room}
    assert result["team"] == []
    assert result["building"]["photoreal"] is False
    assert not any(k in result for k in ("roster", "world", "plan", "spoken", "timeline"))
    stranger = next(q for q in engine.ctx.roster.residents if q.role == "resident" and q.id != p.id and q.room != p.room)
    assert client.post("/api/portal/requests", headers=identity("resident", p.id), json={"title": "Unauthorized room", "room": stranger.room}).status_code == 403


def test_request_assignment_appointment_messages_and_private_inbox(env):
    client, engine = env
    p = resident(engine)
    t = raise_request(client, p)
    url = f"/api/portal/requests/{t['id']}"
    staff = identity("maintenance")
    queued = client.get("/api/portal/snapshot", headers=staff).json()["requests"]
    assert [r["id"] for r in queued] == [t["id"]] and queued[0]["assigned_to"] == ""     # the open queue
    assert client.post(url, headers=staff, json={"action": "start", "expected_version": t["version"]}).status_code == 403
    t = client.post(url, json={"action": "assign", "assigned_to": "demo:maintenance", "expected_version": t["version"]}).json()
    assert client.get("/api/portal/snapshot", headers=staff).json()["requests"][0]["id"] == t["id"]
    at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    t = client.post(url, headers=staff, json={"action": "propose", "appointment": at, "expected_version": t["version"]}).json()
    assert client.post(url, headers=staff, json={"action": "accept", "expected_version": t["version"]}).status_code == 403
    t = client.post(url, headers=identity("resident", p.id), json={"action": "accept", "expected_version": t["version"]}).json()
    assert t["appointment_status"] == "accepted"
    assert client.post(url, headers=staff, json={"action": "start", "expected_version": 1}).status_code == 409
    inbox = client.get("/api/portal/snapshot", headers=identity("resident", p.id)).json()["inbox"]
    assert inbox and all(n["recipient"] == p.id for n in inbox)
    assert client.post(f"/api/portal/inbox/{inbox[0]['id']}/read", headers=staff).status_code == 404
    t = client.post(url, headers=staff, json={"action": "resolve", "expected_version": t["version"]}).json()
    assert t["status"] == "resolved"


def test_roles_cannot_edit_contacts_or_assignments(env):
    client, _ = env
    for role in ("resident", "ra", "maintenance"):
        assert client.put("/api/portal/contacts/housing", headers=identity(role), json={"name": "Forged contact"}).status_code == 403
        assert client.put("/api/portal/assignments/x", headers=identity(role), json={"levels": []}).status_code == 403


def test_housing_survives_reset_and_reconstruction(env):
    client, engine = env
    p = resident(engine)
    t = raise_request(client, p)
    assert client.post("/api/scenario/reset").status_code == 200
    assert t["id"] in engine.state.housing["requests"]
    from haven.world.engine import WorldEngine
    restarted = WorldEngine(engine.store)
    assert t["id"] in restarted.state.housing["requests"]


def test_ra_scope_changes_on_assignment(env):
    client, engine = env
    ra = next(p for p in engine.ctx.roster.residents if p.role == "ra")
    other = next(lv for lv in engine.ctx.level_order if lv != ra.level)
    result = client.put(f"/api/portal/assignments/{ra.id}", json={"levels": [other]})
    assert result.status_code == 200
    data = client.get("/api/portal/snapshot", headers=identity("ra", ra.id)).json()
    assert data["viewer"]["levels"] == [other]
    assert all(s["level"] == other for s in data["building"]["spaces"] if s["kind"] == "room")


def test_websocket_uses_same_private_projection(env):
    client, engine = env
    p = resident(engine)
    with client.websocket_connect("/ws/portal") as ws:
        ws.send_json({"role": "resident", "person": p.id})
        result = ws.receive_json()
        assert result == snapshot(engine, Viewer(role="resident", source="demo", person_id=p.id))
        assert result["team"] == []
    with client.websocket_connect("/ws?identity=1") as ws:
        ws.send_json({"role": "resident", "person": p.id})
        assert ws.receive()["code"] == 4403


def test_clerk_identity_cannot_be_overridden_by_demo_headers(env, monkeypatch):
    client, engine = env
    p = resident(engine)
    monkeypatch.setenv("CLERK_SECRET_KEY", "test-key")
    async def verified(token):
        return Viewer(role="resident", source="clerk", user_id="user_test", person_id=p.id)
    from haven.api import auth
    monkeypatch.setattr(auth.clerk, "viewer", verified)
    headers = {"Authorization": "Bearer signed-token", "X-Haven-Role": "admin"}
    assert client.get("/api/state", headers=headers).status_code == 403
    assert client.get("/api/portal/snapshot", headers=headers).json()["viewer"]["role"] == "resident"
    assert client.get("/api/portal/demo-people", headers=headers).status_code == 404
    assert client.get("/api/portal/snapshot").status_code == 401


def test_incident_is_scoped_per_role(env):
    client, engine = env
    client.post("/api/sensor", json={"sensor_id": engine.ctx.sensor_ids[0], "value": 0.9}, headers=identity("admin"))
    p = next(q for q in engine.ctx.roster.residents if q.role == "resident" and q.story)
    mine = client.get("/api/portal/snapshot", headers=identity("resident", p.id)).json()["incident"]
    assert mine["active"] and mine["people"] == [] and mine["equipment"] == [] and mine["tasks"] == []
    # RAs are staff the Contact Corner names on purpose; every other resident must not appear.
    others = [q.name.split()[0] for q in engine.ctx.roster.residents
              if q.role == "resident" and q.id != p.id and q.name.split()[0] != p.name.split()[0]
              and q.name.split()[0] not in engine.ctx.spec.name]
    words = set(json.dumps(client.get("/api/portal/snapshot", headers=identity("resident", p.id)).json()).replace('"', " ").replace(",", " ").split())
    assert not words & set(others), words & set(others)                   # never another resident's name, anywhere
    level, ra = next((lv, r) for lv, r in engine.ctx.ras.items() if any(x.level == lv for x in engine.state.forecast.impact.residents))
    floor = client.get("/api/portal/snapshot", headers=identity("ra", ra)).json()["incident"]
    assert floor["people"] and all(x["level"] == level for x in floor["people"])
    assert all("needs" not in x for x in floor["people"])                # situation, not medical detail
    fix = client.get("/api/portal/snapshot", headers=identity("maintenance")).json()["incident"]
    assert fix["people"] == [] and fix["tasks"]


def test_maintenance_claims_from_the_queue(env):
    client, engine = env
    p = resident(engine)
    t = raise_request(client, p)
    queue = client.get("/api/portal/snapshot", headers=identity("maintenance")).json()["requests"]
    assert [r["id"] for r in queue] == [t["id"]]
    r = client.post(f"/api/portal/requests/{t['id']}", headers=identity("maintenance"), json={"action": "claim", "expected_version": t["version"]})
    assert r.status_code == 200 and r.json()["assigned_to"] == "demo:maintenance"
    again = client.post(f"/api/portal/requests/{t['id']}", headers=identity("maintenance"), json={"action": "claim", "expected_version": r.json()["version"]})
    assert again.status_code == 409


def test_responders_confirm_only_their_own_steps(env):
    client, engine = env
    client.post("/api/sensor", json={"sensor_id": engine.ctx.sensor_ids[0], "value": 0.9}, headers=identity("admin"))
    plan = engine.state.plan
    assert client.post("/api/plan/decision", headers=identity("admin"),
                       json={"plan_version": plan.version, "decision": "approve"}).status_code == 200
    fix = next(s for s in engine.state.approved_plan.steps if "facilities" in s.actor)
    ra_step = next(s for s in engine.state.approved_plan.steps if s.actor.startswith("ra_"))
    ra = ra_step.actor.split(",")[0]
    other = next(r for r in engine.ctx.ras.values() if r not in ra_step.actor)
    assert client.post(f"/api/portal/tasks/{ra_step.id}/done", headers=identity("ra", other)).status_code == 403
    assert client.post(f"/api/portal/tasks/{ra_step.id}/done", headers=identity("resident", ra)).status_code == 403
    assert client.post(f"/api/portal/tasks/{ra_step.id}/done", headers=identity("ra", ra)).status_code == 200
    assert engine.state.actions[ra_step.id].status == "done"
    assert client.post(f"/api/portal/tasks/{fix.id}/done", headers=identity("maintenance")).status_code == 200
    tasks = client.get("/api/portal/snapshot", headers=identity("maintenance")).json()["incident"]["tasks"]
    assert next(t for t in tasks if t["id"] == fix.id)["status"] == "done"


def test_ask_answers_from_the_viewers_own_projection(env, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    client, engine = env
    client.post("/api/sensor", json={"sensor_id": engine.ctx.sensor_ids[0], "value": 0.9}, headers=identity("admin"))
    ra = next(r for lv, r in engine.ctx.ras.items() if any(x.level == lv for x in engine.state.forecast.impact.residents))
    floor = {x.name for x in engine.state.forecast.impact.residents if x.level == engine.ctx.roster.by_id()[ra].level}
    said = client.post("/api/portal/ask", headers=identity("ra", ra), json={"text": "Who needs a check-in?"}).json()
    assert said["source"] == "rules" and any(n in said["text"] for n in floor)
    p = resident(engine)
    mine = client.post("/api/portal/ask", headers=identity("resident", p.id), json={"text": "Who needs a check-in?"}).json()["text"]
    assert not any(n in mine for n in floor if n != p.name)


def test_only_the_building_spec_is_public(env, monkeypatch):
    client, engine = env
    monkeypatch.setenv("CLERK_SECRET_KEY", "test-key")
    assert client.get("/api/building").status_code == 200
    spec = json.dumps(client.get("/api/building").json())
    assert not any(p.name in spec for p in engine.ctx.roster.residents if p.role == "resident")
    for path in ("/api/state", "/api/people", "/api/sponsors", "/api/runs"):
        assert client.get(path).status_code == 401, path
