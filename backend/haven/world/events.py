"""Input events: the only things that can change the world.

Every input event is persisted to the event log stamped with the simulation step at
which it was applied. Because the simulation is deterministic, re-applying the same
inputs at the same steps reproduces the exact same world (this is the replay fallback).

Derived happenings (a lift going offline, a room losing power) are NOT input events;
the reducer computes them and records them on the timeline.
"""

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field


class SensorReading(BaseModel):
    type: Literal["sensor_reading"] = "sensor_reading"
    sensor_id: str
    # Normalised wetness, 0 = dry, 1 = submerged. The ESP32 maps its raw ADC value into this range.
    value: float = Field(ge=0.0, le=1.0)
    source: Literal["manual", "esp32", "replay"] = "manual"


class EquipmentCommand(BaseModel):
    """Someone (an operator, a plumber, later an approved agent action) operates equipment.

    close/open are for valves (closing takes the valve's `seconds_to_close`);
    off/on isolate or restore an electrical item (a flooded item stays dead when switched on).
    """

    type: Literal["equipment_command"] = "equipment_command"
    equipment_id: str
    command: Literal["close", "open", "off", "on"]
    actor: str = "operator"


class AgentToggle(BaseModel):
    """Switch an agent on or off in the negotiation (the Maya moment is this event for 'resident:maya')."""

    type: Literal["agent_toggle"] = "agent_toggle"
    agent: str                    # "resident:maya", "safety", "housing", "capacity"
    enabled: bool


class ManagerRule(BaseModel):
    """A rule the human in charge imposes in plain language; parsed into a constraint code."""

    type: Literal["manager_rule"] = "manager_rule"
    text: str
    code: str                     # e.g. "no_off_campus", "no_moves_after:00:00"
    actor: str = "manager"


class PlanDecision(BaseModel):
    """The human gate: approve (or reject) the current plan version."""

    type: Literal["plan_decision"] = "plan_decision"
    plan_version: int
    decision: Literal["approve", "reject"]
    actor: str = "manager"


InputEvent = Annotated[
    Union[SensorReading, EquipmentCommand, AgentToggle, ManagerRule, PlanDecision], Field(discriminator="type")
]


class LoggedEvent(BaseModel):
    seq: int
    run_id: str
    step: int
    wall_time: float
    event: InputEvent
