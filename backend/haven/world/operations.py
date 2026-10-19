"""Operations: the building on an ordinary day, and what the emergency engine knows before anything breaks.

Three derived views, all pure functions of (context, state, time of day):

- energy: load per floor and per plant item from who is home and awake, the day's load curve, energy,
  cost and carbon so far, and what the standby generator could carry and for how long;
- health: every piece of plant with its age, last service, interval and a condition score;
- the resilience audit: for every piece of electrical plant, and for water in every plant room, fail it in
  the dependency graph and count who loses a step-free way out, refrigerated medication, device power or
  light. Ranked, this is the list of single points of failure, and it turns into maintenance findings with
  the fix each one implies.

Nothing here names this building: kinds, tags, ratings and records come from the spec; people from the roster.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, Any

from ..building.graph import POWER_RELS, energized, powered_levels
from .cascade import assess

if TYPE_CHECKING:
    from .context import WorldContext
    from .state import WorldState

# A residence hall's weekday load shape, hour 0..23, as a fraction of its evening peak (US DOE
# commercial reference building for dormitories, smoothed). A model of behaviour, not of this building.
LOAD_SHAPE = (0.46, 0.40, 0.36, 0.34, 0.33, 0.35, 0.44, 0.58, 0.66, 0.62, 0.58, 0.58,
              0.60, 0.60, 0.61, 0.63, 0.68, 0.78, 0.88, 0.95, 1.00, 0.99, 0.90, 0.68)
KW_PER_ROOM_IDLE = 0.12        # fridge, router, chargers, standby
KW_PER_PERSON = {"in_room": 0.45, "elsewhere": 0.10, "asleep": 0.12, "away": 0.0}
KW_PER_COMMON_M2 = 0.012       # lighting and ventilation of corridors, lounges, kitchens
LIFT_DUTY = 0.22               # fraction of rated power a passenger lift draws averaged over an hour
FLOOD_PROBE_M = 0.15           # water depth the audit floods a plant room to


def _hour(tod: float) -> float:
    return (tod % 86400) / 3600.0


def _shape(h: float) -> float:
    i = int(h) % 24
    f = h - int(h)
    return LOAD_SHAPE[i] * (1 - f) + LOAD_SHAPE[(i + 1) % 24] * f


def _days_since(iso: str | None, today: date) -> int | None:
    if not iso:
        return None
    try:
        return (today - date.fromisoformat(str(iso))).days
    except ValueError:
        return None


# ---- energy ---------------------------------------------------------------------------------------


def _level_loads(ctx: WorldContext) -> dict[str, float]:
    """Each lit level's load right now (kW), from rooms, the people in them and common floor area."""
    out: dict[str, float] = {lv: 0.0 for lv in ctx.level_order}
    rooms: dict[str, int] = {}
    for s in ctx.spec.spaces:
        if s.kind == "room":
            rooms[s.level] = rooms.get(s.level, 0) + 1
        elif s.kind in ("corridor", "lobby", "lounge", "study", "kitchen", "amenity", "laundry", "office"):
            out[s.level] += s.rect.area * KW_PER_COMMON_M2
    for lv, n in rooms.items():
        out[lv] += n * KW_PER_ROOM_IDLE
    for r in ctx.roster.residents:
        out[r.level] += KW_PER_PERSON.get(r.presence, 0.1)
    return out


def _plant_loads(ctx: WorldContext, live: set[str], wet: set[str]) -> dict[str, float]:
    """Plant that draws power: lifts at their duty, pumps and fixed loads at nameplate, the sump when wet."""
    out: dict[str, float] = {}
    for e in ctx.spec.equipment:
        kw = float(e.props.get("rated_kw", 0) or 0)
        if kw <= 0 or e.kind in ("generator", "utility_feed") or e.id not in live:
            continue
        if e.kind == "lift":
            kw *= LIFT_DUTY
        if e.kind == "sump_pump" and e.space not in wet:
            kw = 0.0
        if e.kind == "fridge":
            continue                      # counted in its floor's load
        if kw:
            out[e.id] = kw
    return out


def energy(ctx: WorldContext, state: WorldState, tod: float) -> dict[str, Any]:
    live = set(state.power.live)
    levels_ok = powered_levels(ctx.graph, live)
    base = _level_loads(ctx)
    h = _hour(tod)
    # The roster is tonight's snapshot: scale the day's shape so the curve passes through it at this hour.
    scale = 1.0 / max(_shape(h), 1e-6)
    floors = {lv: round(kw if levels_ok.get(lv, True) else 0.0, 1) for lv, kw in base.items()}
    plant = {k: round(v, 1) for k, v in _plant_loads(ctx, live, set(state.wet_spaces)).items()}
    now_kw = round(sum(floors.values()) + sum(plant.values()), 1)
    normal_kw = sum(base.values()) + sum(_plant_loads(ctx, set(energized(ctx.graph)), set()).values())
    curve = [round(normal_kw * scale * LOAD_SHAPE[i], 1) for i in range(24)]
    # Energy so far today: the shape integrated to now, at the normal-night scale (an incident is minutes).
    whole = int(h)
    kwh = sum(curve[:whole]) + curve[whole % 24] * (h - whole)
    peak_i = max(range(24), key=lambda i: curve[i])
    feed = next((e for e in ctx.spec.equipment if e.kind == "utility_feed"), None)
    tariff = float(feed.props.get("tariff_usd_kwh", 0) or 0) if feed else 0.0
    carbon = float(feed.props.get("carbon_kg_kwh", 0) or 0) if feed else 0.0
    demand = float(feed.props.get("demand_usd_kw", 0) or 0) if feed else 0.0

    gen = next((e for e in ctx.spec.equipment if e.kind == "generator"), None)
    standby: dict[str, Any] | None = None
    if gen is not None:
        backed = _backed_loads(ctx, gen.id, live)
        rated = float(gen.props.get("rated_kw", 0) or 0)
        fuel = float(gen.props.get("fuel_l", 0) or 0) * float(gen.props.get("fuel_level", 1) or 1)
        burn_full = float(gen.props.get("burn_lph_full", 0) or 0)
        load = sum(backed.values())
        frac = load / rated if rated else 0.0
        burn = burn_full * (0.3 + 0.7 * frac) if burn_full else 0.0     # diesel burns ~30 % at idle
        standby = {"id": gen.id, "name": gen.name, "rated_kw": rated, "load_kw": round(load, 1),
                   "fuel_l": round(fuel), "fuel_pct": round(100 * float(gen.props.get("fuel_level", 1) or 1)),
                   "runtime_h": round(fuel / burn, 1) if burn else None,
                   "carries": [{"id": k, "name": ctx.equipment[k].name, "kw": round(v, 1)} for k, v in sorted(backed.items(), key=lambda kv: -kv[1])],
                   "running": gen.id in live and _on_generator(ctx, live)}
    return {
        "now_kw": now_kw, "normal_kw": round(normal_kw, 1),
        "floors": floors, "plant": plant,
        "curve_kw": curve, "hour": round(h, 2), "peak_hour": peak_i, "peak_kw": curve[peak_i],
        "today_kwh": round(kwh), "today_usd": round(kwh * tariff + demand * curve[peak_i] / 30.0, 2),
        "today_co2_kg": round(kwh * carbon), "tariff_usd_kwh": tariff, "carbon_kg_kwh": carbon,
        "dark_levels": [lv for lv, ok in levels_ok.items() if not ok],
        "standby": standby,
    }


def _backed_loads(ctx: WorldContext, gen: str, live: set[str]) -> dict[str, float]:
    """Plant the generator can carry: everything downstream of a transfer switch it backs up."""
    out: dict[str, float] = {}
    seen: set[str] = set()
    stack = [d for _, d, data in ctx.graph.out_edges(gen, data=True) if data.get("rel") == "backs_up"]
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        e = ctx.equipment.get(n)
        if e is not None:
            kw = float(e.props.get("rated_kw", 0) or 0)
            if e.kind == "lift":
                kw *= LIFT_DUTY
            if kw:
                out[n] = kw
        stack += [d for _, d, data in ctx.graph.out_edges(n, data=True) if data.get("rel") in POWER_RELS]
    return out


def _on_generator(ctx: WorldContext, live: set[str]) -> bool:
    """Is any utility feed dead while something the generator backs is live?"""
    feeds = [e.id for e in ctx.spec.equipment if e.kind == "utility_feed"]
    if not feeds:
        return False
    gens = {e.id for e in ctx.spec.equipment if e.kind == "generator"}
    normal = energized(ctx.graph, failed=gens)
    return any(n in live and n not in normal for n in ctx.equipment if n not in gens)


# ---- the resilience audit ----------------------------------------------------------------------------


def _impact_of(ctx: WorldContext, failed: set[str]) -> dict[str, Any]:
    live = energized(ctx.graph, failed)
    imp = assess(ctx, live, set())
    c = imp.counts
    by_id = ctx.roster.by_id()
    named = [r.id for r in imp.residents if r.id in ctx.story_order and r.severity == "critical"]
    return {
        "dark_levels": imp.dark_levels, "lifts_down": imp.lifts_down,
        "stranded": c.get("stranded", 0), "medication": c.get("medication_at_risk", 0),
        "device_power": c.get("device_power_lost", 0), "on_dark_floors": c.get("on_dark_floors", 0),
        "affected": c.get("affected", 0),
        "named": [by_id[r].name for r in named[:3]],
    }


def _score(i: dict[str, Any]) -> int:
    """How bad a failure is for people: hard needs first, then everyone in the dark."""
    return 1000 * i["stranded"] + 300 * (i["medication"] + i["device_power"]) + i["on_dark_floors"]


_AUDITS: dict[int, dict[str, Any]] = {}


def audit(ctx: WorldContext) -> dict[str, Any]:
    if id(ctx) not in _AUDITS:
        _AUDITS[id(ctx)] = _audit(ctx)
    return _AUDITS[id(ctx)]


def _audit(ctx: WorldContext) -> dict[str, Any]:
    """Fail each piece of electrical plant alone, then flood each plant room to FLOOD_PROBE_M. Static for a
    building (it is about the design, not tonight), so it is computed once per context."""
    single: list[dict[str, Any]] = []
    for e in ctx.spec.equipment:
        if not ctx.is_electrical(e.id) and e.kind not in ("lift", "sump_pump"):
            continue
        if e.kind in ("panel",) and e.props.get("serves_level"):
            continue                      # a floor panel takes out its own floor: obvious, not a finding
        i = _impact_of(ctx, {e.id})
        if _score(i) == 0 and not i["lifts_down"]:
            continue
        single.append({"id": e.id, "name": e.name, "kind": e.kind, "space": e.space, "impact": i, "score": _score(i)})
    single.sort(key=lambda x: -x["score"])

    rooms: list[dict[str, Any]] = []
    plant_spaces = sorted({e.space for e in ctx.spec.equipment if ctx.is_electrical(e.id)})
    for sp in plant_spaces:
        drowned = {e.id for e in ctx.spec.equipment
                   if e.space == sp and e.flood_height is not None and e.flood_height <= FLOOD_PROBE_M}
        if not drowned:
            continue
        i = _impact_of(ctx, drowned)
        rooms.append({"space": sp, "name": ctx.spec.space(sp).name, "depth_m": FLOOD_PROBE_M,
                      "fails": [ctx.equipment[d].name for d in sorted(drowned)], "impact": i, "score": _score(i)})
    rooms.sort(key=lambda x: -x["score"])

    # Common-mode: a space whose loss alone kills every lift, i.e. normal AND standby share it.
    common: list[dict[str, Any]] = []
    for sp in plant_spaces:
        gear = {e.id for e in ctx.spec.equipment if e.space == sp and ctx.is_electrical(e.id)}
        live = energized(ctx.graph, gear)
        backed = any(d.get("rel") == "backs_up" for e in gear for _, _, d in ctx.graph.in_edges(e, data=True))
        if ctx.lifts and all(l not in live for l in ctx.lifts) and backed:
            common.append({"space": sp, "name": ctx.spec.space(sp).name,
                           "detail": "normal and standby power for every lift pass through this one room"})
    return {"single": single[:12], "rooms": rooms, "common_mode": common, "flood_probe_m": FLOOD_PROBE_M}


# ---- equipment health and findings ----------------------------------------------------------------------


def health(ctx: WorldContext, state: WorldState, today: date) -> list[dict[str, Any]]:
    out = []
    for e in ctx.spec.equipment:
        p = e.props
        if "installed" not in p:
            continue
        since = _days_since(p.get("last_service"), today)  # type: ignore[arg-type]
        every = int(p.get("service_days", 0) or 0)
        overdue = since is not None and every and since > every
        age = today.year - int(p["installed"])              # type: ignore[arg-type]
        cond = 100 - min(40, age * 3) - (min(40, (since - every) // 15) if overdue and since is not None else 0)
        status = state.equipment.get(e.id).status if e.id in state.equipment else "online"
        if status == "flooded":
            cond = 0
        out.append({"id": e.id, "name": e.name, "kind": e.kind, "level": e.level, "space": e.space,
                    "installed": p["installed"], "last_service": p.get("last_service"), "service_days": every or None,
                    "days_since": since, "overdue_days": (since - every) if overdue and since is not None else 0,
                    "next_due": (date.fromordinal(today.toordinal() + (every - since)).isoformat()
                                 if since is not None and every and not overdue else None),
                    "task": p.get("task"), "condition": max(0, int(cond)), "status": status,
                    "flood_height": e.flood_height})
    out.sort(key=lambda x: (x["condition"], -x["overdue_days"]))
    return out


def findings(ctx: WorldContext, state: WorldState, today: date) -> list[dict[str, Any]]:
    """What a facilities manager should do this month, each with its reason and what it protects."""
    a = audit(ctx)
    hl = {h["id"]: h for h in health(ctx, state, today)}
    worst = {s["id"]: s for s in a["single"]}
    out: list[dict[str, Any]] = []

    for room in a["rooms"]:
        i = room["impact"]
        if not i["stranded"] and not i["on_dark_floors"]:
            continue
        low = [e for e in ctx.spec.equipment if e.space == room["space"] and e.flood_height is not None
               and e.flood_height <= FLOOD_PROBE_M and ctx.is_electrical(e.id)]
        others = [e.flood_height for e in ctx.spec.equipment if e.space == room["space"]
                  and e.flood_height is not None and e.flood_height > FLOOD_PROBE_M and ctx.is_electrical(e.id)]
        pad = min(others) if others else 0.3
        for e in low:
            out.append({"id": f"raise:{e.id}", "severity": "critical", "equipment": e.id, "kind": "design",
                        "title": f"Raise {e.name} onto a {pad * 100:.0f} cm housekeeping pad",
                        "why": (f"It sits {e.flood_height * 100:.0f} cm off the floor of the {room['name'].lower()}; the gear "
                                f"beside it sits at {pad * 100:.0f} cm. {room['depth_m'] * 100:.0f} cm of water there darkens "
                                f"floors {', '.join(ctx.level_short(lv) for lv in i['dark_levels'])} and strands "
                                f"{i['stranded']} wheelchair user{'s' if i['stranded'] != 1 else ''}"
                                + (f"; {i['medication']} lose refrigerated medication" if i["medication"] else "")
                                + "." + (f" At risk by name: {', '.join(i['named'])}." if i["named"] else "")),
                        "protects": i["affected"], "stranded": i["stranded"]})
    for c in a["common_mode"]:
        out.append({"id": f"separate:{c['space']}", "severity": "critical", "equipment": None, "kind": "design",
                    "title": f"Give the lifts a standby feed outside the {c['name'].lower()}",
                    "why": f"Today {c['detail']}: one flooded room takes every step-free way out of the building.",
                    "protects": sum(1 for r in ctx.roster.residents if "step_free_route" in r.needs), "stranded": None})
    for h in hl.values():
        if not h["overdue_days"]:
            continue
        w = worst.get(h["id"])
        sev = "serious" if w and w["impact"]["stranded"] else "warning"
        if h["kind"] in ("valve", "sump_pump", "transfer_switch", "generator"):
            sev = "serious"
        why = f"Last done {h['last_service']}, every {h['service_days']} days: {h['overdue_days']} days overdue."
        if h["kind"] == "valve":
            why += " A gate valve nobody has turned in years may not close when the riser bursts."
        if h["kind"] == "sump_pump":
            why += " It is the only thing that drains the plant room."
        burst = ctx.equipment[h["id"]].props.get("burst_flow_lps")
        if burst:
            sev = "serious"
            why += (f" A full-bore break releases about {float(burst):.0f} L/s into the "
                    f"{ctx.spec.space(ctx.equipment[h['id']].space).name.lower()}, next to the switchgear.")
        if w and (w["impact"]["on_dark_floors"] or w["impact"]["stranded"]):
            why += f" If it fails: {w['impact']['on_dark_floors']} people in the dark, {w['impact']['stranded']} stranded."
        out.append({"id": f"service:{h['id']}", "severity": sev, "equipment": h["id"], "kind": "service",
                    "title": f"{h['task'] or 'Service'}: {h['name']}", "why": why,
                    "protects": w["impact"]["affected"] if w else 0, "stranded": w["impact"]["stranded"] if w else 0})
    rank = {"critical": 0, "serious": 1, "warning": 2}
    out.sort(key=lambda f: (rank[f["severity"]], -(f["protects"] or 0)))
    for f in out:
        wo = state.work_orders.get(f["id"]) if hasattr(state, "work_orders") else None
        f["work_order"] = wo.model_dump() if wo is not None else None
    return out


def snapshot(ctx: WorldContext, state: WorldState, tod: float, today: date) -> dict[str, Any]:
    hl = health(ctx, state, today)
    fs = findings(ctx, state, today)
    a = audit(ctx)
    return {
        "date": today.isoformat(),
        "energy": energy(ctx, state, tod),
        "health": hl,
        "audit": a,
        "findings": fs,
        "summary": {
            "plant": len(hl), "overdue": sum(1 for h in hl if h["overdue_days"]),
            "critical_findings": sum(1 for f in fs if f["severity"] == "critical"),
            "open_findings": sum(1 for f in fs if not f["work_order"]),
            "single_points": len([s for s in a["single"] if s["impact"]["stranded"]]),
            "people_exposed": max([s["impact"]["affected"] for s in a["single"]] + [r["impact"]["affected"] for r in a["rooms"]] + [0]),
        },
    }
