"""Twilio: the outbound phone call to the plumber and a real text message, behind the human gate.

Key-gated by TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER. HAVEN_PLUMBER_NUMBER is
who the plumber call dials; HAVEN_SMS_TO is a demo phone that receives the critical resident
message (Maya's) so a judge can hold the proof. Without keys every call is simulated and says so
in the action detail. A call or text is a rendering of a message the plan already contains; the
world state only ever records that the step ran and what came back (an SID).
"""

from __future__ import annotations

import logging
import os
from xml.sax.saxutils import escape

import httpx

log = logging.getLogger("haven.twilio")


def _creds() -> tuple[str, str, str] | None:
    sid = os.environ.get("TWILIO_ACCOUNT_SID")
    token = os.environ.get("TWILIO_AUTH_TOKEN")
    sender = os.environ.get("TWILIO_FROM_NUMBER")
    return (sid, token, sender) if sid and token and sender else None


def configured() -> bool:
    return _creds() is not None


def plumber_number() -> str | None:
    return os.environ.get("HAVEN_PLUMBER_NUMBER") or None


def demo_sms_number() -> str | None:
    return os.environ.get("HAVEN_SMS_TO") or None


async def call(to: str, text: str, lang: str = "en") -> str | None:
    """Place a call that speaks `text`; returns the call SID or None when not configured / failed."""
    creds = _creds()
    if creds is None:
        return None
    sid, token, sender = creds
    voice_lang = {"en": "en-US", "es": "es-MX", "zh": "zh-CN"}.get(lang, "en-US")
    twiml = f'<Response><Say language="{voice_lang}">{escape(text)}</Say><Pause length="1"/><Say language="{voice_lang}">{escape(text)}</Say></Response>'
    try:
        async with httpx.AsyncClient(timeout=20.0, auth=(sid, token)) as client:
            r = await client.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json",
                                  data={"To": to, "From": sender, "Twiml": twiml})
        if r.status_code >= 300:
            log.warning("twilio call %s: %s", r.status_code, r.text[:200])
            return None
        return r.json().get("sid")
    except httpx.HTTPError:
        log.exception("twilio call failed")
        return None


async def sms(to: str, text: str) -> str | None:
    creds = _creds()
    if creds is None:
        return None
    sid, token, sender = creds
    try:
        async with httpx.AsyncClient(timeout=20.0, auth=(sid, token)) as client:
            r = await client.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                                  data={"To": to, "From": sender, "Body": text[:1500]})
        if r.status_code >= 300:
            log.warning("twilio sms %s: %s", r.status_code, r.text[:200])
            return None
        return r.json().get("sid")
    except httpx.HTTPError:
        log.exception("twilio sms failed")
        return None
