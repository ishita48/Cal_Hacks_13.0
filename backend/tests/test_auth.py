"""Roles are the server's call: Clerk tokens are verified, the role comes from the user's metadata, and the
demo (no Clerk key) stays open with a declared role. Resend is key-gated like every other integration."""

import asyncio
import json
import time

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from haven.api import auth
from haven.api.app import create_app
from haven.integrations import resend
from haven.world.store import EventStore


def _client():
    return TestClient(create_app(store=EventStore(), run_loop=False))


def test_demo_mode_is_open_and_says_so(monkeypatch):
    monkeypatch.delenv("CLERK_SECRET_KEY", raising=False)
    with _client() as client:
        me = client.get("/api/me").json()
        assert me["role"] == "admin" and me["source"] == "demo"
        assert set(me["roles"]) == {"resident", "ra", "maintenance", "admin"}
        assert client.get("/api/me", headers={"X-Haven-Role": "maintenance"}).json()["role"] == "maintenance"
        assert client.get("/api/me", headers={"X-Haven-Role": "superuser"}).json()["role"] == "resident"
        flags = client.get("/api/integrations").json()
        assert flags["clerk"] is False


def test_an_ra_is_linked_to_their_floors(monkeypatch):
    monkeypatch.delenv("CLERK_SECRET_KEY", raising=False)
    with _client() as client:
        app_ctx = client.app.state.engine.ctx
        level, ra = next(iter(app_ctx.ras.items()))
        me = client.get("/api/me", headers={"X-Haven-Role": "ra", "X-Haven-Person": ra}).json()
        assert me["person"]["id"] == ra and level in me["levels"]


def _signed(key, kid, **claims):
    return jwt.encode({"exp": int(time.time()) + 60, **claims}, key, algorithm="RS256", headers={"kid": kid})


def test_clerk_tokens_are_verified_and_the_role_comes_from_metadata(monkeypatch):
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_x")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk["kid"] = "k1"
    clerk = auth.Clerk()

    async def jwks():
        return {"keys": [jwk]}

    async def user(uid):
        return {"public_metadata": {"role": "maintenance"} if uid == "user_m" else {},
                "first_name": "Luis", "primary_email_address_id": "e1",
                "email_addresses": [{"id": "e1", "email_address": "luis@example.edu"}]}

    monkeypatch.setattr(clerk, "jwks", jwks)
    monkeypatch.setattr(clerk, "user", user)
    monkeypatch.setattr(auth, "clerk", clerk)
    with _client() as client:
        assert client.get("/api/me").status_code == 401
        assert client.get("/api/me", headers={"X-Haven-Role": "admin"}).status_code == 401   # no header bypass
        good = {"Authorization": f"Bearer {_signed(key, 'k1', sub='user_m')}"}
        me = client.get("/api/me", headers=good).json()
        assert me["role"] == "maintenance" and me["source"] == "clerk" and me["email"] == "luis@example.edu"
        none = {"Authorization": f"Bearer {_signed(key, 'k1', sub='user_r')}"}
        assert client.get("/api/me", headers=none).json()["role"] == "resident"    # no role: least privilege
        assert client.post("/api/notify/test", json={}, headers=good).status_code == 403
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        forged = {"Authorization": f"Bearer {_signed(other, 'k1', sub='user_m')}"}
        assert client.get("/api/me", headers=forged).status_code == 401
        expired = {"Authorization": f"Bearer {_signed(key, 'k1', sub='user_m', exp=int(time.time()) - 600)}"}
        assert client.get("/api/me", headers=expired).status_code == 401


def test_resend_is_key_gated(monkeypatch):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("CLERK_SECRET_KEY", raising=False)
    assert not resend.configured() and asyncio.run(resend.send(["a@b.c"], "s", "t")) is None
    with _client() as client:
        assert client.get("/api/integrations").json()["resend"] is False
        assert client.post("/api/notify/test", json={"to": "a@b.c"}).status_code == 503
        assert client.post("/api/notify/test", json={"to": "a@b.c"}, headers={"X-Haven-Role": "resident"}).status_code == 403


def test_an_admin_may_preview_a_role_read_only_and_nobody_else_can(monkeypatch):
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_x")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk["kid"] = "k1"
    clerk = auth.Clerk()

    async def jwks():
        return {"keys": [jwk]}

    async def user(uid):
        return {"public_metadata": {"role": "admin" if uid == "user_a" else "maintenance"}, "first_name": "Ana",
                "primary_email_address_id": "e1", "email_addresses": [{"id": "e1", "email_address": "ana@example.edu"}]}

    monkeypatch.setattr(clerk, "jwks", jwks)
    monkeypatch.setattr(clerk, "user", user)
    monkeypatch.setattr(auth, "clerk", clerk)
    with _client() as client:
        hero = client.app.state.engine.ctx.story_order[0]
        admin = {"Authorization": f"Bearer {_signed(key, 'k1', sub='user_a')}"}
        as_hero = {**admin, "X-Haven-Role": "resident", "X-Haven-Person": hero}
        snap = client.get("/api/portal/snapshot", headers=as_hero).json()
        assert snap["viewer"]["role"] == "resident" and snap["viewer"]["person_id"] == hero
        assert client.post("/api/portal/requests", json={"title": "Leaky tap"}, headers=as_hero).status_code == 403
        assert client.post("/api/portal/ask", json={"text": "who is my RA?"}, headers=as_hero).status_code == 200
        assert client.get("/api/portal/snapshot", headers=admin).json()["viewer"]["role"] == "admin"
        # Only an admin's headers mean anything: maintenance stays maintenance.
        staff = {"Authorization": f"Bearer {_signed(key, 'k1', sub='user_m')}", "X-Haven-Role": "resident", "X-Haven-Person": hero}
        assert client.get("/api/portal/snapshot", headers=staff).json()["viewer"]["role"] == "maintenance"
