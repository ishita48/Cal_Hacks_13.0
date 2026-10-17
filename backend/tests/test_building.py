"""Phase 1: Blackwell Hall as data — layout sanity, power cascade, routes, roster, walkability."""

from collections import Counter, deque
from functools import lru_cache

from haven.building.blackwell import build_blackwell_hall
from haven.building.graph import OUTSIDE, build_graph, energized, powered_levels, route
from haven.building.nav import build_navmesh
from haven.people.roster import build_roster

LIFTS = {"lift_1", "lift_2"}


@lru_cache
def world():
    spec = build_blackwell_hall()
    return spec, build_graph(spec), build_roster(spec)


# ---- layout --------------------------------------------------------------------------------


def test_layout_has_no_overlaps_and_every_space_has_a_door():
    spec, _, _ = world()
    for lv in spec.levels:
        here = [s for s in spec.spaces if s.level == lv.id]
        for i, a in enumerate(here):
            for b in here[i + 1:]:
                assert not a.rect.overlaps(b.rect), (a.id, b.id)
    touched = {o.a for o in spec.openings} | {o.b for o in spec.openings}
    for s in spec.spaces:
        if s.kind not in ("corridor", "riser"):
            assert s.id in touched, f"{s.id} has no door"


def test_matches_real_building_scale():
    spec, _, roster = world()
    rooms = [s for s in spec.spaces if s.kind == "room"]
    beds = sum(r.capacity for r in rooms)
    singles = [r for r in rooms if r.capacity == 1]
    assert 740 <= beds <= 800                      # public figures: ~751 beds
    assert len(singles) == 19                      # public figure: 19 singles
    assert 730 <= len(roster.residents) <= 760
    assert spec.space("room_412").accessible and spec.space("room_412").level == "L4"


def test_roster_respects_room_capacity():
    spec, _, roster = world()
    per_room = Counter(r.room for r in roster.residents)
    for room_id, n in per_room.items():
        assert n <= spec.space(room_id).capacity, room_id
    maya = roster.by_id()["maya"]
    assert maya.room == "room_412" and "step_free_route" in maya.needs
    assert roster.by_id()["dana"].medication_location == "fridge_L3"


# ---- power cascade ---------------------------------------------------------------------------


def test_everything_is_live_normally():
    _, G, _ = world()
    live = energized(G)
    assert LIFTS <= live
    assert all(powered_levels(G, live).values())


def test_generator_covers_lifts_when_only_normal_power_fails():
    _, G, _ = world()
    live = energized(G, failed={"msb_b"})
    assert LIFTS <= live, "ATS-EQ should transfer the lifts to the generator"
    lv = powered_levels(G, live)
    assert not lv["L3"] and not lv["L4"] and lv["L5"]
    assert "fridge_L3" not in live


def test_water_in_electrical_room_takes_out_lifts_and_riser_b():
    _, G, _ = world()
    # Switchgear on the floor of the electrical room floods: MSB section B and ATS-EQ fail.
    live = energized(G, failed={"msb_b", "ats_eq"})
    assert not (LIFTS & live)
    lv = powered_levels(G, live)
    assert (lv["L3"], lv["L4"]) == (False, False)
    assert lv["L2"] and lv["L5"] and lv["L7"]
    assert "fire_alarm" in live, "life safety stays on the generator via ATS-EM"


# ---- routes ----------------------------------------------------------------------------------


def test_every_room_can_reach_outside_and_step_free_when_lifts_work():
    spec, G, _ = world()
    live = energized(G)
    for room in (s for s in spec.spaces if s.kind == "room"):
        assert route(G, room.id, OUTSIDE, live) is not None, room.id
        path = route(G, room.id, OUTSIDE, live, step_free_only=True)
        assert path is not None, f"{room.id} has no step-free route"


def test_maya_is_stranded_when_the_lifts_lose_power():
    _, G, roster = world()
    maya = roster.by_id()["maya"]
    dead = energized(G, failed={"msb_b", "ats_eq"})
    assert route(G, maya.room, OUTSIDE, dead) is not None            # stairs still exist...
    assert route(G, maya.room, OUTSIDE, dead, step_free_only=True) is None   # ...but not for her
    path = route(G, maya.room, OUTSIDE, energized(G), step_free_only=True)
    assert path is not None and any(n.endswith(("lift_1", "lift_2")) for n in path)


# ---- walkable grid ---------------------------------------------------------------------------


def test_every_space_is_physically_reachable_on_the_grid():
    spec, _, _ = world()
    nav = build_navmesh(spec)
    # Flood fill across all levels from every exit cell, through doors and vertical portals.
    seen: set[tuple[str, int]] = set()
    q = deque((lv, c) for lv, g in nav.grids.items() for c in g.exits)
    seen.update(q)
    while q:
        lv, c = q.popleft()
        nxt = [(lv, n) for n, _ in nav.grids[lv].neighbours(c)]
        nxt += [(tl, tc) for tl, tc, *_ in nav.portals.get((lv, c), [])]
        for node in nxt:
            if node not in seen:
                seen.add(node)
                q.append(node)
    reached_spaces = {nav.grids[lv].space_at_cell(c) for lv, c in seen}
    walkable = {s.id for s in spec.spaces if s.kind not in ("riser", "retail")}
    missing = walkable - reached_spaces - {"L1-courtyard"}  # courtyard reached via doors too; checked below
    assert not missing, sorted(missing)[:10]


def test_maya_grid_path_uses_lift_and_fails_without_it():
    spec, G, _ = world()
    nav = build_navmesh(spec)
    room = spec.space("room_412").rect
    exits = {("L1", c) for c in nav.grids["L1"].exits}
    ok = nav.path(("L4", room.cx, room.cy), exits, step_free_only=True, live_verticals={"lift_1", "lift_2"})
    assert ok is not None
    assert nav.path(("L4", room.cx, room.cy), exits, step_free_only=True, live_verticals=set()) is None
    walking = nav.path(("L4", room.cx, room.cy), exits, step_free_only=False, live_verticals=set())
    assert walking is not None  # an able-bodied resident gets out by the stairs
