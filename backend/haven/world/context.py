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
    story_order: tuple[str, ...]              # residents with a story, in roster order (the demo's named people)
    assembly_point: str                       # the space tagged main_entrance (where lift escorts end)
    sensor_ids: tuple[str, ...]               # water sensors, in spec order
    fridges: dict[str, str]                   # level -> fridge equipment id
    egress_stairs: dict[str, tuple[str, ...]] # level -> stair space ids on that level that reach the ground floor
    ground: str                               # the ground floor level id
    below_ground: tuple[str, ...]             # basement levels (index below the ground floor)
    top_level: str                            # the highest level id (the roof sits on it)
    main_switchboard: str | None              # the building's main switchboard (kind "switchboard"), if any
    ras: dict[str, str]                       # level -> the resident id of that floor's RA (role "ra")
    links_by_space: dict[str, tuple[int, ...]]  # space id -> indices into door_links that touch it
    short_name: str                           # the building as people say it ("Blackwell Hall")

    def space_level(self, space_id: str) -> str:
        return self.spec.space(space_id).level

    def level_short(self, level_id: str) -> str:
        """The level in a sentence: '4' for Floor 4, 'ground', 'basement'."""
        return self.spec.level(level_id).short

    def is_upstairs(self, level_id: str) -> bool:
        """Above the ground floor: a lift or a stair is needed to get out."""
        return self.level_order[level_id] > self.level_order[self.ground]

    def ra_for(self, level_id: str) -> str | None:
        """The RA living on this level, if the roster has one."""
        return self.ras.get(level_id)

    def valve_for(self, equipment_id: str) -> str | None:
        """The shut-off valve upstream of a piece of water equipment (the first one found)."""
        valves = self.upstream_valves.get(equipment_id, ())
        return valves[0] if valves else None

    def place_level(self, target: str | None) -> str | None:
        """The level a plan target refers to: a space id, a level id, or something external (None)."""
        if target is None:
            return None
        if target in self.level_order:
            return target
        if target in self.areas:
            return self.space_level(target)
        return None

    def staff_by_role(self, keyword: str):
        """The first staff member whose role mentions `keyword` (facilities, desk, dean, coordinator)."""
        k = keyword.lower()
        return next((s for s in self.roster.staff if k in s.role.lower()), None)

    def is_electrical(self, eid: str) -> bool:
        """Part of the power graph (a source, switchgear, transfer switch, panel, controller), not a pump or heater."""
        from ..building.graph import POWER_RELS

        return any(d.get("rel") in POWER_RELS for _, _, d in self.graph.out_edges(eid, data=True))

    def hops_to_lift(self, eid: str) -> int:
        """Power hops from this equipment to the nearest lift (large when it feeds none)."""
        from collections import deque

        from ..building.graph import POWER_RELS

        seen, q = {eid}, deque([(eid, 0)])
        while q:
            n, d = q.popleft()
            if n in self.lifts:
                return d
            for _, dst, data in self.graph.out_edges(n, data=True):
                if data.get("rel") in POWER_RELS and dst not in seen:
                    seen.add(dst)
                    q.append((dst, d + 1))
        return 10**6

    def powers_lifts(self, eid: str) -> bool:
        """Does de-energising this equipment take a lift down? (A walk over the power edges.)"""
        from ..building.graph import POWER_RELS

        seen, stack = {eid}, [eid]
        while stack:
            n = stack.pop()
            for _, dst, d in self.graph.out_edges(n, data=True):
                if d.get("rel") in POWER_RELS and dst not in seen:
                    seen.add(dst)
                    stack.append(dst)
        return any(l in seen for l in self.lifts)


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
    ground = min((lv for lv in spec.levels if lv.index >= 1), key=lambda lv: lv.index).id
    assembly = next((s.id for s in spec.spaces if "main_entrance" in s.tags), None) \
        or next((s.id for s in spec.spaces if s.kind == "lobby"), spec.spaces[0].id)
    fridges = {}
    for e in spec.equipment:
        if e.kind == "fridge":
            fridges.setdefault(e.level, e.id)
    egress: dict[str, list[str]] = {}
    for v in spec.verticals:
        if v.kind != "stair" or ground not in v.spaces:
            continue
        for lv, sid in v.spaces.items():
            egress.setdefault(lv, []).append(sid)
    ground_index = level_order[ground]
    below = tuple(lv.id for lv in sorted(spec.levels, key=lambda lv: lv.index) if lv.index < ground_index)
    top = max(spec.levels, key=lambda lv: lv.index).id
    ras: dict[str, str] = {}
    for r in roster.residents:
        if r.role == "ra":
            ras.setdefault(r.level, r.id)
    by_space: dict[str, list[int]] = {}
    for i, link in enumerate(links):
        by_space.setdefault(link.a, []).append(i)
        by_space.setdefault(link.b, []).append(i)
    words = spec.name.split()
    return WorldContext(
        spec=spec, graph=graph, roster=roster, areas=areas, door_links=tuple(links),
        equipment=equipment, equipment_in_space={k: tuple(v) for k, v in in_space.items()},
        sensor_targets={k: tuple(v) for k, v in sensor_targets.items()},
        upstream_valves=upstream_valves, floor_drains=floor_drains, sumps=sumps, lifts=lifts,
        level_order=level_order,
        story_order=tuple(r.id for r in roster.residents if r.story and r.role == "resident"),
        assembly_point=assembly,
        sensor_ids=tuple(e.id for e in spec.equipment if e.kind == "sensor"),
        fridges=fridges,
        egress_stairs={lv: tuple(v) for lv, v in egress.items()},
        ground=ground,
        below_ground=below,
        top_level=top,
        main_switchboard=next((e.id for e in spec.equipment if e.kind == "switchboard"), None),
        ras=ras,
        links_by_space={k: tuple(v) for k, v in by_space.items()},
        short_name=" ".join(words[-2:]) if len(words) > 2 else spec.name,
    )
