"""Per-level walkable grids for moving people (0.5 m cells).

Walls are implied between cells that belong to different spaces; a move across that
boundary is allowed only where an Opening spans it. Stairs and lifts link levels through
portal cells (the centre of the stair/lift space). Pathfinding is A* over (level, i, j).
"""

import heapq
import math
from dataclasses import dataclass, field

from .model import WALKABLE_KINDS, BuildingSpec, Opening

CELL = 0.5
_SQRT2 = math.sqrt(2.0)
# Neighbour offsets: 4-connected across walls/doors, diagonals only inside one space.
_ORTHO = [(1, 0), (-1, 0), (0, 1), (0, -1)]
_DIAG = [(1, 1), (1, -1), (-1, 1), (-1, -1)]


@dataclass
class LevelGrid:
    level: str
    nx: int
    ny: int
    space_ids: list[str]                       # index -> space id
    cells: list[int]                           # nx*ny, index into space_ids or -1
    passages: set[tuple[int, int]] = field(default_factory=set)  # (cell_a, cell_b), a < b
    exits: set[int] = field(default_factory=set)                  # cells touching an exit door

    def idx(self, i: int, j: int) -> int:
        return j * self.nx + i

    def space_at_cell(self, c: int) -> str | None:
        k = self.cells[c]
        return self.space_ids[k] if k >= 0 else None

    def cell_of(self, x: float, y: float) -> int:
        i = min(self.nx - 1, max(0, int(x / CELL)))
        j = min(self.ny - 1, max(0, int(y / CELL)))
        return self.idx(i, j)

    def center(self, c: int) -> tuple[float, float]:
        return ((c % self.nx + 0.5) * CELL, (c // self.nx + 0.5) * CELL)

    def neighbours(self, c: int):
        i, j = c % self.nx, c // self.nx
        here = self.cells[c]
        for di, dj in _ORTHO:
            ni, nj = i + di, j + dj
            if 0 <= ni < self.nx and 0 <= nj < self.ny:
                n = self.idx(ni, nj)
                k = self.cells[n]
                if k < 0:
                    continue
                if k == here or (min(c, n), max(c, n)) in self.passages:
                    yield n, 1.0
        for di, dj in _DIAG:
            ni, nj = i + di, j + dj
            if 0 <= ni < self.nx and 0 <= nj < self.ny:
                n = self.idx(ni, nj)
                # Diagonal only if all four cells share one space (no corner cutting through walls).
                if (self.cells[n] == here and self.cells[self.idx(ni, j)] == here
                        and self.cells[self.idx(i, nj)] == here):
                    yield n, _SQRT2


@dataclass
class NavMesh:
    grids: dict[str, LevelGrid]
    # (level, cell) -> list of (level, cell, cost_seconds, vertical_id, step_free)
    portals: dict[tuple[str, int], list[tuple[str, int, float, str, bool]]]

    def path(
        self,
        start: tuple[str, float, float],
        goal_cells: set[tuple[str, int]],
        speed: float = 1.3,
        step_free_only: bool = False,
        live_verticals: set[str] | None = None,
    ) -> list[tuple[str, int]] | None:
        """A* from (level, x, y) to any of goal_cells. Cost in seconds."""
        lv0, x0, y0 = start
        s = (lv0, self.grids[lv0].cell_of(x0, y0))
        if not goal_cells:
            return None
        goals_xy = [(lv, *self.grids[lv].center(c)) for lv, c in goal_cells]

        def h(node: tuple[str, int]) -> float:
            lv, c = node
            x, y = self.grids[lv].center(c)
            return min(math.hypot(x - gx, y - gy) for glv, gx, gy in goals_xy if glv == lv) / speed \
                if any(glv == lv for glv, _, _ in goals_xy) else 0.0

        openq = [(h(s), 0.0, s)]
        came: dict[tuple[str, int], tuple[str, int] | None] = {s: None}
        cost = {s: 0.0}
        while openq:
            _, g, node = heapq.heappop(openq)
            if node in goal_cells:
                out = [node]
                while came[out[-1]] is not None:
                    out.append(came[out[-1]])
                return out[::-1]
            if g > cost[node]:
                continue
            lv, c = node
            grid = self.grids[lv]
            steps = [((lv, n), w * CELL / speed) for n, w in grid.neighbours(c)]
            for tlv, tc, secs, vid, sf in self.portals.get(node, []):
                if step_free_only and not sf:
                    continue
                if live_verticals is not None and vid not in live_verticals and sf:
                    continue
                steps.append(((tlv, tc), secs))
            for nxt, w in steps:
                ng = g + w
                if ng < cost.get(nxt, math.inf):
                    cost[nxt] = ng
                    came[nxt] = node
                    heapq.heappush(openq, (ng + h(nxt), ng, nxt))
        return None


def build_navmesh(spec: BuildingSpec) -> NavMesh:
    width = max(r.x1 for r in spec.footprint)
    depth = max(r.y1 for r in spec.footprint)
    nx_, ny_ = math.ceil(width / CELL), math.ceil(depth / CELL)
    grids: dict[str, LevelGrid] = {}

    for lv in spec.levels:
        spaces = [s for s in spec.spaces if s.level == lv.id and s.kind in WALKABLE_KINDS]
        ids = [s.id for s in spaces]
        cells = [-1] * (nx_ * ny_)
        for k, s in enumerate(spaces):
            i0, i1 = int(round(s.rect.x0 / CELL)), int(round(s.rect.x1 / CELL))
            j0, j1 = int(round(s.rect.y0 / CELL)), int(round(s.rect.y1 / CELL))
            for j in range(max(0, j0), min(ny_, j1)):
                for i in range(max(0, i0), min(nx_, i1)):
                    cells[j * nx_ + i] = k
        grid = LevelGrid(level=lv.id, nx=nx_, ny=ny_, space_ids=ids, cells=cells)
        for o in spec.openings:
            if o.level == lv.id:
                _carve_opening(grid, o)
        grids[lv.id] = grid

    portals: dict[tuple[str, int], list] = {}
    order = {lv.id: lv.index for lv in spec.levels}
    for v in spec.verticals:
        stops = sorted(v.spaces.items(), key=lambda kv: order[kv[0]])
        for (la, sa), (lb, sb) in zip(stops, stops[1:]):
            ca, cb = _space_center_cell(spec, grids, la, sa), _space_center_cell(spec, grids, lb, sb)
            for (l1, c1), (l2, c2) in (((la, ca), (lb, cb)), ((lb, cb), (la, ca))):
                portals.setdefault((l1, c1), []).append((l2, c2, v.seconds_per_level, v.id, v.step_free))
    return NavMesh(grids=grids, portals=portals)


def _space_center_cell(spec: BuildingSpec, grids: dict[str, LevelGrid], level: str, sid: str) -> int:
    r = spec.space(sid).rect
    return grids[level].cell_of(r.cx, r.cy)


def _carve_opening(grid: LevelGrid, o: Opening) -> None:
    half = o.width / 2
    if o.axis == "x":   # wall runs along x at y = o.y; passage is vertical (j-1 <-> j)
        j = int(round(o.y / CELL))
        i0, i1 = int(math.floor((o.x - half) / CELL + 1e-6)), int(math.ceil((o.x + half) / CELL - 1e-6))
        for i in range(max(0, i0), min(grid.nx, i1)):
            a, b = (grid.idx(i, j - 1) if j - 1 >= 0 else None), (grid.idx(i, j) if j < grid.ny else None)
            _link(grid, a, b, o.b == "outside")
    else:               # wall runs along y at x = o.x; passage is horizontal (i-1 <-> i)
        i = int(round(o.x / CELL))
        j0, j1 = int(math.floor((o.y - half) / CELL + 1e-6)), int(math.ceil((o.y + half) / CELL - 1e-6))
        for j in range(max(0, j0), min(grid.ny, j1)):
            a, b = (grid.idx(i - 1, j) if i - 1 >= 0 else None), (grid.idx(i, j) if i < grid.nx else None)
            _link(grid, a, b, o.b == "outside")


def _link(grid: LevelGrid, a: int | None, b: int | None, is_exit: bool) -> None:
    ca = grid.cells[a] if a is not None else -1
    cb = grid.cells[b] if b is not None else -1
    if is_exit:
        for c, k in ((a, ca), (b, cb)):
            if c is not None and k >= 0:
                grid.exits.add(c)
        return
    if ca >= 0 and cb >= 0 and a is not None and b is not None:
        grid.passages.add((min(a, b), max(a, b)))
