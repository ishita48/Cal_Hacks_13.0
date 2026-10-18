"""Deterministic negotiation: specialist agents and one personal agent per resident argue over a
plan under hard constraints, and the plan is a pure function of the world state.

Round 1 is the naive proposal (Safety: cut the switchgear now; Housing: move everyone on the
affected floors to the next building). Every enabled agent evaluates it. Round 2 folds in every
enabled agent's objection: hold power for escorts, move the insulin, split people by capacity,
leave the night-shift worker alone, and so on. Whoever is switched off does not speak, and a
person nobody spoke for shows up in `left_behind`. That is the Maya moment.

No LLM here: an LLM may later paraphrase these stances, never decide them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from ..people.roster import Resident
from ..world.physics import Hydraulics, step
from .models import Constraint, Plan, PlanStep, Round, Stance

if TYPE_CHECKING:
    from ..world.context import WorldContext
    from ..world.state import WorldState

SAFETY_MARGIN_S = 120.0          # switchgear must be dead this long before water touches it
PLUMBER_ETA_S = 20 * 60.0        # on-call plumber travel time at midnight
STAFF_RESPONSE_S = 120.0         # staff from the lobby to a door on an upper floor
ESCORT_LIFT_S = 240.0            # one wheelchair user down by lift, staff stays with them
RELOCATION_S = 15 * 60.0         # moving a floor's residents to the overflow spaces
FORECAST_DT = 2.0

# Overflow outside the building. The hotel is unlimited but off campus.
EXTERNAL_DESTS = [
    ("unit2_lounges", "Unit 2 lounges (next building, on campus)", 60, False),
    ("hotel_rooms", "Hotel rooms (booked, off campus)", 10**6, True),
]
OVERFLOW_KINDS = ("lounge", "study", "kitchen", "amenity")
CRITICAL = ("stranded", "medication_at_risk", "device_power_lost")

STORY_ORDER = ["maya", "dana", "jordan", "sam", "lucia", "theo", "nora", "ahmed", "grace"]


@dataclass
class Situation:
    now_step: int
    lifts_up: bool
    eta_lifts_s: float | None            # until the lifts die if nobody acts (None = already down)
    eta_cut_s: float | None              # latest safe moment to isolate the switchgear
    dark_now: list[str]
    dark_planned: list[str]              # floors that go dark even with the valve closed on time
    valve_closed_at_s: float | None      # when the plumber can have the valve shut
    stage2_averted: bool                 # does the valve close before the original switchgear floods
    movers: list[Resident]               # in the building on a floor that goes dark
    away: list[Resident]                 # live on those floors, not in the building
    flagged: dict[str, list[str]]        # resident id -> impacts (from the forecast)
    rules: set[str]
    enabled: set[str]
    dests: list[tuple[str, str, int, bool]] = field(default_factory=list)   # id, name, capacity, off_campus


# ---- entry point ---------------------------------------------------------------------------


def compute_plan(ctx: WorldContext, state: WorldState) -> Plan:
    incident = bool(state.leaks or state.flooded or state.forecast.events)
    enabled = sorted(a for a, on in state.agents.items() if on)
    if not incident:
        return Plan(version=state.plan.version, computed_step=state.step, status="none",
                    enabled_agents=enabled, rules=list(state.rules))

    sit = _situation(ctx, state)
    r1_steps = _naive_proposal(ctx, sit)
    r1_stances = _evaluate(ctx, sit, r1_steps)
    r2_steps = _revised_proposal(ctx, sit, r1_stances)
    r2_stances = _evaluate(ctx, sit, r2_steps)
    left_behind = _uncovered(ctx, sit, r2_steps)
    feasible2 = not any(s.stance == "veto" for s in r2_stances)

    rounds = [
        Round(n=1, title="First proposal", steps=r1_steps, stances=r1_stances,
              feasible=not any(s.stance == "veto" for s in r1_stances),
              summary=_round_summary(ctx, 1, r1_stances)),
        Round(n=2, title="Revised after objections", steps=r2_steps, stances=r2_stances, feasible=feasible2,
              summary=_round_summary(ctx, 2, r2_stances)),
    ]
    metrics = _metrics(sit, r2_steps, left_behind)
    headline = _headline(ctx, sit, r2_steps, left_behind)

    prev = state.plan
    signature = _signature(r2_steps, r2_stances, left_behind, rounds)
    version = prev.version if prev.status != "none" and prev.signature == signature else prev.version + 1
    status = "approved" if state.approved_plan_version == version else "draft"
    return Plan(version=version, computed_step=state.step, status=status, rounds=rounds, steps=r2_steps,
                stances=r2_stances, left_behind=left_behind, metrics=metrics, enabled_agents=enabled,
                rules=list(state.rules), headline=headline, signature=signature)


# ---- situation -----------------------------------------------------------------------------


def _situation(ctx: WorldContext, state: WorldState) -> Situation:
    f = state.forecast
    elapsed = (state.step - f.computed_step) * _dt()     # the forecast may be a few minutes old
    lifts_up = all(state.power.lifts.values())
    eta_lifts = next((max(0.0, e.eta_s - elapsed) for e in f.events if e.kind == "lifts_down"), None) if lifts_up else None
    eta_cut = max(0.0, eta_lifts - SAFETY_MARGIN_S) if eta_lifts is not None else None

    # What still goes dark if the plumber closes the valve as fast as they can.
    leaking = any(l.active for l in state.leaks.values())
    valve_closed_at = None
    if leaking and "main_valve" not in state.closed_valves:
        secs = float(ctx.equipment["main_valve"].props.get("seconds_to_close", 60))  # type: ignore[arg-type]
        pending = next((p for p in state.pending if p.equipment_id == "main_valve"), None)
        valve_closed_at = (pending.completes_step - state.step) * _dt() if pending else PLUMBER_ETA_S + secs
    dark_planned, stage2 = _planned_dark_levels(ctx, state, valve_closed_at)

    rules = {r.code for r in state.rules}
    by_id = ctx.roster.by_id()
    dark_set = set(dark_planned)
    flagged = _planned_impacts(ctx, dark_set, lifts_up, eta_cut)
    movers = [r for r in ctx.roster.residents if r.level in dark_set and r.presence != "away"]
    away = [r for r in ctx.roster.residents if r.level in dark_set and r.presence == "away"]
    if "no_wake" in rules:
        movers = [r for r in movers if r.presence != "asleep"]
    enabled = {a for a, on in state.agents.items() if on}
    dests = _destinations(ctx, dark_set, rules)
    _ = by_id
    return Situation(now_step=state.step, lifts_up=lifts_up, eta_lifts_s=eta_lifts, eta_cut_s=eta_cut,
                     dark_now=list(state.impact.dark_levels), dark_planned=dark_planned,
                     valve_closed_at_s=valve_closed_at, stage2_averted=stage2, movers=movers, away=away,
                     flagged=flagged, rules=rules, enabled=enabled, dests=dests)


def _planned_impacts(ctx: WorldContext, dark: set[str], lifts_up: bool, eta_cut: float | None) -> dict[str, list[str]]:
    """Critical impacts under the plan's own outcome (valve closed as soon as possible, lifts cut safely)."""
    out: dict[str, list[str]] = {}
    lifts_lost = (not lifts_up) or eta_cut is not None
    for r in ctx.roster.residents:
        if r.presence == "away":
            continue
        imp: list[str] = []
        if "step_free_route" in r.needs and lifts_lost and ctx.level_order[r.level] > ctx.level_order["L1"]:
            imp.append("stranded")
        if r.medication_location and r.medication_location in {f"fridge_{lv}" for lv in dark}:
            imp.append("medication_at_risk")
        if "medical_device_power" in r.needs and r.level in dark:
            imp.append("device_power_lost")
        if imp:
            out[r.id] = imp
    return out


def _dt() -> float:
    from ..world.state import DT

    return DT


def _planned_dark_levels(ctx: WorldContext, state: WorldState, valve_closed_at: float | None) -> tuple[list[str], bool]:
    """Run the water forward with the valve closing at `valve_closed_at`; which floors still die?"""
    from ..building.graph import powered_levels

    h = Hydraulics(volumes={sp: w.volume for sp, w in state.water.items()}, flooded=set(state.flooded),
                   isolated=set(state.isolated), closed_valves=set(state.closed_valves),
                   leaks={e: l.flow_lps for e, l in state.leaks.items()}, wet=set(state.wet_spaces),
                   live=set(state.power.live))
    t = 0.0
    closed = valve_closed_at is None
    horizon = state.forecast.horizon_s or 3600.0
    while t < horizon and not h.idle(ctx):
        if not closed and valve_closed_at is not None and t >= valve_closed_at:
            h.closed_valves.add("main_valve")
            closed = True
        t += FORECAST_DT
        step(h, ctx, FORECAST_DT)
    live = h.live if h.live else set(state.power.live)
    levels = powered_levels(ctx.graph, live)
    dark = sorted((lv for lv, ok in levels.items() if not ok), key=lambda lv: ctx.level_order[lv])
    stage2_averted = "msb_a" not in h.flooded
    return dark, stage2_averted


def _destinations(ctx: WorldContext, dark: set[str], rules: set[str]) -> list[tuple[str, str, int, bool]]:
    out: list[tuple[str, str, int, bool]] = []
    # Powered residential floors first (people stay near home), then the ground floor.
    spaces = [s for s in ctx.spec.spaces if s.kind in OVERFLOW_KINDS and s.capacity > 0 and s.level not in dark
              and s.level != "B1" and s.id != "L1-music"]
    by_level: dict[str, list] = {}
    for s in spaces:
        by_level.setdefault(s.level, []).append(s)
    levels = sorted(by_level, key=lambda lv: (0 if lv != "L1" else 1, -ctx.level_order[lv]))
    for lv in levels:
        group = by_level[lv]
        cap = sum(s.capacity for s in group)
        name = (f"the {ctx.spec.level(lv).name} lounges" if lv != "L1"
                else "ground-floor community spaces (" + ", ".join(s.name for s in group[:3]) + ")")
        out.append((lv, name, cap, False))
    for d in EXTERNAL_DESTS:
        if d[3] and "no_off_campus" in rules:
            continue
        out.append(d)
    return out


# ---- proposals -----------------------------------------------------------------------------


def _naive_proposal(ctx: WorldContext, sit: Situation) -> list[PlanStep]:
    steps: list[PlanStep] = []
    n = 0

    def add(**kw) -> PlanStep:
        nonlocal n
        n += 1
        st = PlanStep(order=n, **kw)
        steps.append(st)
        return st

    add(id="call_plumber", kind="call", actor="haven", at_s=0.0,
        title="Call the emergency plumber (next on the list if no answer)",
        reason="The main shut-off is a gate valve that needs a valve key; facilities cannot close it.")
    if sit.lifts_up and sit.eta_cut_s is not None:
        add(id="isolate_msb_b", kind="isolate", actor="facilities", at_s=0.0, target="msb_b",
            title="Cut MSB section B now", reason="Energised switchgear must not be under water.",
            command={"equipment_id": "msb_b", "command": "off"}, satisfies=["safety"])
        add(id="isolate_ats_eq", kind="isolate", actor="facilities", at_s=0.0, target="ats_eq",
            title="Cut ATS-EQ now (lifts stop)", reason="Same room, same water: the generator feed is live too.",
            command={"equipment_id": "ats_eq", "command": "off"}, satisfies=["safety"])
    everyone = [r.id for r in sit.movers] + [r.id for r in sit.away]
    add(id="relocate_all", kind="relocate", actor="housing", at_s=0.0, target="unit2_lounges",
        title=f"Move all {len(everyone)} residents of floors {_floors(sit.dark_planned)} to Unit 2 lounges",
        reason="Those floors lose lighting, outlets and heating for the night.", people=everyone,
        count=len(everyone), satisfies=["housing"])
    add(id="notify_all", kind="notify", actor="haven", at_s=0.0, count=len(everyone),
        title="Send one building-wide alert", reason="Everyone needs to know.", people=everyone)
    return steps


def _revised_proposal(ctx: WorldContext, sit: Situation, objections: list[Stance]) -> list[PlanStep]:
    by_id = ctx.roster.by_id()
    said = {s.agent for s in objections if s.stance in ("veto", "critique")}
    steps: list[PlanStep] = []
    n = 0

    def add(**kw) -> PlanStep:
        nonlocal n
        n += 1
        st = PlanStep(order=n, **kw)
        steps.append(st)
        return st

    def spoke(rid: str) -> bool:
        return f"resident:{rid}" in said

    # -- water: the plumber --
    add(id="call_plumber", kind="call", actor="haven", at_s=0.0,
        title="Call the emergency plumber (next on the list if no answer)",
        reason=f"Gate valve needs a valve key; plumber ETA ~{PLUMBER_ETA_S / 60:.0f} min.")
    if sit.valve_closed_at_s is not None:
        add(id="close_valve", kind="valve", actor="plumber", at_s=max(0.0, sit.valve_closed_at_s - 420.0),
            deadline_s=sit.valve_closed_at_s, target="main_valve", title="Close the main shut-off valve",
            reason=("Stops the riser; closes before the original switchgear floods" if sit.stage2_averted
                    else "Stops the riser, but too late to save the main switchboard: prepare for the whole building"),
            command={"equipment_id": "main_valve", "command": "close"}, satisfies=["safety"])

    # -- power: hold for escorts, then cut before the water arrives --
    escorts: list[str] = []
    if sit.lifts_up and sit.eta_cut_s is not None:
        t = STAFF_RESPONSE_S
        for r in _wheelchair_users(ctx, sit):
            if not spoke(r.id):
                continue                      # nobody asked for them: the naive cut stands for them
            if ctx.level_order[r.level] <= ctx.level_order["L1"]:
                continue
            if r.level not in set(sit.dark_planned) and r.presence == "asleep":
                add(id=f"shelter_{r.id}", kind="shelter", actor="staff", at_s=t, people=[r.id], target=r.room,
                    title=f"{r.name} stays on {r.level} (floor keeps power); staff check in at the door",
                    reason="Their floor stays lit; the lifts are the only loss, so a check-in beats a stair carry.",
                    satisfies=[f"resident:{r.id}"], count=1)
                continue
            done = t + ESCORT_LIFT_S
            if done > sit.eta_cut_s + 1e-6:
                add(id=f"shelter_{r.id}", kind="shelter", actor="staff", at_s=STAFF_RESPONSE_S, people=[r.id],
                    target=r.room, title=f"{r.name}: stay put; two staff at the door with an evacuation chair",
                    reason=f"Too late for a lift escort: the switchgear must be cut in {sit.eta_cut_s / 60:.0f} min.",
                    satisfies=[f"resident:{r.id}"], count=1)
                continue
            add(id=f"escort_{r.id}", kind="escort", actor="staff", at_s=t, deadline_s=done, people=[r.id],
                target="L1-lobby", title=f"Two staff bring {r.name} down by lift first, and stay with her"
                if r.id == "maya" else f"Two staff bring {r.name} down by lift, and stay with them",
                reason="Wheelchair user: the lift is the only step-free way out, and it dies when the power is cut.",
                satisfies=[f"resident:{r.id}"], count=1)
            escorts.append(r.id)
            t = done
        cut_at = min(sit.eta_cut_s, max([0.0] + [st.deadline_s or 0.0 for st in steps if st.kind == "escort"]))
        if escorts:
            add(id="hold_power", kind="hold", actor="facilities", at_s=0.0, deadline_s=cut_at, target="ats_eq",
                title=f"Keep the lifts energised for {cut_at / 60:.0f} more minutes",
                reason=f"Escorts finish by then; water reaches the switchgear ~{sit.eta_lifts_s / 60:.0f} min from now, "
                       f"{SAFETY_MARGIN_S / 60:.0f} min safety margin kept.", satisfies=["safety"] + [f"resident:{e}" for e in escorts])
        add(id="isolate_msb_b", kind="isolate", actor="facilities", at_s=cut_at, target="msb_b",
            title="Cut MSB section B" + ("" if escorts else " now"),
            reason="Energised switchgear must not be under water.",
            command={"equipment_id": "msb_b", "command": "off"}, satisfies=["safety"])
        add(id="isolate_ats_eq", kind="isolate", actor="facilities", at_s=cut_at, target="ats_eq",
            title="Cut ATS-EQ (lifts stop)" + ("" if escorts else " now"),
            reason="Same room, same water: the generator feed is live too.",
            command={"equipment_id": "ats_eq", "command": "off"}, satisfies=["safety"])
    else:
        cut_at = 0.0
        for r in _wheelchair_users(ctx, sit):
            if spoke(r.id) and ctx.level_order[r.level] > ctx.level_order["L1"]:
                add(id=f"shelter_{r.id}", kind="shelter", actor="staff", at_s=STAFF_RESPONSE_S, people=[r.id],
                    target=r.room, title=f"{r.name}: stay put; two staff at the door with an evacuation chair",
                    reason="Lifts are already down. No step-free route exists, so staff stay with them.",
                    satisfies=[f"resident:{r.id}"], count=1)

    # -- things that must move before the floors go dark --
    meds = _story_first([r for r in ctx.roster.residents if r.medication_location and spoke(r.id)
                         and r.medication_location in {f"fridge_{lv}" for lv in sit.dark_planned}])
    for lv in sorted({r.medication_location[-2:] for r in meds}):
        group = [r for r in meds if r.medication_location == f"fridge_{lv}"]
        add(id=f"move_meds_{lv}", kind="move_item", actor=f"ra_{lv[1:]}", at_s=60.0, deadline_s=cut_at or None,
            people=[r.id for r in group], target="fridge_L2" if "L2" not in sit.dark_planned else "fridge_L5",
            title=f"Move the medication of {_names(group)} from the {lv} fridge to a powered fridge",
            reason="Insulin must stay refrigerated; that fridge dies with the floor.",
            satisfies=[f"resident:{r.id}" for r in group], count=len(group))

    # -- people: wake, escort the ones who need it, relocate by capacity --
    movers = list(sit.movers)
    if movers:
        ras = sorted({f"ra_{lv[1:]}" for lv in sit.dark_planned if lv != "L1" and lv != "B1"})
        deaf = [r for r in movers if "visual_alerts" in r.needs]
        add(id="wake_floors", kind="notify", actor=",".join(ras) or "staff", at_s=STAFF_RESPONSE_S,
            deadline_s=cut_at + 300.0, people=[r.id for r in movers], count=len(movers),
            title=f"RAs knock on every door on {_floors(sit.dark_planned)}"
                  + (f"; a light, not a knock, for {', '.join(r.name.split()[0] for r in deaf if spoke(r.id))}"
                     if any(spoke(r.id) for r in deaf) else ""),
            reason=f"{sum(1 for r in movers if r.presence == 'asleep')} of them are asleep.",
            satisfies=[f"resident:{r.id}" for r in deaf if spoke(r.id)])
        devices = _story_first([r for r in movers if "medical_device_power" in r.needs and spoke(r.id)])
        if devices:
            add(id="power_first", kind="relocate", actor="ra_" + ",ra_".join(sorted({r.level[1:] for r in devices})),
                at_s=STAFF_RESPONSE_S, deadline_s=cut_at or None, people=[r.id for r in devices],
                target=sit.dests[0][0] if sit.dests else None, count=len(devices),
                title=f"{_names(devices)} first: a powered room with an outlet for their device",
                reason="Powered medical device (CPAP); the outlet dies with the floor.",
                satisfies=[f"resident:{r.id}" for r in devices])
        dogs = _story_first([r for r in movers if "guide_dog" in r.needs and spoke(r.id)])
        if dogs:
            add(id="escort_guide_dog", kind="escort", actor="ra_" + ",ra_".join(sorted({r.level[1:] for r in dogs})),
                at_s=STAFF_RESPONSE_S, deadline_s=cut_at + RELOCATION_S, people=[r.id for r in dogs], count=len(dogs),
                title=f"RA escorts {_names(dogs)} and the guide dog down the stairs",
                reason="Blind; moves independently but a dark, crowded stair is where people get hurt.",
                satisfies=[f"resident:{r.id}" for r in dogs])
        slow = _story_first([r for r in movers if "stairs_slow" in r.needs and spoke(r.id)])
        if slow:
            add(id="escort_stairs", kind="escort", actor="staff", at_s=STAFF_RESPONSE_S,
                deadline_s=cut_at + RELOCATION_S, people=[r.id for r in slow], count=len(slow),
                title=f"Someone beside {_names(slow)} on the stairs" + (", after the lift escorts" if escorts else ""),
                reason="Limited mobility: stairs only slowly, with help.", satisfies=[f"resident:{r.id}" for r in slow])
        # Allocation by capacity, floor by floor, keeping floors together where possible.
        assigned: set[str] = set(p for st in steps if st.kind == "relocate" for p in st.people)
        queue = [r for r in movers if r.id not in assigned]
        groups: list[tuple[str, list[Resident]]] = []
        for did, dname, cap, off in sit.dests:
            if not queue:
                break
            take, queue = queue[:cap], queue[cap:]
            groups.append((did, take))
            add(id=f"relocate_{did}", kind="relocate", actor="housing", at_s=cut_at - 300.0 if cut_at > 300 else 0.0,
                deadline_s=cut_at + RELOCATION_S, target=did, people=[r.id for r in take], count=len(take),
                title=f"{len(take)} residents to {dname}" + (" — off campus" if off else ""),
                reason="Nearest powered space with room; floors kept together where capacity allows.",
                satisfies=["housing", "capacity"])
        _ = groups
        if queue:
            add(id="relocate_short", kind="shelter", actor="housing", at_s=cut_at, people=[r.id for r in queue],
                count=len(queue), title=f"{len(queue)} residents shelter in place: no on-campus space left",
                reason="Capacity exhausted under the current rules.", satisfies=["housing"])

    # -- away residents: do not move, do not wake --
    if sit.away:
        add(id="away_notify", kind="notify", actor="haven", at_s=0.0, people=[r.id for r in sit.away],
            count=len(sit.away), title=f"{len(sit.away)} residents are out: message only, nobody is relocated or woken",
            reason="Not in the building tonight; they need to know what they will find when they get back.",
            satisfies=[f"resident:{r.id}" for r in sit.away if spoke(r.id)])

    # -- messages, ticket, summary --
    langs = sorted({by_id[p].contact.lang for st in steps for p in st.people if by_id[p].contact.lang != "en"})
    add(id="notify_each", kind="notify", actor="haven", at_s=0.0,
        count=len(movers) + len(sit.away), people=[],
        title="Send every affected person their own message, in their language"
              + (f" ({', '.join(langs)})" if langs else ""),
        reason="Each message says what that person should do, not what the building is doing.")
    add(id="ticket", kind="ticket", actor="haven", at_s=0.0, title="Open the facilities ticket and brief the dean",
        reason="Riser break, basement flooding, switchgear B and ATS-EQ at risk; two lines for the dean.")
    return steps


# ---- agents --------------------------------------------------------------------------------


def _evaluate(ctx: WorldContext, sit: Situation, steps: list[PlanStep]) -> list[Stance]:
    out: list[Stance] = []
    if "safety" in sit.enabled:
        out.append(_safety(sit, steps))
    if "housing" in sit.enabled:
        out.append(_housing(sit, steps))
    if "capacity" in sit.enabled:
        out.append(_capacity(sit, steps))
    by_id = ctx.roster.by_id()
    order = {rid: i for i, rid in enumerate(STORY_ORDER)}
    agents = sorted((a for a in sit.enabled if a.startswith("resident:")),
                    key=lambda a: (order.get(a.split(":", 1)[1], 99), a))
    for a in agents:
        r = by_id.get(a.split(":", 1)[1])
        if r is None:
            continue
        st = _resident(ctx, sit, r, steps)
        if st is not None:
            out.append(st)
    return out


def _find(steps: list[PlanStep], kind: str, **attrs) -> PlanStep | None:
    for st in steps:
        if st.kind == kind and all(getattr(st, k) == v for k, v in attrs.items()):
            return st
    return None


def _steps_for(steps: list[PlanStep], rid: str, kinds: tuple[str, ...] = ()) -> list[PlanStep]:
    return [st for st in steps if rid in st.people and (not kinds or st.kind in kinds)]


def _cut_time(steps: list[PlanStep]) -> float | None:
    st = _find(steps, "isolate", target="ats_eq")
    return st.at_s if st else None


def _safety(sit: Situation, steps: list[PlanStep]) -> Stance:
    rule = Constraint(type="hard", rule="Switchgear is de-energised before water reaches it; nobody enters the "
                                        "basement; no lift use after isolation", code="deenergise_before_contact",
                      source="safety")
    cut = _cut_time(steps)
    isolates = [st.id for st in steps if st.kind == "isolate"]
    if sit.lifts_up and sit.eta_cut_s is not None:
        if cut is None:
            return Stance(agent="safety", label="Safety agent", stance="veto", constraint=rule, step_ids=isolates,
                          reason="The plan never isolates the switchgear before the water reaches it.")
        if cut > sit.eta_cut_s + 1e-6:
            return Stance(agent="safety", label="Safety agent", stance="veto", constraint=rule, step_ids=isolates,
                          reason=f"Isolation at +{cut / 60:.0f} min is inside the {SAFETY_MARGIN_S / 60:.0f} min "
                                 f"margin before water contact (+{sit.eta_lifts_s / 60:.0f} min).")
        if cut == 0.0:
            return Stance(agent="safety", label="Safety agent", stance="propose", constraint=rule, step_ids=isolates,
                          reason="Cut MSB section B and ATS-EQ now: the water is "
                                 f"{sit.eta_lifts_s / 60:.0f} min from the switchgear and every minute energised is risk.")
        return Stance(agent="safety", label="Safety agent", stance="support", constraint=rule, step_ids=isolates,
                      reason=f"Isolation at +{cut / 60:.0f} min keeps the {SAFETY_MARGIN_S / 60:.0f} min margin. Acceptable.")
    return Stance(agent="safety", label="Safety agent", stance="support", constraint=rule,
                  step_ids=[st.id for st in steps if st.kind in ("valve", "call")],
                  reason="The switchgear is already lost; stop the water and keep everyone out of the basement.")


def _housing(sit: Situation, steps: list[PlanStep]) -> Stance:
    reloc = [st for st in steps if st.kind == "relocate"]
    n = sum(st.count for st in reloc)
    if len(reloc) <= 1:
        return Stance(agent="housing", label="Housing agent", stance="propose", step_ids=[st.id for st in reloc],
                      reason=f"{len(sit.movers) + len(sit.away)} residents live on floors {_floors(sit.dark_planned)}; "
                             f"move them to the next building for the night.")
    return Stance(agent="housing", label="Housing agent", stance="support", step_ids=[st.id for st in reloc],
                  reason=f"{n} people placed across {len(reloc)} spaces, nearest first; "
                         f"{len(sit.away)} who are out tonight are messaged, not moved.")


def _capacity(sit: Situation, steps: list[PlanStep]) -> Stance:
    caps = {d[0]: d[2] for d in sit.dests}
    over = [(st, st.count - caps.get(st.target or "", 0)) for st in steps if st.kind == "relocate"
            and st.count > caps.get(st.target or "", 0)]
    short = _find(steps, "shelter", id="relocate_short")
    rule = Constraint(type="hard", rule="No space takes more people than it holds", code="capacity", source="capacity")
    if over:
        st, by = over[0]
        return Stance(agent="capacity", label="Capacity agent", stance="veto", constraint=rule, step_ids=[st.id],
                      reason=f"{st.target} holds {caps.get(st.target or '', 0)}; the plan sends {st.count} ({by} too many).")
    if short:
        return Stance(agent="capacity", label="Capacity agent", stance="critique", constraint=rule, step_ids=[short.id],
                      reason=f"On-campus space runs out: {short.count} people have nowhere assigned.")
    return Stance(agent="capacity", label="Capacity agent", stance="support", constraint=rule,
                  step_ids=[st.id for st in steps if st.kind == "relocate"],
                  reason="Every destination is within capacity.")


def _resident(ctx: WorldContext, sit: Situation, r: Resident, steps: list[PlanStep]) -> Stance | None:
    agent, label = f"resident:{r.id}", f"{r.name.split()[0]}'s agent"
    first = r.name.split()[0]
    impacts = sit.flagged.get(r.id, [])
    cut = _cut_time(steps)
    upstairs = ctx.level_order[r.level] > ctx.level_order["L1"]
    dark = r.level in set(sit.dark_planned)

    def S(stance, reason, constraint=None, ids=()):
        return Stance(agent=agent, label=label, stance=stance, reason=reason, constraint=constraint,
                      step_ids=list(ids), resident=r.id)

    if "step_free_route" in r.needs and r.presence != "away" and upstairs:
        c = Constraint(type="hard", rule=f"{first} keeps a feasible step-free route", code=f"step_free:{r.id}", source=agent)
        esc = _find(steps, "escort", people=[r.id])
        shelter = _find(steps, "shelter", people=[r.id])
        if sit.lifts_up and sit.eta_cut_s is not None:
            if esc and cut is not None and esc.deadline_s is not None and esc.deadline_s <= cut + 1e-6:
                return S("support", f"Lift escort finishes at +{esc.deadline_s / 60:.0f} min, power is cut at "
                                    f"+{cut / 60:.0f}. {first} gets out.", c, [esc.id])
            if shelter and "evacuation chair" in shelter.title:
                return S("support", f"No time left for the lift; staff at {first}'s door with a chair is the fallback.", c, [shelter.id])
            if shelter:
                return S("support", f"{first}'s floor keeps power; a check-in is enough tonight.", c, [shelter.id])
            if cut == 0.0 or cut is None:
                return S("veto", f"Cutting the power now strands {first} on {r.level}: a wheelchair cannot use the stairs "
                                 f"and no one is coming to the door.", c,
                         [st.id for st in steps if st.kind == "isolate"])
            return S("veto", f"The power is cut before anyone brings {first} down by lift.", c,
                     [st.id for st in steps if st.kind == "isolate"])
        if shelter:
            return S("support", f"Lifts are gone; staff at {first}'s door with an evacuation chair is the right fallback.", c, [shelter.id])
        return S("veto", f"Lifts are down and the plan has nobody at {first}'s door.", c)

    if r.medication_location and r.medication_location in {f"fridge_{lv}" for lv in sit.dark_planned}:
        c = Constraint(type="hard", rule=f"{first}'s insulin stays refrigerated", code=f"meds:{r.id}", source=agent)
        mv = _steps_for(steps, r.id, ("move_item",))
        if mv:
            return S("support", "Medication moves to a powered fridge before the floor goes dark.", c, [mv[0].id])
        return S("veto", f"{first}'s insulin is in the {r.level} fridge, which dies with the floor.", c)

    if "medical_device_power" in r.needs and dark and r.presence != "away":
        c = Constraint(type="hard", rule=f"{first} sleeps next to a powered outlet", code=f"device_power:{r.id}", source=agent)
        sts = [st for st in _steps_for(steps, r.id, ("relocate",)) if st.id == "power_first"]
        if sts:
            return S("support", f"{first} is placed first, with an outlet.", c, [sts[0].id])
        return S("veto", f"{first}'s CPAP loses its outlet when {r.level} goes dark; the plan does not place her first.", c)

    if r.presence == "away" and dark:
        c = Constraint(type="hard", rule=f"{first} is not woken or relocated", code=f"no_move:{r.id}", source=agent)
        st = _find(steps, "notify", id="away_notify")
        if st:
            return S("support", f"{first} is out until {r.away_until}; a message is enough.", c, [st.id])
        bad = [st.id for st in steps if st.kind == "relocate" and r.id in st.people]
        return S("critique", f"{first} is on a night shift until {r.away_until}. Do not relocate or wake them.", c, bad)

    if "visual_alerts" in r.needs and dark and r.presence != "away":
        c = Constraint(type="hard", rule=f"{first} is alerted visually and in text, never by sound", code=f"visual:{r.id}", source=agent)
        st = _find(steps, "notify", id="wake_floors")
        if st and r.id in st.people and "light" in st.title:
            return S("support", f"A knock with a light and a text message: {first} will get it.", c, [st.id])
        return S("critique", f"{first} is Deaf and asleep; an alarm or a call reaches nobody.", c)

    if "guide_dog" in r.needs and dark and r.presence != "away":
        c = Constraint(type="soft", rule=f"{first} and the guide dog are escorted", code=f"escort:{r.id}", source=agent)
        sts = _steps_for(steps, r.id, ("escort",))
        if sts:
            return S("support", f"An RA walks {first} and the guide dog down.", c, [sts[0].id])
        return S("critique", f"{first} is blind; a dark stairwell full of people needs an escort.", c)

    if "stairs_slow" in r.needs and dark and r.presence != "away":
        c = Constraint(type="soft", rule=f"{first} has someone beside them on the stairs", code=f"stairs:{r.id}", source=agent)
        sts = _steps_for(steps, r.id, ("escort",))
        if sts:
            return S("support", f"Someone is beside {first} on the stairs.", c, [sts[0].id])
        return S("critique", f"{first} is on crutches: stairs only slowly, with help.", c)

    if r.contact.lang != "en" and dark and r.presence != "away":
        c = Constraint(type="soft", rule=f"{first} is messaged in {r.contact.lang}", code=f"lang:{r.id}", source=agent)
        st = _find(steps, "notify", id="notify_each")
        if st:
            return S("support", f"{first} gets the message in {r.contact.lang}.", c, [st.id])
        return S("critique", f"{first} needs anything urgent in {r.contact.lang}, not English.", c)

    if r.role == "ra" and r.level in set(sit.dark_planned):
        st = _find(steps, "notify", id="wake_floors")
        if st:
            return S("support", f"{first} runs the knocks on {r.level}.", None, [st.id])
        return S("critique", f"{first} is the RA on {r.level} and has no task yet.")

    if impacts and impacts != ["away"]:
        return None  # dark room only: no personal objection
    return None


# ---- coverage, metrics, summaries ----------------------------------------------------------


def _story_first(rs: list[Resident]) -> list[Resident]:
    order = {rid: i for i, rid in enumerate(STORY_ORDER)}
    return sorted(rs, key=lambda r: (order.get(r.id, 99), r.id))


def _names(rs: list[Resident], limit: int = 2) -> str:
    names = [r.name if i < limit else None for i, r in enumerate(rs)]
    shown = [n for n in names if n]
    rest = len(rs) - len(shown)
    if rest <= 0:
        return " and ".join(shown)
    return ", ".join(shown) + f" and {rest} other{'s' if rest != 1 else ''}"


def _uncovered(ctx: WorldContext, sit: Situation, steps: list[PlanStep]) -> list[str]:
    """Residents with a critical impact the final plan does nothing specific about."""
    out: list[str] = []
    for rid, impacts in sit.flagged.items():
        crit = [i for i in impacts if i in CRITICAL]
        if not crit:
            continue
        r = ctx.roster.by_id()[rid]
        if r.presence == "away":
            continue
        ok = True
        if "stranded" in crit and ctx.level_order[r.level] > ctx.level_order["L1"]:
            ok &= bool(_steps_for(steps, rid, ("escort", "shelter")))
        if "medication_at_risk" in crit:
            ok &= bool(_steps_for(steps, rid, ("move_item",)))
        if "device_power_lost" in crit:
            ok &= any(st.id == "power_first" for st in _steps_for(steps, rid, ("relocate",)))
        if not ok:
            out.append(rid)
    order = {rid: i for i, rid in enumerate(STORY_ORDER)}
    return sorted(out, key=lambda x: (order.get(x, 99), x))


def _wheelchair_users(ctx: WorldContext, sit: Situation) -> list[Resident]:
    order = {rid: i for i, rid in enumerate(STORY_ORDER)}
    users = [r for r in ctx.roster.residents if "step_free_route" in r.needs and r.presence != "away"]
    return sorted(users, key=lambda r: (0 if r.level in set(sit.dark_planned) else 1, order.get(r.id, 99), r.id))


def _metrics(sit: Situation, steps: list[PlanStep], left_behind: list[str]) -> dict[str, float | int]:
    cut = _cut_time(steps)
    reloc = sum(st.count for st in steps if st.kind == "relocate")
    off = sum(st.count for st in steps if st.kind == "relocate" and st.target == "hotel_rooms")
    return {
        "residents_affected": len(sit.movers) + len(sit.away),
        "relocated": reloc,
        "off_campus": off,
        "escorted": sum(st.count for st in steps if st.kind == "escort"),
        "messaged_only": len(sit.away),
        "left_behind": len(left_behind),
        "power_hold_min": round(cut / 60, 1) if cut else 0,
        "water_contact_min": round(sit.eta_lifts_s / 60, 1) if sit.eta_lifts_s is not None else 0,
        "valve_closed_min": round(sit.valve_closed_at_s / 60, 1) if sit.valve_closed_at_s is not None else 0,
        "stage2_averted": int(sit.stage2_averted),
        "steps": len(steps),
    }


def _headline(ctx: WorldContext, sit: Situation, steps: list[PlanStep], left_behind: list[str]) -> str:
    cut = _cut_time(steps)
    by_id = ctx.roster.by_id()
    if left_behind:
        names = ", ".join(by_id[r].name.split()[0] for r in left_behind[:3])
        return (f"Cut the power now and move floors {_floors(sit.dark_planned)} by the stairs. "
                f"{names} {'is' if len(left_behind) == 1 else 'are'} left behind.")
    if cut is not None and cut > 0:
        return (f"Hold the lifts {cut / 60:.0f} min for escorts, then cut section B and ATS-EQ; "
                f"floors {_floors(sit.dark_planned)} relocate on campus. Nobody left behind.")
    if cut is not None:
        return (f"Cut section B and ATS-EQ now, stop the water; floors {_floors(sit.dark_planned)} relocate "
                "on campus. Nobody left behind.")
    return "Stop the water, keep everyone out of the basement, relocate the dark floors. Nobody left behind."


def _round_summary(ctx: WorldContext, n: int, stances: list[Stance]) -> str:
    vetoes = [s.label for s in stances if s.stance == "veto"]
    crit = [s.label for s in stances if s.stance == "critique"]
    if n == 1:
        parts = []
        if vetoes:
            parts.append("vetoed by " + ", ".join(vetoes))
        if crit:
            parts.append(f"{len(crit)} objection{'s' if len(crit) != 1 else ''}")
        return "Cut now, move everyone to Unit 2 — " + ("; ".join(parts) if parts else "no objections")
    if vetoes:
        return "Still vetoed by " + ", ".join(vetoes)
    sup = sum(1 for s in stances if s.stance == "support")
    return f"{sup} agents support" + (f", {len(crit)} still asking for more" if crit else "; every hard constraint holds")


def _signature(steps: list[PlanStep], stances: list[Stance], left_behind: list[str], rounds: list[Round]) -> int:
    key = "|".join([st.id for st in steps] + [f"{s.agent}={s.stance}" for s in stances] + left_behind
                   + [str(r.feasible) for r in rounds])
    h = 0
    for ch in key:
        h = (h * 131 + ord(ch)) % 1_000_000_007
    return h


def _floors(levels: list[str]) -> str:
    names = [lv[1:] if lv.startswith("L") else lv for lv in levels]
    if not names:
        return "—"
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


_ = math
