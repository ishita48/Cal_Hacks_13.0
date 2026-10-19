"""Resend: alerts and updates by email.

Key-gated by RESEND_API_KEY. RESEND_FROM is the sender (a verified domain in Resend); without one it is
Resend's shared test sender, which only delivers to the address that owns the Resend account. Without a key
nothing is sent and callers say so; the in-app inbox is the record either way, email is only a copy.
"""

from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger("haven.resend")

URL = "https://api.resend.com/emails"
TEST_SENDER = "HAVEN <onboarding@resend.dev>"


def configured() -> bool:
    return bool(os.environ.get("RESEND_API_KEY"))


def sender() -> str:
    return os.environ.get("RESEND_FROM") or TEST_SENDER


async def send(to: list[str], subject: str, text: str, html: str | None = None) -> dict | None:
    """Send one email; returns {"id"} or None when not configured / failed."""
    key = os.environ.get("RESEND_API_KEY")
    to = [a for a in to if a]
    if not key or not to:
        return None
    payload = {"from": sender(), "to": to, "subject": subject[:200], "text": text}
    if html:
        payload["html"] = html
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(URL, json=payload, headers={"Authorization": f"Bearer {key}"})
        if r.status_code >= 300:
            log.warning("resend %s: %s", r.status_code, r.text[:200])
            return None
        return {"id": r.json().get("id")}
    except (httpx.HTTPError, ValueError):
        log.exception("resend request failed")
        return None
