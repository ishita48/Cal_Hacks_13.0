"""Run build_blackwell.py with Python output captured to blender/renders/last_build.log.

The Microsoft Store Blender (`blender-launcher.exe`) does not pass its console through to a redirected
shell, so this wrapper is how a headless build leaves a readable log:

    blender-launcher.exe -b -P blender/run_build.py -- --render blender/renders/hero.png ...

Arguments after `--` go to build_blackwell.py unchanged.
"""

import runpy
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
log_path = HERE / "renders" / "last_build.log"
log_path.parent.mkdir(exist_ok=True)
log = open(log_path, "w", encoding="utf-8", buffering=1)
sys.stdout = log
sys.stderr = log
try:
    runpy.run_path(str(HERE / "build_blackwell.py"), run_name="__main__")
    print("build finished")
except BaseException:
    traceback.print_exc()
    print("build FAILED")
    raise
finally:
    log.close()
