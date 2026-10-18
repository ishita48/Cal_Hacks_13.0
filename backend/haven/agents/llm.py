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


def _client():
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        return None
    try:
        import anthropic
    except ImportError:  # pragma: no cover
        return None
    return anthropic.AsyncAnthropic()


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
