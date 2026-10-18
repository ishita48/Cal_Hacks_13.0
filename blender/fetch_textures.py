"""Download the CC0 Poly Haven texture sets and sky that build_blackwell.py layers over its procedural materials.

    python blender/fetch_textures.py            # ~250 MB into blender/textures/ (git-ignored), skips what is there

Writes blender/textures/manifest.json: for each asset its real-world size in metres and the files on disk.
The build script reads that manifest; when it is missing (or an asset is), the material stays procedural.
Standard library only, so it runs with any Python 3. Assets: https://polyhaven.com (CC0, no attribution required).
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "textures"
API = "https://api.polyhaven.com"
MAPS = {"diff": "Diffuse", "rough": "Rough", "nor": "nor_gl"}

# asset id -> resolution. 2k only where the street camera looks closely; 1k keeps the GLBs small.
TEXTURES = {
    "concrete_wall_008": "1k",      # fibre-cement panel detail (overlay), concrete
    "wood_floor_deck": "1k",        # timber cladding, deck boards
    "wood_planks": "1k",            # soffit, desks, ceiling slats
    "concrete_pavement": "2k",      # sidewalks
    "concrete_tiles_02": "1k",      # podium + campus paving
    "asphalt_01": "2k",             # streets, bike lane (overlay)
    "concrete_floor_worn_001": "1k",  # roof membrane, lobby stone (overlay)
    "leafy_grass": "2k",            # lawns
    "gravel_floor_02": "1k",        # courtyard gravel
    "brown_mud": "1k",              # planter soil
    "park_dirt": "1k",              # far ground
    "grey_plaster_02": "1k",        # neighbour stucco (overlay)
    "red_brick_03": "1k",           # neighbour brick
    "roof_tiles_14": "1k",          # neighbour roofs
    "bark_brown_02": "1k",          # tree trunks
    "laminate_floor_02": "1k",      # room plank floors
    "dirty_carpet": "1k",           # lounge carpet, rugs
    "interior_tiles": "1k",         # bathroom tile
    "rubber_tiles": "1k",           # plant-room floors
    "plastered_wall_05": "1k",      # painted interior walls (overlay)
}
HDRI = ("kloofendal_48d_partly_cloudy_puresky", "2k")
# Photoscanned models (glTF + 1k textures): street trees, shrubs, street furniture. Sizes are the .bin meshes.
MODELS = {
    "island_tree_02": "1k",         # broad street tree, ~41 MB
    "tree_small_02": "1k",          # upright small tree, ~95 MB
    "shrub_02": "1k",               # planter shrubs
    "shrub_04": "1k",
    "fire_hydrant": "1k",
    "street_lamp_02": "1k",
    "covered_car": "1k",            # a parked car under a cover
    "modular_street_seating": "1k",
}


def _rel(path: Path) -> str:
    return path.relative_to(OUT).as_posix()


UA = {"User-Agent": "HAVEN-blender-build/1.0 (urllib)"}   # the default urllib agent gets a 403


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def download(url, dest: Path, md5: str | None):
    if dest.exists() and (md5 is None or hashlib.md5(dest.read_bytes()).hexdigest() == md5):
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 16):
            f.write(chunk)
    if md5 and hashlib.md5(tmp.read_bytes()).hexdigest() != md5:
        tmp.unlink()
        raise RuntimeError(f"checksum mismatch for {url}")
    tmp.replace(dest)
    return True


def main():
    OUT.mkdir(exist_ok=True)
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest.setdefault("textures", {})
    failures = []
    for asset, res in TEXTURES.items():
        try:
            files = get_json(f"{API}/files/{asset}")
            info = get_json(f"{API}/info/{asset}")
            dims = info.get("dimensions") or [2000, 2000]
            entry = {"size": [dims[0] / 1000.0, dims[1] / 1000.0], "res": res, "files": {}}
            for key, ph_key in MAPS.items():
                if ph_key not in files:
                    continue
                item = files[ph_key][res]["jpg"]
                dest = OUT / asset / Path(item["url"]).name
                fresh = download(item["url"], dest, item.get("md5"))
                entry["files"][key] = str(dest.relative_to(OUT)).replace("\\", "/")
                print(f"{'fetched' if fresh else 'kept   '} {dest.relative_to(OUT)}  ({item['size'] / 1e6:.1f} MB)")
            manifest["textures"][asset] = entry
        except Exception as exc:  # keep going: a missing set just stays procedural
            failures.append((asset, str(exc)))
            print(f"FAILED  {asset}: {exc}", file=sys.stderr)
        manifest_path.write_text(json.dumps(manifest, indent=1))
    manifest.setdefault("models", {})
    for asset, res in MODELS.items():
        try:
            files = get_json(f"{API}/files/{asset}")
            info = get_json(f"{API}/info/{asset}")
            item = files["gltf"][res]["gltf"]
            folder = OUT / "models" / asset
            dest = folder / Path(item["url"]).name
            fresh = download(item["url"], dest, item.get("md5"))
            for rel, inc in item.get("include", {}).items():
                fresh |= download(inc["url"], folder / rel, inc.get("md5"))
            dims = info.get("dimensions") or [1000, 1000, 1000]
            manifest["models"][asset] = {"gltf": _rel(dest), "size": [d / 1000.0 for d in dims]}
            total = (item["size"] + sum(i["size"] for i in item.get("include", {}).values())) / 1e6
            print(f"{'fetched' if fresh else 'kept   '} models/{asset}  ({total:.0f} MB)")
        except Exception as exc:
            failures.append((asset, str(exc)))
            print(f"FAILED  {asset}: {exc}", file=sys.stderr)
        manifest_path.write_text(json.dumps(manifest, indent=1))
    try:
        hid, res = HDRI
        files = get_json(f"{API}/files/{hid}")
        item = files["hdri"][res]["hdr"]
        dest = OUT / "hdri" / Path(item["url"]).name
        fresh = download(item["url"], dest, item.get("md5"))
        manifest["hdri"] = {"id": hid, "file": str(dest.relative_to(OUT)).replace("\\", "/")}
        print(f"{'fetched' if fresh else 'kept   '} {dest.relative_to(OUT)}  ({item['size'] / 1e6:.1f} MB)")
    except Exception as exc:
        failures.append((HDRI[0], str(exc)))
        print(f"FAILED  {HDRI[0]}: {exc}", file=sys.stderr)
    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(f"\n{len(manifest['textures'])} texture sets, {len(manifest['models'])} models in {OUT}; manifest written")
    if failures:
        print("failed:", ", ".join(a for a, _ in failures))
        sys.exit(1)


if __name__ == "__main__":
    main()
