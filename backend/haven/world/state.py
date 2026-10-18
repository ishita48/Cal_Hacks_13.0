"""The authoritative world state and its pure reducer.

`apply_input` folds one input event into the state; `advance` runs one fixed simulation
step. Both are deterministic functions of (state, input, static context): the same inputs
at the same steps give the same world. Nothing outside this module mutates a WorldState.

Derived facts (water depth, flooded switchgear, dead lifts, dark floors, who is stranded,
and the forecast of all of that) are recomputed here from inputs + physics and recorded on
the timeline. Replay re-derives them; they are never logged as inputs.
"""

import math
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..agents.models import Constraint, Plan
from ..agents.planner import compute_plan
from ..building.graph import POWER_RELS, powered_levels
from .cascade import Forecast, Impact, assess, describe, forecast
from .context import WorldContext
from .events import ActionEvent, AgentToggle, EquipmentCommand, InputEvent, ManagerRule, PlanDecision, SensorReading
from .physics import Happening, Hydraulics, step

# Fixed simulation step, in simulated seconds.
DT = 0.2
# Wall-clock time of day (seconds after midnight) at step 0: Tuesday 23:41:30.
SCENARIO_START_TOD = 23 * 3600 + 41 * 60 + 30

WET_THRESHOLD = 0.5
DEFAULT_VALVE_SECONDS = 60.0

EquipmentStatus = Literal["online", "offline", "flooded", "isolated", "closing", "closed"]


class SensorState(BaseModel):
    value: float = 0.0
    wet: bool = False
    last_step: int | None = None
    source: str | None = None


class TimelineEntry(BaseModel):
    step: int
    kind: str
    severity: Literal["info", "warning", "critical"] = "info"
    message: str
    data: dict[str, Any] = Field(default_factory=dict)


class WaterState(BaseModel):
    depth: float            # metres
    volume: float           # m3


class LeakState(BaseModel):
    equipment_id: str
    space: str
    flow_lps: float
    started_step: int
    active: bool = True     # False once an upstream valve is closed


class EquipmentState(BaseModel):
    status: EquipmentStatus = "online"
    since_step: int = 0


class PendingCommand(BaseModel):
    equipment_id: str
    command: str
    actor: str
    issued_step: int
    completes_step: int


class ActionState(BaseModel):
    step_id: str
    status: Literal["assigned", "done", "failed"]
    step: int
    detail: str = ""


class PowerState(BaseModel):
    live: list[str] = Field(default_factory=list)
    levels: dict[str, bool] = Field(default_factory=dict)
    lifts: dict[str, bool] = Field(default_factory=dict)


class WorldState(BaseModel):
    run_id: str
    scenario: str
    mode: Literal["live", "replay"] = "live"
    step: int = 0
    version: int = 0
    sensors: dict[str, SensorState] = Field(default_factory=dict)
    timeline: list[TimelineEntry] = Field(default_factory=list)

    # -- physical world (inputs + physics) --
    water: dict[str, WaterState] = Field(default_factory=dict)       # space id -> water
    wet_spaces: list[str] = Field(default_factory=list)              # ever wet, sorted
    leaks: dict[str, LeakState] = Field(default_factory=dict)        # leaking equipment id -> leak
    flooded: list[str] = Field(default_factory=list)                 # equipment destroyed by water
    isolated: list[str] = Field(default_factory=list)                # equipment switched off
    closed_valves: list[str] = Field(default_factory=list)
    pending: list[PendingCommand] = Field(default_factory=list)

    # -- the negotiation's inputs --
    agents: dict[str, bool] = Field(default_factory=dict)            # agent id -> enabled
    rules: list[Constraint] = Field(default_factory=list)            # manager-imposed constraints
    approved_plan_version: int | None = None
    approved_plan: Plan | None = None            # frozen copy being executed; state.plan keeps advising
    actions: dict[str, ActionState] = Field(default_factory=dict)    # step id -> progress
    moved: dict[str, str] = Field(default_factory=dict)              # resident id -> space they are in now

    # -- derived views (recomputed by the reducer, never logged) --
    equipment: dict[str, EquipmentState] = Field(default_factory=dict)
    power: PowerState = Field(default_factory=PowerState)
    impact: Impact = Field(default_factory=Impact)
    forecast: Forecast = Field(default_factory=Forecast)
    plan: Plan = Field(default_factory=Plan)

    @property
    def sim_time(self) -> float:
        return self.step * DT

    def record(self, kind: str, message: str, severity: str = "info", **data: Any) -> None:
        self.timeline.append(
            TimelineEntry(step=self.step, kind=kind, severity=severity, message=message, data=data)
        )


def initial_state(run_id: str, scenario: str, ctx: WorldContext, mode: str = "live") -> WorldState:
    state = WorldState(run_id=run_id, scenario=scenario, mode=mode)
    state.equipment = {eid: EquipmentState() for eid in sorted(ctx.equipment)}
    state.agents = {a: True for a in default_agents(ctx)}
    _rederive(state, ctx, [], narrate=False)
    return state


def default_agents(ctx: WorldContext) -> list[str]:
    """Specialists plus one personal agent per resident with a specific need or a story."""
    out = ["safety", "housing", "capacity"]
    for r in ctx.roster.residents:
        if r.needs or r.story:
            out.append(f"resident:{r.id}")
    return out


# ---- reducer ------------------------------------------------------------------------------


def apply_input(state: WorldState, event: InputEvent, ctx: WorldContext) -> None:
    changed = True
    if isinstance(event, SensorReading):
        changed = _apply_sensor(state, event, ctx)
    elif isinstance(event, EquipmentCommand):
        _apply_command(state, event, ctx)
    elif isinstance(event, AgentToggle):
        _apply_toggle(state, event, ctx)
    elif isinstance(event, ManagerRule):
        state.rules.append(Constraint(type="hard", rule=event.text, code=event.code, source=event.actor))
        state.record("rule", f'{event.actor}: "{event.text}"', "warning", code=event.code)
    elif isinstance(event, PlanDecision):
        _apply_decision(state, event)
    elif isinstance(event, ActionEvent):
        _apply_action(state, event, ctx)
    if changed:          # a repeated wet/dry reading changes nothing physical: skip the forecast
        _rederive(state, ctx, [])
    state.version += 1


def advance(state: WorldState, ctx: WorldContext) -> bool:
    """Run one simulation step. Returns True if anything observable changed."""
    state.step += 1
    changed = False

    due = [p for p in state.pending if p.completes_step <= state.step]
    if due:
        state.pending = [p for p in state.pending if p.completes_step > state.step]
        for p in due:
            _complete_command(state, p, ctx)
        changed = True

    if state.water or state.leaks:
        h = _hydraulics(state, ctx)
        happenings = step(h, ctx, DT)
        _store_water(state, h, ctx)
        if happenings or changed:
            _rederive(state, ctx, happenings, h)
        changed = True

    if changed:
        state.version += 1
    return changed


# ---- inputs -------------------------------------------------------------------------------


def _apply_sensor(state: WorldState, ev: SensorReading, ctx: WorldContext) -> bool:
    sensor = state.sensors.setdefault(ev.sensor_id, SensorState())
    was_wet = sensor.wet
    sensor.value = ev.value
    sensor.wet = ev.value >= WET_THRESHOLD
    sensor.last_step = state.step
    sensor.source = ev.source
    if sensor.wet == was_wet:
        return False
    if sensor.wet:
        state.record("sensor_wet", f"Water detected by {ev.sensor_id} ({ev.source})", "critical",
                     sensor_id=ev.sensor_id, value=ev.value)
        for eq_id in ctx.sensor_targets.get(ev.sensor_id, ()):
            eq = ctx.equipment[eq_id]
            flow = eq.props.get("burst_flow_lps")
            if flow is None or eq_id in state.leaks:
                continue
            state.leaks[eq_id] = LeakState(equipment_id=eq_id, space=eq.space, flow_lps=float(flow),  # type: ignore[arg-type]
                                           started_step=state.step)
            state.record("leak", f"{eq.name} has burst — ~{float(flow):.0f} L/s into {ctx.spec.space(eq.space).name}",  # type: ignore[arg-type]
                         "critical", equipment_id=eq_id, space=eq.space, flow_lps=flow)
    else:
        state.record("sensor_dry", f"{ev.sensor_id} reads dry", "info", sensor_id=ev.sensor_id)
        for eq_id in ctx.sensor_targets.get(ev.sensor_id, ()):
            if eq_id in state.leaks:
                del state.leaks[eq_id]
                state.record("leak_stopped", f"{ctx.equipment[eq_id].name} no longer leaking", "info",
                             equipment_id=eq_id)
    return True


def _apply_command(state: WorldState, ev: EquipmentCommand, ctx: WorldContext) -> None:
    eq = ctx.equipment.get(ev.equipment_id)
    if eq is None:
        state.record("command_rejected", f"Unknown equipment {ev.equipment_id}", "warning", actor=ev.actor)
        return
    cmd = ev.command
    if cmd == "close":
        if eq.id in state.closed_valves or any(p.equipment_id == eq.id for p in state.pending):
            return
        secs = float(eq.props.get("seconds_to_close", DEFAULT_VALVE_SECONDS))  # type: ignore[arg-type]
        done = state.step + max(1, math.ceil(secs / DT))
        state.pending.append(PendingCommand(equipment_id=eq.id, command=cmd, actor=ev.actor,
                                            issued_step=state.step, completes_step=done))
        state.record("command", f"{ev.actor}: closing {eq.name} (~{secs / 60:.0f} min)", "info",
                     equipment_id=eq.id, command=cmd, actor=ev.actor, seconds=secs)
    elif cmd == "open":
        state.pending = [p for p in state.pending if p.equipment_id != eq.id]
        if eq.id in state.closed_valves:
            state.closed_valves.remove(eq.id)
        state.record("command", f"{ev.actor}: opened {eq.name}", "info", equipment_id=eq.id, command=cmd,
                     actor=ev.actor)
    elif cmd == "off":
        if eq.id not in state.isolated:
            state.isolated = sorted({*state.isolated, eq.id})
        state.record("command", f"{ev.actor}: isolated {eq.name} (switched off)", "warning",
                     equipment_id=eq.id, command=cmd, actor=ev.actor)
    elif cmd == "on":
        if eq.id in state.isolated:
            state.isolated.remove(eq.id)
        state.record("command", f"{ev.actor}: restored {eq.name}", "info", equipment_id=eq.id, command=cmd,
                     actor=ev.actor)


def _apply_toggle(state: WorldState, ev: AgentToggle, ctx: WorldContext) -> None:
    if ev.agent not in state.agents:
        state.record("command_rejected", f"Unknown agent {ev.agent}", "warning")
        return
    state.agents[ev.agent] = ev.enabled
    label = agent_label(ctx, ev.agent)
    state.record("agent_toggle", f"{label} switched {'on' if ev.enabled else 'OFF'}",
                 "info" if ev.enabled else "warning", agent=ev.agent, enabled=ev.enabled)


def _apply_decision(state: WorldState, ev: PlanDecision) -> None:
    if ev.plan_version != state.plan.version:
        state.record("command_rejected", f"Decision on stale plan v{ev.plan_version} (current v{state.plan.version})",
                     "warning")
        return
    if ev.decision == "approve":
        state.approved_plan_version = ev.plan_version
        state.approved_plan = state.plan.model_copy(deep=True)
        state.approved_plan.status = "approved"
        state.record("plan_approved", f"{ev.actor} approved plan v{ev.plan_version}: HAVEN is acting", "info",
                     version=ev.plan_version)
    else:
        state.approved_plan_version = None
        state.approved_plan = None
        state.record("plan_rejected", f"{ev.actor} rejected plan v{ev.plan_version}", "warning", version=ev.plan_version)


def _apply_action(state: WorldState, ev: ActionEvent, ctx: WorldContext) -> None:
    plan = state.approved_plan
    step = next((s for s in plan.steps if s.id == ev.step_id), None) if plan else None
    if step is None:
        state.record("command_rejected", f"Action on unknown step {ev.step_id}", "warning")
        return
    state.actions[ev.step_id] = ActionState(step_id=ev.step_id, status=ev.status, step=state.step, detail=ev.detail)
    sev = "warning" if ev.status == "failed" else "info"
    verb = {"assigned": "assigned", "done": "done", "failed": "FAILED"}[ev.status]
    state.record("action", f"{verb}: {step.title}" + (f" — {ev.detail}" if ev.detail else ""), sev,
                 step_id=step.id, status=ev.status, step_kind=step.kind, people=step.people)
    if ev.status == "done" and step.kind in ("escort", "relocate", "shelter") and step.people:
        where = _place(ctx, step.target, step.kind)
        for rid in step.people:
            if step.kind == "shelter":
                state.moved.pop(rid, None)
            elif where:
                state.moved[rid] = where
    if plan is not None:
        statuses = [state.actions.get(s.id).status if s.id in state.actions else None for s in plan.steps]
        plan.status = "done" if all(st == "done" for st in statuses) else "executing"


def _place(ctx: WorldContext, target: str | None, kind: str) -> str | None:
    """Where people end up after a step: a space id, or 'outside' for another building."""
    if target is None:
        return "L1-lobby" if kind == "escort" else None
    if target in ctx.areas:
        return target
    if target in ctx.level_order:
        for s in ctx.spec.spaces:
            if s.level == target and s.kind in ("lounge", "study", "kitchen", "amenity") and s.capacity > 0:
                return s.id
    return "outside"


def agent_label(ctx: WorldContext, agent: str) -> str:
    if agent.startswith("resident:"):
        r = ctx.roster.by_id().get(agent.split(":", 1)[1])
        return f"{r.name.split()[0]}'s agent" if r else agent
    return {"safety": "Safety agent", "housing": "Housing agent", "capacity": "Capacity agent"}.get(agent, agent)


def _complete_command(state: WorldState, p: PendingCommand, ctx: WorldContext) -> None:
    eq = ctx.equipment[p.equipment_id]
    if p.command == "close":
        state.closed_valves = sorted({*state.closed_valves, eq.id})
        stopped = [l for l in state.leaks.values()
                   if eq.id in ctx.upstream_valves.get(l.equipment_id, ())]
        for l in stopped:
            l.active = False
        msg = f"{eq.name} closed"
        if stopped:
            msg += " — " + ", ".join(ctx.equipment[l.equipment_id].name for l in stopped) + " stopped"
        state.record("valve_closed", msg, "info", equipment_id=eq.id, actor=p.actor)


# ---- derivation ---------------------------------------------------------------------------


def _hydraulics(state: WorldState, ctx: WorldContext) -> Hydraulics:
    return Hydraulics(
        volumes={sp: w.volume for sp, w in state.water.items()},
        flooded=set(state.flooded), isolated=set(state.isolated), closed_valves=set(state.closed_valves),
        leaks={eid: l.flow_lps for eid, l in state.leaks.items()},
        wet=set(state.wet_spaces), live=set(state.power.live),
    )


def _store_water(state: WorldState, h: Hydraulics, ctx: WorldContext) -> None:
    state.water = {sp: WaterState(depth=v / ctx.areas[sp], volume=v) for sp, v in sorted(h.volumes.items())}
    state.wet_spaces = sorted(h.wet)
    state.flooded = sorted(h.flooded)


def _rederive(state: WorldState, ctx: WorldContext, happenings: list[Happening], h: Hydraulics | None = None,
              narrate: bool = True) -> None:
    """Recompute every derived view from the physical state and narrate what changed."""
    h = h or _hydraulics(state, ctx)
    h.refresh_power(ctx)
    live_before = set(state.power.live)
    impact_before = state.impact

    _store_water(state, h, ctx)
    for leak in state.leaks.values():
        leak.active = h.leak_active(ctx, leak.equipment_id)
    state.power = PowerState(live=sorted(h.live), levels=powered_levels(ctx.graph, h.live),
                             lifts={l: l in h.live for l in ctx.lifts})
    closing = {p.equipment_id for p in state.pending if p.command == "close"}
    for eid in ctx.equipment:
        status = _status(eid, h, ctx, closing)
        cur = state.equipment.get(eid)
        if cur is None or cur.status != status:
            state.equipment[eid] = EquipmentState(status=status, since_step=state.step)
    state.impact = assess(ctx, h.live, h.wet, state.moved)
    if narrate:
        for ev in describe(ctx, happenings, live_before, h.live, impact_before, state.impact):
            state.record(ev.kind, ev.message, ev.severity, id=ev.id, cause=ev.cause, **ev.data)
    state.forecast = forecast(h, ctx, state.impact, state.step, moved=state.moved)
    state.plan = compute_plan(ctx, state)


def _status(eid: str, h: Hydraulics, ctx: WorldContext, closing: set[str]) -> EquipmentStatus:
    if eid in h.flooded:
        return "flooded"
    if eid in h.isolated:
        return "isolated"
    if eid in h.closed_valves:
        return "closed"
    if eid in closing:
        return "closing"
    powered = any(d["rel"] in POWER_RELS for _, _, d in ctx.graph.in_edges(eid, data=True))
    if powered and eid not in h.live:
        return "offline"
    return "online"


# ---- replay -------------------------------------------------------------------------------


def replay_events(run_id: str, scenario: str, events: list, until_step: int, ctx: WorldContext) -> WorldState:
    """Rebuild a world from its log, headless. Used for tests and fast-forward replay."""
    state = initial_state(run_id, scenario, ctx, mode="replay")
    pending = sorted(events, key=lambda e: e.seq)
    i = 0
    while True:
        while i < len(pending) and pending[i].step == state.step:
            apply_input(state, pending[i].event, ctx)
            i += 1
        if state.step >= until_step:
            return state
        advance(state, ctx)
