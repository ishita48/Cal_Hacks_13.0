"""ElevenLabs: HAVEN's voice, first in line.

Two capabilities, both key-gated by ELEVENLABS_API_KEY and both optional:
  1. Text-to-speech for every spoken line (Buds, the plumber script, the manager brief): the flash
     model for conversational latency, multilingual so the es / zh messages are voiced too.
  2. Conversational AI: with ELEVENLABS_AGENT_ID set, the browser can open a live, interruptible
     voice agent grounded in the current world (we mint a signed URL server-side for private agents
     and hand over dynamic variables; the key never reaches the client).

Order of voices for /api/speak: ElevenLabs -> Cartesia -> 503 (the browser then uses its own
synthesis). Audio is a rendering of a message the plan already contains; it never changes state.
"""

from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger("haven.elevenlabs")

API = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"          # "Rachel": warm, clear; free-tier accounts can use it
DEFAULT_MODEL = "eleven_flash_v2_5"              # ~75 ms model latency, 32 languages


def _key() -> str | None:
    k = (os.environ.get("ELEVENLABS_API_KEY") or "").strip()
    return k or None


def configured() -> bool:
    return _key() is not None


def voice_id() -> str:
    return (os.environ.get("ELEVENLABS_VOICE_ID") or "").strip() or DEFAULT_VOICE


def model_id() -> str:
    return (os.environ.get("ELEVENLABS_MODEL") or "").strip() or DEFAULT_MODEL


def agent_id() -> str | None:
    return (os.environ.get("ELEVENLABS_AGENT_ID") or "").strip() or None


def agent_configured() -> bool:
    return agent_id() is not None


async def speak(text: str, lang: str = "en") -> bytes | None:
    """MP3 bytes for `text`, or None when not configured / the request fails."""
    key = _key()
    if not key or not text.strip():
        return None
    body = {
        "text": text[:4000],
        "model_id": model_id(),
        "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.2, "use_speaker_boost": True},
    }
    if lang and lang != "en":
        body["language_code"] = lang           # flash v2.5 / multilingual honour this; others ignore it
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            r = await client.post(f"{API}/text-to-speech/{voice_id()}?output_format=mp3_44100_128",
                                  json=body, headers={"xi-api-key": key, "Accept": "audio/mpeg"})
        if r.status_code != 200:
            log.warning("elevenlabs tts %s: %s", r.status_code, r.text[:200])
            return None
        return r.content
    except httpx.HTTPError:
        log.exception("elevenlabs tts failed")
        return None


async def voice_name() -> str | None:
    """The configured voice's name: the proof the key is live (used by the sponsor check)."""
    key = _key()
    if not key:
        return None
    async with httpx.AsyncClient(timeout=6.0) as client:
        r = await client.get(f"{API}/voices/{voice_id()}", headers={"xi-api-key": key})
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    return r.json().get("name") or voice_id()


async def agent_signed_url() -> str | None:
    """A short-lived signed WebSocket URL for a private Conversational AI agent (None = connect publicly)."""
    key, aid = _key(), agent_id()
    if not key or not aid:
        return None
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(f"{API}/convai/conversation/get-signed-url", params={"agent_id": aid},
                                 headers={"xi-api-key": key})
        if r.status_code != 200:
            return None
        return r.json().get("signed_url")
    except httpx.HTTPError:
        return None
