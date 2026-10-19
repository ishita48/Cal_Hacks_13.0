"""The red team: an agent whose only job is to break the plan.

The checker verifies that the plan satisfies the constraints the facts imply. The red team goes
further and attacks the plan: a faster leak than forecast, two escorts booked on the same two desk
staff at the same minute, a stairwell asked to carry more people than it can, a valve that arrives
too late to matter, people the plan forgot to place. Every attack is deterministic, runs on every
plan version, and cannot be switched off. Where an attack lands, the planner applies the fix the
attack names (so the attack visibly changes the plan) and the attack is reported as "fixed".
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

from pydantic import BaseModel

from .models import PlanStep

if TYPE_CHECKING:
    from ..world.context import WorldContext
    from .planner import Situation

STRESS_FLOW = 1.3                 # the leak is 30 % worse than the forecast says
STAIR_FLOW_PER_MIN = 40.0         # people a 1.2 m egress stair passes per minute (NFPA ~0.5 m/s)
STAIR_CLEAR_LIMIT_MIN = 6.0       # a dark stairwell must clear in this long or it is a crush
HOLD_MARGIN_S = 60.0              # the lift hold must end this long before the stressed contact


class Attack(BaseModel):
    code: str
    label: str
    ok: bool                      # True = the plan survived (possibly after the fix)
    detail: str
    fixed: bool = False           # the attack landed and the planner applied the fix
    fix: str = ""                 # what the fix was (or would be)


@dataclass
class Verdict:
    attacks: list[Attack]
    steps: list[PlanStep]         # the plan after fixes
    eta_cut_s: float | None       # a tighter cut-off if the stress test demanded one


def _stair_for(ctx: WorldContext, room: str) -> str:
    """The nearest egress stair to a room, by plan distance (every level shares the stair footprints)."""
    sp = ctx.spec.space(room)
    stairs = [ctx.spec.space(sid) for sid in ctx.egress_stairs.get(sp.level, ())]
    if not stairs:
        return "stair"
    best = min(stairs, key=lambda s: math.hypot(s.rect.cx - sp.rect.cx, s.rect.cy - sp.rect.cy))
    return best.id.split("-", 1)[1]


def attack(ctx: WorldContext, sit: Situation, steps: list[PlanStep]) -> Verdict:
    out: list[Attack] = []
    steps = [s.model_copy(deep=True) for s in steps]
    by_id = ctx.roster.by_id()
    # The cut that matters is the one that stops the lifts (the plan's lift feeder); any isolate step otherwise.
    cut = next((s.at_s for s in steps if s.kind == "isolate" and s.target == sit.lift_feeder), None)
    if cut is None:
        cut = next((s.at_s for s in steps if s.kind == "isolate"), None)
    eta_cut_s = None

    # 1. A faster leak than forecast: does the lift hold still end before the water reaches the switchgear?
    if sit.lifts_up and sit.eta_lifts_s is not None and cut is not None and cut > 0:
        stressed_contact = sit.eta_lifts_s / STRESS_FLOW
        latest = stressed_contact - HOLD_MARGIN_S
        if cut > latest + 1e-6:
            eta_cut_s = max(0.0, latest)
            out.append(Attack(code="surge", label=f"A {int((STRESS_FLOW - 1) * 100)} % faster leak", ok=True, fixed=True,
                              detail=f"Contact would come at +{stressed_contact / 60:.1f} min; the hold ran to +{cut / 60:.1f}. "
                                     f"Cut-off pulled forward to +{latest / 60:.1f} min.",
                              fix="shorten the lift hold"))
        else:
            out.append(Attack(code="surge", label=f"A {int((STRESS_FLOW - 1) * 100)} % faster leak", ok=True,
                              detail=f"Contact would come at +{stressed_contact / 60:.1f} min; the hold ends at +{cut / 60:.1f} min, "
                                     f"{(latest - cut) / 60:.1f} min to spare."))
    elif cut is not None:
        out.append(Attack(code="surge", label="A faster leak", ok=True, detail="The switchgear is cut at once; the leak's speed cannot beat it."))

    # 2. Two escorts on the same two desk staff at the same minute.
    escorts = [s for s in steps if s.kind == "escort" and s.actor == "staff"]
    escorts.sort(key=lambda s: (s.at_s, s.order))

    def window(s: PlanStep) -> tuple[float, float]:
        return s.at_s, (s.deadline_s if s.deadline_s is not None else s.at_s + 240.0)

    def free(actor: str, lo: float, hi: float) -> bool:
        for other in steps:
            if other.kind == "escort" and actor in other.actor.split(","):
                a, b = window(other)
                if lo < b - 1e-6 and a < hi - 1e-6:
                    return False
        return True

    busy_until = None
    reassigned: list[str] = []
    unfixed: list[str] = []
    for s in escorts:
        lo, end = window(s)
        if busy_until is not None and lo < busy_until - 1e-6:
            r = by_id.get(s.people[0]) if s.people else None
            # The person's own RA first, then the RAs of the dark floors, then any RA in the building.
            levels = ([r.level] if r else []) + list(sit.dark_planned) + [lv for lv in ctx.level_order if ctx.is_upstairs(lv)]
            candidates = [rid for lv in levels for rid in [ctx.ra_for(lv)] if rid]
            ra = next((c for c in dict.fromkeys(candidates) if c in by_id and free(c, lo, end)), None)
            if ra:
                who = f"RA {by_id[ra].name.split()[0]} ({ctx.spec.level(by_id[ra].level).name.lower()})"
                s.actor = ra
                s.title = s.title.replace("Two staff", who).replace("Staff", who)
                reassigned.append(f"{s.id} → {ra}")
                continue
            unfixed.append(s.id)
        busy_until = max(busy_until or 0.0, end)
    if unfixed:
        out.append(Attack(code="double_booked", label="The same two staff on two escorts at once", ok=False,
                          detail="Desk staff are booked on overlapping escorts and no RA is free: " + ", ".join(unfixed) + ".",
                          fix="hand the second escort to a free RA"))
    elif reassigned:
        out.append(Attack(code="double_booked", label="The same two staff on two escorts at once", ok=True, fixed=True,
                          detail="Desk staff were booked on overlapping escorts. " + "; ".join(reassigned) + ".",
                          fix="hand the second escort to the floor's RA"))
    elif escorts:
        out.append(Attack(code="double_booked", label="The same two staff on two escorts at once", ok=True,
                          detail="Escorts on the desk staff do not overlap."))

    # 3. Stairwell load: everyone on the dark floors leaving at the cut-off, split across the nearest stairs.
    movers = [r for r in sit.movers if r.id not in sit.moved]
    if movers:
        load: dict[str, int] = {}
        for r in movers:
            load[_stair_for(ctx, r.room)] = load.get(_stair_for(ctx, r.room), 0) + 1
        worst, n = max(load.items(), key=lambda kv: kv[1])
        clear_min = n / STAIR_FLOW_PER_MIN
        if clear_min > STAIR_CLEAR_LIMIT_MIN:
            waves = math.ceil(clear_min / STAIR_CLEAR_LIMIT_MIN)
            for s in steps:
                if s.kind == "relocate" and s.id.startswith("relocate_"):
                    s.title = f"{s.title} (in {waves} waves, {STAIR_CLEAR_LIMIT_MIN:.0f} min apart)"
            out.append(Attack(code="stair_load", label=f"{worst} stair overloaded", ok=True, fixed=True,
                              detail=f"{n} people on the {worst} stair would take {clear_min:.1f} min to clear in the dark.",
                              fix=f"relocate in {waves} waves"))
        else:
            out.append(Attack(code="stair_load", label="Stairwell load at the cut-off", ok=True,
                              detail=f"Worst stair ({worst}): {n} people, clears in {clear_min:.1f} min of {STAIR_CLEAR_LIMIT_MIN:.0f}."))

    # 4. The plumber: can the valve save the switchgear at all?
    if sit.valve_closed_at_s is not None and sit.eta_lifts_s is not None:
        late = sit.valve_closed_at_s > sit.eta_lifts_s
        relies = cut is None and late
        out.append(Attack(code="plumber_late", label="The valve arrives too late", ok=not relies,
                          detail=(f"Valve closes at +{sit.valve_closed_at_s / 60:.0f} min, water reaches the switchgear at "
                                  f"+{sit.eta_lifts_s / 60:.1f} min: the valve cannot save section B. "
                                  + ("The plan cuts the power itself and does not rely on it." if cut is not None else "The plan relies on it.")
                                  if late else f"Valve closes at +{sit.valve_closed_at_s / 60:.0f} min, before contact.")))

    # 5. Anyone on a dark floor the plan does not place, shelter or escort.
    placed = {p for s in steps if s.kind in ("relocate", "shelter", "escort") for p in s.people}
    forgotten = [r for r in movers if r.id not in placed]
    out.append(Attack(code="forgotten", label="People the plan forgot", ok=not forgotten,
                      detail=(f"{len(forgotten)} on dark floors have no step: " + ", ".join(r.name for r in forgotten[:3])
                              + (" …" if len(forgotten) > 3 else "")) if forgotten else f"Every one of {len(movers)} people on a dark floor has a step."))

    return Verdict(attacks=out, steps=steps, eta_cut_s=eta_cut_s)
