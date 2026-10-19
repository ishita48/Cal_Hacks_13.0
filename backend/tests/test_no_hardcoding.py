"""No building facts in code: the engine, the agents and the API must not name this building's ids.

Everything about David Blackwell Hall lives in haven/building/blackwell.py and haven/people/roster.py.
If a level, room, switchboard, valve or resident id shows up anywhere else, a new building would need
a code change, which is the thing the architecture promises never to need.
"""

import re
from pathlib import Path

from haven.world.context import build_context

HAVEN = Path(__file__).resolve().parents[1] / "haven"
SPEC_FILES = {HAVEN / "building" / "blackwell.py", HAVEN / "people" / "roster.py"}


def _code_lines(path: Path):
    """Source lines with comments and docstrings stripped (examples in prose are fine)."""
    text = path.read_text(encoding="utf-8")
    text = re.sub(r'"""[\s\S]*?"""', "", text)
    for line in text.splitlines():
        yield re.sub(r"#.*$", "", line)


def test_engine_and_agents_name_no_building_ids():
    ctx = build_context()
    ids = {lv.id for lv in ctx.spec.levels} | {e.id for e in ctx.spec.equipment} | set(ctx.story_order)
    ids |= {s.id for s in ctx.spec.spaces} | set(ctx.ras.values())
    # A singleton's id may equal its kind ("generator", "sump_pump"); naming a kind is fine, naming an id is not.
    kinds = {e.kind for e in ctx.spec.equipment} | {s.kind for s in ctx.spec.spaces}
    ids -= kinds
    quoted = re.compile(r"""["']([A-Za-z0-9_\-]+)["']""")
    convention = re.compile(r'f"ra_\{|"ra_" \+|startswith\("ra_"\)|startswith\("L"\)|startswith\("B1"\)|\b(lv|level)\[1:\]')
    offenders: list[str] = []
    for path in sorted(HAVEN.rglob("*.py")):
        if path in SPEC_FILES:
            continue
        for n, line in enumerate(_code_lines(path), 1):
            for m in quoted.finditer(line):
                if m.group(1) in ids:
                    offenders.append(f"{path.relative_to(HAVEN)}:{n}: {m.group(0)}")
            if convention.search(line):
                offenders.append(f"{path.relative_to(HAVEN)}:{n}: naming convention {line.strip()[:60]}")
            if "Blackwell" in line or "Dana Street" in line:
                offenders.append(f"{path.relative_to(HAVEN)}:{n}: {line.strip()[:60]}")
    assert not offenders, "\n".join(offenders)


def test_context_derives_what_the_planner_needs():
    ctx = build_context()
    assert ctx.ground in ctx.level_order and ctx.top_level in ctx.level_order
    assert all(ctx.level_order[lv] < ctx.level_order[ctx.ground] for lv in ctx.below_ground)
    assert ctx.main_switchboard is None or ctx.equipment[ctx.main_switchboard].kind == "switchboard"
    assert all(ctx.roster.by_id()[rid].role == "ra" for rid in ctx.ras.values())
    assert ctx.short_name and ctx.short_name in ctx.spec.name
    for sensor in ctx.sensor_ids:
        for eq in ctx.sensor_targets[sensor]:
            assert ctx.valve_for(eq) is not None, "every monitored riser has a shut-off valve upstream"
    assert all(ctx.level_short(lv) for lv in ctx.level_order)
