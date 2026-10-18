"""Governance by voice: a sentence from the manager becomes a constraint code.

Deterministic patterns first (they cover the demo and are instant); anything they do not
match can be handed to the LLM parser (haven/agents/llm.py), which must return one of the
same codes. The planner only ever sees codes, never prose.
"""

import re
from dataclasses import dataclass

CODES: dict[str, str] = {
    "no_off_campus": "Nobody is moved off campus",
    "no_wake": "Nobody who is asleep is woken; they shelter in place",
    "shelter_in_place": "Nobody is relocated except for a hard medical or access need",
    "no_moves_after": "No relocation after a given time of night",
    "lifts_first": "Wheelchair users are brought down before anything else",
}


@dataclass(frozen=True)
class ParsedRule:
    code: str
    text: str
    summary: str
    confident: bool


_TIME = r"(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?"


def parse_rule(text: str) -> ParsedRule:
    t = " ".join(text.lower().strip().split())
    neg = r"(no|nobody|no one|noone|don't|dont|do not|never|not)"

    if re.search(r"off[- ]?campus|hotel|motel", t) and re.search(neg, t):
        return ParsedRule("no_off_campus", text, CODES["no_off_campus"], True)
    if re.search(r"off[- ]?campus|hotel", t) and re.search(r"keep|stay|on campus", t):
        return ParsedRule("no_off_campus", text, CODES["no_off_campus"], True)

    if re.search(r"(after|past)\s+midnight", t) and re.search(r"move|moves|moved|relocat|leave", t):
        return ParsedRule("no_moves_after:00:00", text, "No relocation after 00:00", True)
    m = re.search(r"(?:after|past|beyond)\s+" + _TIME, t)
    if m and re.search(r"move|moves|moved|relocat|leave", t):
        h = int(m.group(1))
        mi = int(m.group(2) or 0)
        ap = (m.group(3) or "").replace(".", "")
        if ap == "pm" and h < 12:
            h += 12
        if ap == "am" and h == 12:
            h = 0
        if not ap and h <= 6:          # "after 1" at night means 01:00
            pass
        code = f"no_moves_after:{h:02d}:{mi:02d}"
        return ParsedRule(code, text, f"No relocation after {h:02d}:{mi:02d}", True)

    if re.search(r"wake|waking|woken|sleep", t) and re.search(neg, t):
        return ParsedRule("no_wake", text, CODES["no_wake"], True)

    if re.search(r"(shelter|stay|remain)s?[- ]in[- ]place|stay (in|where they are|put)|nobody (moves|leaves)|no one (moves|leaves)", t):
        return ParsedRule("shelter_in_place", text, CODES["shelter_in_place"], True)

    if re.search(r"wheelchair|maya|lift|elevator", t) and re.search(r"first|before|priority", t):
        return ParsedRule("lifts_first", text, CODES["lifts_first"], True)

    return ParsedRule("unparsed", text, "Not understood; not enforced", False)


def describe(code: str) -> str:
    if code.startswith("no_moves_after:"):
        return f"No relocation after {code.split(':', 1)[1]}"
    return CODES.get(code, code)
