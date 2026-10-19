"""Who the agents are: ids, labels, kinds and one-line descriptions, derived from the roster.

The specialists are fixed roles of the system (they exist for any building); every other agent is a
resident's personal agent, named and described from that resident's roster entry. Nothing here names
a person or a place: swap the roster and the same code labels a different society.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..world.context import WorldContext

RESIDENT_PREFIX = "resident:"

# Role agents: label, kind, what the role argues for (not building facts: the job description).
SPECIALISTS: dict[str, tuple[str, str, str]] = {
    "safety": ("Safety agent", "specialist",
               "Hard veto. The switchgear must be dead before water touches it, nobody enters the basement, "
               "and no lift moves after the cut."),
    "housing": ("Housing agent", "specialist",
                "Who lives on the floors that go dark, who is asleep or away, and where everyone sleeps tonight, "
                "nearest first."),
    "capacity": ("Capacity agent", "specialist",
                 "No space takes more people than it holds."),
    "redteam": ("Red team", "redteam",
                "Attacks every plan: a faster leak, double-booked staff, a crowded stair, a late valve, people "
                "the plan forgot. Always on."),
    "checker": ("Checker agent", "checker",
                "Verifies the final plan against the facts, whoever spoke. Always on."),
}

NEED_PHRASE = {
    "step_free_route": "wheelchair user",
    "stairs_slow": "limited mobility",
    "visual_alerts": "Deaf",
    "guide_dog": "blind, with a guide dog",
    "refrigerated_medication": "refrigerated medication",
    "medical_device_power": "powered medical device",
}


def resident_id(agent: str) -> str | None:
    return agent[len(RESIDENT_PREFIX):] if agent.startswith(RESIDENT_PREFIX) else None


def agent_kind(agent: str) -> str:
    if resident_id(agent) is not None:
        return "resident"
    return SPECIALISTS.get(agent, ("", "specialist", ""))[1]


def agent_label(ctx: WorldContext, agent: str) -> str:
    rid = resident_id(agent)
    if rid is not None:
        r = ctx.roster.by_id().get(rid)
        return f"{r.name.split()[0]}'s agent" if r else agent
    return SPECIALISTS.get(agent, (agent, "", ""))[0]


def agent_info(ctx: WorldContext, agent: str, enabled: bool) -> dict[str, Any]:
    """Everything a screen needs to introduce an agent, read from the roster for residents."""
    rid = resident_id(agent)
    if rid is None:
        label, kind, description = SPECIALISTS.get(agent, (agent, "specialist", ""))
        return {"id": agent, "label": label, "kind": kind, "description": description, "enabled": enabled,
                "resident": None, "name": None, "level": None, "needs": [], "named": False,
                "fixed": kind in ("checker", "redteam")}
    r = ctx.roster.by_id().get(rid)
    if r is None:
        return {"id": agent, "label": agent, "kind": "resident", "description": "", "enabled": enabled,
                "resident": rid, "name": None, "level": None, "needs": [], "named": False, "fixed": False}
    needs = [NEED_PHRASE.get(n, n) for n in r.needs]
    where = f"{ctx.spec.space(r.room).name}, {ctx.spec.level(r.level).name.lower()}"
    description = r.story or (f"{', '.join(needs)}; {where}." if needs else f"{where}.")
    return {"id": agent, "label": agent_label(ctx, agent), "kind": "resident", "description": description,
            "enabled": enabled, "resident": rid, "name": r.name, "level": r.level, "needs": list(r.needs),
            "named": rid in ctx.story_order, "fixed": False, "role": r.role}
