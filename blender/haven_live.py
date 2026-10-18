"""HAVEN live link for Blender: the scene becomes another view of the one world state.

Blender connects to the HAVEN backend like the dashboard does, reads the same frames, and draws
what they say: water rising in the basement rooms, floors tinted dark now / dark if nobody acts,
equipment coloured by status, every flagged resident as a figure in their room (violet when
their agent is off and nobody spoke for them: the Maya moment), the responders (RAs, facilities,
desk staff, the plumber) walking to the step they are on, step-free routes as glowing lines, and a
floating headline with the clock and the plan. Buttons in the panel submit input events to the
backend (simulate the leak, toggle Maya's agent, approve the plan, set the clock); nothing is
decided here and nothing is stored here.

Loaded by ``build_blackwell.py`` (stored in the .blend next to ``haven_walk.py``) or by hand:
Scripting workspace -> open this file -> Run Script. The panel lives in the 3D viewport sidebar
(N) under the HAVEN tab. Only the Python standard library is used: it polls ``GET /api/state``
in a background thread and applies frames on Blender's main thread with ``bpy.app.timers``.

Headless, for a still of the live world from the saved scene (``*_check.png`` is git-ignored)::

    blender-launcher.exe -b blender/blackwell.blend -P blender/haven_live.py -- \\
        --snapshot blender/renders/live_check.png [--url http://127.0.0.1:8000] \\
        [--camera CutawayCam] [--cutaway L4] [--fast] [--look person_maya]
"""

import json
import math
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

DEFAULT_URL = "http://127.0.0.1:8000"
POLL_S = 0.4            # background poll interval
TICK_S = 0.05           # main-thread timer: apply new frames, ease figures toward their targets
COLL = "Live"
NAMED = {"maya", "dana", "jordan", "sam", "lucia", "theo", "nora", "ahmed", "grace"}
SENSOR_ID = "basement_mech_1"
FLOOR_TOP = 0.27        # slab + floor tile, above the level elevation (build_blackwell.py)

# sRGB-ish colours the dashboard uses, as linear-ish floats for Blender materials.
RGB = {
    "water": (0.10, 0.45, 1.00),
    "dark": (0.45, 0.03, 0.04),
    "soon": (1.00, 0.55, 0.05),
    "critical": (1.00, 0.12, 0.14),
    "warning": (1.00, 0.62, 0.08),
    "safe": (0.08, 0.70, 0.35),
    "left": (0.55, 0.20, 0.90),
    "route": (0.10, 0.75, 0.40),
    "moving": (0.25, 0.70, 1.00),
    "done": (0.10, 0.75, 0.35),
    "idle": (0.45, 0.45, 0.48),
    "isolated": (0.40, 0.40, 0.45),
    "offline": (0.80, 0.10, 0.10),
    "closing": (1.00, 0.55, 0.05),
    "closed": (0.40, 0.40, 0.45),
    "flooded": (0.10, 0.45, 1.00),
    "label": (0.96, 0.96, 0.97),
}


# ---- the link (threads + shared frame) -------------------------------------------------------------


class Link:
    """Polls the backend; the newest frame waits here for the main thread."""

    def __init__(self):
        self.url = DEFAULT_URL
        self.lock = threading.Lock()
        self.frame = None           # {"clock": ..., "state": ...}
        self.spec = None
        self.roster = None
        self.connected = False
        self.error = ""
        self.last_post = ""
        self.applied_version = -1
        self.applied_step = -1
        self.thread = None
        self.stop = threading.Event()

    # -- http ----------------------------------------------------------------------------------------

    def get(self, path, timeout=4.0):
        with urllib.request.urlopen(self.url.rstrip("/") + path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def post(self, path, payload, timeout=6.0):
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.url.rstrip("/") + path, data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def post_async(self, path, payload, label):
        def run():
            try:
                self.post(path, payload)
                self.last_post = f"{label}: ok"
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", "replace")[:120]
                self.last_post = f"{label}: {exc.code} {body}"
            except Exception as exc:      # noqa: BLE001 - surfaced in the panel
                self.last_post = f"{label}: {exc}"
        threading.Thread(target=run, daemon=True).start()

    # -- lifecycle -----------------------------------------------------------------------------------

    def fetch_static(self):
        self.spec = self.get("/api/building")
        self.roster = self.get("/api/people")

    def fetch_frame(self):
        frame = self.get("/api/state")
        with self.lock:
            self.frame = frame
        return frame

    def start(self, url):
        self.stop_polling()
        self.url = url or DEFAULT_URL
        self.error = ""
        self.stop.clear()
        self.thread = threading.Thread(target=self._poll, daemon=True)
        self.thread.start()
        if not bpy.app.timers.is_registered(_tick):
            bpy.app.timers.register(_tick, first_interval=TICK_S, persistent=True)

    def stop_polling(self):
        self.stop.set()
        self.connected = False
        self.thread = None

    def _poll(self):
        try:
            self.fetch_static()
        except Exception as exc:      # noqa: BLE001
            self.error = f"cannot reach {self.url}: {exc}"
            self.connected = False
            return
        while not self.stop.is_set():
            try:
                self.fetch_frame()
                self.connected = True
                self.error = ""
            except Exception as exc:      # noqa: BLE001
                self.connected = False
                self.error = f"{exc}"
            self.stop.wait(POLL_S)

    def take(self):
        with self.lock:
            return self.frame


LINK = Link()


# ---- scene helpers --------------------------------------------------------------------------------


def _scene():
    return bpy.context.scene if bpy.context.scene is not None else bpy.data.scenes[0]


def _coll():
    coll = bpy.data.collections.get(COLL)
    if coll is None:
        coll = bpy.data.collections.new(COLL)
    scene = _scene()
    if coll.name not in scene.collection.children:
        scene.collection.children.link(coll)
    return coll


def _mat(name, rgb, emit=0.0, alpha=1.0, rough=0.5):
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Alpha"].default_value = alpha
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (*rgb, 1.0)
            bsdf.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = (*rgb, alpha)
    if alpha < 1.0:
        if hasattr(m, "surface_render_method"):
            m.surface_render_method = "BLENDED"
        elif hasattr(m, "blend_method"):
            m.blend_method = "BLEND"
    return m


def make_materials():
    return {
        "water": _mat("live_water", RGB["water"], emit=0.6, alpha=0.55, rough=0.1),
        "tint_dark": _mat("live_tint_dark", RGB["dark"], emit=1.2),
        "tint_soon": _mat("live_tint_soon", RGB["soon"], emit=0.8),
        "tint_wet": _mat("live_tint_wet", RGB["water"], emit=0.9),
        "critical": _mat("live_person_critical", RGB["critical"], emit=2.5),
        "warning": _mat("live_person_warning", RGB["warning"], emit=2.0),
        "safe": _mat("live_person_safe", RGB["safe"], emit=2.0),
        "left": _mat("live_person_left", RGB["left"], emit=3.0),
        "head": _mat("live_head", RGB["label"], emit=0.3),
        "moving": _mat("live_actor_moving", RGB["moving"], emit=3.0),
        "done": _mat("live_actor_done", RGB["done"], emit=2.0),
        "idle": _mat("live_actor_idle", RGB["idle"], emit=0.6),
        "route": _mat("live_route", RGB["route"], emit=4.0),
        "label": _mat("live_label", RGB["label"], emit=3.0),
        "ring": _mat("live_ring", RGB["left"], emit=4.0),
        "halo": _mat("live_halo", RGB["water"], emit=2.0, alpha=0.35),
        **{f"eq_{k}": _mat(f"live_eq_{k}", RGB[k], emit=2.0) for k in ("flooded", "isolated", "offline", "closing", "closed")},
    }


def _figure_mesh(name, hat=False, scale=1.0):
    me = bpy.data.meshes.get(name)
    if me is not None:
        return me
    bm = bmesh.new()
    body = bmesh.ops.create_cone(bm, cap_ends=True, segments=14, radius1=0.24 * scale, radius2=0.20 * scale,
                                 depth=1.15 * scale)
    bmesh.ops.translate(bm, verts=body["verts"], vec=(0, 0, 0.575 * scale))
    head = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.19 * scale)
    bmesh.ops.translate(bm, verts=head["verts"], vec=(0, 0, 1.4 * scale))
    for f in bm.faces:
        f.material_index = 1 if all(v.co.z > 1.2 * scale for v in f.verts) else 0
    if hat:
        brim = bmesh.ops.create_cone(bm, cap_ends=True, segments=14, radius1=0.30 * scale, radius2=0.30 * scale, depth=0.05)
        bmesh.ops.translate(bm, verts=brim["verts"], vec=(0, 0, 1.52 * scale))
        for f in bm.faces:
            if all(v.co.z > 1.49 * scale and abs(v.co.z - 1.52 * scale) < 0.03 for v in f.verts):
                f.material_index = 0
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(None)
    me.materials.append(None)
    for p in me.polygons:
        p.use_smooth = True
    return me


def _unit_plane():
    me = bpy.data.meshes.get("live_unit_plane")
    if me is None:
        me = bpy.data.meshes.new("live_unit_plane")
        me.from_pydata([(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)], [], [(0, 1, 2, 3)])
        me.materials.append(None)
    return me


def _ring_mesh():
    me = bpy.data.meshes.get("live_ring")
    if me is None:
        bm = bmesh.new()
        outer = bmesh.ops.create_circle(bm, cap_ends=False, segments=32, radius=1.0)
        inner = bmesh.ops.create_circle(bm, cap_ends=False, segments=32, radius=0.78)
        bmesh.ops.bridge_loops(bm, edges=[e for e in bm.edges])
        me = bpy.data.meshes.new("live_ring")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(None)
        del outer, inner
    return me


def _object(name, data, coll, props=None):
    ob = bpy.data.objects.get(name)
    if ob is None or ob.data is not data:
        if ob is not None:
            bpy.data.objects.remove(ob, do_unlink=True)
        ob = bpy.data.objects.new(name, data)
        coll.objects.link(ob)
        ob["_live"] = True
    for k, v in (props or {}).items():
        ob[k] = v
    return ob


def _set_mats(ob, *mats):
    for i, mat in enumerate(mats):
        if i < len(ob.material_slots):
            slot = ob.material_slots[i]
            slot.link = "OBJECT"
            slot.material = mat


def _goto(ob, target, snap):
    """Ease an object toward a target (the timer lerps it), or snap it there."""
    ob["_live_target"] = tuple(target)
    if snap or "_live_placed" not in ob:
        ob.location = Vector(target)
        ob["_live_placed"] = True


def _tint(ob, mat):
    """Override every material slot of an existing building object, remembering nothing: restoring
    is just linking the slots back to their mesh data."""
    for slot in ob.material_slots:
        slot.link = "OBJECT"
        slot.material = mat
    ob["_live_tinted"] = True


def _untint(ob):
    if ob.get("_live_tinted"):
        for slot in ob.material_slots:
            slot.link = "DATA"
        del ob["_live_tinted"]


def _text(name, body, coll, size=0.6, props=None):
    cu = bpy.data.curves.get(f"txt_{name}")
    if cu is None:
        cu = bpy.data.curves.new(f"txt_{name}", "FONT")
        cu.align_x = "CENTER"
        cu.materials.append(None)
    cu.size = size
    cu.body = body
    ob = _object(name, cu, coll, props)
    ob.rotation_euler = (math.pi / 2, 0.0, 0.0)      # upright, readable from the south (HeroCam side)
    return ob


# ---- applying a frame ------------------------------------------------------------------------------


class Index:
    """The static spec and roster, indexed the way apply_state needs them."""

    def __init__(self, spec, roster):
        self.levels = {lv["id"]: lv for lv in spec["levels"]}
        self.spaces = {s["id"]: s for s in spec["spaces"]}
        self.equipment = {e["id"]: e for e in spec["equipment"]}
        self.residents = {r["id"]: r for r in roster["residents"]}

    def level_index(self, space_id):
        s = self.spaces.get(space_id)
        return self.levels[s["level"]]["index"] if s else 0

    def centre(self, space_id, dz=FLOOR_TOP):
        s = self.spaces.get(space_id)
        if s is None:
            return None
        r = s["rect"]
        z = self.levels[s["level"]]["elevation"] + dz
        return ((r["x0"] + r["x1"]) / 2, (r["y0"] + r["y1"]) / 2, z)


def _hm(seconds):
    s = int(seconds) % 86400
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}"


def apply_state(frame, index, snap=False):
    """Draw one world frame into the scene. Pure function of (frame, spec, roster); idempotent."""
    state, clock = frame["state"], frame["clock"]
    coll = _coll()
    mats = make_materials()
    keep = set()

    def place(name, data, target, level_index, *ms):
        ob = _object(name, data, coll, {"level_index": level_index})
        _set_mats(ob, *ms)
        _goto(ob, target, snap)
        keep.add(name)
        return ob

    # -- water: one translucent sheet per wet space at its depth -----------------------------------
    plane = _unit_plane()
    for sid, w in state.get("water", {}).items():
        s = index.spaces.get(sid)
        depth = float(w.get("depth", 0.0))
        if s is None or depth <= 0.0:
            continue
        r = s["rect"]
        z = index.levels[s["level"]]["elevation"] + FLOOR_TOP + max(0.005, depth)
        ob = place(f"water_{sid}", plane, ((r["x0"] + r["x1"]) / 2, (r["y0"] + r["y1"]) / 2, z),
                   index.levels[s["level"]]["index"], mats["water"])
        ob.scale = (max(0.1, r["x1"] - r["x0"] - 0.1), max(0.1, r["y1"] - r["y0"] - 0.1), 1.0)

    # -- leak halo on the burst riser; sensor flash while wet ---------------------------------------
    for eid, leak in state.get("leaks", {}).items():
        eq = index.equipment.get(eid)
        if eq is None or not leak.get("active"):
            continue
        z = index.levels[eq["level"]]["elevation"] + FLOOR_TOP + 1.0
        ob = place(f"halo_{eid}", _halo_mesh(), (eq["x"], eq["y"], z), index.levels[eq["level"]]["index"], mats["halo"])
        ob.scale = (1.6, 1.6, 1.6)

    # -- floors: dark now, dark if nobody acts, wet --------------------------------------------------
    dark_now = set(state["impact"].get("dark_levels", []))
    dark_soon = set(state["forecast"]["impact"].get("dark_levels", [])) - dark_now
    wet = {sid for sid, w in state.get("water", {}).items() if float(w.get("depth", 0)) > 0}
    for ob in bpy.data.objects:
        if not ob.name.startswith("floor_"):
            continue
        sid = ob.name[len("floor_"):]
        s = index.spaces.get(sid)
        if s is None:
            continue
        if sid in wet:
            _tint(ob, mats["tint_wet"])
        elif s["level"] in dark_now:
            _tint(ob, mats["tint_dark"])
        elif s["level"] in dark_soon:
            _tint(ob, mats["tint_soon"])
        else:
            _untint(ob)

    # -- equipment by status --------------------------------------------------------------------------
    for eid, st in state.get("equipment", {}).items():
        ob = bpy.data.objects.get(f"eq_{eid}")
        if ob is None:
            continue
        status = st.get("status", "online")
        if status == "online":
            if eid == SENSOR_ID and state.get("sensors", {}).get(eid, {}).get("wet"):
                _tint(ob, mats["tint_wet"])
            else:
                _untint(ob)
        else:
            _tint(ob, mats.get(f"eq_{status}", mats["eq_offline"]))

    # -- residents: flagged people in their rooms, moved people where they are now -----------------
    person = _figure_mesh("live_person")
    ring = _ring_mesh()
    moved = state.get("moved", {})
    left = set(state["plan"].get("left_behind", []))
    agents = state.get("agents", {})
    residents = state["impact"].get("residents") or state["forecast"]["impact"].get("residents", [])
    predicted = not state["impact"].get("residents")
    per_space = {}
    placed = set()
    labels = []

    def slot_in(sid):
        s = index.spaces[sid]
        r = s["rect"]
        k = per_space.get(sid, 0)
        per_space[sid] = k + 1
        cols = max(1, int((r["x1"] - r["x0"]) / 1.0))
        x = min(r["x0"] + 0.7 + (k % cols) * 1.0, r["x1"] - 0.5)
        y = min(r["y0"] + 0.7 + (k // cols) * 1.0, r["y1"] - 0.5)
        return (x, y, index.levels[s["level"]]["elevation"] + FLOOR_TOP)

    for rid, sid in moved.items():
        if sid not in index.spaces:
            placed.add(rid)
            continue
        placed.add(rid)
        ob = place(f"person_{rid}", person, slot_in(sid), index.level_index(sid), mats["safe"], mats["head"])
        ob.scale = (1, 1, 1)
        if rid in NAMED:
            labels.append((rid, index.residents.get(rid, {}).get("name", rid).split()[0], ob.location.copy(), "safe"))
    for r in residents:
        rid = r["id"]
        if rid in placed or r.get("severity") == "info":
            continue
        room = r.get("room")
        if room not in index.spaces:
            continue
        is_left = rid in left
        mat = mats["left"] if is_left else mats["critical"] if r.get("severity") == "critical" else mats["warning"]
        ob = place(f"person_{rid}", person, index.centre(room), index.level_index(room), mat, mats["head"])
        ob.scale = (0.85, 0.85, 0.85) if predicted else (1, 1, 1)
        if is_left:
            rg = place(f"ring_{rid}", ring, index.centre(room, FLOOR_TOP + 0.03), index.level_index(room), mats["ring"])
            rg.scale = (1.3, 1.3, 1.0)
        if rid in NAMED or is_left:
            first = r.get("name", rid).split()[0]
            tag = " · left behind" if is_left else (" · agent off" if agents.get(f"resident:{rid}") is False else "")
            labels.append((rid, first + tag, Vector(index.centre(room)), "left" if is_left else "label"))

    # -- responders: where the backend says they are, heading where it says they go ---------------
    responder = _figure_mesh("live_responder", hat=True, scale=1.05)
    steps = {s["id"]: s for s in (state.get("approved_plan") or {}).get("steps", [])}
    for k, a in enumerate(state.get("actors", {}).values()):
        at = a.get("at")
        if not at or at not in index.spaces:
            continue
        shown = a.get("heading") if a.get("heading") in index.spaces else at
        off = (k % 3) * 0.8 - 0.8
        cx, cy, cz = index.centre(shown)
        status = a.get("status", "idle")
        ob = place(f"agent_{a['actor']}", responder, (cx + 1.4 + off, cy + 0.6, cz), index.level_index(shown),
                   mats[status if status in ("moving", "done") else "idle"], mats["head"])
        if status != "idle":
            step = steps.get(a.get("step_id") or "")
            what = (step["title"] if step else "")
            if len(what) > 36:
                what = what[:34] + "…"
            labels.append((f"agent_{a['actor']}", f"{a['label']} · {'on it' if status == 'moving' else 'done'}: {what}",
                           Vector((cx + 1.4 + off, cy + 0.6, cz)), status))

    # -- step-free routes ---------------------------------------------------------------------------
    for rid, path in (state["impact"].get("routes") or {}).items():
        if not path:
            continue
        pts = [index.centre(sid, FLOOR_TOP + 0.3) for sid in path if sid in index.spaces]
        if len(pts) < 2:
            continue
        cu = bpy.data.curves.get(f"crv_route_{rid}")
        if cu is not None:
            cu.splines.clear()
        else:
            cu = bpy.data.curves.new(f"crv_route_{rid}", "CURVE")
            cu.dimensions = "3D"
            cu.bevel_depth = 0.07
            cu.materials.append(None)
        sp = cu.splines.new("POLY")
        sp.points.add(len(pts) - 1)
        for p, (x, y, z) in zip(sp.points, pts):
            p.co = (x, y, z, 1.0)
        ob = _object(f"route_{rid}", cu, coll, {"level_index": index.level_index(path[0])})
        _set_mats(ob, mats["route"])
        keep.add(ob.name)

    # -- labels + the headline ----------------------------------------------------------------------
    for key, text, pos, kind in labels:
        ob = _text(f"label_{key}", text, coll, size=0.55, props={"level_index": _level_index_at(index, pos.z)})
        _set_mats(ob, mats["left" if kind == "left" else kind if kind in ("moving", "done", "safe") else "label"])
        _goto(ob, (pos.x, pos.y - 0.4, pos.z + 1.95), snap)
        keep.add(ob.name)

    plan = state.get("approved_plan") or state.get("plan", {})
    m = plan.get("metrics", {})
    headline = plan.get("headline") or "No incident. Blackwell Hall is quiet."
    hud = (f"{_hm(clock.get('time_of_day', 0))}   ·   " + "\n".join(_wrap(headline, 72)) + "\n"
           f"{int(m.get('residents_affected', 0))} affected  ·  {int(m.get('left_behind', len(left)))} left behind"
           f"  ·  plan {plan.get('status', 'none')} v{plan.get('version', 0)}"
           + ("  ·  REPLAY" if state.get("mode") == "replay" else ""))
    roof = max(lv["elevation"] + lv["height"] for lv in index.levels.values())
    xs = [s["rect"]["x0"] for s in index.spaces.values()] + [s["rect"]["x1"] for s in index.spaces.values()]
    ob = _text("hud", hud, coll, size=1.6, props={"level_index": 99})
    ob.location = ((min(xs) + max(xs)) / 2, min(s["rect"]["y0"] for s in index.spaces.values()) - 6.0, roof + 3.0)
    _set_mats(ob, mats["label"])
    keep.add("hud")

    # -- anything we drew last frame that is not in this one goes away ------------------------------
    for ob in list(coll.objects):
        if ob.name not in keep:
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if isinstance(data, bpy.types.Curve) and data.users == 0:
                bpy.data.curves.remove(data)


def _level_index_at(index, z):
    """The level whose floor is just below z (so cutaways hide labels with their floor)."""
    below = [lv for lv in index.levels.values() if lv["elevation"] <= z + 0.5]
    return max(below, key=lambda lv: lv["elevation"])["index"] if below else 0


def _halo_mesh():
    me = bpy.data.meshes.get("live_halo")
    if me is None:
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=1.0)
        me = bpy.data.meshes.new("live_halo")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(None)
        for p in me.polygons:
            p.use_smooth = True
    return me


def face(rotation):
    """Turn every label and the HUD to face a view (a camera's or the viewport's rotation)."""
    coll = bpy.data.collections.get(COLL)
    if coll is None or rotation is None:
        return
    eul = rotation.to_euler() if hasattr(rotation, "to_euler") else rotation
    for ob in coll.objects:
        if ob.type == "FONT":
            ob.rotation_euler = eul


def _view_rotation():
    wm = bpy.context.window_manager
    if wm is None:
        return None
    for window in wm.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                r3d = area.spaces.active.region_3d
                if r3d.view_perspective == "CAMERA" and bpy.context.scene.camera is not None:
                    return bpy.context.scene.camera.matrix_world.to_quaternion()
                return r3d.view_rotation
    return None


def clear_live():
    coll = bpy.data.collections.get(COLL)
    if coll is not None:
        for ob in list(coll.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
    for ob in bpy.data.objects:
        _untint(ob)


# ---- the main-thread timer -------------------------------------------------------------------------


def _redraw():
    wm = bpy.context.window_manager
    if wm is None:
        return
    for window in wm.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


def _tick():
    if LINK.stop.is_set() and LINK.thread is None:
        return None
    frame = LINK.take()
    if frame is not None and LINK.spec is not None:
        st = frame["state"]
        if st["version"] != LINK.applied_version or st["step"] != LINK.applied_step:
            try:
                apply_state(frame, Index(LINK.spec, LINK.roster))
            except Exception as exc:      # noqa: BLE001
                LINK.error = f"apply: {exc}"
            LINK.applied_version, LINK.applied_step = st["version"], st["step"]
    coll = bpy.data.collections.get(COLL)
    if coll is not None:
        for ob in coll.objects:
            t = ob.get("_live_target")
            if t is not None:
                target = Vector(t)
                if (ob.location - target).length > 0.01:
                    ob.location = ob.location.lerp(target, 0.12)
        face(_view_rotation())
    _redraw()
    return TICK_S


# ---- operators + panel -----------------------------------------------------------------------------


class HAVEN_OT_live_connect(bpy.types.Operator):
    """Connect to the HAVEN backend and start mirroring its world in this scene"""
    bl_idname = "haven.live_connect"
    bl_label = "Connect"

    def execute(self, context):
        LINK.start(context.scene.haven_url)
        return {"FINISHED"}


class HAVEN_OT_live_disconnect(bpy.types.Operator):
    """Stop mirroring (the last frame stays drawn)"""
    bl_idname = "haven.live_disconnect"
    bl_label = "Disconnect"

    def execute(self, context):
        LINK.stop_polling()
        return {"FINISHED"}


class HAVEN_OT_live_clear(bpy.types.Operator):
    """Remove everything the live link drew and restore the building's own materials"""
    bl_idname = "haven.live_clear"
    bl_label = "Clear"

    def execute(self, context):
        clear_live()
        LINK.applied_version = -1
        return {"FINISHED"}


class HAVEN_OT_live_input(bpy.types.Operator):
    """Submit an input event to the world (what the dashboard buttons do)"""
    bl_idname = "haven.live_input"
    bl_label = "Input"

    kind: bpy.props.StringProperty()
    value: bpy.props.FloatProperty(default=0.0)
    flag: bpy.props.BoolProperty(default=True)
    text: bpy.props.StringProperty(default="")

    def execute(self, context):
        frame = LINK.take() or {}
        state = frame.get("state", {})
        k = self.kind
        if k == "leak":
            LINK.post_async("/api/sensor", {"sensor_id": SENSOR_ID, "value": self.value, "source": "manual"},
                            "leak" if self.value >= 0.5 else "dry")
        elif k == "agent":
            LINK.post_async("/api/agent", {"agent": self.text, "enabled": self.flag}, f"{self.text} {'on' if self.flag else 'off'}")
        elif k == "approve":
            LINK.post_async("/api/plan/decision", {"plan_version": state.get("plan", {}).get("version", 0),
                                                   "decision": "approve", "actor": "manager (blender)"}, "approve")
        elif k == "speed":
            LINK.post_async("/api/clock", {"speed": self.value}, f"speed {self.value:g}x")
        elif k == "play":
            LINK.post_async("/api/clock", {"playing": self.flag}, "play" if self.flag else "pause")
        elif k == "reset":
            LINK.post_async("/api/scenario/reset", {}, "reset")
        elif k == "demo":
            LINK.post_async("/api/demo/load", {}, "demo")
        elif k == "rule":
            LINK.post_async("/api/rule/parse", {"text": self.text, "actor": "manager (blender)"}, "rule")
        return {"FINISHED"}


class HAVEN_OT_live_look(bpy.types.Operator):
    """Point the viewport at a live object (Maya, the plumber, the switchgear)"""
    bl_idname = "haven.live_look"
    bl_label = "Look at"

    name: bpy.props.StringProperty()

    def execute(self, context):
        ob = bpy.data.objects.get(self.name)
        if ob is None:
            self.report({"WARNING"}, f"{self.name} is not in the scene yet")
            return {"CANCELLED"}
        for area in context.screen.areas:
            if area.type == "VIEW_3D":
                r3d = area.spaces.active.region_3d
                r3d.view_perspective = "PERSP"
                r3d.view_location = Vector(ob.location) + Vector((0, 0, 0.8))
                r3d.view_distance = 14.0
                break
        return {"FINISHED"}


def _wrap(text, width=38):
    out, line = [], ""
    for word in text.split():
        if len(line) + len(word) + 1 > width and line:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        out.append(line)
    return out


class HAVEN_PT_live(bpy.types.Panel):
    bl_label = "HAVEN: live world"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "HAVEN"

    def draw(self, context):
        lay = self.layout
        col = lay.column(align=True)
        col.prop(context.scene, "haven_url", text="")
        row = col.row(align=True)
        row.operator("haven.live_connect", icon="LINKED")
        row.operator("haven.live_disconnect", icon="UNLINKED")
        row.operator("haven.live_clear", icon="TRASH")

        frame = LINK.take()
        box = lay.box()
        if LINK.error:
            box.label(text=LINK.error[:60], icon="ERROR")
        elif LINK.connected and frame:
            st, ck = frame["state"], frame["clock"]
            box.label(text=f"{_hm(ck.get('time_of_day', 0))}  ·  {st['mode']}  ·  step {st['step']}  ·  v{st['version']}",
                      icon="TIME")
            plan = st.get("approved_plan") or st["plan"]
            for line in _wrap(plan.get("headline") or "No incident."):
                box.label(text=line)
            m = plan.get("metrics", {})
            if plan.get("status", "none") != "none":
                box.label(text=f"{int(m.get('residents_affected', 0))} affected · {int(m.get('left_behind', 0))} left behind"
                               f" · plan {plan.get('status')} v{plan.get('version', 0)}")
            deepest = max((float(w.get("depth", 0)) for w in st.get("water", {}).values()), default=0.0)
            if deepest > 0:
                box.label(text=f"water {deepest * 100:.0f} cm · dark: {', '.join(st['impact'].get('dark_levels', [])) or 'none'}",
                          icon="MOD_FLUIDSIM")
        else:
            box.label(text="not connected", icon="UNLINKED")
        if LINK.last_post:
            box.label(text=LINK.last_post[:60], icon="INFO")

        col = lay.column(align=True)
        col.label(text="Inputs (events to the one world)")
        row = col.row(align=True)
        op = row.operator("haven.live_input", text="Simulate leak", icon="MOD_FLUIDSIM")
        op.kind, op.value = "leak", 0.9
        op = row.operator("haven.live_input", text="Dry")
        op.kind, op.value = "leak", 0.0
        maya_on = bool(frame and frame["state"].get("agents", {}).get("resident:maya", True))
        op = col.operator("haven.live_input", text=f"Maya's agent: {'ON' if maya_on else 'OFF'}",
                          icon="CHECKBOX_HLT" if maya_on else "CHECKBOX_DEHLT", depress=maya_on)
        op.kind, op.text, op.flag = "agent", "resident:maya", not maya_on
        op = col.operator("haven.live_input", text="Approve plan", icon="CHECKMARK")
        op.kind = "approve"
        row = col.row(align=True)
        row.prop(context.scene, "haven_rule", text="")
        op = row.operator("haven.live_input", text="", icon="REC")
        op.kind, op.text = "rule", context.scene.haven_rule
        row = col.row(align=True)
        for s in (1, 5, 20, 60):
            op = row.operator("haven.live_input", text=f"{s}x")
            op.kind, op.value = "speed", float(s)
        row = col.row(align=True)
        op = row.operator("haven.live_input", text="Play", icon="PLAY")
        op.kind, op.flag = "play", True
        op = row.operator("haven.live_input", text="Pause", icon="PAUSE")
        op.kind, op.flag = "play", False
        row = col.row(align=True)
        op = row.operator("haven.live_input", text="Reset", icon="FILE_REFRESH")
        op.kind = "reset"
        op = row.operator("haven.live_input", text="Load demo", icon="FILE_MOVIE")
        op.kind = "demo"

        col = lay.column(align=True)
        col.label(text="Look at")
        row = col.row(align=True)
        for label, name in (("Maya", "person_maya"), ("Plumber", "agent_plumber"), ("Switchgear", "eq_msb_b"), ("Riser", "eq_water_riser")):
            row.operator("haven.live_look", text=label).name = name


CLASSES = (HAVEN_OT_live_connect, HAVEN_OT_live_disconnect, HAVEN_OT_live_clear, HAVEN_OT_live_input,
           HAVEN_OT_live_look, HAVEN_PT_live)


def register():
    bpy.types.Scene.haven_url = bpy.props.StringProperty(name="HAVEN backend", default=DEFAULT_URL)
    bpy.types.Scene.haven_rule = bpy.props.StringProperty(name="Manager rule", default="Nobody gets moved off campus")
    for cls in CLASSES:
        try:
            bpy.utils.register_class(cls)
        except ValueError:          # already registered (re-run)
            bpy.utils.unregister_class(cls)
            bpy.utils.register_class(cls)


def unregister():
    LINK.stop_polling()
    for cls in reversed(CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass


# ---- headless snapshot -----------------------------------------------------------------------------


def _log(msg):
    """The Store launcher detaches stdout, so headless runs also write blender/renders/live_snapshot.log."""
    print(msg)
    try:
        log_path = Path(__file__).resolve().parent / "renders" / "live_snapshot.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except Exception:      # noqa: BLE001
        pass


def look_camera(target_name, offset=(-9.0, -11.0, 8.0), lens=32.0):
    """A camera a few metres from a live object (e.g. person_maya), looking at it."""
    ob = bpy.data.objects.get(target_name)
    if ob is None:
        raise KeyError(f"{target_name} is not in the scene")
    cam = bpy.data.objects.get("LiveCam")
    if cam is None:
        cam = bpy.data.objects.new("LiveCam", bpy.data.cameras.new("LiveCam"))
        _scene().collection.objects.link(cam)
    cam.data.lens = lens
    cam.data.clip_end = 20000.0
    at = Vector(ob.location) + Vector((0, 0, 0.8))     # matrix_world is stale until the depsgraph runs
    cam.location = at + Vector(offset)
    cam.rotation_euler = (at - cam.location).to_track_quat("-Z", "Y").to_euler()
    return cam


def snapshot(out_path, url=DEFAULT_URL, camera="HeroCam", cutaway_level=None, fast=False, look=None):
    """Fetch the world once, draw it, render one still. Used by the check script and CI-style runs."""
    LINK.url = url
    _log(f"snapshot: fetching {url}")
    LINK.fetch_static()
    frame = LINK.fetch_frame()
    t0 = time.time()
    apply_state(frame, Index(LINK.spec, LINK.roster), snap=True)
    _log(f"snapshot: frame applied in {time.time() - t0:.1f} s")
    scene = _scene()
    if fast:
        scene.render.resolution_percentage = 50
        for attr, val in (("taa_render_samples", 8), ("use_raytracing", False)):
            if hasattr(scene.eevee, attr):
                setattr(scene.eevee, attr, val)
    hidden = []
    world = scene.world
    if cutaway_level:
        target = next(lv["index"] for lv in LINK.spec["levels"] if lv["id"] == cutaway_level)
        for ob in bpy.data.objects:
            idx = ob.get("level_index")
            if ob.name == "hud":
                continue
            if (idx is not None and idx > target) or (ob.name.startswith("site_") and target < 1):
                ob.hide_render = True
                hidden.append(ob)
        if target < 1 and bpy.data.worlds.get("World Flat"):
            scene.world = bpy.data.worlds["World Flat"]
    cam = bpy.data.objects.get(camera)
    if look:
        cam = look_camera(look)
    if cam is not None:
        scene.camera = cam
    if scene.camera is not None:
        face(scene.camera.matrix_world.to_quaternion())
    out = Path(out_path)
    if not out.is_absolute():       # the launcher's cwd is not the repo: resolve against the repo root
        out = Path(__file__).resolve().parent.parent / out
    out.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(out)
    scene.render.image_settings.file_format = "PNG"
    _log(f"snapshot: rendering {camera} -> {out}")
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    _log(f"snapshot: rendered in {time.time() - t0:.1f} s")
    for ob in hidden:
        ob.hide_render = False
    scene.world = world
    st = frame["state"]
    _log(f"live snapshot -> {out}  (run {st['run_id']} step {st['step']} v{st['version']}, "
          f"{len(st.get('water', {}))} wet spaces, {len(st.get('moved', {}))} moved, "
          f"{sum(1 for a in st.get('actors', {}).values() if a.get('at'))} responders drawn)")
    return frame


def _cli(argv):
    opts = {"snapshot": None, "url": DEFAULT_URL, "camera": "HeroCam", "cutaway": None, "fast": False, "look": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--snapshot", "--url", "--camera", "--cutaway", "--look") and i + 1 < len(argv):
            opts[a[2:]] = argv[i + 1]
            i += 2
        elif a == "--fast":
            opts["fast"] = True
            i += 1
        else:
            i += 1
    return opts


if __name__ == "__main__" or __name__.startswith("haven_live"):
    register()
    if "--" in sys.argv:
        _opts = _cli(sys.argv[sys.argv.index("--") + 1:])
        if _opts["snapshot"]:
            _t0 = time.time()
            try:
                snapshot(_opts["snapshot"], _opts["url"], _opts["camera"], _opts["cutaway"], _opts["fast"], _opts["look"])
            except Exception as exc:      # noqa: BLE001
                import traceback
                _log("snapshot FAILED: " + "".join(traceback.format_exception(exc)))
                raise
            _log(f"done in {time.time() - _t0:.1f} s")
