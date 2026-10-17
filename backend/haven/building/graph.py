"""One NetworkX graph for the whole building: spaces, equipment, and typed edges.

Edge `rel` values:
  connects     space <-> space through a door/opening, or up/down a stair or lift shaft
  powers       electrical supply (src energises dst)
  backs_up     standby supply (generator -> transfer switch); same OR-logic as powers
  controls     controller -> the machine it runs (lift controller -> lift)
  feeds_water  domestic water supply
  monitors     sensor -> what it watches
  located_in   equipment -> the space it physically sits in

The cascade is graph traversal, not an LLM: `energized()` propagates power from live
sources, `step_free_route()` searches the space graph with dead lifts removed.
"""

import math
from collections import deque
from collections.abc import Iterable

import networkx as nx

from .model import BuildingSpec

OUTSIDE = "outside"
POWER_RELS = ("powers", "backs_up", "controls")
SOURCE_KINDS = ("utility_feed", "generator")


def build_graph(spec: BuildingSpec) -> nx.MultiDiGraph:
    G = nx.MultiDiGraph(name=spec.name)
    levels = {lv.id: lv for lv in spec.levels}

    G.add_node(OUTSIDE, node_type="outside", x=0.0, y=0.0, z=0.0)
    for s in spec.spaces:
        G.add_node(
            s.id, node_type="space", kind=s.kind, level=s.level, name=s.name,
            x=s.rect.cx, y=s.rect.cy, z=levels[s.level].elevation, capacity=s.capacity,
        )
    for e in spec.equipment:
        G.add_node(
            e.id, node_type="equipment", kind=e.kind, level=e.level, name=e.name,
            x=e.x, y=e.y, z=levels[e.level].elevation, flood_height=e.flood_height,
        )
        G.add_edge(e.id, e.space, rel="located_in")

    for o in spec.openings:
        length = _door_path_length(G, o.a, o.b, o.x, o.y)
        attrs = dict(rel="connects", via=o.id, kind=o.kind, step_free=o.step_free, length=length)
        G.add_edge(o.a, o.b, **attrs)
        G.add_edge(o.b, o.a, **attrs)

    order = {lv.id: i for i, lv in enumerate(sorted(spec.levels, key=lambda lv: lv.index))}
    for v in spec.verticals:
        stops = sorted(v.spaces.items(), key=lambda kv: order[kv[0]])
        for (_, lo), (_, hi) in zip(stops, stops[1:]):
            # Stairs: length in "equivalent metres" of walking (a flight ~ 14 s ~ 18 m).
            length = v.seconds_per_level * 1.3
            attrs = dict(rel="connects", via=v.id, kind=v.kind, step_free=v.step_free,
                         requires=v.equipment, length=length)
            G.add_edge(lo, hi, **attrs)
            G.add_edge(hi, lo, **attrs)

    for d in spec.dependencies:
        G.add_edge(d.src, d.dst, rel=d.rel)
    return G


# ---- power -------------------------------------------------------------------------------


def energized(G: nx.MultiDiGraph, failed: Iterable[str] = ()) -> set[str]:
    """Every equipment node that has power, given a set of failed / de-energised nodes.

    A node is live if ANY of its supplies is live (a transfer switch is fed by normal power
    OR the generator). Failed nodes are dead and pass nothing on.
    """
    failed = set(failed)
    live: set[str] = set()
    queue = deque(
        n for n, d in G.nodes(data=True)
        if d.get("node_type") == "equipment" and d.get("kind") in SOURCE_KINDS and n not in failed
    )
    while queue:
        n = queue.popleft()
        if n in live:
            continue
        live.add(n)
        for _, dst, data in G.out_edges(n, data=True):
            if data["rel"] in POWER_RELS and dst not in failed and dst not in live:
                queue.append(dst)
    return live


def powered_levels(G: nx.MultiDiGraph, live: set[str]) -> dict[str, bool]:
    """Level id -> whether its floor panel (lighting, outlets, fridge) is live."""
    out: dict[str, bool] = {}
    for n, d in G.nodes(data=True):
        if d.get("node_type") == "equipment" and d.get("kind") == "panel" and n.startswith("panel_"):
            out[d["level"]] = n in live
    return out


def dependents(G: nx.MultiDiGraph, node: str, rels: tuple[str, ...] = POWER_RELS + ("feeds_water",)) -> set[str]:
    """Everything downstream of `node` along the given relations (ignores redundancy)."""
    seen: set[str] = set()
    stack = [node]
    while stack:
        n = stack.pop()
        for _, dst, data in G.out_edges(n, data=True):
            if data["rel"] in rels and dst not in seen:
                seen.add(dst)
                stack.append(dst)
    return seen


# ---- movement ----------------------------------------------------------------------------


def space_graph(G: nx.MultiDiGraph, live: set[str] | None = None, step_free_only: bool = False,
                blocked_spaces: Iterable[str] = ()) -> nx.Graph:
    """Walkable topology as a simple weighted graph.

    Lifts whose equipment is not in `live` are removed. `live=None` means everything works.
    """
    blocked = set(blocked_spaces)
    H = nx.Graph()
    for u, v, data in G.edges(data=True):
        if data["rel"] != "connects" or u in blocked or v in blocked:
            continue
        if step_free_only and not data["step_free"]:
            continue
        req = data.get("requires")
        if req and live is not None and req not in live:
            continue
        w = data.get("length", 1.0)
        if not H.has_edge(u, v) or H[u][v]["weight"] > w:
            H.add_edge(u, v, weight=w, via=data.get("via"), kind=data.get("kind"))
    return H


def route(G: nx.MultiDiGraph, start: str, goal: str = OUTSIDE, live: set[str] | None = None,
          step_free_only: bool = False, blocked_spaces: Iterable[str] = ()) -> list[str] | None:
    H = space_graph(G, live, step_free_only, blocked_spaces)
    if start not in H or goal not in H:
        return None
    try:
        return nx.shortest_path(H, start, goal, weight="weight")
    except nx.NetworkXNoPath:
        return None


def route_length(G: nx.MultiDiGraph, path: list[str], live: set[str] | None = None,
                 step_free_only: bool = False) -> float:
    H = space_graph(G, live, step_free_only)
    return sum(H[a][b]["weight"] for a, b in zip(path, path[1:]))


def _door_path_length(G: nx.MultiDiGraph, a: str, b: str, x: float, y: float) -> float:
    def leg(n: str) -> float:
        if n == OUTSIDE:
            return 2.0
        d = G.nodes[n]
        return math.hypot(d["x"] - x, d["y"] - y)

    return leg(a) + leg(b)
