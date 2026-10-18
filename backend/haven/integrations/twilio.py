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


def vendors() -> list[str]:
    """The on-call list, first to last: HAVEN_PLUMBER_NUMBER, then HAVEN_PLUMBER_NUMBER_2, _3."""
    out = [os.environ.get(k, "") for k in ("HAVEN_PLUMBER_NUMBER", "HAVEN_PLUMBER_NUMBER_2", "HAVEN_PLUMBER_NUMBER_3")]
    return [v for v in out if v]


def public_url() -> str | None:
    """Where Twilio can reach this backend for the answer webhook (a tunnel or the deployed URL)."""
    return (os.environ.get("HAVEN_PUBLIC_URL") or "").rstrip("/") or None


def gather_twiml(text: str, action: str, lang: str = "en") -> str:
    """Speak the script, then listen for a yes or no (speech or keypad) and post it to `action`."""
    voice_lang = {"en": "en-US", "es": "es-MX", "zh": "zh-CN"}.get(lang, "en-US")
    return (f'<Response><Say language="{voice_lang}">{escape(text)}</Say>'
            f'<Gather input="speech dtmf" numDigits="1" timeout="6" speechTimeout="auto" action="{escape(action)}" method="POST">'
            f'<Say language="{voice_lang}">Can you take this job? Say yes or no, or press 1 for yes, 2 for no.</Say></Gather>'
            f'<Redirect method="POST">{escape(action)}?timeout=1</Redirect></Response>')


def parse_answer(speech: str | None, digits: str | None) -> str:
    """yes | no | unknown from what Twilio heard."""
    d = (digits or "").strip()
    if d == "1":
        return "yes"
    if d == "2":
        return "no"
    s = (speech or "").strip().lower()
    if not s:
        return "unknown"
    if any(w in s for w in ("yes", "yeah", "yep", "sure", "on my way", "can do", "okay", "ok")):
        return "yes"
    if any(w in s for w in ("no", "can't", "cannot", "not tonight", "busy", "unavailable")):
        return "no"
    return "unknown"


def demo_sms_number() -> str | None:
    return os.environ.get("HAVEN_SMS_TO") or None


async def call(to: str, text: str, lang: str = "en", answer_url: str | None = None) -> str | None:
    """Place a call that speaks `text`. With `answer_url` the call also asks for a yes or no and posts
    the answer there; without it the script is just spoken twice. Returns the call SID, or None."""
    creds = _creds()
    if creds is None:
        return None
    sid, token, sender = creds
    voice_lang = {"en": "en-US", "es": "es-MX", "zh": "zh-CN"}.get(lang, "en-US")
    if answer_url:
        twiml = gather_twiml(text, answer_url, lang)
    else:
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
