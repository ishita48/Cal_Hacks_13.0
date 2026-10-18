"""Path-traced stills from the saved scene, in a separate headless Blender so the live one stays free.

    blender-launcher.exe -b blender/blackwell.blend -P blender/render_cycles.py -- [--samples 96] [--scale 100] [CAM ...]

CAM is StreetCam, HeroCam, CutawayCam or PlantCam (default: StreetCam HeroCam). Output goes to
blender/renders/<cam>_cycles.png. On CPU expect roughly 10-20 min per 1080p frame at 96 samples.
"""

import sys
import time
from pathlib import Path

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
samples, scale, cams = 96, 100, []
i = 0
while i < len(argv):
    if argv[i] == "--samples":
        samples = int(argv[i + 1])
        i += 2
    elif argv[i] == "--scale":
        scale = int(argv[i + 1])
        i += 2
    else:
        cams.append(argv[i])
        i += 1
cams = cams or ["StreetCam", "HeroCam"]

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = samples
scene.cycles.use_denoising = True
scene.cycles.use_adaptive_sampling = True
scene.render.resolution_percentage = scale
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.get_devices()
    for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        if any(d.type != "CPU" for d in prefs.devices):
            for d in prefs.devices:
                d.use = True
            scene.cycles.device = "GPU"
            break
except Exception as exc:  # no GPU configured: CPU it is
    print("cycles on CPU:", exc)

out_dir = Path(bpy.data.filepath).resolve().parent / "renders"
out_dir.mkdir(exist_ok=True)
for cam in cams:
    scene.camera = bpy.data.objects[cam]
    scene.render.filepath = str(out_dir / f"{cam.replace('Cam', '').lower()}_cycles.png")
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print(f"rendered {scene.render.filepath} in {time.time() - t:.0f} s")
