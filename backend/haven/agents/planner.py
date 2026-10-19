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
from .models import Attack, Check, Constraint, Message, Plan, PlanStep, Round, Stance
from .rules import describe as describe_rule

if TYPE_CHECKING:
    from ..world.context import WorldContext
    from ..world.state import WorldState

SAFETY_MARGIN_S = 120.0          # switchgear must be dead this long before water touches it
PLUMBER_ETA_S = 20 * 60.0        # on-call plumber travel time at midnight
STAFF_RESPONSE_S = 120.0         # staff from the lobby to a door on an upper floor
ESCORT_LIFT_S = 240.0            # one wheelchair user down by lift, staff stays with them
RELOCATION_S = 15 * 60.0         # moving a floor's residents to the overflow spaces
FORECAST_DT = 2.0

OVERFLOW_KINDS = ("lounge", "study", "kitchen", "amenity")
CRITICAL = ("stranded", "medication_at_risk", "device_power_lost")


def _order(ctx: WorldContext) -> dict[str, int]:
    """Named people first, in roster order: the demo's story residents, derived from the roster."""
    return {rid: i for i, rid in enumerate(ctx.story_order)}


def _fridge_in_dark(ctx: WorldContext, r: Resident, dark: set[str]) -> bool:
    eq = ctx.equipment.get(r.medication_location or "")
    return eq is not None and eq.level in dark


def _powered_fridge(ctx: WorldContext, dark: set[str], from_level: str) -> str | None:
    """The nearest fridge on a floor that keeps power (closest level first, lower floors on a tie)."""
    here = ctx.level_order[from_level]
    best = [(abs(ctx.level_order[lv] - here), ctx.level_order[lv], fid) for lv, fid in ctx.fridges.items() if lv not in dark]
    return min(best)[2] if best else None


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
    moved: dict[str, str] = field(default_factory=dict)  # already relocated by an executed step
    at_risk: list[str] = field(default_factory=list)      # equipment the forecast says floods, in order
    lift_feeder: str | None = None                        # the at-risk item whose loss stops the lifts
    move_deadline_s: float | None = None                 # "no moves after HH:MM", as seconds from now
    now_tod: float = 0.0


# ---- entry point ---------------------------------------------------------------------------


def compute_plan(ctx: WorldContext, state: WorldState) -> Plan:
    incident = bool(state.leaks or state.flooded or state.forecast.events)
    enabled = sorted(a for a, on in state.agents.items() if on)
    if not incident:
        return Plan(version=state.plan.version, computed_step=state.step, status="none",
                    enabled_agents=enabled, rules=list(state.rules))

    sit = _situation(ctx, state)
    key = situation_key(sit)
    r1_steps = _naive_proposal(ctx, sit)
    r1_stances = _evaluate(ctx, sit, r1_steps, state.spoken.get(f"{key}#1", {}))
    r2_steps = _revised_proposal(ctx, sit, r1_stances)
    # The red team attacks the revised plan; a landed attack changes it (a tighter cut-off re-plans).
    from .redteam import attack as red_team

    verdict = red_team(ctx, sit, r2_steps)
    if verdict.eta_cut_s is not None and sit.eta_cut_s is not None and verdict.eta_cut_s < sit.eta_cut_s:
        sit.eta_cut_s = verdict.eta_cut_s
        verdict = red_team(ctx, sit, _revised_proposal(ctx, sit, r1_stances))
        verdict.attacks[0].fixed = True
    r2_steps = verdict.steps
    attacks: list[Attack] = [Attack(**a.model_dump()) for a in verdict.attacks]
    r2_stances = _evaluate(ctx, sit, r2_steps, state.spoken.get(f"{key}#2", {}))
    left_behind = _uncovered(ctx, sit, r2_steps)
    checks = _check(ctx, sit, r2_steps, left_behind)
    r2_stances.append(_redteam_stance(attacks))
    if "checker" in sit.enabled:
        r2_stances.append(_checker_stance(ctx, checks))
    feasible2 = not any(s.stance == "veto" for s in r2_stances)

    rounds = [
        Round(n=1, title="First proposal", steps=r1_steps, stances=r1_stances,
              feasible=not any(s.stance == "veto" for s in r1_stances),
              summary=_round_summary(ctx, 1, r1_stances)),
        Round(n=2, title="Revised after objections", steps=r2_steps, stances=r2_stances, feasible=feasible2,
              summary=_round_summary(ctx, 2, r2_stances)),
    ]
    metrics = _metrics(sit, r2_steps, left_behind)
    metrics["violations"] = sum(1 for c in checks if not c.ok)
    metrics["checks"] = len(checks)
    metrics["attacks"] = len(attacks)
    metrics["attacks_landed"] = sum(1 for a in attacks if a.fixed or not a.ok)
    headline = _headline(ctx, sit, r2_steps, left_behind)
    messages = _messages(ctx, sit, r2_steps)

    prev = state.plan
    signature = _signature(r2_steps, r2_stances, left_behind, rounds)
    version = prev.version if prev.status != "none" and prev.signature == signature else prev.version + 1
    status = "approved" if state.approved_plan_version == version else "draft"
    return Plan(version=version, computed_step=state.step, status=status, rounds=rounds, steps=r2_steps,
                stances=r2_stances, left_behind=left_behind, metrics=metrics, enabled_agents=enabled,
                rules=list(state.rules), headline=headline, signature=signature, messages=messages,
                checks=checks, situation=key, attacks=attacks)


def situation_key(sit: Situation) -> str:
    """A short hash of every fact the agents reason from. Stances are given for a key; when the facts move
    (water, a rule, a toggle, people relocated), the key moves and the agents are asked again."""
    parts = [
        ",".join(sit.dark_planned), str(sit.lifts_up),
        f"{sit.eta_cut_s:.0f}" if sit.eta_cut_s is not None else "-",
        f"{sit.valve_closed_at_s:.0f}" if sit.valve_closed_at_s is not None else "-",
        ";".join(f"{k}:{'+'.join(v)}" for k, v in sorted(sit.flagged.items())),
        ",".join(sorted(sit.rules)), ",".join(sorted(sit.enabled)), ",".join(sorted(sit.moved)),
        f"{sit.move_deadline_s:.0f}" if sit.move_deadline_s is not None else "-",
    ]
    h = 0
    for ch in "|".join(parts):
        h = (h * 131 + ord(ch)) % (1 << 61)
    return f"{h:015x}"


# ---- situation -----------------------------------------------------------------------------


def _situation(ctx: WorldContext, state: WorldState) -> Situation:
    f = state.forecast
    elapsed = (state.step - f.computed_step) * _dt()     # the forecast may be a few minutes old
    lifts_up = all(state.power.lifts.values())
    eta_lifts = next((max(0.0, e.eta_s - elapsed) for e in f.events if e.kind == "lifts_down"), None) if lifts_up else None
    eta_cut = max(0.0, eta_lifts - SAFETY_MARGIN_S) if eta_lifts is not None else None

    # What still goes dark if the plumber closes the valve as fast as they can. The valve is whichever
    # shut-off sits upstream of the leaking riser in the water graph.
    valve = next((ctx.valve_for(l.equipment_id) for l in state.leaks.values() if l.active), None)
    valve_closed_at = None
    if valve is not None and valve not in state.closed_valves:
        secs = float(ctx.equipment[valve].props.get("seconds_to_close", 60))  # type: ignore[arg-type]
        pending = next((p for p in state.pending if p.equipment_id == valve), None)
        valve_closed_at = (pending.completes_step - state.step) * _dt() if pending else PLUMBER_ETA_S + secs
    dark_planned, stage2 = _planned_dark_levels(ctx, state, valve, valve_closed_at)

    rules = {r.code for r in state.rules}
    by_id = ctx.roster.by_id()
    dark_set = set(dark_planned)
    flagged = _planned_impacts(ctx, dark_set, lifts_up, eta_cut, state.moved)
    moved = dict(state.moved)
    movers = [r for r in ctx.roster.residents if r.level in dark_set and r.presence != "away" and r.id not in moved]
    away = [r for r in ctx.roster.residents if r.level in dark_set and r.presence == "away"]
    if "no_wake" in rules:
        movers = [r for r in movers if r.presence != "asleep"]
    enabled = {a for a, on in state.agents.items() if on}
    dests = _destinations(ctx, dark_set, rules)
    # The switchgear to isolate: electrical equipment the forecast floods before the valve can stop the
    # water (after that the valve, not a breaker, is the answer), in the order it floods.
    horizon = valve_closed_at if valve_closed_at is not None else float("inf")
    at_risk = [e.id for e in f.events if e.kind == "flooded" and e.id in ctx.equipment
               and e.eta_s <= horizon + 1e-6 and ctx.is_electrical(e.id)]
    at_risk = list(dict.fromkeys(at_risk + [x for x in state.flooded if x in ctx.equipment and ctx.is_electrical(x)]))
    feeders = [e for e in at_risk if ctx.powers_lifts(e)]
    lift_feeder = min(feeders, key=ctx.hops_to_lift) if feeders else (at_risk[-1] if at_risk else None)
    now_tod = (_start_tod() + state.step * _dt()) % 86400
    move_deadline = None
    for code in rules:
        if code.startswith("no_moves_after:"):
            hh, mm = code.split(":")[1:3]
            target = int(hh) * 3600 + int(mm) * 60
            delta = (target - now_tod) % 86400
            move_deadline = 0.0 if delta > 12 * 3600 else delta       # already past: no moves at all
    _ = by_id
    return Situation(now_step=state.step, lifts_up=lifts_up, eta_lifts_s=eta_lifts, eta_cut_s=eta_cut,
                     dark_now=list(state.impact.dark_levels), dark_planned=dark_planned,
                     valve_closed_at_s=valve_closed_at, stage2_averted=stage2, movers=movers, away=away,
                     flagged=flagged, rules=rules, enabled=enabled, dests=dests, moved=moved,
                     move_deadline_s=move_deadline, now_tod=now_tod, at_risk=at_risk, lift_feeder=lift_feeder)


def _start_tod() -> float:
    from ..world.state import SCENARIO_START_TOD

    return SCENARIO_START_TOD


def _planned_impacts(ctx: WorldContext, dark: set[str], lifts_up: bool, eta_cut: float | None,
                     moved: dict[str, str] | None = None) -> dict[str, list[str]]:
    """Critical impacts under the plan's own outcome (valve closed as soon as possible, lifts cut safely)."""
    out: dict[str, list[str]] = {}
    moved = moved or {}
    lifts_lost = (not lifts_up) or eta_cut is not None

    def moved_ok(rid: str) -> bool:
        where = moved.get(rid)
        return where is not None and (where == "outside" or not ctx.is_upstairs(ctx.space_level(where)))

    for r in ctx.roster.residents:
        if r.presence == "away":
            continue
        imp: list[str] = []
        if "step_free_route" in r.needs and lifts_lost and ctx.is_upstairs(r.level) and not moved_ok(r.id):
            imp.append("stranded")
        if r.medication_location and _fridge_in_dark(ctx, r, dark):
            imp.append("medication_at_risk")
        if "medical_device_power" in r.needs and r.level in dark and r.id not in moved:
            imp.append("device_power_lost")
        if imp:
            out[r.id] = imp
    return out


def _dt() -> float:
    from ..world.state import DT

    return DT


def _planned_dark_levels(ctx: WorldContext, state: WorldState, valve: str | None,
                         valve_closed_at: float | None) -> tuple[list[str], bool]:
    """Run the water forward with `valve` closing at `valve_closed_at`; which floors still die, and does
    the water stop short of the building's main switchboard (stage two: the whole building dark)?"""
    from ..building.graph import powered_levels

    h = Hydraulics(volumes={sp: w.volume for sp, w in state.water.items()}, flooded=set(state.flooded),
                   isolated=set(state.isolated), closed_valves=set(state.closed_valves),
                   leaks={e: l.flow_lps for e, l in state.leaks.items()}, wet=set(state.wet_spaces),
                   live=set(state.power.live))
    t = 0.0
    closed = valve is None or valve_closed_at is None
    horizon = state.forecast.horizon_s or 3600.0
    while t < horizon and not h.idle(ctx):
        if not closed and valve_closed_at is not None and t >= valve_closed_at:
            h.closed_valves.add(valve)
            closed = True
        t += FORECAST_DT
        step(h, ctx, FORECAST_DT)
    live = h.live if h.live else set(state.power.live)
    levels = powered_levels(ctx.graph, live)
    dark = sorted((lv for lv, ok in levels.items() if not ok), key=lambda lv: ctx.level_order[lv])
    stage2_averted = ctx.main_switchboard is None or ctx.main_switchboard not in h.flooded
    return dark, stage2_averted


def _destinations(ctx: WorldContext, dark: set[str], rules: set[str]) -> list[tuple[str, str, int, bool]]:
    out: list[tuple[str, str, int, bool]] = []
    # Powered residential floors first (people stay near home), then the ground floor; never below grade,
    # never a space the spec tags no_overflow.
    spaces = [s for s in ctx.spec.spaces if s.kind in OVERFLOW_KINDS and s.capacity > 0 and s.level not in dark
              and s.level not in ctx.below_ground and "no_overflow" not in s.tags]
    by_level: dict[str, list] = {}
    for s in spaces:
        by_level.setdefault(s.level, []).append(s)
    levels = sorted(by_level, key=lambda lv: (0 if lv != ctx.ground else 1, -ctx.level_order[lv]))
    for lv in levels:
        group = by_level[lv]
        cap = sum(s.capacity for s in group)
        name = (f"the {ctx.spec.level(lv).name} lounges" if lv != ctx.ground
                else f"{ctx.spec.level(lv).name.lower()}-floor community spaces (" + ", ".join(s.name for s in group[:3]) + ")")
        out.append((lv, name, cap, False))
    for d in ctx.spec.external_destinations:
        if d.off_campus and "no_off_campus" in rules:
            continue
        out.append((d.id, d.name, d.capacity, d.off_campus))
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
        _isolate_steps(ctx, sit, add, 0.0, now=True)
    everyone = [r.id for r in sit.movers] + [r.id for r in sit.away]
    first_dest = next((d for d in ctx.spec.external_destinations if not d.off_campus), None)
    add(id="relocate_all", kind="relocate", actor="housing", at_s=0.0, target=first_dest.id if first_dest else None,
        title=f"Move all {len(everyone)} residents of floors {_floors(ctx, sit.dark_planned)} to {first_dest.name if first_dest else 'another building'}",
        reason="Those floors lose lighting, outlets and heating for the night.", people=everyone,
        count=len(everyone), satisfies=["housing"])
    add(id="notify_all", kind="notify", actor="haven", at_s=0.0, count=len(everyone),
        title="Send one building-wide alert", reason="Everyone needs to know.", people=everyone)
    return steps


def _isolate_steps(ctx: WorldContext, sit: Situation, add, at_s: float, now: bool) -> None:
    """One isolate step per piece of equipment the forecast says floods, named from the spec."""
    for eid in sit.at_risk:
        eq = ctx.equipment[eid]
        lifts = eid == sit.lift_feeder
        add(id=f"isolate_{eid}", kind="isolate", actor="facilities", at_s=at_s, target=eid,
            title=f"Cut {eq.name}" + (" (lifts stop)" if lifts else "") + (" now" if now else ""),
            reason="Energised switchgear must not be under water." if not lifts else
                   "Same room, same water: the feed that runs the lifts is live too.",
            command={"equipment_id": eid, "command": "off"}, satisfies=["safety"])


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
    valve = _supply_valve(ctx)
    if sit.valve_closed_at_s is not None and valve is not None:
        add(id="close_valve", kind="valve", actor="plumber", at_s=max(0.0, sit.valve_closed_at_s - 420.0),
            deadline_s=sit.valve_closed_at_s, target=valve.id, title=f"Close the {valve.name.lower()}",
            reason=("Stops the riser; closes before the original switchgear floods" if sit.stage2_averted
                    else "Stops the riser, but too late to save the main switchboard: prepare for the whole building"),
            command={"equipment_id": valve.id, "command": "close"}, satisfies=["safety"])

    # -- power: hold for escorts, then cut before the water arrives --
    escorts: list[str] = []
    if sit.lifts_up and sit.eta_cut_s is not None:
        t = STAFF_RESPONSE_S
        for r in _wheelchair_users(ctx, sit):
            if not spoke(r.id):
                continue                      # nobody asked for them: the naive cut stands for them
            if not ctx.is_upstairs(r.level):
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
                target=ctx.assembly_point, title=f"Two staff bring {r.name} down by lift first, and stay with them",
                reason="Wheelchair user: the lift is the only step-free way out, and it dies when the power is cut.",
                satisfies=[f"resident:{r.id}"], count=1)
            escorts.append(r.id)
            t = done
        cut_at = min(sit.eta_cut_s, max([0.0] + [st.deadline_s or 0.0 for st in steps if st.kind == "escort"]))
        if escorts:
            add(id="hold_power", kind="hold", actor="facilities", at_s=0.0, deadline_s=cut_at, target=sit.lift_feeder,
                title=f"Keep the lifts energised for {cut_at / 60:.0f} more minutes",
                reason=f"Escorts finish by then; water reaches the switchgear ~{sit.eta_lifts_s / 60:.0f} min from now, "
                       f"{SAFETY_MARGIN_S / 60:.0f} min safety margin kept.", satisfies=["safety"] + [f"resident:{e}" for e in escorts])
        _isolate_steps(ctx, sit, add, cut_at, now=not escorts)
    else:
        cut_at = 0.0
        for r in _wheelchair_users(ctx, sit):
            if spoke(r.id) and ctx.is_upstairs(r.level):
                add(id=f"shelter_{r.id}", kind="shelter", actor="staff", at_s=STAFF_RESPONSE_S, people=[r.id],
                    target=r.room, title=f"{r.name}: stay put; two staff at the door with an evacuation chair",
                    reason="Lifts are already down. No step-free route exists, so staff stay with them.",
                    satisfies=[f"resident:{r.id}"], count=1)

    # -- things that must move before the floors go dark --
    dark_set = set(sit.dark_planned)
    meds = _story_first(ctx, [r for r in ctx.roster.residents if r.medication_location and spoke(r.id)
                              and _fridge_in_dark(ctx, r, dark_set)])
    for lv in sorted({ctx.equipment[r.medication_location].level for r in meds}, key=lambda x: ctx.level_order[x]):
        group = [r for r in meds if ctx.equipment[r.medication_location].level == lv]
        add(id=f"move_meds_{lv}", kind="move_item", actor=_ras_for(ctx, [lv]), at_s=60.0, deadline_s=cut_at or None,
            people=[r.id for r in group], target=_powered_fridge(ctx, dark_set, lv),
            title=f"Move the medication of {_names(group)} from the {ctx.spec.level(lv).name.lower()} fridge to a powered fridge",
            reason="Refrigerated medication must stay cold; that fridge dies with the floor.",
            satisfies=[f"resident:{r.id}" for r in group], count=len(group))

    # -- people: wake, escort the ones who need it, relocate by capacity --
    movers = list(sit.movers)
    if movers:
        ras = _ras_for(ctx, sit.dark_planned)
        deaf = [r for r in movers if "visual_alerts" in r.needs]
        add(id="wake_floors", kind="notify", actor=ras, at_s=STAFF_RESPONSE_S,
            deadline_s=cut_at + 300.0, people=[r.id for r in movers], count=len(movers),
            title=f"RAs knock on every door on {_floors(ctx, sit.dark_planned)}"
                  + (f"; a light, not a knock, for {', '.join(r.name.split()[0] for r in deaf if spoke(r.id))}"
                     if any(spoke(r.id) for r in deaf) else ""),
            reason=f"{sum(1 for r in movers if r.presence == 'asleep')} of them are asleep.",
            satisfies=[f"resident:{r.id}" for r in deaf if spoke(r.id)])
        devices = _story_first(ctx, [r for r in movers if "medical_device_power" in r.needs and spoke(r.id)])
        if devices:
            add(id="power_first", kind="relocate", actor=_ras_for(ctx, [r.level for r in devices]),
                at_s=STAFF_RESPONSE_S, deadline_s=cut_at or None, people=[r.id for r in devices],
                target=sit.dests[0][0] if sit.dests else None, count=len(devices),
                title=f"{_names(devices)} first: a powered room with an outlet for their device",
                reason="A powered medical device; the outlet dies with the floor.",
                satisfies=[f"resident:{r.id}" for r in devices])
        dogs = _story_first(ctx, [r for r in movers if "guide_dog" in r.needs and spoke(r.id)])
        if dogs:
            add(id="escort_guide_dog", kind="escort", actor=_ras_for(ctx, [r.level for r in dogs]),
                at_s=STAFF_RESPONSE_S, deadline_s=cut_at + RELOCATION_S, people=[r.id for r in dogs], count=len(dogs),
                title=f"RA escorts {_names(dogs)} and the guide dog down the stairs",
                reason="Blind; moves independently but a dark, crowded stair is where people get hurt.",
                satisfies=[f"resident:{r.id}" for r in dogs])
        slow = _story_first(ctx, [r for r in movers if "stairs_slow" in r.needs and spoke(r.id)])
        if slow:
            add(id="escort_stairs", kind="escort", actor="staff", at_s=STAFF_RESPONSE_S,
                deadline_s=cut_at + RELOCATION_S, people=[r.id for r in slow], count=len(slow),
                title=f"Someone beside {_names(slow)} on the stairs" + (", after the lift escorts" if escorts else ""),
                reason="Limited mobility: stairs only slowly, with help.", satisfies=[f"resident:{r.id}" for r in slow])
        # Allocation by capacity, floor by floor, keeping floors together where possible.
        # People a specific step already places (lift escorts end in the lobby, shelter stays put).
        assigned: set[str] = {p for st in steps if st.kind in ("relocate", "shelter") for p in st.people}
        assigned |= {p for st in steps if st.kind == "escort" and st.target == ctx.assembly_point for p in st.people}
        queue = [r for r in movers if r.id not in assigned]
        groups: list[tuple[str, list[Resident]]] = []
        shelter_reason = None
        if "shelter_in_place" in sit.rules:
            shelter_reason = "Rule from the manager: " + describe_rule("shelter_in_place")
        elif sit.move_deadline_s is not None and cut_at + RELOCATION_S > sit.move_deadline_s:
            shelter_reason = (f"Rule from the manager: no relocation after {_hm(sit.now_tod + sit.move_deadline_s)}; "
                             f"the move would run until {_hm(sit.now_tod + cut_at + RELOCATION_S)}")
        if shelter_reason and queue:
            add(id="shelter_floors", kind="shelter", actor="housing", at_s=cut_at, people=[r.id for r in queue],
                count=len(queue), title=f"{len(queue)} residents shelter in place on {_floors(ctx, sit.dark_planned)}; "
                "RAs check every room, emergency lighting stays on",
                reason=shelter_reason, satisfies=["housing"])
            queue = []
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
        reason=f"Riser break, basement flooding, {_cut_names(ctx, sit)} at risk; two lines for the dean.")
    return steps


# ---- agents --------------------------------------------------------------------------------


def _evaluate(ctx: WorldContext, sit: Situation, steps: list[PlanStep], spoken: dict | None = None) -> list[Stance]:
    """Every enabled agent's stance on `steps`: what it said (a logged AgentStance for this situation and
    round) when it has spoken, the rule function otherwise. The checker never goes through here."""
    spoken = spoken or {}
    ids = {st.id for st in steps}

    def said(agent: str, label: str, resident: str | None, fallback: Stance | None) -> Stance | None:
        sp = spoken.get(agent)
        if sp is None:
            return fallback
        c = None
        if sp.constraint_code or sp.constraint_rule:
            c = Constraint(type=sp.constraint_type or "hard", rule=sp.constraint_rule or sp.constraint_code or "",
                           code=sp.constraint_code or "", source=agent)
        return Stance(agent=agent, label=label, stance=sp.stance, reason=sp.reason, constraint=c,
                      step_ids=[x for x in sp.step_ids if x in ids], resident=resident, source=sp.source)

    out: list[Stance | None] = []
    if "safety" in sit.enabled:
        out.append(said("safety", "Safety agent", None, _safety(ctx, sit, steps)))
    if "housing" in sit.enabled:
        out.append(said("housing", "Housing agent", None, _housing(ctx, sit, steps)))
    if "capacity" in sit.enabled:
        out.append(said("capacity", "Capacity agent", None, _capacity(sit, steps)))
    by_id = ctx.roster.by_id()
    order = _order(ctx)
    agents = sorted((a for a in sit.enabled if a.startswith("resident:")),
                    key=lambda a: (order.get(a.split(":", 1)[1], 99), a))
    for a in agents:
        r = by_id.get(a.split(":", 1)[1])
        if r is None:
            continue
        out.append(said(a, f"{r.name.split()[0]}'s agent", r.id, _resident(ctx, sit, r, steps)))
    return [x for x in out if x is not None]


def _find(steps: list[PlanStep], kind: str, **attrs) -> PlanStep | None:
    for st in steps:
        if st.kind == kind and all(getattr(st, k) == v for k, v in attrs.items()):
            return st
    return None


def _steps_for(steps: list[PlanStep], rid: str, kinds: tuple[str, ...] = ()) -> list[PlanStep]:
    return [st for st in steps if rid in st.people and (not kinds or st.kind in kinds)]


def _cut_time(steps: list[PlanStep]) -> float | None:
    """When the switchgear is cut: the first isolate step (they are issued together)."""
    times = [st.at_s for st in steps if st.kind == "isolate"]
    return min(times) if times else None


def _safety(ctx: WorldContext, sit: Situation, steps: list[PlanStep]) -> Stance:
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
                          reason=f"Cut {_cut_names(ctx, sit)} now: the water is "
                                 f"{sit.eta_lifts_s / 60:.0f} min from the switchgear and every minute energised is risk.")
        return Stance(agent="safety", label="Safety agent", stance="support", constraint=rule, step_ids=isolates,
                      reason=f"Isolation at +{cut / 60:.0f} min keeps the {SAFETY_MARGIN_S / 60:.0f} min margin. Acceptable.")
    return Stance(agent="safety", label="Safety agent", stance="support", constraint=rule,
                  step_ids=[st.id for st in steps if st.kind in ("valve", "call")],
                  reason="The switchgear is already lost; stop the water and keep everyone out of the basement.")


def _housing(ctx: WorldContext, sit: Situation, steps: list[PlanStep]) -> Stance:
    reloc = [st for st in steps if st.kind == "relocate"]
    n = sum(st.count for st in reloc)
    shelter = _find(steps, "shelter", id="shelter_floors")
    if shelter:
        return Stance(agent="housing", label="Housing agent", stance="support", step_ids=[shelter.id],
                      reason=f"{shelter.count} people stay in their rooms under the manager's rule; "
                             f"{n} with a hard need still move.")
    if len(reloc) <= 1:
        return Stance(agent="housing", label="Housing agent", stance="propose", step_ids=[st.id for st in reloc],
                      reason=f"{len(sit.movers) + len(sit.away)} residents live on floors {_floors(ctx, sit.dark_planned)}; "
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
    upstairs = ctx.is_upstairs(r.level)
    dark = r.level in set(sit.dark_planned)

    def S(stance, reason, constraint=None, ids=()):
        return Stance(agent=agent, label=label, stance=stance, reason=reason, constraint=constraint,
                      step_ids=list(ids), resident=r.id)

    if "step_free_route" in r.needs and r.presence != "away" and upstairs:
        c = Constraint(type="hard", rule=f"{first} keeps a feasible step-free route", code=f"step_free:{r.id}", source=agent)
        if r.id in sit.moved and "stranded" not in impacts:
            where = sit.moved[r.id]
            place = ctx.spec.space(where).name if where in ctx.areas else "another building"
            return S("support", f"{first} is already in the {place.lower()}, where the plan put them. Nothing more to ask.", c)
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

    if r.medication_location and _fridge_in_dark(ctx, r, set(sit.dark_planned)):
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


# ---- the adversarial checker -----------------------------------------------------------------


def _check(ctx: WorldContext, sit: Situation, steps: list[PlanStep], left_behind: list[str]) -> list[Check]:
    """Verify the final plan against every hard constraint from the facts, not from who spoke.

    Agents can be switched off; the checker cannot. A violation here is what the ledger reports.
    """
    by_id = ctx.roster.by_id()
    out: list[Check] = []
    cut = _cut_time(steps)
    first = lambda rid: by_id[rid].name.split()[0]  # noqa: E731

    # Safety: switchgear dead before water contact, with the margin; no lift use after isolation.
    if sit.lifts_up and sit.eta_cut_s is not None:
        ok = cut is not None and cut <= sit.eta_cut_s + 1e-6
        out.append(Check(code="deenergise_before_contact", label="Switchgear isolated before water contact",
                         ok=ok, severity="safety",
                         detail=(f"cut at +{cut / 60:.0f} min, water at +{sit.eta_lifts_s / 60:.0f} min, "
                                 f"{SAFETY_MARGIN_S / 60:.0f} min margin" if cut is not None else "no isolation step")))
        late = [st for st in steps if st.kind == "escort" and st.target == ctx.assembly_point and st.deadline_s is not None
                and cut is not None and st.deadline_s > cut + 1e-6]
        out.append(Check(code="no_lift_after_cut", label="No lift use after isolation", ok=not late, severity="safety",
                         detail=", ".join(st.title for st in late) if late else "every lift escort finishes before the cut"))
    out.append(Check(code="nobody_in_basement", label="No resident sent to the basement", severity="safety",
                     ok=not any(ctx.place_level(st.target) in ctx.below_ground
                                for st in steps if st.kind in ("relocate", "escort", "shelter")),
                     detail="all destinations above grade"))

    # Access and medical needs: every person with a hard need has a step with their name on it.
    for r in ctx.roster.residents:
        imp = sit.flagged.get(r.id, [])
        if "stranded" in imp:
            out.append(Check(code=f"step_free:{r.id}", label=f"{r.name} keeps a way out (wheelchair)", severity="access",
                             ok=r.id not in left_behind,
                             detail="lift escort or staff at the door" if r.id not in left_behind else "no step covers them"))
        if "medication_at_risk" in imp:
            out.append(Check(code=f"meds:{r.id}", label=f"{first(r.id)}'s medication stays refrigerated", severity="access",
                             ok=bool(_steps_for(steps, r.id, ("move_item",))),
                             detail="moved to a powered fridge" if _steps_for(steps, r.id, ("move_item",)) else "left in a dead fridge"))
        if "device_power_lost" in imp:
            okd = any(st.id == "power_first" for st in _steps_for(steps, r.id, ("relocate",)))
            out.append(Check(code=f"device_power:{r.id}", label=f"{first(r.id)} sleeps next to a powered outlet", severity="access",
                             ok=okd, detail="placed first, with an outlet" if okd else "no powered placement"))

    # Capacity.
    caps = {d[0]: d[2] for d in sit.dests}
    over = [st for st in steps if st.kind == "relocate" and st.target in caps and st.count > caps[st.target]]
    out.append(Check(code="capacity", label="No space over capacity", ok=not over, severity="capacity",
                     detail=", ".join(f"{st.target} {st.count}/{caps[st.target]}" for st in over) if over else
                     f"{sum(st.count for st in steps if st.kind == 'relocate')} placed within capacity"))

    # The manager's rules.
    for code in sorted(sit.rules):
        if code == "no_off_campus":
            off_ids = {d.id for d in ctx.spec.external_destinations if d.off_campus}
            bad = [st for st in steps if st.kind == "relocate" and st.target in off_ids]
            out.append(Check(code=code, label="Nobody moved off campus", ok=not bad, severity="rule",
                             detail=f"{sum(st.count for st in bad)} off campus" if bad else "all placements on campus"))
        elif code == "no_wake":
            asleep = {r.id for r in ctx.roster.residents if r.presence == "asleep"}
            bad = [st for st in steps if st.kind == "relocate" and st.id.startswith("relocate_") and set(st.people) & asleep]
            out.append(Check(code=code, label="Nobody asleep is woken", ok=not bad, severity="rule",
                             detail="sleeping residents shelter in place" if not bad else f"{len(bad)} relocation steps wake people"))
        elif code == "shelter_in_place":
            bad = [st for st in steps if st.kind == "relocate" and st.id.startswith("relocate_")]
            out.append(Check(code=code, label="Everyone shelters in place", ok=not bad, severity="rule",
                             detail="only hard needs move" if not bad else f"{len(bad)} general relocations"))
        elif code.startswith("no_moves_after:"):
            deadline = sit.move_deadline_s
            bad = [st for st in steps if st.kind == "relocate" and st.id.startswith("relocate_") and st.deadline_s is not None
                   and deadline is not None and st.deadline_s > deadline + 1e-6]
            out.append(Check(code=code, label=f"No relocation after {code.split(':', 1)[1]}", ok=not bad, severity="rule",
                             detail="moves finish in time or people shelter" if not bad else f"{len(bad)} moves run past the deadline"))
        elif code == "lifts_first":
            esc = [st for st in steps if st.kind == "escort" and st.target == ctx.assembly_point]
            others = [st for st in steps if st.kind == "relocate" and st.id.startswith("relocate_")]
            ok = not esc or not others or min(st.at_s for st in esc) <= min(st.at_s for st in others) + 1e-6
            out.append(Check(code=code, label="Wheelchair users come down first", ok=ok, severity="rule",
                             detail="lift escorts start before any relocation" if ok else "a relocation starts before the escorts"))
    return out


def _redteam_stance(attacks: list[Attack]) -> Stance:
    """The attacker's own word on the final plan. Rule-based, cannot be switched off."""
    rule = Constraint(type="hard", rule="The plan survives a faster leak, double-booked staff, stair crush, a late valve, and forgets nobody",
                      code="redteam", source="redteam")
    broken = [a for a in attacks if not a.ok]
    fixed = [a for a in attacks if a.fixed]
    if broken:
        return Stance(agent="redteam", label="Red team", stance="veto", constraint=rule,
                      reason=f"{len(broken)} attack{'s' if len(broken) != 1 else ''} landed and nothing fixes it: " + "; ".join(a.label for a in broken[:2]))
    if fixed:
        return Stance(agent="redteam", label="Red team", stance="critique", constraint=rule,
                      reason=f"{len(fixed)} attack{'s' if len(fixed) != 1 else ''} landed; the plan was changed: " + "; ".join(f"{a.label} → {a.fix}" for a in fixed[:2]))
    return Stance(agent="redteam", label="Red team", stance="support", constraint=rule,
                  reason=f"{len(attacks)} attacks tried, none landed: " + "; ".join(a.label.lower() for a in attacks[:3]) + ".")


def _checker_stance(ctx: WorldContext, checks: list[Check]) -> Stance:
    bad = [c for c in checks if not c.ok]
    rule = Constraint(type="hard", rule="Every hard constraint verified against the facts, not against who spoke",
                      code="checker", source="checker")
    if bad:
        return Stance(agent="checker", label="Checker agent", stance="veto", constraint=rule,
                      reason=f"{len(bad)} violation{'s' if len(bad) != 1 else ''}: " + "; ".join(c.label for c in bad[:3]))
    return Stance(agent="checker", label="Checker agent", stance="support", constraint=rule,
                  reason=f"{len(checks)} checks pass: safety margin, access, medication, capacity, rules.")


def _cut_names(ctx: WorldContext, sit: Situation) -> str:
    """The at-risk switchgear, named from the spec ('MSB section B and ATS-EQ')."""
    names = [ctx.equipment[e].name for e in sit.at_risk]
    return " and ".join(names) if names else "the switchgear"


def _supply_valve(ctx: WorldContext):
    """The shut-off valve upstream of the monitored riser (the first valve in the spec as a fallback)."""
    for sensor in ctx.sensor_ids:
        for eq in ctx.sensor_targets.get(sensor, ()):
            v = ctx.valve_for(eq)
            if v:
                return ctx.equipment[v]
    return next((e for e in ctx.spec.equipment if e.kind == "valve"), None)


def _story_first(ctx: WorldContext, rs: list[Resident]) -> list[Resident]:
    order = _order(ctx)
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
        if "stranded" in crit and ctx.is_upstairs(r.level):
            ok &= bool(_steps_for(steps, rid, ("escort", "shelter")))
        if "medication_at_risk" in crit:
            ok &= bool(_steps_for(steps, rid, ("move_item",)))
        if "device_power_lost" in crit:
            ok &= any(st.id == "power_first" for st in _steps_for(steps, rid, ("relocate",)))
        if not ok:
            out.append(rid)
    order = _order(ctx)
    return sorted(out, key=lambda x: (order.get(x, 99), x))


def _wheelchair_users(ctx: WorldContext, sit: Situation) -> list[Resident]:
    order = _order(ctx)
    users = [r for r in ctx.roster.residents if "step_free_route" in r.needs and r.presence != "away"
             and r.id not in sit.moved]
    return sorted(users, key=lambda r: (0 if r.level in set(sit.dark_planned) else 1, order.get(r.id, 99), r.id))


def _metrics(sit: Situation, steps: list[PlanStep], left_behind: list[str]) -> dict[str, float | int]:
    cut = _cut_time(steps)
    reloc = sum(st.count for st in steps if st.kind == "relocate")
    off = sum(st.count for st in steps if st.kind == "relocate" and st.target in {d[0] for d in sit.dests if d[3]})
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
        return (f"Cut the power now and move floors {_floors(ctx, sit.dark_planned)} by the stairs. "
                f"{names} {'is' if len(left_behind) == 1 else 'are'} left behind.")
    if cut is not None and cut > 0:
        return (f"Hold the lifts {cut / 60:.0f} min for escorts, then cut {_cut_names(ctx, sit)}; "
                f"floors {_floors(ctx, sit.dark_planned)} relocate on campus. Nobody left behind.")
    if cut is not None:
        return (f"Cut {_cut_names(ctx, sit)} now, stop the water; floors {_floors(ctx, sit.dark_planned)} relocate "
                "on campus. Nobody left behind.")
    return "Stop the water, keep everyone out of the basement, relocate the dark floors. Nobody left behind."


def _hm(tod: float) -> str:
    t = int(tod) % 86400
    return f"{t // 3600:02d}:{(t % 3600) // 60:02d}"


_GENERIC = {
    "en": "{building}: floors {floors} lose power tonight. Take what you need for the night and go to {dest}. "
          "Your RA will knock. Reply HELP if you need assistance.",
    "es": "{building}: los pisos {floors} se quedan sin electricidad esta noche. Lleve lo necesario para la noche "
          "y vaya a {dest}. Su RA llamará a su puerta. Responda AYUDA si necesita asistencia.",
    "zh": "{building}：{floors} 楼今晚停电。请带上过夜所需物品前往{dest}。楼层助理会敲门通知。如需帮助请回复 HELP。",
}
_SHELTER_GENERIC = {
    "en": "{building}: floors {floors} lose power tonight. Stay in your room; emergency lighting stays on and your "
          "RA will check on you. Reply HELP if you need anything.",
    "es": "{building}: los pisos {floors} se quedan sin electricidad esta noche. Quédese en su habitación; la "
          "iluminación de emergencia sigue funcionando y su RA pasará a verle. Responda AYUDA si necesita algo.",
    "zh": "{building}：{floors} 楼今晚停电。请留在房间内，应急照明保持开启，楼层助理会来查看。如需帮助请回复 HELP。",
}


def _messages(ctx: WorldContext, sit: Situation, steps: list[PlanStep]) -> list[Message]:
    by_id = ctx.roster.by_id()
    staff = {s.id: s for s in ctx.roster.staff}
    out: list[Message] = []
    floors = _floors(ctx, sit.dark_planned)
    cut = _cut_time(steps)
    cut_hm = _hm(sit.now_tod + cut) if cut is not None else None
    personal: set[str] = set()

    story = set(ctx.story_order)
    short = ctx.short_name
    floor_of = lambda r: ctx.spec.level(r.level).name  # noqa: E731  ("Floor 4", "Ground")
    grouped: dict[tuple[str, str], list[str]] = {}       # (step id, lang) -> resident ids
    group_text: dict[tuple[str, str], tuple[str, PlanStep, str, str]] = {}

    def msg(to: str, text: str, step: PlanStep | None, priority: str = "normal", lang: str | None = None,
            role: str = "resident", channel: str | None = None, name: str | None = None, count: int = 1) -> None:
        r = by_id.get(to)
        st = staff.get(to)
        # Generated residents with a routine step share one grouped message per step and language.
        if r is not None and r.id not in story and priority != "critical" and step is not None:
            key = (step.id, r.contact.lang)
            grouped.setdefault(key, []).append(r.id)
            group_text.setdefault(key, (text.split(", this is HAVEN", 1)[-1].lstrip(". "), step, channel or r.contact.channel, priority))
            return
        out.append(Message(
            id=f"msg_{len(out) + 1:02d}_{to}", to=to,
            name=name or (r.name if r else st.name if st else to),
            role=role, channel=channel or (r.contact.channel if r else st.contact.channel if st else "sms"),
            lang=lang or (r.contact.lang if r else "en"), priority=priority, text=text,
            step_ids=[step.id] if step else [], count=count,
        ))

    for st in steps:
        if st.kind == "escort" and st.target == ctx.assembly_point and len(st.people) == 1:
            r = by_id[st.people[0]]
            personal.add(r.id)
            mins = max(1, round(st.at_s / 60))
            msg(r.id, f"{r.name.split()[0]}, this is HAVEN at {short}. Water in the basement means the lifts "
                      f"will stop at {cut_hm}. Two staff are coming to your door in about {mins} minutes to bring you "
                      f"down by lift. Please wait there and do not use the stairs. They will stay with you.",
                st, "critical", channel="call" if r.contact.channel == "call" else None)
        elif st.kind == "shelter" and len(st.people) == 1:
            r = by_id[st.people[0]]
            personal.add(r.id)
            msg(r.id, f"{r.name.split()[0]}, this is HAVEN at {short}. Floors {floors} lose power tonight"
                      f"{'; your floor keeps power' if r.level not in set(sit.dark_planned) else ''}. "
                      f"Please stay where you are; a staff member will come to your door to check on you.",
                st, "critical")
        elif st.kind == "move_item":
            to_fridge = ctx.equipment.get(st.target or "")
            dest = f"the powered {ctx.spec.level(to_fridge.level).name.lower()} fridge" if to_fridge else "a powered fridge"
            for rid in st.people:
                r = by_id[rid]
                personal.add(rid)
                msg(rid, f"{r.name.split()[0]}, this is HAVEN. {floor_of(r)} loses power tonight. Your RA is "
                         f"moving your medication from the {floor_of(r).lower()} fridge to {dest} "
                         f"now; it stays cold. Ask any staff member when you need it.", st, "critical")
        elif st.id == "power_first":
            for rid in st.people:
                r = by_id[rid]
                personal.add(rid)
                msg(rid, f"{r.name.split()[0]}, this is HAVEN. {floor_of(r)} loses power tonight, including "
                         f"your outlet. Your RA will walk you to a powered lounge first, before anyone else moves, "
                         f"so your device runs all night. Pack it and the cable.", st, "critical")
        elif st.id == "escort_guide_dog":
            for rid in st.people:
                r = by_id[rid]
                personal.add(rid)
                msg(rid, f"{r.name.split()[0]}, this is HAVEN. {floor_of(r)} loses power tonight. Your RA is "
                         f"coming to walk down with you and your dog; the stairwell will be busy. Wait at your door.",
                    st, "normal", channel="call")
        elif st.id == "escort_stairs":
            for rid in st.people:
                r = by_id[rid]
                personal.add(rid)
                msg(rid, f"{r.name.split()[0]}, this is HAVEN. {floor_of(r)} loses power tonight. Please wait "
                         f"at your door; a staff member will come to take the stairs with you at your pace.", st)
        elif st.id == "away_notify":
            for rid in st.people:
                r = by_id[rid]
                personal.add(rid)
                msg(rid, f"{r.name.split()[0]}, this is HAVEN. A basement leak at {short} means floors "
                         f"{floors} have no power tonight. Nothing is needed from you now. When you are back"
                         f"{' at ' + r.away_until if r.away_until else ''}, come to the front desk and we will "
                         f"show you where to sleep. Your room and belongings are secure.", st, channel="sms")

    deaf = [by_id[p] for st in steps if st.id == "wake_floors" for p in st.people if "visual_alerts" in by_id[p].needs]
    for r in deaf:
        personal.add(r.id)
        msg(r.id, f"{r.name.split()[0]}, this is HAVEN (text only). {floor_of(r)} loses power tonight. Your RA "
                  f"will flash a light at your door, not knock. Please go with them to the lounge they show you.",
            _find(steps, "notify", id="wake_floors"), "critical", channel="text_only")

    for (sid, lang), ids in grouped.items():
        body, step, channel, priority = group_text[(sid, lang)]
        out.append(Message(id=f"msg_{len(out) + 1:02d}_{sid}_{lang}", to=f"group_{sid}_{lang}",
                           name=f"{len(ids)} residents · {step.kind}" + (f" ({lang})" if lang != "en" else ""),
                           role="resident", channel=channel, lang=lang, priority=priority,
                           text="This is HAVEN. " + body[0].upper() + body[1:], step_ids=[sid], count=len(ids)))

    shelter_all = _find(steps, "shelter", id="shelter_floors")
    for st in steps:
        if st.kind == "relocate" and st.id.startswith("relocate_"):
            dest = next((d[1] for d in sit.dests if d[0] == st.target), st.target or "")
            rest = [p for p in st.people if p not in personal]
            langs = sorted({by_id[p].contact.lang for p in rest})
            for lang in langs:
                tmpl = _GENERIC.get(lang, _GENERIC["en"])
                n = sum(1 for p in rest if by_id[p].contact.lang == lang)
                msg(f"group_{st.target}_{lang}", tmpl.format(building=short, floors=_floors(ctx, sit.dark_planned, lang), dest=dest), st, "normal", lang=lang,
                    name=f"{n} residents → {dest}" + (f" ({lang})" if lang != "en" else ""), channel="app", count=n)
    if shelter_all:
        rest = [p for p in shelter_all.people if p not in personal]
        for lang in sorted({by_id[p].contact.lang for p in rest}):
            n = sum(1 for p in rest if by_id[p].contact.lang == lang)
            tmpl = _SHELTER_GENERIC.get(lang, _SHELTER_GENERIC["en"])
            msg(f"group_shelter_{lang}", tmpl.format(building=short, floors=_floors(ctx, sit.dark_planned, lang)), shelter_all, "normal", lang=lang,
                name=f"{n} residents stay in place" + (f" ({lang})" if lang != "en" else ""), channel="app", count=n)

    # -- staff --
    for lv in sit.dark_planned:
        ra = by_id.get(ctx.ra_for(lv) or "")
        if ra is None:
            continue
        on_floor = [by_id[p] for st in steps for p in st.people if by_id[p].level == lv and by_id[p].id in personal]
        names = "; ".join(f"{r.name} ({ctx.spec.space(r.room).name}: {', '.join(NEED_WORDS.get(n, n) for n in r.needs) or 'see plan'})"
                          for r in _story_first(ctx, on_floor))
        count = sum(1 for r in ctx.roster.residents if r.level == lv and r.presence != "away")
        msg(ra.id, f"{ra.name.split()[0]}: {ctx.spec.level(lv).name.lower()} goes dark at {cut_hm or 'the cut-off'}. Knock on every door "
                   f"({count} people, {sum(1 for r in ctx.roster.residents if r.level == lv and r.presence == 'asleep')} "
                   f"asleep). First, these: {names or 'nobody flagged'}.", _find(steps, "notify", id="wake_floors"),
            "critical", role="staff", channel="call", name=ra.name)
    cut_names = " and ".join(ctx.equipment[e].name for e in sit.at_risk) or "the switchgear"
    cut_room = ctx.spec.space(ctx.equipment[sit.at_risk[0]].space).name.lower() if sit.at_risk else "the electrical room"
    valve = _supply_valve(ctx)
    tech = ctx.staff_by_role("facilities")
    if tech:
        msg(tech.id, f"{tech.name.split()[0]}: close nothing yet. At {cut_hm or 'the cut-off'} open {cut_names} ({cut_room}, "
                     f"do not enter standing water). Plumber is called for the {valve.name.lower() if valve else 'main valve'}.",
            next((st for st in steps if st.kind == "isolate"), None), "critical", role="staff", channel="call")
    desk = ctx.staff_by_role("desk")
    first_escort = next((st for st in steps if st.kind == "escort" and st.target == ctx.assembly_point and st.people), None)
    if desk and first_escort:
        who = by_id[first_escort.people[0]]
        need = NEED_WORDS.get(who.needs[0], who.needs[0]) if who.needs else "escorted"
        msg(desk.id, f"{desk.name.split()[0]}: {ctx.spec.space(ctx.assembly_point).name.lower()} is the assembly point. "
                     f"{who.name} ({need}) arrives by lift with two staff; keep the accessible bathroom free and a chair-height table clear.",
            first_escort, "normal", role="staff", channel="app")
    msg("plumber", f"Emergency plumber call: {ctx.spec.name}, {ctx.spec.address}. Riser burst in the basement "
                   f"mechanical room, main shut-off valve needs a valve key. Water reaches the switchgear in "
                   f"~{sit.eta_lifts_s / 60:.0f} min. Come to the service door; facilities will meet you."
        if sit.eta_lifts_s else f"Emergency plumber call: {ctx.spec.name} basement riser burst; the main shut-off valve needs a key.",
        _find(steps, "call", id="call_plumber"), "critical", role="external", channel="call", name="Emergency plumber")
    reloc = sum(st.count for st in steps if st.kind == "relocate")
    reloc = sum(st.count for st in steps if st.kind == "relocate")
    dean = ctx.staff_by_role("dean")
    if dean:
        msg(dean.id, f"{ctx.spec.name}: basement water leak, floors {floors} without power tonight; {reloc} students relocated "
                     f"on campus, {len(sit.away)} away and informed. Every resident with an access or medical need has a "
                     f"named staff member; no one is off campus.", _find(steps, "ticket", id="ticket"), "normal",
            role="staff", channel="sms")
    manager = next((st for st in ctx.roster.staff if st.on_call), None)
    if manager:
        msg(manager.id, f"{manager.name.split()[0]}: plan is ready for your approval. Lifts held until {cut_hm or '—'} for escorts, "
                        f"then {cut_names} cut; {reloc} residents relocate on campus; plumber ETA ~{PLUMBER_ETA_S / 60:.0f} min. "
                        f"Say a rule or tap approve.", None, "critical", role="staff", channel="call")
    return out


NEED_WORDS = {
    "step_free_route": "wheelchair", "stairs_slow": "stairs slowly, with help", "visual_alerts": "Deaf: light, not knock",
    "guide_dog": "blind, guide dog", "refrigerated_medication": "refrigerated medication",
    "medical_device_power": "powered medical device",
}


def _ras_for(ctx: WorldContext, levels) -> str:
    """The actor string for the RAs of these levels ('ra_3,ra_4'), 'staff' when no RA lives there."""
    ids = sorted({rid for lv in levels for rid in [ctx.ra_for(lv)] if rid and ctx.is_upstairs(lv)})
    return ",".join(ids) or "staff"


def _round_summary(ctx: WorldContext, n: int, stances: list[Stance]) -> str:
    vetoes = [s.label for s in stances if s.stance == "veto"]
    crit = [s.label for s in stances if s.stance == "critique"]
    if n == 1:
        parts = []
        if vetoes:
            parts.append("vetoed by " + ", ".join(vetoes))
        if crit:
            parts.append(f"{len(crit)} objection{'s' if len(crit) != 1 else ''}")
        first = next((d.name.split(" (")[0] for d in ctx.spec.external_destinations if not d.off_campus), "another building")
        return f"Cut now, move everyone to {first} — " + ("; ".join(parts) if parts else "no objections")
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


def _floors(ctx: WorldContext, levels: list[str], lang: str = "en") -> str:
    """Levels as people say them: 'floors 3 and 4' reads from each level's short label in the spec."""
    names = [ctx.level_short(lv) for lv in levels]
    if not names:
        return "—"
    if len(names) == 1:
        return names[0]
    joiner = {"es": " y ", "zh": "、"}.get(lang, " and ")
    sep = "、" if lang == "zh" else ", "
    return sep.join(names[:-1]) + joiner + names[-1]


_ = math
