"""Proof that every sponsor is really wired in: a cheap, read-only round trip per service whose
answer only the live service could give (a voice name, a model list, a Postgres version, an
account name, a Linear viewer, an agent address). "live" means a request just succeeded, not
"the env var is set". Memoised for 30 s so the Live stack panel can be opened freely; ?fresh re-checks.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Awaitable, Callable

import httpx

from ..agents import llm
from . import cartesia, elevenlabs, linear, twilio

TIMEOUT_S = 5.0
TTL_S = 30.0

SPONSORS: list[dict[str, str]] = [
    {"id": "fetch", "name": "Fetch.ai", "role": "The residents' personal agents as uAgents; the Maya veto on the network", "color": "#5f5cff"},
    {"id": "anthropic", "name": "Claude", "role": "Parses spoken rules the regex misses; agents explain themselves; Buds' fallback", "color": "#d97706"},
    {"id": "elevenlabs", "name": "ElevenLabs", "role": "HAVEN's voice: Buds, the plumber script, the manager brief", "color": "#111827"},
    {"id": "cartesia", "name": "Cartesia", "role": "Second voice in line for spoken briefs", "color": "#0ea5e9"},
    {"id": "tiger", "name": "Tiger Data", "role": "Sensor readings time-series (hypertable)", "color": "#f97316"},
    {"id": "twilio", "name": "Twilio", "role": "The real plumber call and the demo text on approval", "color": "#f22f46"},
    {"id": "linear", "name": "Linear", "role": "The facilities ticket filed on approval", "color": "#5e6ad2"},
    {"id": "hardware", "name": "ESP32 sensor", "role": "The $4 water probe that starts everything", "color": "#30d158"},
]

Check = Callable[[], Awaitable[str]]


class NotConfigured(Exception):
    pass


def _env(k: str) -> str | None:
    v = (os.environ.get(k) or "").strip()
    return v or None


async def _get_json(url: str, headers: dict[str, str] | None = None, auth: tuple[str, str] | None = None) -> Any:
    async with httpx.AsyncClient(timeout=TIMEOUT_S, auth=auth) as client:
        r = await client.get(url, headers=headers)
    if r.status_code >= 300:
        raise RuntimeError(f"HTTP {r.status_code}")
    return r.json()


def checks(engine: Any, society: Any, tiger: Any) -> dict[str, Check]:
    async def fetch() -> str:
        st = society.status(engine.state) if society else {"configured": False}
        if not st.get("configured"):
            raise NotConfigured()
        if not st.get("running"):
            raise RuntimeError(st.get("error") or "bureau not running")
        n = len(st.get("agents", []))
        table = (st.get("table") or "")[:14]
        return f"{n} resident agents on {st.get('hosted')} · table {table}… · {st.get('agreeing', 0)}/{st.get('received', 0)} stances confirmed"

    async def anthropic() -> str:
        key = _env("ANTHROPIC_API_KEY") or _env("ANTHROPIC_AUTH_TOKEN")
        if not key:
            raise NotConfigured()
        data = await _get_json("https://api.anthropic.com/v1/models?limit=1",
                               headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
        first = (data.get("data") or [{}])[0].get("id", "?")
        return f"key verified · using {llm.MODEL} (account lists {first})"

    async def eleven() -> str:
        if not elevenlabs.configured():
            raise NotConfigured()
        name = await elevenlabs.voice_name()
        return f"voice “{name}” · {elevenlabs.model_id()}" + (" · live agent ready" if elevenlabs.agent_configured() else "")

    async def cart() -> str:
        key = _env("CARTESIA_API_KEY")
        if not key:
            raise NotConfigured()
        data = await _get_json("https://api.cartesia.ai/voices?limit=1",
                               headers={"X-API-Key": key, "Cartesia-Version": cartesia.CARTESIA_VERSION})
        n = len(data if isinstance(data, list) else data.get("data", []))
        return f"key verified · {cartesia.MODEL_ID}" + (f" · {n} voice listed" if n else "")

    async def tig() -> str:
        if not tiger or not tiger.url:
            raise NotConfigured()
        ver = await asyncio.to_thread(_tiger_version, tiger)
        return ver

    async def twil() -> str:
        if not twilio.configured():
            raise NotConfigured()
        sid, token = _env("TWILIO_ACCOUNT_SID"), _env("TWILIO_AUTH_TOKEN")
        data = await _get_json(f"https://api.twilio.com/2010-04-01/Accounts/{sid}.json", auth=(sid or "", token or ""))
        name = data.get("friendly_name", "account")
        who = []
        if twilio.plumber_number():
            who.append("plumber number set")
        if twilio.demo_sms_number():
            who.append("demo phone set")
        return f"account “{name}” · {data.get('status', '?')}" + (" · " + ", ".join(who) if who else "")

    async def lin() -> str:
        if not linear.configured():
            raise NotConfigured()
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            r = await client.post(linear.URL, json={"query": "{ viewer { name } }"},
                                  headers={"Authorization": _env("LINEAR_API_KEY") or "", "Content-Type": "application/json"})
        if r.status_code >= 300:
            raise RuntimeError(f"HTTP {r.status_code}")
        name = ((r.json().get("data") or {}).get("viewer") or {}).get("name", "?")
        return f"signed in as {name} · team {(_env('LINEAR_TEAM_ID') or '')[:8]}…"

    async def hardware() -> str:
        st = engine.state
        readings = [t for t in st.timeline if t.kind == "sensor_wet" or t.kind == "sensor_dry"]
        src = next((s for s in st.sensors.values() if s.source == "esp32"), None)
        if src is not None:
            return f"ESP32 reading received this run (value {src.value:.2f})" + (" · token required" if _env("HAVEN_SENSOR_TOKEN") else "")
        if _env("HAVEN_SENSOR_TOKEN"):
            raise RuntimeError("token set; no ESP32 reading yet this run")
        _ = readings
        raise NotConfigured()

    return {"fetch": fetch, "anthropic": anthropic, "elevenlabs": eleven, "cartesia": cart, "tiger": tig,
            "twilio": twil, "linear": lin, "hardware": hardware}


def _tiger_version(tiger: Any) -> str:
    import psycopg

    with psycopg.connect(tiger.url, connect_timeout=5) as conn:
        row = conn.execute("select version(), current_database()").fetchone()
    ver = (row[0] or "").split(",")[0].replace("PostgreSQL ", "PG ") if row else "?"
    return f"{ver} · db “{row[1]}”" if row else "connected"


class SponsorHealth:
    def __init__(self, engine: Any, society: Any, tiger: Any) -> None:
        self._checks = checks(engine, society, tiger)
        self._memo: tuple[float, dict[str, Any]] | None = None

    async def _run(self, sponsor: dict[str, str]) -> dict[str, Any]:
        t0 = time.perf_counter()
        try:
            proof = await asyncio.wait_for(self._checks[sponsor["id"]](), timeout=TIMEOUT_S + 1)
            state = "live"
        except NotConfigured:
            proof, state = "not configured", "off"
        except asyncio.TimeoutError:
            proof, state = "timed out", "error"
        except Exception as exc:  # noqa: BLE001
            proof, state = str(exc)[:140] or exc.__class__.__name__, "error"
        ms = round((time.perf_counter() - t0) * 1000)
        return {**sponsor, "state": state, "latency_ms": ms if state in ("live", "error") else None, "proof": proof}

    async def report(self, fresh: bool = False) -> dict[str, Any]:
        now = time.time()
        if not fresh and self._memo and now - self._memo[0] < TTL_S:
            return self._memo[1]
        rows = await asyncio.gather(*(self._run(s) for s in SPONSORS))
        out = {"checked_at": now, "live": sum(1 for r in rows if r["state"] == "live"), "sponsors": list(rows)}
        self._memo = (now, out)
        return out
