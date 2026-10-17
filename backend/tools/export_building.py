"""Write the building spec + roster to shared/ for Blender and offline tooling.

    PYTHONPATH=. uv run python tools/export_building.py
"""

import json
from pathlib import Path

from haven.building.blackwell import build_blackwell_hall
from haven.people.roster import build_roster

out = Path(__file__).resolve().parents[2] / "shared"
out.mkdir(exist_ok=True)
spec = build_blackwell_hall()
(out / "blackwell_hall.json").write_text(json.dumps(spec.model_dump(mode="json"), indent=1))
(out / "roster.json").write_text(json.dumps(build_roster(spec).model_dump(mode="json"), indent=1))
print(f"wrote {out / 'blackwell_hall.json'} and roster.json")
