"""Static world context: the building, its graph and its people, pre-indexed for the reducer.

Built once per process and never mutated. The reducer is a pure function of
(WorldState, InputEvent, WorldContext); passing the context explicitly keeps the reducer
testable and replay exact.
"""

from dataclasses import dataclass
from functools import lru_cache

import networkx as nx

from ..building.blackwell import build_blackwell_hall
from ..building.graph import build_graph
from ..building.model import WALKABLE_KINDS, BuildingSpec, Equipment
from ..people.roster import Roster, build_roster

# Passive floor-drain capacity for spaces tagged "floor_drain" (one 4-inch drain, partly clogged).
FLOOR_DRAIN_LPS = 1.5


@dataclass(frozen=True)
class DoorLink:
    a: str
    b: str
    width: float


@dataclass(frozen=True)
class WorldContext:
    spec: BuildingSpec
    graph: nx.MultiDiGraph
    roster: Roster
    areas: dict[str, float]                   # walkable space id -> floor area (m2)
    door_links: tuple[DoorLink, ...]          # same-level openings water can cross
    equipment: dict[str, Equipment]
    equipment_in_space: dict[str, tuple[str, ...]]
    sensor_targets: dict[str, tuple[str, ...]]   # sensor id -> equipment it monitors
    upstream_valves: dict[str, tuple[str, ...]]  # equipment -> valves on its water supply path
    floor_drains: dict[str, float]            # space id -> passive drain capacity (L/s)
    sumps: dict[str, tuple[str, float]]       # space id -> (sump pump equipment id, L/s)
    lifts: tuple[str, ...]
    level_order: dict[str, int]

    def space_level(self, space_id: str) -> str:
        return self.spec.space(space_id).level


@lru_cache(maxsize=1)
def build_context() -> WorldContext:
    spec = build_blackwell_hall()
    graph = build_graph(spec)
    roster = build_roster(spec)
    return make_context(spec, graph, roster)


def make_context(spec: BuildingSpec, graph: nx.MultiDiGraph, roster: Roster) -> WorldContext:
    areas = {s.id: s.rect.area for s in spec.spaces if s.kind in WALKABLE_KINDS}
    links: list[DoorLink] = []
    for o in spec.openings:
        if o.a in areas and o.b in areas:
            links.append(DoorLink(o.a, o.b, o.width))

    equipment = {e.id: e for e in spec.equipment}
    in_space: dict[str, list[str]] = {}
    for e in spec.equipment:
        in_space.setdefault(e.space, []).append(e.id)

    sensor_targets: dict[str, list[str]] = {}
    for d in spec.dependencies:
        if d.rel == "monitors":
            sensor_targets.setdefault(d.src, []).append(d.dst)

    water_up: dict[str, list[str]] = {}
    for d in spec.dependencies:
        if d.rel == "feeds_water":
            water_up.setdefault(d.dst, []).append(d.src)

    def valves_upstream(eq: str) -> tuple[str, ...]:
        out: list[str] = []
        stack = [eq]
        seen = {eq}
        while stack:
            for src in water_up.get(stack.pop(), []):
                if src in seen:
                    continue
                seen.add(src)
                if equipment[src].kind == "valve":
                    out.append(src)
                stack.append(src)
        return tuple(sorted(out))

    upstream_valves = {e.id: valves_upstream(e.id) for e in spec.equipment}

    floor_drains = {s.id: FLOOR_DRAIN_LPS for s in spec.spaces if "floor_drain" in s.tags}
    sumps: dict[str, tuple[str, float]] = {}
    for e in spec.equipment:
        if e.kind == "sump_pump":
            sumps[e.space] = (e.id, float(e.props.get("capacity_lps", 3.0)))  # type: ignore[arg-type]

    lifts = tuple(sorted(e.id for e in spec.equipment if e.kind == "lift"))
    level_order = {lv.id: lv.index for lv in spec.levels}
    return WorldContext(
        spec=spec, graph=graph, roster=roster, areas=areas, door_links=tuple(links),
        equipment=equipment, equipment_in_space={k: tuple(v) for k, v in in_space.items()},
        sensor_targets={k: tuple(v) for k, v in sensor_targets.items()},
        upstream_valves=upstream_valves, floor_drains=floor_drains, sumps=sumps, lifts=lifts,
        level_order=level_order,
    )
