"""Cartesia text-to-speech: the plumber call and the spoken manager alert.

Key-gated by CARTESIA_API_KEY. Without it, `speak` returns None and the UI falls back to the
browser's own speech synthesis. Audio is never part of the world state; it is a rendering of a
message the plan already contains.
"""

import logging
import os

import httpx

log = logging.getLogger("haven.cartesia")

CARTESIA_URL = "https://api.cartesia.ai/tts/bytes"
CARTESIA_VERSION = "2024-06-10"
DEFAULT_VOICE = os.environ.get("CARTESIA_VOICE_ID", "a0e99841-438c-4a64-b679-ae501e7d6091")  # a calm, clear voice
MODEL_ID = os.environ.get("CARTESIA_MODEL", "sonic-2")


def configured() -> bool:
    return bool(os.environ.get("CARTESIA_API_KEY"))


async def speak(text: str, lang: str = "en", voice_id: str | None = None) -> bytes | None:
    """Return MP3 bytes for `text`, or None when Cartesia is not configured or fails."""
    key = os.environ.get("CARTESIA_API_KEY")
    if not key:
        return None
    body = {
        "model_id": MODEL_ID,
        "transcript": text,
        "voice": {"mode": "id", "id": voice_id or DEFAULT_VOICE},
        "language": lang if lang in ("en", "es", "zh", "ko", "hi", "fr", "de", "ja", "pt") else "en",
        "output_format": {"container": "mp3", "bit_rate": 128000, "sample_rate": 44100},
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                CARTESIA_URL, json=body,
                headers={"X-API-Key": key, "Cartesia-Version": CARTESIA_VERSION, "Content-Type": "application/json"},
            )
        if r.status_code != 200:
            log.warning("cartesia %s: %s", r.status_code, r.text[:200])
            return None
        return r.content
    except httpx.HTTPError:
        log.exception("cartesia request failed")
        return None
