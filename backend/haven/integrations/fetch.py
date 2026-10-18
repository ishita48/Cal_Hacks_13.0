"""Fetch.ai uAgents: the residents' personal agents live on the agent network, not in a prompt.

HAVEN's negotiation is deterministic (haven/agents/planner.py): a resident's stance is a pure
function of their profile and the proposal, and the planner runs it inline so the plan is
reproducible. This module hosts the same personal agents as Fetch.ai uAgents: each resident agent
is its own identity (a stable address derived from a seed), receives every proposal the planner
puts on the table, computes its stance with the very same function, and sends it, signed by its
address, to HAVEN's table agent. The table keeps a ledger per plan version; the dashboard shows
each agent's address and whether what it said on the network matches what the planner used.

Nothing here decides anything: if the network is slow or absent, the plan is unchanged. With
AGENTVERSE_API_KEY set, the agents also register on Agentverse (mailbox), so they are reachable
and inspectable there; without it they run locally inside the backend process.

Env: HAVEN_FETCH=0 disables; HAVEN_FETCH_ALL=1 hosts every resident agent, not only the nine with
a story; HAVEN_FETCH_PORT (default 8010) is the bureau's HTTP port; HAVEN_FETCH_SEED salts the
addresses; AGENTVERSE_API_KEY registers the agents on Agentverse.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import TYPE_CHECKING, Any

from ..agents.models import PlanStep, Stance
from ..agents.planner import STORY_ORDER, Situation, _resident, _situation

if TYPE_CHECKING:
    from ..world.context import WorldContext
    from ..world.state import WorldState

log = logging.getLogger("haven.fetch")

try:
    from uagents import Agent, Bureau, Context, Model

    _AVAILABLE = True
except Exception:  # pragma: no cover - uagents is optional
    _AVAILABLE = False

    class Model:  # type: ignore[no-redef]
        pass


def configured() -> bool:
    return _AVAILABLE and os.environ.get("HAVEN_FETCH", "1") != "0"


def agentverse() -> bool:
    return bool(os.environ.get("AGENTVERSE_API_KEY"))


# ---- the protocol ---------------------------------------------------------------------------------


class Proposal(Model):
    """What the table puts in front of a resident agent: the facts and one round's steps."""

    plan_version: int
    round: int
    facts: dict[str, Any]
    steps: list[dict[str, Any]]


class StanceMessage(Model):
    """What a resident agent sends back, signed by its address."""

    plan_version: int
    round: int
    resident: str
    agent: str
    label: str
    stance: str
    reason: str
    constraint: dict[str, Any] | None = None
    step_ids: list[str] = []


# ---- facts the resident function needs, serialisable ----------------------------------------------


def facts_for(ctx: WorldContext, state: WorldState) -> dict[str, Any]:
    """The slice of the planner's Situation a resident agent reasons from (see planner._resident)."""
    sit = _situation(ctx, state)
    return {"flagged": {k: list(v) for k, v in sit.flagged.items()}, "dark_planned": list(sit.dark_planned),
            "lifts_up": sit.lifts_up, "eta_cut_s": sit.eta_cut_s}


def situation_from(facts: dict[str, Any]) -> Situation:
    return Situation(now_step=0, lifts_up=bool(facts.get("lifts_up", True)), eta_lifts_s=None,
                     eta_cut_s=facts.get("eta_cut_s"), dark_now=[], dark_planned=list(facts.get("dark_planned", [])),
                     valve_closed_at_s=None, stage2_averted=False, movers=[], away=[],
                     flagged={k: list(v) for k, v in facts.get("flagged", {}).items()}, rules=set(), enabled=set())


def resident_stance(ctx: WorldContext, resident_id: str, facts: dict[str, Any], steps: list[dict[str, Any]]) -> Stance | None:
    """The same function the planner runs, evaluated by the resident's own agent."""
    r = ctx.roster.by_id().get(resident_id)
    if r is None:
        return None
    return _resident(ctx, situation_from(facts), r, [PlanStep(**s) for s in steps])


# ---- the society ----------------------------------------------------------------------------------


class Society:
    """One uAgent per hosted resident plus HAVEN's table; a ledger of what each said per plan version."""

    def __init__(self, ctx: WorldContext) -> None:
        self.ctx = ctx
        self.running = False
        self.error = ""
        self.inbox: dict[str, Any] = {"plan_version": 0, "rounds": [], "facts": {}, "enabled": set()}
        self.ledger: dict[int, dict[str, dict[str, Any]]] = {}     # plan version -> agent id -> receipt
        self.expected: dict[str, dict[str, Any]] = {}              # planner's stance per (version) for agreement checks
        self.agents: dict[str, Any] = {}                           # resident id -> uAgent
        self.table = None
        self._bureau = None
        self._task: asyncio.Task | None = None
        self._seen: dict[str, int] = {}

    def _build(self) -> None:
        """Create the uAgents (lazily, on start: tests and tools that never start the bureau pay nothing)."""
        if self.table is not None or not configured():
            return
        seed = os.environ.get("HAVEN_FETCH_SEED", "haven-blackwell-hall")
        hosted = [r.id for r in self.ctx.roster.residents if r.id in STORY_ORDER]
        if os.environ.get("HAVEN_FETCH_ALL") == "1":
            hosted = [r.id for r in self.ctx.roster.residents if r.needs or r.story]
        # uvicorn builds its loop through a loop factory, so the SDK's default loop lookup would pick a
        # different one; every agent and the bureau must be told the running loop explicitly.
        kwargs: dict[str, Any] = {"log_level": logging.WARNING, "loop": asyncio.get_running_loop()}
        if agentverse():
            kwargs["mailbox"] = True
        try:
            self.table = Agent(name="haven_table", seed=f"{seed}:table", **kwargs)
            for rid in hosted:
                self.agents[rid] = Agent(name=f"haven_{rid}", seed=f"{seed}:{rid}", **kwargs)
        except Exception as exc:  # pragma: no cover - SDK/network trouble must not stop the demo
            self.error = f"uagents: {exc}"
            self.agents, self.table = {}, None
            return
        self._wire()

    # -- wiring --------------------------------------------------------------------------------------

    def _wire(self) -> None:
        society = self

        @self.table.on_message(model=StanceMessage)
        async def on_stance(ctx: Context, sender: str, msg: StanceMessage) -> None:
            expected = society.agents.get(msg.resident)
            receipt = {
                "address": sender, "agent": msg.agent, "label": msg.label, "round": msg.round,
                "stance": msg.stance, "reason": msg.reason, "constraint": msg.constraint, "step_ids": msg.step_ids,
                "verified": expected is not None and sender == expected.address, "received_at": time.time(),
            }
            planner = society.expected.get(f"{msg.plan_version}:{msg.round}:{msg.agent}")
            receipt["agrees"] = planner is not None and planner.get("stance") == msg.stance
            society.ledger.setdefault(msg.plan_version, {})[f"{msg.agent}#{msg.round}"] = receipt

        for rid, agent in self.agents.items():
            self._wire_resident(rid, agent)

    def _wire_resident(self, rid: str, agent: Any) -> None:
        society = self

        @agent.on_interval(period=0.5)
        async def consider(ctx: Context) -> None:
            inbox = society.inbox
            v = inbox["plan_version"]
            if v == 0 or society._seen.get(rid) == v:
                return
            society._seen[rid] = v
            if f"resident:{rid}" not in inbox["enabled"]:
                return                       # switched off: this agent does not speak (the Maya moment)
            for rnd in inbox["rounds"]:
                stance = resident_stance(society.ctx, rid, inbox["facts"], rnd["steps"])
                if stance is None:
                    continue
                await ctx.send(society.table.address, StanceMessage(
                    plan_version=v, round=rnd["n"], resident=rid, agent=stance.agent, label=stance.label,
                    stance=stance.stance, reason=stance.reason,
                    constraint=stance.constraint.model_dump() if stance.constraint else None, step_ids=stance.step_ids))

    # -- lifecycle -----------------------------------------------------------------------------------

    async def start(self) -> None:
        if self.running:
            return
        self._build()
        if self.table is None:
            return
        port = int(os.environ.get("HAVEN_FETCH_PORT", "8010"))
        try:
            self._bureau = Bureau(port=port, endpoint=None, loop=asyncio.get_running_loop())
            self._bureau.add(self.table)
            for agent in self.agents.values():
                self._bureau.add(agent)
            self._task = asyncio.create_task(self._bureau.run_async(), name="haven-fetch-bureau")
            self.running = True
        except Exception as exc:  # pragma: no cover
            self.error = f"bureau: {exc}"
            self.running = False

    async def stop(self) -> None:
        task, self._task = self._task, None
        self.running = False
        if task is not None:
            task.cancel()
            try:                                   # the bureau's own shutdown can dawdle; never hang the app on it
                await asyncio.wait_for(asyncio.shield(task), timeout=3.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass

    # -- the table -----------------------------------------------------------------------------------

    def offer(self, state: WorldState) -> None:
        """Put the current plan's rounds in front of every hosted agent (called when the plan version changes)."""
        if self.table is None:
            return
        plan = state.plan
        if plan.version == self.inbox["plan_version"] or not plan.rounds:
            return
        for rnd in plan.rounds:
            for st in rnd.stances:
                self.expected[f"{plan.version}:{rnd.n}:{st.agent}"] = {"stance": st.stance, "reason": st.reason}
        self.inbox = {
            "plan_version": plan.version,
            "rounds": [{"n": r.n, "steps": [s.model_dump() for s in r.steps]} for r in plan.rounds],
            "facts": facts_for(self.ctx, state),
            "enabled": set(plan.enabled_agents),
        }
        self.ledger.setdefault(plan.version, {})
        # Keep the ledger small: the last few versions only.
        for old in sorted(self.ledger)[:-6]:
            self.ledger.pop(old, None)

    def status(self, state: WorldState) -> dict[str, Any]:
        version = state.plan.version
        receipts = self.ledger.get(version, {})
        agents = []
        for rid, agent in self.agents.items():
            r = self.ctx.roster.by_id().get(rid)
            key = f"resident:{rid}"
            said = {n: receipts.get(f"{key}#{n}") for n in (1, 2)}
            agents.append({
                "id": key, "resident": rid, "label": f"{r.name.split()[0]}'s agent" if r else rid,
                "address": agent.address, "enabled": state.agents.get(key, False),
                "hosted": "agentverse" if agentverse() else "local",
                "receipts": {str(n): rc for n, rc in said.items() if rc},
            })
        return {
            "configured": configured(), "running": self.running, "error": self.error,
            "hosted": "agentverse" if agentverse() else "local", "table": self.table.address if self.table else None,
            "plan_version": version, "agents": agents,
            "received": len(receipts), "agreeing": sum(1 for rc in receipts.values() if rc.get("agrees")),
        }
