"""Buds: the on-screen companion the manager talks to, grounded in the one world state.

Buds answers questions about what is on screen (who is where, why the lifts are held, what happens
if nobody acts, who is left behind), points at the thing it is talking about, and offers to do
things, but never does them itself: every action it proposes goes back to the human as an
approval card, and only then becomes the same input event the dashboard button would send.

Deterministic first: a small intent router answers from the state and the roster, which is what
makes the answers exact (numbers, names, times) and reproducible. Claude is the fallback for
anything the router does not understand, and it only gets to *say* things: it is handed the facts
and a list of things it may point at, and its answer is text plus pointers. No LLM decides.
"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from .rules import parse_rule

if TYPE_CHECKING:
    from ..world.context import WorldContext
    from ..world.state import WorldState

log = logging.getLogger("haven.buds")

NAME = "Buds"


class Focus(BaseModel):
    """Something on screen Buds points at: an agent card, a plan step, a level, a tab, a panel."""

    kind: str          # agent | step | level | tab | panel | resident | actor
    id: str
    label: str = ""


class Action(BaseModel):
    """Something Buds offers to do. Runs only after the human approves it (POST /api/buds/act)."""

    kind: str          # toggle_agent | approve | rule | leak | demo | clock | reset
    label: str
    payload: dict[str, Any] = Field(default_factory=dict)


class Reply(BaseModel):
    speech: str
    focus: list[Focus] = Field(default_factory=list)
    actions: list[Action] = Field(default_factory=list)
    source: str = "rules"          # rules | llm | template
    intent: str = ""


# ---- helpers ---------------------------------------------------------------------------------------


def _hm(seconds: float) -> str:
    s = int(seconds) % 86400
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}"


def _first(name: str) -> str:
    return name.split()[0]


def _find_resident(ctx: WorldContext, text: str):
    t = text.lower()
    for r in ctx.roster.residents:
        if r.id in ctx.story_order and re.search(rf"\b{_first(r.name).lower()}\b", t):
            return r
    for r in ctx.roster.residents:
        if re.search(rf"\b{re.escape(r.name.lower())}\b", t):
            return r
    m = re.search(r"\bra\s*(?:floor|for floor|on floor)?\s*(\w+)\b", t)
    if m:
        wanted = m.group(1)
        lv = next((lv for lv in ctx.level_order if ctx.level_short(lv) == wanted or lv.lower() == wanted), None)
        rid = ctx.ra_for(lv) if lv else None
        return ctx.roster.by_id().get(rid) if rid else None
    return None


def _where(ctx: WorldContext, state: WorldState, rid: str) -> tuple[str, str]:
    """(human description, level id) of where a resident is right now."""
    r = ctx.roster.by_id()[rid]
    moved = state.moved.get(rid)
    if moved == "outside":
        return "in another building (relocated off site)", ctx.ground
    if moved:
        sp = ctx.spec.space(moved)
        return f"in the {sp.name} on {sp.level} (moved there by the plan)", sp.level
    if r.presence == "away":
        return f"away from the building until {r.away_until or 'morning'}", r.level
    sp = ctx.spec.space(r.room)
    return f"in {sp.name} on {r.level}, {r.presence.replace('_', ' ')}", r.level


def _status_line(state: WorldState, ctx: WorldContext | None = None) -> str:
    plan = state.approved_plan or state.plan
    if plan.status == "none":
        return f"{ctx.spec.name if ctx else 'The building'} is quiet: no incident, nothing to plan."
    m = plan.metrics
    deepest = max((w.depth for w in state.water.values()), default=0.0)
    dark = ", ".join(state.impact.dark_levels) or "none"
    return (f"{plan.headline} {int(m.get('residents_affected', 0))} residents affected, "
            f"{int(m.get('left_behind', 0))} left behind. Water is {deepest * 100:.0f} cm deep in the basement; "
            f"floors dark now: {dark}. The plan is {plan.status}, version {plan.version}.")


# ---- the router ------------------------------------------------------------------------------------


def answer(ctx: WorldContext, state: WorldState, text: str, clock_tod: float = 0.0) -> Reply | None:
    """Deterministic answers for the questions a manager asks during the demo. None = not understood."""
    t = " ".join(text.lower().strip().split())
    plan = state.approved_plan or state.plan
    by_id = ctx.roster.by_id()
    steps = {s.id: s for s in plan.steps}

    # -- commands the human must approve (Buds proposes, never acts) --------------------------------
    m = re.search(r"\b(turn|switch|toggle|put)\b.*\b(off|on|back on|back)\b|\b(mute|silence|unmute|enable|disable)\b", t)
    r = _find_resident(ctx, t)
    if m and ("agent" in t or r is not None):
        on = bool(re.search(r"\b(on|back|enable|unmute)\b", t)) and not re.search(r"\b(off|disable|mute|silence)\b", t)
        agent = f"resident:{r.id}" if r else next((a for a in ("safety", "housing", "capacity") if a in t), None)
        if agent and agent in state.agents:
            label = f"{_first(r.name)}'s agent" if r else f"{agent.title()} agent"
            now = state.agents[agent]
            if now == on:
                return Reply(speech=f"{label} is already {'on' if on else 'off'}.", focus=[Focus(kind="agent", id=agent, label=label)], intent="toggle")
            return Reply(speech=f"I can switch {label} {'on' if on else 'off'}. That changes the plan: approve it and watch the Agents panel.",
                         focus=[Focus(kind="agent", id=agent, label=label)],
                         actions=[Action(kind="toggle_agent", label=f"Switch {label} {'on' if on else 'off'}",
                                         payload={"agent": agent, "enabled": on})], intent="toggle")

    if re.search(r"\bapprove\b|\bgo ahead\b|\bexecute the plan\b|\bsign off\b", t) and not t.startswith(("why", "what", "who")):
        if state.plan.status == "none":
            return Reply(speech="There is nothing to approve yet: no incident.", intent="approve")
        if state.approved_plan is not None:
            return Reply(speech=f"Plan v{state.approved_plan.version} is already approved and {state.approved_plan.status}.",
                         focus=[Focus(kind="panel", id="plan", label="Plan")], intent="approve")
        return Reply(speech=f"Plan v{state.plan.version}: {state.plan.headline} Approve it and HAVEN acts.",
                     focus=[Focus(kind="panel", id="plan", label="Plan")],
                     actions=[Action(kind="approve", label=f"Approve plan v{state.plan.version}", payload={"plan_version": state.plan.version})],
                     intent="approve")

    if re.search(r"\b(simulate|start|trigger)\b.*\b(leak|burst|incident|demo)\b|\bdrip\b", t):
        if re.search(r"\bdemo\b|\breplay\b", t):
            return Reply(speech="I can load the recorded run and replay it from the event log.",
                         actions=[Action(kind="demo", label="Load the recorded demo", payload={})], intent="demo")
        return Reply(speech="I can trip the basement water sensor, the same event the ESP32 sends.",
                     focus=[Focus(kind="panel", id="controls", label="Sensor")],
                     actions=[Action(kind="leak", label="Simulate the leak", payload={"value": 0.9, "sensor_id": ctx.sensor_ids[0] if ctx.sensor_ids else None})], intent="leak")

    if re.search(r"\b(reset|start over|clean slate)\b", t):
        return Reply(speech="I can reset the world to a quiet building (a new run in the event log).",
                     actions=[Action(kind="reset", label="Reset the scenario", payload={})], intent="reset")

    m = re.search(r"\b(speed|fast[- ]?forward|faster|slow down|pause|play|resume)\b", t)
    if m:
        if re.search(r"\bpause\b", t):
            return Reply(speech="I can pause the clock.", actions=[Action(kind="clock", label="Pause", payload={"playing": False})], intent="clock")
        if re.search(r"\bplay\b|\bresume\b", t):
            return Reply(speech="I can start the clock again.", actions=[Action(kind="clock", label="Play", payload={"playing": True})], intent="clock")
        sp = re.search(r"(\d+)\s*x", t)
        speed = float(sp.group(1)) if sp else (1.0 if "slow" in t else 60.0)
        return Reply(speech=f"I can run the clock at {speed:g}x.", actions=[Action(kind="clock", label=f"Run at {speed:g}x", payload={"speed": speed})], intent="clock")

    rule = parse_rule(text)
    if rule.confident and (re.search(r"\b(rule|nobody|no one|don't|do not|never|everyone|no )", t) or t.startswith(("rule:", "say"))):
        return Reply(speech=f'That is a rule: "{rule.summary}". Approve it and every agent re-plans under it.',
                     focus=[Focus(kind="panel", id="voice", label="Say a rule")],
                     actions=[Action(kind="rule", label=f"Impose: {rule.summary}", payload={"text": text, "code": rule.code})], intent="rule")

    # -- questions answered from the world -----------------------------------------------------------
    if re.search(r"\b(hi|hello|hey|help|what can you do|who are you)\b", t) and len(t) < 40:
        return Reply(speech=f"I'm {NAME}. I read the same world state as every panel here. Ask me where someone is, why the lifts are "
                            "held, what happens if nobody acts, who is left behind, or tell me to switch an agent, say a rule, or approve.",
                     intent="help")

    if re.search(r"\b(where|which floor|location)\b", t) and r is not None:
        desc, level = _where(ctx, state, r.id)
        stranded = any(x.id == r.id and "stranded" in x.impacts for x in state.impact.residents)
        extra = " They are stranded: no step-free route right now." if stranded else ""
        focus = [Focus(kind="level", id=level, label=level), Focus(kind="resident", id=r.id, label=r.name)]
        if f"resident:{r.id}" in state.agents:
            focus.append(Focus(kind="agent", id=f"resident:{r.id}", label=f"{_first(r.name)}'s agent"))
        return Reply(speech=f"{r.name} is {desc}.{extra}", focus=focus, intent="where")

    if re.search(r"\bleft behind\b|\bnobody (spoke|speaks)\b|\bmissed\b", t):
        left = state.plan.left_behind
        if not left:
            off = [a for a, on in state.agents.items() if not on]
            tail = f" {len(off)} agent(s) are switched off, but their people are still covered." if off else ""
            return Reply(speech=f"Nobody is left behind in plan v{state.plan.version}.{tail}",
                         focus=[Focus(kind="panel", id="plan", label="Plan")], intent="left_behind")
        names = ", ".join(by_id[x].name for x in left if x in by_id)
        focus = [Focus(kind="agent", id=f"resident:{x}", label=f"{_first(by_id[x].name)}'s agent") for x in left if f"resident:{x}" in state.agents]
        acts = [Action(kind="toggle_agent", label=f"Switch {_first(by_id[x].name)}'s agent on", payload={"agent": f"resident:{x}", "enabled": True})
                for x in left if f"resident:{x}" in state.agents and not state.agents[f"resident:{x}"]]
        return Reply(speech=f"Left behind: {names}. A hard need nobody spoke for. Switch their agent back on and the plan changes.",
                     focus=focus, actions=acts, intent="left_behind")

    if re.search(r"\bwhy\b.*\b(hold|held|lift|lifts|power|wait|delay)\b|\bhold the lifts\b", t):
        hold = steps.get("hold_power")
        # The person the hold is for: whoever the hold step satisfies (the first wheelchair user escorted).
        escorted = next((a for a in (hold.satisfies if hold else []) if a.startswith("resident:")), None)
        voice = next((s for s in state.plan.stances if s.agent == escorted), None) if escorted else None
        if hold:
            speech = (f"The lifts stay energised for {hold.deadline_s / 60:.0f} more minutes so the escorts finish before the cut: "
                      f"{hold.reason}")
            focus = [Focus(kind="step", id="hold_power", label=hold.title)]
            if voice:
                speech += f" {voice.label}: {voice.reason}"
                focus.append(Focus(kind="agent", id=voice.agent, label=voice.label))
            return Reply(speech=speech, focus=focus, intent="why_hold")
        cut = next((s for s in plan.steps if s.kind == "isolate"), None)
        if cut:
            return Reply(speech=f"There is no hold: the switchgear is cut at +{cut.at_s / 60:.0f} min. {cut.reason}",
                         focus=[Focus(kind="step", id=cut.id, label=cut.title)], intent="why_hold")
        return Reply(speech="No power decision is in the plan yet.", intent="why_hold")

    if re.search(r"\bwhy\b", t) and r is not None:
        st = next((s for s in state.plan.stances if s.resident == r.id), None)
        if st:
            return Reply(speech=f"{st.label} says {st.stance}: {st.reason}" + (f" Hard rule: {st.constraint.rule}." if st.constraint and st.constraint.type == "hard" else ""),
                         focus=[Focus(kind="agent", id=st.agent, label=st.label)], intent="why_agent")
        return Reply(speech=f"{_first(r.name)}'s agent has nothing to object to in this plan.", intent="why_agent")

    if re.search(r"\b(if nobody|if no one|nothing is done|forecast|what happens|what will|cascade|next)\b", t):
        fc = state.forecast
        if not fc.events:
            return Reply(speech="Nothing is forecast: no water in the building.", intent="forecast")
        lines = [f"{e.message} at +{e.eta_s / 60:.0f} min" for e in fc.events[:4]]
        counts = fc.impact.counts
        return Reply(speech="If nobody acts: " + "; ".join(lines) + f". {counts.get('affected', 0)} people affected, "
                            f"{counts.get('stranded', 0)} stranded.",
                     focus=[Focus(kind="tab", id="cascade", label="Cascade")], intent="forecast")

    if re.search(r"\b(plumber|valve)\b", t):
        act = state.actors.get("plumber")
        cv = steps.get("close_valve")
        if cv:
            when = f"closes the main valve at +{cv.deadline_s / 60:.0f} min" if cv.deadline_s else "closes the main valve"
            where = {"offsite": "not on site yet", "moving": "on the way to the mechanical room", "done": "in the mechanical room, done",
                     "idle": "idle"}.get(act.status if act else "offsite", "")
            return Reply(speech=f"The plumber {when} ({where}). Call placed: {state.actions.get('call_plumber').detail if 'call_plumber' in state.actions else 'not yet, plan not approved'}.",
                         focus=[Focus(kind="step", id="close_valve", label=cv.title), Focus(kind="actor", id="plumber", label="Plumber")], intent="plumber")
        return Reply(speech="No plumber step yet: there is no leak to close.", intent="plumber")

    if re.search(r"\b(how many|count|affected|stranded|asleep)\b", t):
        c = (state.impact if state.impact.residents else state.forecast.impact).counts
        return Reply(speech=f"{c.get('affected', 0)} affected, {c.get('on_dark_floors', 0)} on dark floors, {c.get('asleep', 0)} asleep, "
                            f"{c.get('stranded', 0)} stranded, {c.get('medication_at_risk', 0)} with medication at risk.",
                     focus=[Focus(kind="panel", id="ledger", label="Impact ledger")], intent="counts")

    if re.search(r"\b(message|messages|told|notify|notified|text)\b", t):
        msgs = plan.messages
        crit = [m for m in msgs if m.priority == "critical"]
        return Reply(speech=f"{sum(m.count for m in msgs)} people get a message in their own language; {len(crit)} are critical, "
                            f"for example: {crit[0].name}: \"{crit[0].text[:90]}…\"" if crit else "No messages yet: nothing to say until there is a plan.",
                     focus=[Focus(kind="tab", id="messages", label="Messages")], intent="messages")

    if re.search(r"\b(status|summary|going on|situation|brief|update|what.s happening)\b", t):
        return Reply(speech=_status_line(state, ctx), focus=[Focus(kind="panel", id="plan", label="Plan")], intent="status")

    if re.search(r"\b(agents?|who speaks|negotiat)", t):
        on = [a for a, v in state.agents.items() if v]
        vetoes = [s for s in state.plan.stances if s.stance == "veto"]
        r1 = next((rd for rd in state.plan.rounds if rd.n == 1), None)
        speech = f"{len(on)} of {len(state.agents)} agents are in the negotiation."
        if r1:
            speech += f" Round one: {r1.summary}."
        if vetoes:
            speech += " Vetoes now: " + "; ".join(f"{v.label}: {v.reason}" for v in vetoes[:2])
        return Reply(speech=speech, focus=[Focus(kind="tab", id="agents", label="Agents")], intent="agents")

    if r is not None:
        desc, level = _where(ctx, state, r.id)
        needs = ", ".join(r.needs) or "no special needs"
        return Reply(speech=f"{r.name}: {r.story or needs}. Right now {desc}.",
                     focus=[Focus(kind="level", id=level, label=level), Focus(kind="resident", id=r.id, label=r.name)], intent="who")

    return None


# ---- the Claude fallback ----------------------------------------------------------------------------


def context_for_llm(ctx: WorldContext, state: WorldState) -> dict[str, Any]:
    plan = state.approved_plan or state.plan
    by_id = ctx.roster.by_id()
    return {
        "status": _status_line(state, ctx),
        "headline": plan.headline, "plan_status": plan.status, "plan_version": plan.version,
        "metrics": plan.metrics, "left_behind": plan.left_behind,
        "agents_off": [a for a, on in state.agents.items() if not on],
        "rules": [r.rule for r in state.rules],
        "dark_now": state.impact.dark_levels, "dark_if_nothing_done": state.forecast.impact.dark_levels,
        "forecast": [{"eta_min": round(e.eta_s / 60), "message": e.message} for e in state.forecast.events[:6]],
        "flagged": [{"id": r.id, "name": r.name, "room": r.room, "level": r.level, "needs": r.needs, "impacts": r.impacts,
                     "where_now": _where(ctx, state, r.id)[0]} for r in (state.impact.residents or state.forecast.impact.residents)[:12]],
        "steps": [{"id": s.id, "title": s.title, "at_min": round(s.at_s / 60), "actor": s.actor, "reason": s.reason} for s in plan.steps[:14]],
        "stances": [{"agent": s.agent, "label": s.label, "stance": s.stance, "reason": s.reason} for s in state.plan.stances[:12]],
        "responders": {a: {"status": v.status, "at": v.at, "heading": v.heading} for a, v in state.actors.items() if v.status != "idle"},
        "pointable": {"agent": list(state.agents)[:14], "step": [s.id for s in plan.steps], "level": list(ctx.level_order),
                      "tab": ["agents", "messages", "cascade"], "panel": ["plan", "ledger", "controls", "voice", "map"],
                      "resident": [r.id for r in by_id.values() if r.story][:9]},
    }


_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "speech": {"type": "string"},
        "focus": {"type": "array", "items": {"type": "object", "properties": {"kind": {"type": "string"}, "id": {"type": "string"}},
                                                "required": ["kind", "id"], "additionalProperties": False}},
    },
    "required": ["speech", "focus"],
    "additionalProperties": False,
}


async def answer_llm(ctx: WorldContext, state: WorldState, text: str) -> Reply | None:
    """Claude answers from the facts and may only point at things in `pointable`. None without a key."""
    from .llm import MODEL, _client

    client = _client()
    if client is None:
        return None
    facts = context_for_llm(ctx, state)
    try:
        response = await client.beta.messages.create(
            model=MODEL, max_tokens=400,
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            system=(f"You are {NAME}, the on-screen companion in HAVEN, a building-emergency command centre. Answer the on-call "
                    "manager in one to three short spoken sentences, using ONLY the facts in the JSON. Keep every number and name "
                    "exact; if the facts do not cover it, say so. `focus` lists up to two things to point at, chosen only from "
                    "`pointable` (kind + id)."),
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA}},
            messages=[{"role": "user", "content": f"FACTS:\n{json.dumps(facts)}\n\nQUESTION: {text}"}],
        )
    except Exception:
        log.exception("buds llm failed")
        return None
    if response.stop_reason == "refusal":
        return None
    raw = next((b.text for b in response.content if b.type == "text"), "")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    pointable = facts["pointable"]
    focus = [Focus(kind=f["kind"], id=f["id"]) for f in data.get("focus", [])
             if f.get("kind") in pointable and f.get("id") in pointable[f["kind"]]][:2]
    return Reply(speech=str(data.get("speech", "")).strip()[:600], focus=focus, source="llm", intent="llm")


def fallback(text: str) -> Reply:
    return Reply(speech=f"I did not catch that. Ask me where someone is, why the lifts are held, what happens if nobody acts, "
                        f"who is left behind, or tell me to switch an agent off, say a rule, or approve the plan.",
                 source="template", intent="unknown")
