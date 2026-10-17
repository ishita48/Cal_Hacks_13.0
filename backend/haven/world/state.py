"""The authoritative world state and its pure reducer.

`apply_input` folds one input event into the state; `advance` runs one fixed simulation
step. Both are deterministic: the same inputs at the same steps give the same world.
Nothing outside this module mutates a WorldState.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from .events import InputEvent, SensorReading

# Fixed simulation step, in simulated seconds.
DT = 0.2
# Wall-clock time of day (seconds after midnight) at step 0: Tuesday 23:41:30.
SCENARIO_START_TOD = 23 * 3600 + 41 * 60 + 30

WET_THRESHOLD = 0.5


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


class WorldState(BaseModel):
    run_id: str
    scenario: str
    mode: Literal["live", "replay"] = "live"
    step: int = 0
    version: int = 0
    sensors: dict[str, SensorState] = Field(default_factory=dict)
    timeline: list[TimelineEntry] = Field(default_factory=list)

    @property
    def sim_time(self) -> float:
        return self.step * DT

    def record(self, kind: str, message: str, severity: str = "info", **data: Any) -> None:
        self.timeline.append(
            TimelineEntry(step=self.step, kind=kind, severity=severity, message=message, data=data)
        )


def initial_state(run_id: str, scenario: str, mode: str = "live") -> WorldState:
    return WorldState(run_id=run_id, scenario=scenario, mode=mode)


def apply_input(state: WorldState, event: InputEvent) -> None:
    if isinstance(event, SensorReading):
        _apply_sensor(state, event)
    state.version += 1


def advance(state: WorldState) -> bool:
    """Run one simulation step. Returns True if anything observable changed."""
    state.step += 1
    return False


def _apply_sensor(state: WorldState, ev: SensorReading) -> None:
    sensor = state.sensors.setdefault(ev.sensor_id, SensorState())
    was_wet = sensor.wet
    sensor.value = ev.value
    sensor.wet = ev.value >= WET_THRESHOLD
    sensor.last_step = state.step
    sensor.source = ev.source
    if sensor.wet and not was_wet:
        state.record(
            "sensor_wet",
            f"Water detected by {ev.sensor_id} ({ev.source})",
            "critical",
            sensor_id=ev.sensor_id,
            value=ev.value,
        )
    elif was_wet and not sensor.wet:
        state.record("sensor_dry", f"{ev.sensor_id} reads dry", "info", sensor_id=ev.sensor_id)


def replay_events(run_id: str, scenario: str, events: list, until_step: int) -> WorldState:
    """Rebuild a world from its log, headless. Used for tests and fast-forward replay."""
    state = initial_state(run_id, scenario, mode="replay")
    pending = sorted(events, key=lambda e: e.seq)
    i = 0
    while True:
        while i < len(pending) and pending[i].step == state.step:
            apply_input(state, pending[i].event)
            i += 1
        if state.step >= until_step:
            return state
        advance(state)
