# blender/ — David Blackwell Hall, built from the spec

`build_blackwell.py` builds Blackwell Hall in Blender from `shared/blackwell_hall.json`, the same spec the
backend graph, nav grids and the frontend floor plan derive from. Exterior, interiors and building services
all come from the spec; nothing about the building is typed in here twice.

| Spec data                              | Becomes                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `footprint` + each level's spaces      | Slab + 0.3 m exterior wall ring per level; courtyard and podium garden are the holes the spaces leave |
| `levels` (elevation, height)           | Floor stacking, roof, parapet, penthouse over the lift core              |
| Space kind behind each exterior wall   | Facade: tall paired windows with a large ochre accent field per bay in a checker rhythm (rooms), curtain wall (lounges, studies, kitchens, the corner "lantern"), slot (stairs), small frosted (bathrooms), blank (corridors, lifts, risers, service). Courtyard-facing walls are ochre, as in the real courtyard |
| Shared edges of spaces + `openings`    | Interior partitions with door gaps                                       |
| Openings with `b == "outside"`         | Street doors and exits                                                   |
| Space kind + `capacity`                | Furniture: beds, desks, wardrobes (rooms), stalls (bathrooms), sofas and tables (lounges), counters (kitchens), washers (laundry), front desk (lobby), stair flights, lift cars, racks, shelving |
| `equipment` (kind, x, y, flood_height) | One object per item: switchboard sections on their pads, transfer switches, generator, pumps, water heaters, riser, valve, panels, fridges, the ESP32 sensor |
| `outdoor` spaces                       | Ground courtyard: gravel, raised concrete planters, trees                 |

Facade proportions and colours follow photos of the real building (Capital Strategies, Berkeley News, Street
View): white fibre-cement panels with fine joints, ochre fields, dark window frames, a timber-clad glazed
ground floor with a timber soffit band, and the glass lounge stack at Dana St × Durant Ave. Interiors follow
the published photos: wood-look plank floors with navy beds in rooms, grey carpet lounges with blue and
purple seating and a lime accent wall, a dark stone lobby with a timber desk.

All materials are procedural (panel joints, timber boards, concrete, asphalt, pavers, carpet, tiles),
so nothing needs downloading. To go further, tick Poly Haven in the MCP for Blender sidebar in Blender
(press N in the 3D viewport); `import_asset` can then swap in scanned PBR textures and an HDRI.

## Running

Export the spec first: `cd backend && PYTHONPATH=. uv run python tools/export_building.py`.

**Headless** (the Microsoft Store install exposes `blender-launcher.exe`; a portable install exposes `blender`):

```powershell
blender-launcher.exe -b -P blender/build_blackwell.py -- --glb frontend/public/models/blackwell.glb --glb-interior frontend/public/models/blackwell_interior.glb --render blender/renders/hero.png --cutaway L4 --cutaway B1 --blend blender/blackwell.blend
```

Flags: `--glb <path>` exterior (Shell + Windows) as glTF binary · `--glb-interior <path>` interiors + plant ·
`--render <path>` hero camera · `--cutaway <LEVEL>` (repeatable) renders `renders/cutaway_<LEVEL>.png` with every
level above hidden; below grade it uses the close `PlantCam` and a flat backdrop · `--blend <path>` save ·
`--no-site` / `--no-interior` skip those parts. Relative paths resolve against the repo root.

**Inside a live Blender** (Python console, or through the Blender MCP):

```python
exec(open(r"C:/path/to/Cal_Hacks_13.0/blender/build_blackwell.py").read(),
     {"HAVEN_ROOT": r"C:/path/to/Cal_Hacks_13.0",
      "HAVEN_ARGS": ["--glb", "frontend/public/models/blackwell.glb", "--cutaway", "L4"]})
```

Both routes clear the scene first. A full build makes ~550 objects and takes ~1.5 min; renders are EEVEE.

Cameras: `HeroCam` (three-quarter from Dana × Durant, like the reference photo), `StreetCam` (eye level on the
corner), `CutawayCam` (looking down into a floor), `PlantCam` (into the basement electrical + mechanical rooms).

## Using the GLBs in the frontend

- `frontend/public/models/blackwell.glb` — exterior only: slabs, wall rings, windows, doors, roof, podium.
- `frontend/public/models/blackwell_interior.glb` — floors, partitions, furniture, courtyard, and every
  equipment item as `eq_<equipment_id>`.

The glTF exporter converts Blender's z-up to glTF's y-up, so a spec point `(x, y, z)` lands at `(x, z, -y)` in
three.js. Object names and custom properties survive as `mesh.name` and `mesh.userData`:

| Object            | `userData`                                              |
| ----------------- | ------------------------------------------------------- |
| `win_<space_id>`  | `space_id`, `level`, `level_index`, `kind`              |
| `eq_<equip_id>`   | `equipment_id`, `kind`, `space_id`, `level`, `flood_height` (−1 when none) |
| `floor_<L>`, `walls_<L>`, `furniture_<L>`, `slab_<L>`, `walls_ext_<L>` | `level`, `level_index` |

So an R3F view can hide levels above the one in focus (`level_index`), tint a room's glass from world state
(the glass material has an emission colour with strength 0, ready to be driven), and flash the switchgear
or sensor by equipment id. Procedural textures do not export; the GLBs carry base colours only.

## Files

- `build_blackwell.py` — the script (bpy + bmesh only; no add-ons needed).
- `renders/hero.png`, `renders/cutaway_L4.png`, `renders/cutaway_B1.png` — latest full-resolution renders.
- `blackwell.blend` — saved scene, regenerated by the script; not hand-edited (git-ignored).
