"""What HAVEN does in the world outside the building when an approved step comes due.

The executor (WorldEngine.due_actions) decides *when* a step runs and logs the result as an
ActionEvent; this module performs the step's outward side effect and returns the one line of
detail that goes into that event: the call SID, the ticket id, or "simulated" when no provider
is configured. Idempotent per step id within a process, so a tick that runs late never dials
twice. Every provider is optional; the demo runs with none of them.
"""

from __future__ import annotations

import logging

from ..agents.models import Plan, PlanStep
from . import linear, twilio

log = logging.getLogger("haven.actions")

_done: set[tuple[str, str]] = set()      # (run id, step id) already performed


def providers() -> dict[str, bool]:
    return {"twilio": twilio.configured(), "linear": linear.configured()}


def _message_for(plan: Plan, to: str) -> str | None:
    return next((m.text for m in plan.messages if m.to == to), None)


def _first_critical(plan: Plan):
    """The first critical resident message (the plan lists the named people first)."""
    return next((m for m in plan.messages if m.priority == "critical" and m.role == "resident"), None)


async def perform(run_id: str, step: PlanStep, plan: Plan, default_detail: str, building: str = "HAVEN") -> str:
    """Run the outward effect of a step once and describe what happened."""
    key = (run_id, step.id)
    if key in _done:
        return default_detail
    _done.add(key)
    try:
        if step.kind == "call":
            text = _message_for(plan, "plumber") or step.title
            to = twilio.plumber_number()
            if twilio.configured() and to:
                base = twilio.public_url()
                answer = f"{base}/api/twilio/answer/{step.id}?vendor=0" if base else None
                sid = await twilio.call(to, text, answer_url=answer)
                if sid:
                    return (f"plumber called via Twilio ({sid}); waiting for a yes or no, next vendor on no" if answer
                            else f"plumber called via Twilio ({sid}), ETA ~20 min (set HAVEN_PUBLIC_URL to hear the answer)")
                return "plumber call failed (Twilio error); next vendor on the list, ETA ~20 min"
            return "plumber dispatched, ETA ~20 min (call simulated: set TWILIO_* and HAVEN_PLUMBER_NUMBER to dial)"
        if step.kind == "ticket":
            body = _message_for(plan, "dean") or step.reason
            if linear.configured():
                issue = await linear.create_issue(f"{building}: {step.title}",
                                                  f"{plan.headline}\n\n{body}\n\nOpened by HAVEN on approval of plan v{plan.version}.")
                if issue:
                    return f"ticket {issue['identifier']} opened in Linear ({issue['url']})"
                return "ticket failed (Linear error); logged locally"
            return "ticket opened (simulated: set LINEAR_API_KEY and LINEAR_TEAM_ID to file it in Linear)"
        if step.kind == "notify" and step.id == "notify_each":
            to = twilio.demo_sms_number()
            if twilio.configured() and to:
                m = _first_critical(plan)
                if m is not None:
                    sid = await twilio.sms(to, m.text)
                    if sid:
                        return f"{default_detail}; {m.name.split()[0]}'s message also texted to the demo phone via Twilio ({sid})"
            return f"{default_detail} (on screen; set TWILIO_* and HAVEN_SMS_TO to text one for real)"
    except Exception:  # noqa: BLE001 - a provider must never stall the world loop
        log.exception("action %s failed", step.id)
    return default_detail
