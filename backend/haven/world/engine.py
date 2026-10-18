"""WorldEngine: owns the one authoritative WorldState and is the only thing that mutates it.

- Inputs are stamped with the current step, persisted, then applied (live mode).
- A fixed-rate loop advances the simulation according to the clock (play/pause/speed).
- Every connected client receives the same state stream over a subscriber queue.
- Replay re-applies a stored run's inputs at their original steps.
"""

import asyncio
import contextlib
import logging
from typing import Any

from ..building.model import BuildingSpec
from ..people.roster import Roster
from .context import WorldContext, build_context
from .events import InputEvent, LoggedEvent
from .state import DT, SCENARIO_START_TOD, WorldState, advance, apply_input, initial_state
from .store import EventStore

log = logging.getLogger("haven.engine")

TICK_SECONDS = 0.1  # real seconds between loop iterations / broadcasts
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
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._replay_queue: list[LoggedEvent] = []
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._last_broadcast_version = -1
        self._last_broadcast_step = -1
        self.state: WorldState = initial_state(store.create_run(scenario), scenario, self.ctx)

    # ---- lifecycle -------------------------------------------------------------------

    async def start(self) -> None:
        if self._task is None:
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

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=8)
        self._subscribers.add(q)
        q.put_nowait(self.snapshot())
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(q)

    def snapshot(self) -> dict[str, Any]:
        return {"type": "state", "clock": self.clock(), "state": self.state.model_dump(mode="json")}

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
                        self._step_budget += self.speed * TICK_SECONDS / DT
                        while self._step_budget >= 1.0:
                            self._step_budget -= 1.0
                            advance(self.state, self.ctx)
                            self._apply_due_replay_events()
                await self._broadcast()
            except Exception:  # keep the world alive; one bad tick must not kill the demo
                log.exception("world loop tick failed")
            await asyncio.sleep(max(0.0, next_tick - loop.time()))

    def _apply_due_replay_events(self) -> None:
        while self._replay_queue and self._replay_queue[0].step <= self.state.step:
            apply_input(self.state, self._replay_queue.pop(0).event, self.ctx)

    async def _broadcast(self, force: bool = False) -> None:
        if not force and (
            self.state.version == self._last_broadcast_version
            and self.state.step == self._last_broadcast_step
        ):
            return
        self._last_broadcast_version = self.state.version
        self._last_broadcast_step = self.state.step
        msg = self.snapshot()
        for q in list(self._subscribers):
            if q.full():  # slow client: drop its stale frame, keep the newest
                with contextlib.suppress(asyncio.QueueEmpty):
                    q.get_nowait()
            q.put_nowait(msg)


def _clamp_speed(speed: float) -> float:
    return max(0.1, min(MAX_SPEED, float(speed)))
