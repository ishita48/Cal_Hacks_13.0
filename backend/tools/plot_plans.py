"""Render floor plans of the building spec to PNG for visual checks: uv run python tools/plot_plans.py out.png"""

import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

from haven.building.blackwell import build_blackwell_hall
from haven.people.roster import build_roster

COLORS = {
    "room": "#e9edf2", "corridor": "#fdf6e3", "lobby": "#ffe8b0", "lounge": "#c9f2d9", "study": "#c9e4f2",
    "bathroom": "#d9d2f2", "laundry": "#f2d9ea", "kitchen": "#b9efc7", "office": "#f2e4c9", "retail": "#f7c9b9",
    "amenity": "#bfe3f7", "storage": "#dddddd", "stair": "#ff9f80", "lift": "#5aa9ff", "service": "#cccccc",
    "mechanical": "#9ec9ff", "electrical": "#ffd166", "generator": "#ffb3b3", "riser": "#999999",
    "courtyard": "#d8f0c8",
}

spec = build_blackwell_hall()
roster = build_roster(spec)
occ = {}
for r in roster.residents:
    occ[r.room] = occ.get(r.room, 0) + 1
named = {r.room: r.name.split()[0] for r in roster.residents if not r.id.startswith("r_")}
levels = [sys.argv[2]] if len(sys.argv) > 2 else ["B1", "L1", "L4"]
fig, axes = plt.subplots(1, len(levels), figsize=(7 * len(levels), 11))
axes = [axes] if len(levels) == 1 else axes
for ax, lv in zip(axes, levels):
    for s in spec.spaces:
        if s.level != lv:
            continue
        r = s.rect
        ax.add_patch(Rectangle((r.x0, r.y0), r.w, r.h, fc=COLORS[s.kind], ec="#333", lw=0.6))
        label = s.name.replace("Room ", "") if s.kind == "room" else s.name
        if s.kind == "room":
            label += f"\n{occ.get(s.id, 0)}/{s.capacity}" + (f"\n{named[s.id]}" if s.id in named else "")
        if s.kind not in ("corridor",):
            ax.text(r.cx, r.cy, label, ha="center", va="center", fontsize=4.2 if s.kind == "room" else 5)
    for o in spec.openings:
        if o.level != lv:
            continue
        dx, dy = (o.width / 2, 0) if o.axis == "x" else (0, o.width / 2)
        col = "#e63946" if o.b == "outside" else "#2a9d8f"
        ax.plot([o.x - dx, o.x + dx], [o.y - dy, o.y + dy], color=col, lw=2.2 if o.b == "outside" else 1.4)
    for e in spec.equipment:
        if e.level == lv:
            ax.plot(e.x, e.y, "k^" if e.kind != "sensor" else "b*", ms=4 if e.kind != "sensor" else 9)
    ax.set_title(f"{spec.name} — {spec.level(lv).name} ({lv})")
    ax.set_xlim(-2, 48); ax.set_ylim(-4, 86); ax.set_aspect("equal")
    ax.set_xlabel("x (m, east)  — Dana St on the left, Durant Ave at the bottom")
fig.tight_layout()
fig.savefig(sys.argv[1] if len(sys.argv) > 1 else "plans.png", dpi=170)
