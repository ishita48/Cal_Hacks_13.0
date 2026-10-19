"""The LLM layer: parse, paraphrase, explain. Never decide.

Every function here is optional and key-gated: with no Anthropic credentials it returns None
and the deterministic path carries on. Nothing the model returns enters the WorldState
except through the same input events a human would send (a parsed rule becomes a
ManagerRule event with a code the planner already understands).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from .rules import CODES, ParsedRule, describe

log = logging.getLogger("haven.llm")

MODEL = os.environ.get("HAVEN_LLM_MODEL", "claude-opus-5-5")

_RULE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "code": {"type": "string", "enum": [*CODES.keys(), "unparsed"]},
        "time": {"type": "string", "description": "HH:MM, only for no_moves_after; empty otherwise"},
        "confident": {"type": "boolean"},
    },
    "required": ["code", "time", "confident"],
    "additionalProperties": False,
}

_RULE_SYSTEM = (
    "You turn a building manager's spoken instruction during a dorm emergency into exactly one constraint code. "
    "Codes: " + "; ".join(f"{k} = {v}" for k, v in CODES.items()) + ". "
    "Use no_moves_after with a 24h HH:MM time when the instruction forbids relocation after a time of night. "
    "If the instruction matches none of the codes, return code 'unparsed' with confident=false. Never invent codes."
)


_CLIENT: tuple[str, object] | None = None


def _client():
    """One client for the process (one connection pool, one TLS context); a new one only if the key changes."""
    global _CLIENT
    key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN") or ""
    if not key:
        return None
    if _CLIENT is not None and _CLIENT[0] == key:
        return _CLIENT[1]
    try:
        import anthropic
    except ImportError:  # pragma: no cover
        return None
    _CLIENT = (key, anthropic.AsyncAnthropic(max_retries=2, timeout=25.0))
    return _CLIENT[1]


async def parse_rule_llm(text: str) -> ParsedRule | None:
    """Map free text to a rule code when the regex parser was not confident."""
    client = _client()
    if client is None:
        return None
    try:
        response = await client.beta.messages.create(
            model=MODEL,
            max_tokens=256,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=_RULE_SYSTEM,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _RULE_SCHEMA}},
            messages=[{"role": "user", "content": text}],
        )
    except Exception:  # the demo must not depend on the network
        log.exception("rule parse failed")
        return None
    if response.stop_reason == "refusal":
        return None
    raw = next((b.text for b in response.content if b.type == "text"), "")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    code = data.get("code", "unparsed")
    if code == "no_moves_after" and data.get("time"):
        code = f"no_moves_after:{data['time']}"
    confident = bool(data.get("confident")) and code != "unparsed"
    return ParsedRule(code=code, text=text, summary=describe(code) if confident else "Not understood; not enforced",
                      confident=confident)


async def narrate(plan_summary: str, audience: str = "the on-call manager") -> str | None:
    """A two-sentence spoken version of the plan for a voice alert. Optional polish only."""
    client = _client()
    if client is None:
        return None
    try:
        response = await client.beta.messages.create(
            model=MODEL,
            max_tokens=300,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=f"Rewrite the plan below as two short spoken sentences for {audience}. Keep every number. "
                   "No preamble, no bullet points.",
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": plan_summary}],
        )
    except Exception:
        log.exception("narration failed")
        return None
    if response.stop_reason == "refusal":
        return None
    return next((b.text for b in response.content if b.type == "text"), None)


async def explain_stance(agent_label: str, stance: str, reason: str, rule: str | None, story: str | None,
                         headline: str) -> str | None:
    """One or two first-person sentences from an agent about its stance. Paraphrase only: the stance,
    the reason and the rule are given; the model may not add facts or change the position."""
    client = _client()
    if client is None:
        return None
    facts = (f"Agent: {agent_label}. Stance: {stance}. Reason: {reason}. "
             f"Hard rule: {rule or 'none'}. Who they speak for: {story or 'n/a'}. Plan headline: {headline}")
    try:
        response = await client.beta.messages.create(
            model=MODEL,
            max_tokens=200,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system="You voice one agent in a building-emergency negotiation. Write one or two short first-person "
                   "sentences explaining the agent's stance to the on-call manager. Use only the facts given; keep "
                   "every number; do not change the stance; no preamble.",
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": facts}],
        )
    except Exception:
        log.exception("explain failed")
        return None
    if response.stop_reason == "refusal":
        return None
    return next((b.text for b in response.content if b.type == "text"), None)


def template_explanation(agent_label: str, stance: str, reason: str, rule: str | None, story: str | None) -> str:
    """The no-key version: the same content, first person, deterministic."""
    who = f" I speak for someone who {story[0].lower() + story[1:]}" if story else ""
    opener = {"veto": "I cannot accept this plan.", "critique": "I can live with this plan, with one change.",
              "support": "I support this plan.", "propose": "Here is what I propose."}.get(stance, "")
    tail = f" My hard rule: {rule}." if rule else ""
    return f"{opener} {reason}{tail}{who}".strip()
