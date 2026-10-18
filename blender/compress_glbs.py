"""Compress the exported GLBs for the dashboard: meshopt geometry, 1k WebP textures, same names and extras.

    python blender/compress_glbs.py [--out-dir DIR] [FILE ...]

Defaults to the four files in frontend/public/models, rewritten in place. Runs gltf-transform (npx, needs
Node) with only name-preserving passes: dedup, resize, webp, meshopt. No join / flatten / optimize, because
those merge nodes and would lose win_<space_id>, eq_<id>, floor_<id> names and the level_index extras the
frontend keys on. The loader needs MeshoptDecoder registered (three/examples/jsm/libs/meshopt_decoder.module.js).
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "frontend" / "public" / "models"
DEFAULT = [MODELS / n for n in ("blackwell.glb", "blackwell_interior.glb", "blackwell_furniture.glb", "blackwell_site.glb")]
CLI = ["npx", "--yes", "@gltf-transform/cli@4"]


def run(args, cwd):
    cmd = CLI + args
    res = subprocess.run(cmd, cwd=cwd, shell=sys.platform == "win32", capture_output=True, text=True)
    if res.returncode != 0:
        sys.stderr.write(res.stdout[-2000:] + res.stderr[-2000:])
        raise SystemExit(f"gltf-transform failed: {' '.join(args[:2])}")


def compress(src: Path, dst: Path, texture_size: int):
    before = src.stat().st_size
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        a, b = tmp / "a.glb", tmp / "b.glb"
        shutil.copy(src, a)
        run(["dedup", str(a), str(b)], ROOT)
        run(["resize", str(b), str(a), "--width", str(texture_size), "--height", str(texture_size)], ROOT)
        run(["webp", str(a), str(b)], ROOT)
        run(["meshopt", str(b), str(a), "--level", "medium"], ROOT)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(a, dst)
    print(f"{src.name}: {before / 1e6:.1f} MB -> {dst.stat().st_size / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", type=Path)
    ap.add_argument("--out-dir", type=Path, default=None, help="write here instead of in place")
    ap.add_argument("--texture-size", type=int, default=1024)
    opts = ap.parse_args()
    files = opts.files or DEFAULT
    for f in files:
        f = f if f.is_absolute() else ROOT / f
        dst = (opts.out_dir / f.name) if opts.out_dir else f
        compress(f, dst, opts.texture_size)


if __name__ == "__main__":
    main()
