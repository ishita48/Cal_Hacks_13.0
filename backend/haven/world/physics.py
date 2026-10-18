"""Deterministic hydraulics: where the water goes, and what it kills when it gets there.

Water is tracked as a volume per space; depth = volume / floor area. Between two spaces
that share an opening it flows as over a broad-crested weir (q = C * width * head^1.5),
capped so one step can never overshoot equalisation. Floor drains remove a little; the sump
pump removes more while it has power. Equipment whose lowest live part (`flood_height`)
is under water is flooded and stays flooded.

The same `step()` drives both the live world (dt = DT) and the forecast (coarser dt).
"""

from dataclasses import dataclass, field

from ..building.graph import energized
from .context import WorldContext

SPILL_DEPTH = 0.01      # water leaves a room once it is deeper than the door threshold
WEIR_C = 1.7            # broad-crested weir coefficient (SI)
WET_DEPTH = 0.003       # a space counts as wet above 3 mm


@dataclass
class Hydraulics:
    """Mutable working copy of everything the water physics reads and writes."""

    volumes: dict[str, float] = field(default_factory=dict)      # space -> m3
    flooded: set[str] = field(default_factory=set)               # equipment destroyed by water
    isolated: set[str] = field(default_factory=set)              # equipment switched off on purpose
    closed_valves: set[str] = field(default_factory=set)
    leaks: dict[str, float] = field(default_factory=dict)        # leaking equipment -> gross L/s
    wet: set[str] = field(default_factory=set)                   # spaces that have been wet
    live: set[str] = field(default_factory=set)

    def copy(self) -> "Hydraulics":
        return Hydraulics(dict(self.volumes), set(self.flooded), set(self.isolated), set(self.closed_valves),
                          dict(self.leaks), set(self.wet), set(self.live))

    def failed(self) -> set[str]:
        return self.flooded | self.isolated

    def refresh_power(self, ctx: WorldContext) -> None:
        self.live = energized(ctx.graph, self.failed())

    def leak_active(self, ctx: WorldContext, eq: str) -> bool:
        return eq in self.leaks and not any(v in self.closed_valves for v in ctx.upstream_valves.get(eq, ()))

    def inflow(self, ctx: WorldContext) -> dict[str, float]:
        out: dict[str, float] = {}
        for eq, lps in self.leaks.items():
            if self.leak_active(ctx, eq):
                sp = ctx.equipment[eq].space
                out[sp] = out.get(sp, 0.0) + lps
        return out

    def depth(self, ctx: WorldContext, space: str) -> float:
        v = self.volumes.get(space, 0.0)
        return v / ctx.areas[space] if v > 0 else 0.0

    def idle(self, ctx: WorldContext) -> bool:
        return not self.volumes and not self.inflow(ctx)


@dataclass(frozen=True)
class Happening:
    kind: str           # "wet" | "flooded"
    id: str             # space id or equipment id
    depth: float


def step(h: Hydraulics, ctx: WorldContext, dt: float) -> list[Happening]:
    """Advance the water by dt seconds in place. Returns what newly happened, in a fixed order."""
    out: list[Happening] = []
    vols = h.volumes

    for sp, lps in h.inflow(ctx).items():
        vols[sp] = vols.get(sp, 0.0) + lps / 1000.0 * dt

    if vols:
        _spill(h, ctx, dt)
        for sp, lps in ctx.floor_drains.items():
            if sp in vols:
                vols[sp] = max(0.0, vols[sp] - lps / 1000.0 * dt)
        for sp, (pump, lps) in ctx.sumps.items():
            if sp in vols and pump in h.live:
                vols[sp] = max(0.0, vols[sp] - lps / 1000.0 * dt)
        for sp in [s for s, v in vols.items() if v <= 1e-9]:
            del vols[sp]

    for sp in sorted(vols):
        d = vols[sp] / ctx.areas[sp]
        if sp not in h.wet and d >= WET_DEPTH:
            h.wet.add(sp)
            out.append(Happening("wet", sp, d))
        for eq in ctx.equipment_in_space.get(sp, ()):
            fh = ctx.equipment[eq].flood_height
            if fh is not None and eq not in h.flooded and d >= fh:
                h.flooded.add(eq)
                out.append(Happening("flooded", eq, d))
    if any(x.kind == "flooded" for x in out):
        h.refresh_power(ctx)
    return out


def _spill(h: Hydraulics, ctx: WorldContext, dt: float) -> None:
    vols = h.volumes
    moves: list[tuple[str, str, float]] = []
    for link in ctx.door_links:
        va, vb = vols.get(link.a, 0.0), vols.get(link.b, 0.0)
        if va <= 0.0 and vb <= 0.0:
            continue
        aa, ab = ctx.areas[link.a], ctx.areas[link.b]
        ha, hb = max(0.0, va / aa - SPILL_DEPTH), max(0.0, vb / ab - SPILL_DEPTH)
        if ha == hb:
            continue
        if ha > hb:
            src, dst, hs, hd, as_, ad = link.a, link.b, ha, hb, aa, ab
        else:
            src, dst, hs, hd, as_, ad = link.b, link.a, hb, ha, ab, aa
        head = hs - hd
        q = WEIR_C * link.width * head ** 1.5 * dt
        cap = head * (as_ * ad) / (as_ + ad)       # volume that exactly equalises the two
        moves.append((src, dst, min(q, cap)))
    if not moves:
        return
    outflow: dict[str, float] = {}
    for src, _, q in moves:
        outflow[src] = outflow.get(src, 0.0) + q
    for src, dst, q in moves:
        avail = vols.get(src, 0.0)
        if outflow[src] > avail:                    # never move more than the room holds
            q *= avail / outflow[src]
        vols[src] = vols.get(src, 0.0) - q
        vols[dst] = vols.get(dst, 0.0) + q
