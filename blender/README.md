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

Windows and doors are real openings cut into the wall rings (an exact boolean per level, cutters kept in a hidden
`Cutters` collection that is never exported), so reveals catch shadows. Trees have trunks, branches and clumped
canopies; the street has curbs, signals, bike racks, benches, bins and the building name on both corner faces.
The compositor adds a touch of bloom and chromatic aberration.

Materials have two layers. The procedural layer (panel joints with rain streaks, timber boards, concrete,
asphalt, pavers, carpet, tiles) needs nothing downloaded and is always there. On top of it, when
`python blender/fetch_textures.py` has been run, twenty scanned CC0 texture sets from [Poly Haven](https://polyhaven.com)
(albedo + roughness + normal; asphalt, pavement slabs, concrete, grass, gravel, soil, bark, brick, plaster, roof
tiles, deck and plank timber, laminate, carpet, tiles, rubber) are layered over the matching materials, and a
partly cloudy sky HDRI lights the scene. Every mesh gets box-projected UVs in metres, so scans tile at their
real-world size across walls, floors and streets, and the same UVs go out in the GLBs. Two blend modes:
`albedo` uses the scan's colour, modulated by the procedural large-scale variation (which hides the tile repeat)
and an optional tint; `overlay` keeps the designed colour (the white and ochre panels, stucco, painted walls)
and adds only the scan's grain and relief. The table is `SCANS` in the script; `--no-textures` (or simply not
fetching) keeps everything procedural. The HDRI is rotated so its sun sits behind the Sun lamp, with its hot
spot clamped, so the lamp stays the only hard shadow; the camera sees the physical sky, everything else is
lit by the HDRI.

Street trees, campus trees, podium and courtyard shrubs, the hydrant and every fourth parked car are
photoscanned Poly Haven models (`island_tree_02`, `tree_small_02`, `shrub_02`, `fire_hydrant`, `covered_car`).
Each is imported once, the million-triangle trees decimated to about a fifth and cached beside the glTF as
`<asset>_lod.blend`, parked in an excluded `Library` collection, and placed as collection instances in a
`Props` collection (never exported), so thirty trees share one mesh. Without the downloads the trees fall back
to the procedural trunk-and-clump version. View transform is AgX "Punchy".

## Walking around in Blender

`haven_walk.py` adds a **HAVEN** tab to the 3D viewport sidebar (press N). The build script loads it and
stores it in the .blend. The tab has:

- **Walk** buttons: street corner, along Durant, lobby, courtyard, floor 4 (lift lobby, Maya's wing,
  lounge), podium garden, basement electrical and mechanical rooms, roof. Each puts you at eye level and
  starts Blender's walk navigation: mouse to look, W/A/S/D to move, Q/E up and down, Shift to run,
  Esc to stop, left-click to keep the view. Shift+` starts walk mode from wherever you are.
- **Cut away floors above** a level (B1 … L7, roof) in the viewport.
- **Cameras**: HeroCam, StreetCam, CutawayCam, PlantCam. F12 renders the active one.

If the tab is missing after reopening the file (Blender's "Auto Run Python Scripts" is off), open
`haven_walk.py` in the Scripting workspace and press Run Script.

## Live link

`haven_live.py` (also embedded in the .blend) adds a **HAVEN: live world** panel to the same HAVEN tab (N in the
3D viewport). Open `blackwell.blend`, press Connect with the backend at `http://127.0.0.1:8000`, and the panel
mirrors the world state into a `Live` collection: water sheets per space, dark / soon floor tints, equipment
status, `person_<id>` figures (violet = left behind), `agent_<actor>` responders, routes and a HUD. Its buttons
POST inputs back to the backend (start the leak, toggle Maya's agent, approve the plan, speak a rule, speed).
Headless snapshot of the live state:

```powershell
blender-launcher.exe -b blender/blackwell.blend -P blender/haven_live.py -- --snapshot blender/renders/live_check.png --camera CutawayCam --cutaway L4
```

## The surrounding blocks

The site is a plausible Berkeley block, not a survey: stucco and brick apartment blocks with punched
windows and parapets, gabled houses with porches, shopfronts with awnings along the south side of Durant,
the campus edge north of Bancroft with lawn and mature trees, the green Bancroft bike lane, parked cars,
utility poles and wires on the far side of Dana, a bus shelter and hydrant, signals, bike racks, benches.

## Running

Export the spec first: `cd backend && PYTHONPATH=. uv run python tools/export_building.py`.
Then (once) fetch the scanned textures: `python blender/fetch_textures.py` (~70 MB into `blender/textures/`,
git-ignored, standard library only; without it the build is purely procedural).

**Headless** (the Microsoft Store install exposes `blender-launcher.exe`; a portable install exposes `blender`):

```powershell
blender-launcher.exe -b -P blender/build_blackwell.py -- --glb frontend/public/models/blackwell.glb --glb-interior frontend/public/models/blackwell_interior.glb --glb-furniture frontend/public/models/blackwell_furniture.glb --render blender/renders/hero.png --cutaway L4 --cutaway L1 --cutaway B1 --blend blender/blackwell.blend
```

Flags: `--glb <path>` exterior (Shell + Windows) as glTF binary · `--glb-interior <path>` floors, walls, glazing, courtyard + plant · `--glb-furniture <path>` the `furniture_<L>` meshes · `--glb-site <path>` the surroundings and props ·
`--render <path>` hero camera (plus `street.png` beside it from `StreetCam`) · `--cutaway <LEVEL>` (repeatable) renders `renders/cutaway_<LEVEL>.png` with every
level above hidden; below grade it uses the close `PlantCam` and a flat backdrop · `--blend <path>` save ·
`--engine cycles [--samples N]` path-traced stills (GPU if configured, denoised; a few minutes per frame on CPU) ·
`--no-site` / `--no-interior` skip those parts · `--no-textures` ignores the downloaded scans · `--bake` (or `--rebake`) bakes every
procedural material into colour / roughness / normal tiles (`textures/baked/`, cached) and exports the GLBs with those instead of base
colours, so panel joints, rain streaks, timber grain and the far-city window grids reach the dashboard. Relative paths resolve against the repo root.

**Inside a live Blender** (Python console, or through the Blender MCP):

```python
exec(open(r"C:/path/to/Cal_Hacks_13.0/blender/build_blackwell.py").read(),
     {"HAVEN_ROOT": r"C:/path/to/Cal_Hacks_13.0",
      "HAVEN_ARGS": ["--glb", "frontend/public/models/blackwell.glb", "--cutaway", "L4"]})
```

Both routes clear the scene first. A full build makes ~1200 objects and takes 2-3 min (plus a one-time minute to
decimate and cache the tree scans); renders are EEVEE. Headless with a log: `blender-launcher.exe -b -P blender/run_build.py -- <same flags>`.

Cameras: `HeroCam` (three-quarter from Dana × Durant, like the reference photo), `StreetCam` (eye level on the
corner), `CutawayCam` (looking down into a floor), `PlantCam` (into the basement electrical + mechanical rooms).

## Using the GLBs in the frontend

- `frontend/public/models/blackwell.glb` — exterior only: slabs, wall rings, windows, doors, roof, podium.
- `frontend/public/models/blackwell_interior.glb` — floor tiles, partitions, glazed partitions, courtyard, and
  every equipment item as `eq_<equipment_id>` (~2 MB).
- `frontend/public/models/blackwell_furniture.glb` — the `furniture_<L>` meshes only (beds, desks, pods,
  kitchens, door leaves, lights; ~34 MB). Optional: the view works without it.
- `frontend/public/models/blackwell_site.glb` (`--glb-site`) — the surroundings: streets, sidewalks, neighbour
  blocks, far city, cars, signals, and every photoscanned prop and mannequin realised as plain objects that
  share one mesh per model (tree scans thinned again for the file). Every object carries `level_index = 1` and
  is named `site_*`, so a focus on a basement level hides it. The dashboard loads it when present; optional.

The glTF exporter converts Blender's z-up to glTF's y-up, so a spec point `(x, y, z)` lands at `(x, z, -y)` in
three.js. Object names and custom properties survive as `mesh.name` and `mesh.userData`:

| Object            | `userData`                                              |
| ----------------- | ------------------------------------------------------- |
| `win_<space_id>`  | `space_id`, `level`, `level_index`, `kind`              |
| `eq_<equip_id>`   | `equipment_id`, `kind`, `space_id`, `level`, `flood_height` (−1 when none) |
| `floor_<space_id>`  | `space_id`, `level`, `level_index`, `kind` (one tile per space, for tinting rooms) |
| `walls_<L>`, `furniture_<L>`, `slab_<L>`, `walls_ext_<L>` | `level`, `level_index` |

With `--bake`, each material in the GLBs is a plain PBR material fed by baked tiles on the same box UVs
(`KHR_texture_transform` scale = 1 / tile size, wrap `MIRRORED_REPEAT`, so a 4.8 m tile mirrors seamlessly). The sky the
scene is lit by is copied to `frontend/public/env/sky_2k.hdr` for the dashboard's environment; the build log prints the
rotation that puts its sun behind the Sun lamp.

So an R3F view can hide levels above the one in focus (`level_index`), tint a room's glass from world state
(the glass material has an emission colour with strength 0, ready to be driven), and flash the switchgear
or sensor by equipment id. The procedural layer does not export (glTF has no node graphs), but the scanned
albedo / roughness / normal maps do, as JPEGs on the box UVs, so the twin shows real asphalt, concrete, timber
and brick; without the fetched textures the GLBs carry base colours only.

## Files

- `build_blackwell.py` — the script (bpy + bmesh only; no add-ons needed).
- `fetch_textures.py` — downloads the Poly Haven sets, HDRI and photoscanned models into `textures/` and writes
  `textures/manifest.json` (asset sizes in metres, file paths); the build reads the manifest.
- `compress_glbs.py` — post-export pass over the four GLBs (needs Node): dedup, textures to 1k WebP, meshopt geometry
  (`EXT_meshopt_compression` + `KHR_mesh_quantization`), names and extras untouched; ~100 MB becomes ~20 MB. The
  loader must register `MeshoptDecoder` from `three/examples/jsm/libs/meshopt_decoder.module.js`.
- `run_build.py` — runs the build with Python output captured to `renders/last_build.log` (the Store
  `blender-launcher.exe` does not pass its console to a redirected shell).
- `render_cycles.py` — path-traced stills from the saved .blend in a second headless Blender.
- `renders/hero.png`, `renders/street.png`, `renders/cutaway_L4.png`, `renders/cutaway_B1.png` — latest full-resolution renders.
- `blackwell.blend` — saved scene, regenerated by the script; not hand-edited (git-ignored).
