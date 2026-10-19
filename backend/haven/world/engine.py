"""WorldEngine: owns the one authoritative WorldState and is the only thing that mutates it.

- Inputs are stamped with the current step, persisted, then applied (live mode).
- A fixed-rate loop advances the simulation according to the clock (play/pause/speed).
- Every connected client receives the same state stream over a subscriber queue.
- Replay re-applies a stored run's inputs at their original steps.
"""

import asyncio
import contextlib
import json
import logging
import os
from typing import Any, Callable

from ..building.model import BuildingSpec
from ..integrations import actions
from ..people.roster import Roster
from .context import WorldContext, build_context
from .events import ActionEvent, EquipmentCommand, InputEvent, LoggedEvent
from .state import DT, SCENARIO_START_TOD, WorldState, advance, apply_input, initial_state
from .store import EventStore

log = logging.getLogger("haven.engine")

TICK_SECONDS = 0.1  # real seconds between loop iterations / broadcasts
# What clients never read leaves the frame: `spoken` (every stance logged for the last situations) is the
# planner's input, kept in the state and served whole by GET /api/state, but it is a third of a frame.
FRAME_EXCLUDE = {"spoken"}
MAX_STEPS_PER_TICK = 60  # = MAX_SPEED * TICK_SECONDS / DT; if a tick runs late the sim slows, it never jumps
STEP_FRAME_HZ = 2.0  # frames per second when only the clock advanced (every version change is sent at once)
MAX_SPEED = 120.0


class ReplayActiveError(RuntimeError):
    pass


class WorldEngine:
    def __init__(self, store: EventStore, scenario: str = "blackwell_basement_leak") -> None:
        self.store = store
        # Static world: the building and who lives in it. Immutable for the life of the process.
        self.ctx: WorldContext = build_context()
        self.building: BuildingSpec = self.ctx.spec
        self.graph = self.ctx.graph
        self.roster: Roster = self.ctx.roster
        self.scenario = scenario
        self.playing = True
        self.speed = 1.0
        self._step_budget = 0.0
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._replay_queue: list[LoggedEvent] = []
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._last_broadcast_version = -1
        self._last_broadcast_step = -1
        self._last_broadcast_at = 0.0
        self._last_plan_version = -1
        self.plan_listeners: list[Callable[[WorldState], None]] = []   # called when the plan version changes
        self.state: WorldState = initial_state(store.create_run(scenario), scenario, self.ctx)

    # ---- lifecycle -------------------------------------------------------------------

    async def start(self) -> None:
        if self._task is None:
            if os.environ.get("HAVEN_LOOP_DEBUG"):
                # Log every callback that holds the event loop longer than 150 ms, with its name: the way to
                # find what stalls the world (and the WebSocket) while fifty agents answer at once.
                loop = asyncio.get_running_loop()
                loop.set_debug(True)
                loop.slow_callback_duration = 0.15
                logging.getLogger("asyncio").setLevel(logging.WARNING)
            self._task = asyncio.create_task(self._loop(), name="haven-world-loop")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    # ---- inputs ----------------------------------------------------------------------

    async def submit(self, event: InputEvent) -> LoggedEvent:
        async with self._lock:
            if self.state.mode == "replay":
                raise ReplayActiveError("World is replaying a recorded run; reset to go live.")
            logged = self.store.append(self.state.run_id, self.state.step, event)
            apply_input(self.state, event, self.ctx)
        await self._broadcast(force=True)
        return logged

    async def reset(self) -> WorldState:
        async with self._lock:
            self.state = initial_state(self.store.create_run(self.scenario), self.scenario, self.ctx)
            self._replay_queue = []
            self._step_budget = 0.0
        await self._broadcast(force=True)
        return self.state

    async def start_replay(self, run_id: str, speed: float | None = None) -> WorldState:
        events = self.store.events(run_id)
        async with self._lock:
            self.state = initial_state(run_id, self.scenario, self.ctx, mode="replay")
            self._replay_queue = events
            self._step_budget = 0.0
            self._apply_due_replay_events()
            if speed is not None:
                self.speed = _clamp_speed(speed)
            self.playing = True
        await self._broadcast(force=True)
        return self.state

    async def set_clock(self, playing: bool | None = None, speed: float | None = None) -> None:
        if playing is not None:
            self.playing = playing
        if speed is not None:
            self.speed = _clamp_speed(speed)
        await self._broadcast(force=True)

    # ---- subscriptions ---------------------------------------------------------------

    def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=8)
        self._subscribers.add(q)
        q.put_nowait(self.frame())
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subscribers.discard(q)

    def snapshot(self, full: bool = False) -> dict[str, Any]:
        state = self.state.model_dump(mode="json", exclude=None if full else FRAME_EXCLUDE)
        return {"type": "state", "clock": self.clock(), "state": state}

    def frame(self) -> str:
        """The state frame as text, encoded once and shared by every subscriber."""
        return json.dumps(self.snapshot(), ensure_ascii=False, separators=(",", ":"))

    def clock(self) -> dict[str, Any]:
        sim_time = self.state.sim_time
        return {
            "step": self.state.step,
            "sim_time": sim_time,
            "time_of_day": (SCENARIO_START_TOD + sim_time) % 86400,
            "dt": DT,
            "playing": self.playing,
            "speed": self.speed,
            "mode": self.state.mode,
            "replay_remaining": len(self._replay_queue),
        }

    # ---- loop ------------------------------------------------------------------------

    async def _loop(self) -> None:
        loop = asyncio.get_running_loop()
        next_tick = loop.time()
        while True:
            next_tick += TICK_SECONDS
            try:
                async with self._lock:
                    if self.playing:
                        self._step_budget = min(self._step_budget + self.speed * TICK_SECONDS / DT, MAX_STEPS_PER_TICK)
                        while self._step_budget >= 1.0:
                            self._step_budget -= 1.0
                            advance(self.state, self.ctx)
                            self._apply_due_replay_events()
                await self._execute_due()
                self._remember_outcome()
                await self._broadcast()
            except Exception:  # keep the world alive; one bad tick must not kill the demo
                log.exception("world loop tick failed")
            await asyncio.sleep(max(0.0, next_tick - loop.time()))

    # ---- memory ------------------------------------------------------------------------------

    def outcome(self) -> dict[str, Any] | None:
        """The incident's outcome once the approved plan is done; None before that."""
        st = self.state
        plan = st.approved_plan
        if plan is None or plan.status != "done":
            return None
        start = next((t.step for t in st.timeline if t.kind == "sensor_wet"), None)
        done_steps = [t.step for t in st.timeline if t.kind == "action" and t.data.get("status") == "done"]
        if start is None or not done_steps:
            return None
        approved = next((t.step for t in st.timeline if t.kind == "plan_approved"), start)
        return {
            "scenario": st.scenario, "mode": st.mode,
            "minutes_to_done": round((max(done_steps) - start) * DT / 60, 1),
            "minutes_to_approve": round((approved - start) * DT / 60, 1),
            "left_behind": len(plan.left_behind),
            "violations": int(plan.metrics.get("violations", 0)),
            "attacks_landed": int(plan.metrics.get("attacks_landed", 0)),
            "residents_affected": int(plan.metrics.get("residents_affected", 0)),
            "rules": [r.code for r in st.rules],
            "agents_off": [a for a, on in st.agents.items() if not on],
            "model_stances": sum(1 for s in plan.stances if s.source and s.source != "rules"),
        }

    def _remember_outcome(self) -> None:
        if self.state.mode != "live" or getattr(self, "_remembered", None) == self.state.run_id:
            return
        out = self.outcome()
        if out is not None:
            self.store.save_outcome(self.state.run_id, out)
            self._remembered = self.state.run_id

    # ---- acting on the approved plan --------------------------------------------------------

    def due_actions(self) -> list[InputEvent]:
        """Events the executor owes the world right now: commands at their time, progress reports."""
        st = self.state
        plan = st.approved_plan
        if st.mode != "live" or plan is None or plan.status == "done":
            return []
        elapsed = (st.step - plan.computed_step) * DT
        out: list[InputEvent] = []
        for step in plan.steps:
            cur = st.actions.get(step.id)
            if cur is None and step.at_s <= elapsed:
                if step.command:
                    out.append(EquipmentCommand(**step.command, actor="haven:plan", step_id=step.id))
                if step.kind in ("call", "notify", "ticket", "valve", "isolate"):
                    detail = {"call": "plumber dispatched, ETA ~20 min", "notify": f"{step.count} messages sent",
                              "ticket": "ticket opened", "valve": "plumber on site, closing",
                              "isolate": "breaker opened"}.get(step.kind, "")
                    out.append(ActionEvent(step_id=step.id, status="done" if step.kind != "valve" else "assigned",
                                           detail=detail))
                else:
                    out.append(ActionEvent(step_id=step.id, status="assigned", detail=f"{step.actor} dispatched"))
            elif cur is not None and cur.status == "assigned" and step.deadline_s is not None and step.deadline_s <= elapsed:
                out.append(ActionEvent(step_id=step.id, status="done", actor="haven:auto",
                                       detail=f"auto-confirmed at the deadline (no acknowledgement from {step.actor})"))
            elif cur is not None and cur.status == "assigned" and step.deadline_s is None and step.at_s + 60 <= elapsed:
                out.append(ActionEvent(step_id=step.id, status="done", actor="haven:auto",
                                       detail=f"auto-confirmed (no acknowledgement from {step.actor})"))
        return out

    async def _execute_due(self) -> None:
        plan = self.state.approved_plan
        for ev in self.due_actions():
            if isinstance(ev, ActionEvent) and ev.status == "done" and plan is not None:
                step = next((s for s in plan.steps if s.id == ev.step_id), None)
                if step is not None and step.kind in ("call", "ticket", "notify"):
                    # The outward effect (phone call, ticket, text) happens here, once; its result is the detail.
                    ev.detail = await actions.perform(self.state.run_id, step, plan, ev.detail, self.ctx.short_name)
            await self.submit(ev)

    def _apply_due_replay_events(self) -> None:
        while self._replay_queue and self._replay_queue[0].step <= self.state.step:
            apply_input(self.state, self._replay_queue.pop(0).event, self.ctx)

    async def _broadcast(self, force: bool = False) -> None:
        now = asyncio.get_running_loop().time()
        if not force:
            if self.state.version == self._last_broadcast_version and self.state.step == self._last_broadcast_step:
                return
            # Only the clock moved: frames can be large, so cap step-only frames at STEP_FRAME_HZ.
            if self.state.version == self._last_broadcast_version and now - self._last_broadcast_at < 1.0 / STEP_FRAME_HZ:
                return
        self._last_broadcast_version = self.state.version
        self._last_broadcast_step = self.state.step
        self._last_broadcast_at = now
        if self.state.plan.version != self._last_plan_version:
            self._last_plan_version = self.state.plan.version
            for fn in self.plan_listeners:
                try:
                    fn(self.state)
                except Exception:  # a listener (the agent network) must never break the world
                    log.exception("plan listener failed")
        if not self._subscribers:
            return
        msg = self.frame()
        for q in list(self._subscribers):
            if q.full():  # slow client: drop its stale frame, keep the newest
                with contextlib.suppress(asyncio.QueueEmpty):
                    q.get_nowait()
            q.put_nowait(msg)


def _clamp_speed(speed: float) -> float:
    return max(0.1, min(MAX_SPEED, float(speed)))
