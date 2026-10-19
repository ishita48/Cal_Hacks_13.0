"""The cascade: what a set of failures means for the building and for every person in it.

Everything here is deterministic graph work. `assess` turns the live-power set into a
per-resident impact list; `describe` turns one step's happenings into human-readable chain
events; `forecast` runs the hydraulics forward to predict the chain before it happens.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from ..building.graph import OUTSIDE, POWER_RELS, powered_levels, route
from ..people.roster import Resident
from .context import WorldContext
from .physics import Happening, Hydraulics, step

Severity = Literal["info", "warning", "critical"]

# Resident impact codes, in display priority order.
IMPACTS: tuple[str, ...] = (
    "stranded",            # needs a step-free route and none exists
    "medication_at_risk",  # refrigerated medication in a dead fridge
    "device_power_lost",   # powered medical device on a dark floor
    "stairs_only_slow",    # mobility-limited, can do stairs slowly with help
    "needs_escort",        # blind / guide dog: escort through a dark, crowded corridor
    "needs_visual_alert",  # Deaf: will not hear anything
    "power_lost",          # room is dark
    "away",                # not in the building (inform, do not relocate)
)
_CRITICAL = {"stranded", "medication_at_risk", "device_power_lost"}
_WARNING = {"stairs_only_slow", "needs_escort", "needs_visual_alert"}


class ResidentImpact(BaseModel):
    id: str
    name: str
    room: str
    level: str
    presence: str
    needs: list[str]
    impacts: list[str]
    severity: Severity
    channel: str
    lang: str
    role: str = "resident"


class Impact(BaseModel):
    dark_levels: list[str] = Field(default_factory=list)
    lifts_down: list[str] = Field(default_factory=list)
    fridges_down: list[str] = Field(default_factory=list)
    wet_spaces: list[str] = Field(default_factory=list)
    # People with a specific need the plan must honour (severity warning/critical), in priority order.
    residents: list[ResidentImpact] = Field(default_factory=list)
    # Everyone else affected (room dark, nothing more): ids only; the client has the roster.
    others: list[str] = Field(default_factory=list)
    # Step-free routes (space ids) for residents who depend on one; None = stranded.
    routes: dict[str, list[str] | None] = Field(default_factory=dict)
    counts: dict[str, int] = Field(default_factory=dict)


class ChainEvent(BaseModel):
    eta_s: float = 0.0
    kind: str
    id: str
    message: str
    severity: Severity = "info"
    cause: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class Forecast(BaseModel):
    computed_step: int = 0
    horizon_s: float = 0.0
    events: list[ChainEvent] = Field(default_factory=list)
    impact: Impact = Field(default_factory=Impact)
    settled: bool = True       # True when the water stopped doing anything within the horizon


# ---- impact --------------------------------------------------------------------------------


def assess(ctx: WorldContext, live: set[str], wet: set[str], moved: dict[str, str] | None = None) -> Impact:
    moved = moved or {}
    G = ctx.graph
    levels = powered_levels(G, live)
    dark = sorted((lv for lv, ok in levels.items() if not ok), key=lambda lv: ctx.level_order[lv])
    dark_set = set(dark)
    lifts_down = [l for l in ctx.lifts if l not in live]
    lifts_ok = not lifts_down
    fridges_down = sorted(e.id for e in ctx.equipment.values() if e.kind == "fridge" and e.id not in live)

    routes: dict[str, list[str] | None] = {}
    residents: list[ResidentImpact] = []
    others: list[str] = []
    counts: dict[str, int] = {k: 0 for k in IMPACTS}
    counts.update(on_dark_floors=0, asleep=0, affected=0)

    for r in ctx.roster.residents:
        impacts = _resident_impacts(ctx, r, live, dark_set, lifts_ok, routes, moved.get(r.id))
        if not impacts or impacts == ["away"]:
            continue
        for k in impacts:
            counts[k] += 1
        counts["affected"] += 1
        if r.level in dark_set:
            counts["on_dark_floors"] += 1
        if r.presence == "asleep":
            counts["asleep"] += 1
        severity = _severity(impacts)
        if severity == "info":
            others.append(r.id)
            continue
        residents.append(ResidentImpact(
            id=r.id, name=r.name, room=r.room, level=r.level, presence=r.presence, needs=list(r.needs),
            impacts=impacts, severity=severity, channel=r.contact.channel, lang=r.contact.lang,
            role=r.role,
        ))

    rank = {"critical": 0, "warning": 1, "info": 2}
    residents.sort(key=lambda x: (rank[x.severity], -ctx.level_order[x.level], x.name))
    return Impact(dark_levels=dark, lifts_down=lifts_down, fridges_down=fridges_down, wet_spaces=sorted(wet),
                  residents=residents, others=others, routes=routes, counts=counts)


def _resident_impacts(ctx: WorldContext, r: Resident, live: set[str], dark: set[str], lifts_ok: bool,
                      routes: dict[str, list[str] | None], moved_to: str | None = None) -> list[str]:
    out: list[str] = []
    here = moved_to or (r.location if r.presence == "elsewhere" and r.location else r.room)
    if here == "outside":
        return []
    level_here = ctx.space_level(here)
    in_building = r.presence != "away"
    upstairs = ctx.is_upstairs(level_here)
    # Someone already moved to a powered space has what they need tonight.
    sleeps_dark = (level_here if moved_to else r.level) in dark

    if "step_free_route" in r.needs:
        path = route(ctx.graph, here, OUTSIDE, live, step_free_only=True) if in_building else None
        routes[r.id] = path
        if in_building and path is None:
            out.append("stranded")
    if r.medication_location and r.medication_location not in live:
        out.append("medication_at_risk")
    if "medical_device_power" in r.needs and sleeps_dark:
        out.append("device_power_lost")
    if "stairs_slow" in r.needs and in_building and upstairs and not lifts_ok:
        out.append("stairs_only_slow")
    if "guide_dog" in r.needs and in_building and level_here in dark:
        out.append("needs_escort")
    if "visual_alerts" in r.needs and in_building and sleeps_dark:
        out.append("needs_visual_alert")
    if sleeps_dark:
        out.append("power_lost")
    if not in_building:
        out.append("away")
    return out


def _severity(impacts: list[str]) -> Severity:
    if any(i in _CRITICAL for i in impacts):
        return "critical"
    if any(i in _WARNING for i in impacts):
        return "warning"
    return "info"


# ---- narration -----------------------------------------------------------------------------


def describe(ctx: WorldContext, happenings: list[Happening], live_before: set[str], live_after: set[str],
             before: Impact, after: Impact, eta_s: float = 0.0) -> list[ChainEvent]:
    """Turn one step's physical happenings + power change into ordered, explained events."""
    ev: list[ChainEvent] = []
    spec = ctx.spec

    for h in happenings:
        if h.kind == "wet":
            sp = spec.space(h.id)
            sev: Severity = "critical" if sp.kind in ("electrical", "generator") else "warning"
            ev.append(ChainEvent(eta_s=eta_s, kind="wet", id=h.id, severity=sev,
                                 message=f"Water entering {sp.name} ({sp.level})", data={"level": sp.level}))
    for h in happenings:
        if h.kind == "flooded":
            e = ctx.equipment[h.id]
            ev.append(ChainEvent(eta_s=eta_s, kind="flooded", id=h.id, severity="critical", cause=e.space,
                                 message=f"{e.name} under water ({h.depth * 100:.0f} cm)",
                                 data={"depth": round(h.depth, 3), "space": e.space}))

    drowned = {h.id for h in happenings if h.kind == "flooded"}
    dead = sorted(n for n in live_before - live_after if n in ctx.equipment and n not in drowned)
    lifts = [n for n in dead if ctx.equipment[n].kind == "lift"]
    if lifts:
        names = ", ".join(ctx.equipment[n].name for n in lifts)
        ev.append(ChainEvent(eta_s=eta_s, kind="lifts_down", id="lifts", severity="critical",
                             cause=_cause(ctx, lifts[0], live_after),
                             message=f"{'Lift' if len(lifts) == 1 else 'Lifts'} offline: {names} — no step-free way down",
                             data={"lifts": lifts}))
    for n in dead:
        e = ctx.equipment[n]
        cause = _cause(ctx, n, live_after)
        if e.kind == "lift" or e.kind == "elevator_controller":
            continue
        if e.kind == "panel" and e.props.get("serves_level"):
            lv = str(e.props["serves_level"])
            ev.append(ChainEvent(eta_s=eta_s, kind="level_dark", id=lv, severity="critical", cause=cause,
                                 message=f"{spec.level(lv).name} dark — lighting, outlets and lounge off",
                                 data={"level": lv}))
        elif e.kind == "fridge":
            ev.append(ChainEvent(eta_s=eta_s, kind="offline", id=n, severity="warning", cause=cause,
                                 message=f"{e.name} unpowered — refrigerated medication at risk"))
        elif e.kind == "sump_pump":
            ev.append(ChainEvent(eta_s=eta_s, kind="offline", id=n, severity="warning", cause=cause,
                                 message="Sump pump lost power — basement stops draining"))
        else:
            ev.append(ChainEvent(eta_s=eta_s, kind="offline", id=n, severity="info", cause=cause,
                                 message=f"{e.name} lost power"))

    newly_dark = [lv for lv in after.dark_levels if lv not in before.dark_levels]
    if newly_dark:
        on = [r for r in ctx.roster.residents if r.level in newly_dark]
        asleep = sum(1 for r in on if r.presence == "asleep")
        away = sum(1 for r in on if r.presence == "away")
        floors = _join([spec.level(lv).name for lv in newly_dark])
        ev.append(ChainEvent(eta_s=eta_s, kind="residents_affected", id=",".join(newly_dark), severity="warning",
                             message=f"{len(on)} residents on {floors} affected ({asleep} asleep, {away} away)",
                             data={"levels": newly_dark, "count": len(on), "asleep": asleep, "away": away}))

    prev = {(r.id, i) for r in before.residents for i in r.impacts}
    for r in after.residents:
        for i in r.impacts:
            if i in _CRITICAL and (r.id, i) not in prev:
                ev.append(ChainEvent(eta_s=eta_s, kind=i, id=r.id, severity="critical",
                                     message=_resident_message(ctx, r, i), data={"level": r.level, "room": r.room}))
    return ev


def _join(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _cause(ctx: WorldContext, node: str, live: set[str]) -> str | None:
    dead_preds = [u for u, _, d in ctx.graph.in_edges(node, data=True) if d["rel"] in POWER_RELS and u not in live]
    return dead_preds[0] if dead_preds else None


def _resident_message(ctx: WorldContext, r: ResidentImpact, impact: str) -> str:
    room = ctx.spec.space(r.room).name
    if impact == "stranded":
        return f"{r.name} ({room}) has no step-free route out — wheelchair user, lifts down"
    if impact == "medication_at_risk":
        res = ctx.roster.by_id()[r.id]
        fridge = ctx.equipment[res.medication_location].name if res.medication_location else "a fridge"
        return f"{r.name}: refrigerated medication in the unpowered {fridge}"
    if impact == "device_power_lost":
        return f"{r.name} ({room}): powered medical device on a dark floor"
    return f"{r.name}: {impact}"


# ---- forecast ------------------------------------------------------------------------------


def forecast(h: Hydraulics, ctx: WorldContext, impact_now: Impact, computed_step: int,
             horizon_s: float = 3600.0, dt: float = 2.0, moved: dict[str, str] | None = None) -> Forecast:
    """Run the water forward from the current state and narrate what will fail, and when."""
    sim = h.copy()
    events: list[ChainEvent] = []
    live_before = set(sim.live)
    impact = impact_now
    t = 0.0
    settled = False
    while t < horizon_s:
        if sim.idle(ctx):
            settled = True
            break
        t += dt
        hap = step(sim, ctx, dt)
        if not hap:
            continue
        new_impact = assess(ctx, sim.live, sim.wet, moved) if sim.live != live_before else impact
        events.extend(describe(ctx, hap, live_before, sim.live, impact, new_impact, eta_s=t))
        live_before, impact = set(sim.live), new_impact
    return Forecast(computed_step=computed_step, horizon_s=horizon_s, events=events, impact=impact, settled=settled)
