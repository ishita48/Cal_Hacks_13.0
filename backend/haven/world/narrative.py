"""The story so far, in plain words: a derived view of the world state for every screen.

One headline (what is happening), one detail (what it means and for whom), what comes next, and
what the human on this screen should do now. Pure function of (context, state, clock): the
dashboard, the phone, Buds and Blender all read the same sentences, nobody re-derives them.
Every name and number comes from the spec, the roster and the state; nothing here is typed in.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from .context import WorldContext
    from .state import WorldState

Stage = str   # quiet | trace | negotiate | govern | approve | act | done

IMPACT_PHRASE = {
    "stranded": "{first} ({need}, {floor}) would be stranded: no step-free way out",
    "medication_at_risk": "{first}'s medication is in a fridge that dies with the floor",
    "device_power_lost": "{first}'s medical device loses its outlet",
}


class Narrative(BaseModel):
    stage: Stage = "quiet"
    headline: str = ""                 # what is happening, one sentence
    detail: str = ""                   # what it means, and for whom
    next: str = ""                     # what HAVEN proposes or does next
    ask: str = ""                      # what the person at this screen should do
    people: list[str] = Field(default_factory=list)   # resident ids the sentences name, for pointing
    contact_in_s: float | None = None  # seconds until water reaches the first switchgear, when this was written
    contact_at_s: float | None = None  # the same moment as absolute simulation seconds (clients count down from it)
    contact_name: str = ""             # that switchgear's name
    affected_if_nothing_done: int = 0  # residents the forecast says lose power, lifts or a need
    affected_by_plan: int = 0          # residents the plan moves, escorts or messages


def _hm(seconds: float) -> str:
    s = int(seconds) % 86400
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}"


def _join(items: list[str]) -> str:
    if not items:
        return ""
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def _floors(ctx: WorldContext, levels: list[str]) -> str:
    return _join([ctx.level_short(lv) for lv in levels])


def narrate(ctx: WorldContext, state: WorldState, tod: float, dt: float) -> Narrative:
    by_id = ctx.roster.by_id()
    first = lambda rid: by_id[rid].name.split()[0] if rid in by_id else rid  # noqa: E731
    plan = state.approved_plan or state.plan
    incident = bool(state.leaks or state.flooded or state.forecast.events)
    home = [r for r in ctx.roster.residents if r.presence != "away"]

    if not incident:
        sensor = ctx.equipment.get(ctx.sensor_ids[0]) if ctx.sensor_ids else None
        room = ctx.spec.space(sensor.space).name.lower() if sensor else "the basement"
        asleep = sum(1 for r in home if r.presence == "asleep")
        return Narrative(
            stage="quiet", headline=f"{ctx.short_name} is quiet.",
            detail=f"{len(home)} residents are home tonight, {asleep} of them asleep. The water sensor in the {room} reads dry.",
            next="", ask="Drip on the sensor, or press Simulate leak.")

    # -- what is happening ------------------------------------------------------------------------
    fc = state.forecast
    elapsed = (state.step - fc.computed_step) * dt
    # The contact that matters: the first piece of switchgear the water reaches (not a heater or a pump).
    flooded_ev = next((e for e in fc.events if e.kind == "flooded" and e.id in ctx.equipment and ctx.is_electrical(e.id)), None)
    contact_in = max(0.0, flooded_ev.eta_s - elapsed) if flooded_ev else None
    contact_name = ctx.equipment[flooded_ev.id].name if flooded_ev and flooded_ev.id in ctx.equipment else ""
    leak = next((l for l in state.leaks.values()), None)
    deepest = max((w.depth for w in state.water.values()), default=0.0)
    dark_now = state.impact.dark_levels
    dark_soon = fc.impact.dark_levels
    lifts_down = bool(state.impact.lifts_down)
    valve_closed = leak is not None and not leak.active

    if valve_closed and not dark_now:
        valve = ctx.valve_for(leak.equipment_id)
        headline = f"The leak is stopped: {ctx.equipment[valve].name.lower() if valve else 'the valve'} is closed."
    elif dark_now:
        headline = (f"Floors {_floors(ctx, dark_now)} are dark" + (", the lifts are down" if lifts_down else "")
                    + (" and the leak is stopped." if valve_closed else f"; water is {deepest * 100:.0f} cm deep in the basement."))
    elif leak is not None:
        headline = (f"Water is pouring into the {ctx.spec.space(leak.space).name.lower()}: "
                    f"{leak.flow_lps:.0f} L/s from the {ctx.equipment[leak.equipment_id].name.lower()}.")
    else:
        headline = "Water in the basement."

    # -- what it means, for whom --------------------------------------------------------------------
    parts: list[str] = []
    acting = state.approved_plan is not None
    if acting:
        # While HAVEN acts, the facts that matter are what is true now, not the forecast nobody is ignoring.
        # The headline already says which floors are dark; here: the water, the people, the switchgear still at risk.
        if not dark_now and contact_in is not None and contact_name:
            parts.append(f"Water reaches {contact_name} in {max(1, round(contact_in / 60))} min unless the plan cuts it first.")
        if leak is not None and not valve_closed:
            parts.append(f"The riser is still pouring; the plumber closes the valve at the plan's time.")
        moved = len(state.moved)
        if moved:
            parts.append(f"{moved} {'person is' if moved == 1 else 'people are'} where the plan put them.")
    if not acting and contact_in is not None and contact_name:
        # The chain in two waves: what dies with the first switchgear, and what follows later if nobody acts.
        first_eta = flooded_ev.eta_s
        darkens = [(e.eta_s, e.id) for e in fc.events if e.kind == "level_dark"]
        wave1 = [lv for eta, lv in darkens if eta <= first_eta + 60.0]
        wave2 = [(eta, lv) for eta, lv in darkens if eta > first_eta + 60.0]
        chain = []
        if any(e.kind == "lifts_down" for e in fc.events):
            chain.append("the lifts stop")
        if wave1:
            chain.append(f"floors {_floors(ctx, wave1)} go dark")
        line = f"In {max(1, round(contact_in / 60))} min the water reaches {contact_name}" + (": " + " and ".join(chain) if chain else "")
        if wave2:
            later = max(eta for eta, _ in wave2)
            whole = len(set(wave1) | {lv for _, lv in wave2}) >= len(ctx.level_order)
            line += (f"; the whole building by {_hm(tod + later - elapsed)} if nobody acts" if whole
                     else f"; floors {_floors(ctx, [lv for _, lv in wave2])} by {_hm(tod + later - elapsed)} if nobody acts")
        parts.append(line + ".")
    counts = fc.impact.counts
    affected_fc = int(counts.get("affected", 0))
    if affected_fc and not acting:
        parts.append(f"{affected_fc} residents lose power, lifts or something they need if nobody acts.")
    people: list[str] = []
    order = {rid: i for i, rid in enumerate(ctx.story_order)}
    if not acting:
        named = sorted((r for r in fc.impact.residents if r.id in order and r.severity == "critical"),
                       key=lambda r: order[r.id])
        for r in named[:2]:
            impact = next((i for i in r.impacts if i in IMPACT_PHRASE), None)
            if impact is None:
                continue
            need = ", ".join(ctx_need(n) for n in r.needs[:1]) or "resident"
            parts.append(IMPACT_PHRASE[impact].format(first=first(r.id), need=need, floor=ctx.spec.level(r.level).name.lower()) + ".")
            people.append(r.id)
    detail = " ".join(p for p in parts if p)

    # -- the plan, the gate, the action -------------------------------------------------------------
    affected_plan = int(plan.metrics.get("residents_affected", 0))
    if state.approved_plan is None:
        off = [a for a, on in state.agents.items() if not on]
        if plan.left_behind:
            names = _join([first(x) for x in plan.left_behind])
            silent = [x for x in plan.left_behind if f"resident:{x}" in off]
            why = (f" {_join([first(x) + chr(39) + 's' for x in silent])} agent is off: nobody spoke for them." if len(silent) == 1
                   else f" Their agents are off: nobody spoke for them." if silent else " No step in the plan covers them.")
            stage = "negotiate"
            nxt = f"This plan leaves {names} behind.{why}"
            ask = f"Switch {first(plan.left_behind[0])}'s agent back on and watch the plan change."
            people = list(dict.fromkeys(people + plan.left_behind))
        else:
            stage = "govern" if state.rules else "negotiate"
            nxt = f"The agents propose: {plan.headline}" if plan.headline else "The agents are negotiating a plan."
            ask = ("Approve the plan here or on the manager's phone, say a rule to change it, "
                   "or switch an agent off to see what it protects.")
    else:
        ap = state.approved_plan
        done = sum(1 for s in ap.steps if state.actions.get(s.id) and state.actions[s.id].status == "done")
        total = len(ap.steps)
        base = ap.computed_step * dt
        if ap.status == "done":
            start = next((t.step for t in state.timeline if t.kind == "sensor_wet"), None)
            last = max((t.step for t in state.timeline if t.kind == "action" and t.data.get("status") == "done"), default=state.step)
            minutes = round((last - start) * dt / 60) if start is not None else None
            stage = "done"
            m = ap.metrics
            headline = (f"Done{f' {minutes} min after the first drip' if minutes is not None else ''}: "
                        f"{int(m.get('relocated', 0))} relocated, {int(m.get('escorted', 0))} escorted by lift, "
                        f"{len(ap.left_behind)} left behind, {int(m.get('violations', 0))} violations.")
            nxt = ""
            ask = "Start a new run, or replay this one from the event log."
        else:
            stage = "act"
            nxt_step = min((s for s in ap.steps if s.id not in state.actions), key=lambda s: (s.at_s, s.order), default=None)
            latest = max((t for t in state.timeline if t.kind == "action" and t.data.get("status") == "done"),
                         key=lambda t: t.step, default=None)
            where = []
            for rid in ctx.story_order:
                sp = state.moved.get(rid)
                if sp and sp in ctx.areas:
                    where.append(f"{first(rid)} is in the {ctx.spec.space(sp).name.lower()}")
                    people.append(rid)
            last_line = latest.message.split(" — ")[0].removeprefix("done: ") if latest else ""
            nxt = (f"HAVEN is acting on plan v{ap.version}: {done} of {total} steps done."
                   + (f" Last: {last_line}." if last_line else "")
                   + (f" Next: {nxt_step.title} at {_hm(tod + (base + nxt_step.at_s) - state.step * dt)}." if nxt_step else "")
                   + (f" {_join(where[:2])}." if where else ""))
            ask = "Responders confirm each step from their phones; a step nobody confirms closes at its deadline."
    return Narrative(stage=stage, headline=headline, detail=detail, next=nxt, ask=ask, people=people[:4],
                     contact_in_s=contact_in, contact_name=contact_name,
                     contact_at_s=(fc.computed_step * dt + flooded_ev.eta_s) if flooded_ev else None,
                     affected_if_nothing_done=affected_fc, affected_by_plan=affected_plan)


def ctx_need(need: str) -> str:
    from ..agents.registry import NEED_PHRASE

    return NEED_PHRASE.get(need, need)
