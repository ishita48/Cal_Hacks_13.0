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


InputEvent = Annotated[Union[SensorReading], Field(discriminator="type")]


class LoggedEvent(BaseModel):
    seq: int
    run_id: str
    step: int
    wall_time: float
    event: InputEvent
