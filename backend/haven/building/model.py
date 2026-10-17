"""Building spec data model: the single description every other layer derives from.

Coordinates are metres. x = east, y = north, z = up. Origin at the building's SW corner
(Dana St x Durant Ave). Spaces are axis-aligned rectangles on one level; walls are implied
by rectangle edges and pierced only by Openings.
"""

from typing import Literal

from pydantic import BaseModel, Field, PrivateAttr

SpaceKind = Literal[
    "room",          # resident room (double or single)
    "corridor",
    "lobby",
    "lounge",
    "study",
    "bathroom",
    "laundry",
    "kitchen",
    "office",
    "retail",
    "amenity",       # fitness, rec room, academic centre, community spaces
    "storage",
    "stair",
    "lift",          # lift car position on this level (the shaft is a VerticalLink)
    "service",       # trash, mail, package rooms
    "mechanical",
    "electrical",
    "generator",
    "riser",         # vertical service shaft
    "courtyard",     # open to sky
]

# Kinds a person can stand in. Shafts and plant rooms are walkable only for staff, but we
# still let the nav grid include plant rooms so staff/plumbers can reach equipment.
WALKABLE_KINDS: frozenset[str] = frozenset(
    {
        "room", "corridor", "lobby", "lounge", "study", "bathroom", "laundry", "kitchen",
        "office", "retail", "amenity", "storage", "stair", "lift", "service", "mechanical",
        "electrical", "generator", "courtyard",
    }
)


class Rect(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def w(self) -> float:
        return self.x1 - self.x0

    @property
    def h(self) -> float:
        return self.y1 - self.y0

    @property
    def area(self) -> float:
        return self.w * self.h

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    def contains(self, x: float, y: float, eps: float = 1e-9) -> bool:
        return self.x0 - eps <= x <= self.x1 + eps and self.y0 - eps <= y <= self.y1 + eps

    def overlaps(self, o: "Rect", eps: float = 1e-6) -> bool:
        return self.x0 < o.x1 - eps and o.x0 < self.x1 - eps and self.y0 < o.y1 - eps and o.y0 < self.y1 - eps


class Level(BaseModel):
    id: str            # "B1", "L1" ... "L7"
    index: int         # B1 = -1, L1 = 1 ...
    name: str
    elevation: float   # finished floor height above grade (m)
    height: float      # floor-to-floor (m)


class Space(BaseModel):
    id: str
    level: str
    kind: SpaceKind
    name: str
    rect: Rect
    capacity: int = 0            # beds for rooms; people for lounges / overflow spaces
    accessible: bool = False     # ADA room (roll-in shower etc.)
    outdoor: bool = False
    tags: list[str] = Field(default_factory=list)


class Opening(BaseModel):
    """A door or open passage on the shared edge between two spaces (or a space and outside)."""

    id: str
    level: str
    a: str                       # space id
    b: str                       # space id, or "outside"
    x: float                     # centre of the opening
    y: float
    width: float
    axis: Literal["x", "y"]      # the wall runs along this axis
    kind: Literal["door", "opening", "exit", "fire_door", "lift_door"] = "door"
    step_free: bool = True


class VerticalLink(BaseModel):
    """A stair or lift shaft: the same xy footprint stacked through several levels."""

    id: str
    kind: Literal["stair", "lift"]
    name: str
    spaces: dict[str, str]       # level id -> space id at that level
    step_free: bool
    # Lifts move only while powered; the equipment id the shaft depends on.
    equipment: str | None = None
    # Seconds to travel one level (lift) or descend one flight (stair, able-bodied).
    seconds_per_level: float = 10.0


class Equipment(BaseModel):
    id: str
    kind: Literal[
        "utility_feed", "switchboard", "switchboard_section", "transfer_switch", "generator",
        "panel", "elevator_controller", "lift", "pump", "sump_pump", "water_main",
        "water_riser", "water_heater", "valve", "fridge", "fire_alarm", "emergency_lighting",
        "sensor",
    ]
    name: str
    level: str
    x: float
    y: float
    space: str                   # space it physically sits in
    # Height above the level's floor of the lowest live part. Water deeper than this destroys
    # or endangers the equipment (switchgear ~0.10 m on a housekeeping pad).
    flood_height: float | None = None
    props: dict[str, str | float | int | bool | list[str]] = Field(default_factory=dict)


class Dependency(BaseModel):
    src: str
    dst: str
    rel: Literal["powers", "backs_up", "feeds_water", "controls", "monitors"]


class BuildingSpec(BaseModel):
    id: str
    name: str
    address: str
    footprint: list[Rect]        # outline used for massing (per typical floor)
    levels: list[Level]
    spaces: list[Space]
    openings: list[Opening]
    verticals: list[VerticalLink]
    equipment: list[Equipment]
    dependencies: list[Dependency]
    notes: list[str] = Field(default_factory=list)

    _idx: dict[str, Space] | None = PrivateAttr(default=None)

    def level(self, level_id: str) -> Level:
        return next(lv for lv in self.levels if lv.id == level_id)

    def space(self, space_id: str) -> Space:
        return self._space_index()[space_id]

    def _space_index(self) -> dict[str, Space]:
        if self._idx is None:
            self._idx = {s.id: s for s in self.spaces}
        return self._idx
