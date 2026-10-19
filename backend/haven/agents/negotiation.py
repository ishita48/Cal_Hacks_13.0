"""The negotiation, for real: agents reason with Claude over the facts, and what they say shapes the plan.

How it fits the non-negotiables:
- The planner stays a pure function of the world state. An agent's stance enters the world as an
  `AgentStance` input event (logged with its step), so the plan it shaped re-derives on replay with no
  model in the loop. Without a key, or if a model never answers, the rule functions in planner.py stand.
- Hard constraints stay hard: a model may only pick a stance, a reason, which steps it objects to, and a
  constraint code from the list its role allows. The checker verifies the final plan against the facts,
  whoever spoke; a resident agent that fails to object leaves its person in `left_behind`, visibly.
- Resident agents speak through their Fetch.ai identity when the society is running (the uAgent makes
  the model call and signs the stance); specialists speak in-process.

The Negotiator runs on the engine's plan listener: when the situation key changes it asks every enabled
agent, round by round (round 2 only exists once round 1 was answered, because the revised proposal is
built from the objections), with a timeout per agent.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from ..world.events import AgentStance
from .models import PlanStep, Stance
from .planner import Situation, _cut_time, _situation, _steps_for, situation_key

if TYPE_CHECKING:
    from ..world.context import WorldContext
    from ..world.state import WorldState

log = logging.getLogger("haven.negotiation")

AGENT_TIMEOUT_S = 30.0
MAX_PENDING_ROUNDS = 2

ROLE = {
    "safety": "the Safety agent. Hard rule: the switchgear at risk must be de-energised with a "
              "two-minute margin before water reaches it; nobody enters the basement; no lift use after isolation. "
              "You may veto a plan that cuts too late or never. You may propose cutting now.",
    "housing": "the Housing agent. You know who lives on every floor that goes dark, who is asleep, who is away, "
               "and the overflow spaces in order. You want everyone placed somewhere tonight, nearest first, and "
               "nobody woken or moved without reason.",
    "capacity": "the Capacity agent. Hard rule: no space takes more people than it holds. You veto a plan that "
                "sends more people to a destination than its capacity.",
}

# What each role may demand, as a machine code the planner understands (type, rule text template).
CODES: dict[str, tuple[str, str]] = {
    "deenergise_before_contact": ("hard", "Switchgear is de-energised before water reaches it; nobody enters the basement"),
    "capacity": ("hard", "No space takes more people than it holds"),
    "nobody_unplaced": ("soft", "Everyone on a dark floor has somewhere to sleep tonight"),
    "step_free": ("hard", "{first} keeps a feasible step-free route"),
    "meds": ("hard", "{first}'s insulin stays refrigerated"),
    "device_power": ("hard", "{first} sleeps next to a powered outlet"),
    "no_move": ("hard", "{first} is not woken or relocated"),
    "visual": ("hard", "{first} is alerted visually and in text, never by sound"),
    "escort": ("soft", "{first} and the guide dog are escorted"),
    "stairs": ("soft", "{first} has someone beside them on the stairs"),
    "lang": ("soft", "{first} is messaged in their own language"),
}
SPECIALIST_CODES = {"safety": ["deenergise_before_contact"], "housing": ["nobody_unplaced"], "capacity": ["capacity"]}
RESIDENT_CODES = ["step_free", "meds", "device_power", "no_move", "visual", "escort", "stairs", "lang"]

_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "stance": {"type": "string", "enum": ["propose", "support", "critique", "veto"]},
        "reason": {"type": "string", "description": "One or two sentences, first person, with the numbers that matter."},
        "constraint_code": {"type": "string", "description": "A code from your allowed list, or empty when you demand nothing."},
        "step_ids": {"type": "array", "items": {"type": "string"}, "description": "The steps your stance is about."},
    },
    "required": ["stance", "reason", "constraint_code", "step_ids"],
    "additionalProperties": False,
}


def configured() -> bool:
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    return has_key and os.environ.get("HAVEN_NEGOTIATION", "claude") != "rules"


# ---- the facts an agent reasons from ------------------------------------------------------------------


def facts_for_agent(ctx: WorldContext, sit: Situation, steps: list[PlanStep], agent: str) -> dict[str, Any]:
    cut = _cut_time(steps)
    base = {
        "floors_that_go_dark": sit.dark_planned,
        "lifts_running_now": sit.lifts_up,
        "water_reaches_switchgear_in_min": round(sit.eta_lifts_s / 60, 1) if sit.eta_lifts_s is not None else None,
        "latest_safe_cut_min": round(sit.eta_cut_s / 60, 1) if sit.eta_cut_s is not None else None,
        "plan_cuts_switchgear_at_min": round(cut / 60, 1) if cut is not None else None,
        "valve_closed_at_min": round(sit.valve_closed_at_s / 60, 1) if sit.valve_closed_at_s is not None else None,
        "manager_rules": sorted(sit.rules),
        "residents_to_move": len(sit.movers), "residents_away": len(sit.away),
        "destinations": [{"id": d[0], "name": d[1], "capacity": d[2], "off_campus": d[3]} for d in sit.dests],
        "steps": [{"id": st.id, "kind": st.kind, "title": st.title, "actor": st.actor, "at_min": round(st.at_s / 60, 1),
                   "deadline_min": round(st.deadline_s / 60, 1) if st.deadline_s is not None else None,
                   "target": st.target, "people": len(st.people), "names": st.people[:4]} for st in steps],
    }
    if agent.startswith("resident:"):
        r = ctx.roster.by_id()[agent.split(":", 1)[1]]
        mine = _steps_for(steps, r.id)
        esc = [st for st in mine if st.kind == "escort"]
        base["you_speak_for"] = {
            "id": r.id, "name": r.name, "room": r.room, "level": r.level, "needs": r.needs, "presence": r.presence,
            "away_until": r.away_until, "language": r.contact.lang, "story": r.story,
            "medication_in": r.medication_location, "role": r.role,
            "floor_goes_dark": r.level in set(sit.dark_planned),
            "impacts_if_nobody_acts": sit.flagged.get(r.id, []),
            "steps_that_involve_them": [{"id": st.id, "kind": st.kind, "deadline_min": round(st.deadline_s / 60, 1) if st.deadline_s is not None else None} for st in mine],
            "escort_finishes_before_cut": bool(esc and cut is not None and esc[0].deadline_s is not None and esc[0].deadline_s <= cut + 1e-6),
        }
    return base


def allowed_codes(agent: str) -> list[str]:
    if agent.startswith("resident:"):
        rid = agent.split(":", 1)[1]
        return [f"{c}:{rid}" for c in RESIDENT_CODES]
    return SPECIALIST_CODES.get(agent, [])


def constraint_for(ctx: WorldContext, agent: str, code: str) -> tuple[str, str, str] | None:
    """(type, rule, code) for a code an agent is allowed to use; None if it is not."""
    if not code or code not in allowed_codes(agent):
        return None
    base = code.split(":")[0]
    ctype, tmpl = CODES[base]
    first = ""
    if agent.startswith("resident:"):
        r = ctx.roster.by_id().get(agent.split(":", 1)[1])
        first = r.name.split()[0] if r else ""
    return ctype, tmpl.format(first=first), code


def _system(ctx: WorldContext, agent: str) -> str:
    if agent in ROLE:
        who = ROLE[agent]
    else:
        r = ctx.roster.by_id()[agent.split(":", 1)[1]]
        who = (f"{r.name.split()[0]}'s personal agent. You speak only for {r.name} ({r.story or ', '.join(r.needs) or 'no special needs'}). "
               "Your person's needs are hard constraints: veto any plan that leaves them stranded, without their medication, "
               "without power for a medical device, or woken/moved against a standing instruction. Support a plan that "
               "covers them; critique one that could do better for them. Do not speak for anyone else.")
    return (f"You are {who} You are in a negotiation over an emergency plan for {ctx.spec.name} ({ctx.spec.address}). "
            "A burst riser is flooding the basement towards the electrical switchgear. Read the FACTS and the proposed STEPS "
            "and return your stance. Rules: use only the facts given; keep every number; 'veto' means the plan is unacceptable "
            "to you as it stands; 'critique' means acceptable with a change; 'support' means acceptable; 'propose' only if you "
            "are tabling the plan. Put the ids of the steps your stance is about in step_ids. If you demand something, give "
            "exactly one constraint_code from ALLOWED; otherwise an empty string.")


async def stance_llm(ctx: WorldContext, sit: Situation, steps: list[PlanStep], agent: str, round_n: int) -> Stance | None:
    """One model call: the agent's stance on this round, validated against what its role may demand."""
    from .llm import MODEL, _client

    client = _client()
    if client is None:
        return None
    facts = facts_for_agent(ctx, sit, steps, agent)
    allowed = allowed_codes(agent)
    user = (f"ROUND {round_n} ({'the naive first proposal' if round_n == 1 else 'the revised proposal after objections'}).\n"
            f"ALLOWED constraint codes: {allowed}\n\nFACTS:\n{json.dumps(facts)}")
    try:
        response = await client.beta.messages.create(
            model=MODEL, max_tokens=350,
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            system=_system(ctx, agent),
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA}},
            messages=[{"role": "user", "content": user}],
        )
    except Exception:
        log.exception("stance call failed for %s", agent)
        return None
    if response.stop_reason == "refusal":
        return None
    raw = next((b.text for b in response.content if b.type == "text"), "")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return validate(ctx, agent, steps, data)


def validate(ctx: WorldContext, agent: str, steps: list[PlanStep], data: dict[str, Any]) -> Stance | None:
    """Turn a model's answer into a Stance the planner accepts; None if it is malformed."""
    stance = data.get("stance")
    if stance not in ("propose", "support", "critique", "veto"):
        return None
    reason = str(data.get("reason", "")).strip()[:400]
    if not reason:
        return None
    ids = {st.id for st in steps}
    step_ids = [x for x in data.get("step_ids", []) if isinstance(x, str) and x in ids][:8]
    c = constraint_for(ctx, agent, str(data.get("constraint_code", "") or ""))
    from .models import Constraint

    constraint = Constraint(type=c[0], rule=c[1], code=c[2], source=agent) if c else None
    from .registry import agent_label, resident_id

    return Stance(agent=agent, label=agent_label(ctx, agent), stance=stance, reason=reason, constraint=constraint,
                  step_ids=step_ids, resident=resident_id(agent), source="claude")


def to_event(st: Stance, situation: str, round_n: int, source: str) -> AgentStance:
    return AgentStance(agent=st.agent, situation=situation, round=round_n, stance=st.stance, reason=st.reason,
                       constraint_type=st.constraint.type if st.constraint else None,
                       constraint_rule=st.constraint.rule if st.constraint else None,
                       constraint_code=st.constraint.code if st.constraint else None,
                       step_ids=list(st.step_ids), source=source)


# ---- the runner ----------------------------------------------------------------------------------------


class Negotiator:
    """Asks every enabled agent for its stance whenever the situation changes, and feeds the answers back
    into the world as AgentStance events. `ask_resident` can be redirected through the Fetch.ai society."""

    def __init__(self, ctx: WorldContext, submit: Callable[[AgentStance], Awaitable[Any]],
                 get_state: Callable[[], WorldState] | None = None) -> None:
        self.ctx = ctx
        self.submit = submit
        self.get_state = get_state
        self.enabled = configured()
        self.requested: set[str] = set()          # "situation#round#agent"
        self.pending: dict[str, float] = {}       # same key -> started at
        self.answered = 0
        self.failed = 0
        self.ask_resident: Callable[[str, Situation, list[PlanStep], int, str], Awaitable[bool]] | None = None
        self._tasks: set[asyncio.Task] = set()

    def on_plan(self, state: WorldState) -> None:
        """Plan listener (sync): schedule the asks this situation still needs."""
        if not self.enabled or state.mode != "live" or state.plan.status == "none" or not state.plan.rounds:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        key = state.plan.situation
        sit = _situation(self.ctx, state)
        for rnd in state.plan.rounds:
            spoken = state.spoken.get(f"{key}#{rnd.n}", {})
            if rnd.n == 2 and not self._round_done(state, key, 1):
                break                                   # round 2 is built from round-1 objections: wait for them
            for agent in state.plan.enabled_agents:
                if agent in ("checker", "redteam") or agent in spoken:
                    continue
                if not self._speaks(agent, sit):
                    continue
                k = f"{key}#{rnd.n}#{agent}"
                if k in self.requested:
                    continue
                self.requested.add(k)
                self.pending[k] = time.time()
                task = loop.create_task(self._ask(agent, sit, list(rnd.steps), rnd.n, key))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
        if len(self.requested) > 4000:
            self.requested = set(list(self.requested)[-2000:])

    def _speaks(self, agent: str, sit: Situation) -> bool:
        """Only agents with something at stake are asked: specialists always, residents on a dark floor or
        with a flagged impact (the rule functions stay silent for the rest, and so does the model)."""
        if not agent.startswith("resident:"):
            return True
        rid = agent.split(":", 1)[1]
        r = self.ctx.roster.by_id().get(rid)
        if r is None:
            return False
        return r.level in set(sit.dark_planned) or bool(sit.flagged.get(rid)) or rid in self.ctx.story_order

    def _round_done(self, state: WorldState, key: str, n: int) -> bool:
        """Round n is answered when every asked agent has spoken or timed out."""
        for k in list(self.pending):
            if k.startswith(f"{key}#{n}#") and time.time() - self.pending[k] < AGENT_TIMEOUT_S + 5:
                return False
        return True

    async def _ask(self, agent: str, sit: Situation, steps: list[PlanStep], round_n: int, key: str) -> None:
        k = f"{key}#{round_n}#{agent}"
        try:
            if agent.startswith("resident:") and self.ask_resident is not None:
                ok = await asyncio.wait_for(self.ask_resident(agent, sit, steps, round_n, key), timeout=AGENT_TIMEOUT_S)
                if ok:
                    self.answered += 1
                    return
            st = await asyncio.wait_for(stance_llm(self.ctx, sit, steps, agent, round_n), timeout=AGENT_TIMEOUT_S)
            if st is None:
                self.failed += 1
                return                                  # the rule function stands for this agent
            await self.submit(to_event(st, key, round_n, "claude"))
            self.answered += 1
        except (asyncio.TimeoutError, Exception):      # noqa: BLE001 - a silent agent must never stall the world
            log.exception("agent %s did not answer", agent)
            self.failed += 1
        finally:
            self.pending.pop(k, None)
            # Whether or not the answer changed the plan, see what this situation still needs (round 2).
            if self.get_state is not None:
                try:
                    self.on_plan(self.get_state())
                except Exception:  # noqa: BLE001
                    log.exception("negotiator follow-up failed")

    async def accept_from_network(self, st: Stance, key: str, round_n: int) -> None:
        """A resident's Fetch.ai agent sent a model-made stance: log it like any other."""
        k = f"{key}#{round_n}#{st.agent}"
        if k in self.requested:
            await self.submit(to_event(st, key, round_n, "fetch:claude"))
            self.pending.pop(k, None)
            self.answered += 1

    def status(self, state: WorldState) -> dict[str, Any]:
        key = state.plan.situation
        return {
            "mode": "claude" if self.enabled else "rules",
            "configured": self.enabled,
            "situation": key,
            "pending": sorted(k.split("#", 2)[2] + f"#{k.split('#')[1]}" for k in self.pending if k.startswith(key)),
            "spoken": {rk: {a: {"stance": s.stance, "source": s.source} for a, s in v.items()}
                       for rk, v in state.spoken.items() if rk.startswith(key)},
            "answered": self.answered, "failed": self.failed,
        }
