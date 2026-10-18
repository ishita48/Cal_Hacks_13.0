"""Build David Blackwell Hall in Blender from the shared building spec: exterior, interiors, services.

Everything derives from ``shared/blackwell_hall.json`` (written by ``backend/tools/export_building.py``):
level massing from the footprint plus each level's spaces, exterior walls as a 0.3 m ring,
slabs, interior partitions from the shared edges of spaces, door gaps from openings, windows
from the kind of space behind each stretch of exterior wall, street doors from ``outside``
openings, furniture from space kind + capacity, plant from the equipment list, the courtyard and
podium garden from the holes the spaces leave. Nothing about the building is typed in here twice.

Facade language, from photos of the real building (Capital Strategies / Berkeley News / Street
View): white fibre-cement panels with large ochre accent fields and tall paired windows in a
checker rhythm, a timber-clad glazed ground floor, the courtyard walls painted ochre, a glass
lounge "lantern" at the Dana St x Durant Ave corner, flat roof with parapet. Interiors follow the
published photos: wood-look plank floors and navy beds in rooms, grey carpet lounges with blue
and purple seating, a dark stone lobby with a timber desk.

Materials are procedural (no texture downloads), so the Blender render is fully textured; the glTF
export keeps base colours only.

Run headless (Store install exposes ``blender-launcher.exe``; a zip install exposes ``blender``):

    blender -b -P blender/build_blackwell.py -- --glb frontend/public/models/blackwell.glb \
        --glb-interior frontend/public/models/blackwell_interior.glb --render blender/renders/hero.png         --cutaway L4 --cutaway B1 --blend blender/blackwell.blend

Run inside a live Blender (e.g. through the Blender MCP):

    exec(open(r"C:/.../blender/build_blackwell.py").read(),
         {"HAVEN_ROOT": r"C:/.../Cal_Hacks_13.0", "HAVEN_ARGS": ["--glb", "frontend/public/models/blackwell.glb"]})

Naming for consumers (the React Three Fiber view reads glTF ``extras`` as ``userData``):
``win_<space_id>`` windows (space_id, level, kind), ``eq_<equipment_id>`` plant (equipment_id, kind,
flood_height), ``floor_<space_id>`` tiles (space_id, kind), ``walls_<level>`` / ``furniture_<level>`` interiors, every object
carries ``level``. Coordinates are the spec's: metres, x east, y north, z up, origin at the SW corner.
"""

import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

# ---- locate the repo ------------------------------------------------------------------------

if "HAVEN_ROOT" in globals():
    ROOT = Path(globals()["HAVEN_ROOT"])
elif "__file__" in globals():
    ROOT = Path(__file__).resolve().parents[1]
else:
    ROOT = Path.cwd()
SPEC_PATH = ROOT / "shared" / "blackwell_hall.json"

# ---- tunables (metres) ----------------------------------------------------------------------

EXT_WALL = 0.30            # exterior wall ring
INT_WALL = 0.12            # interior partitions
SLAB = 0.25
PARAPET_H = 1.0
PARAPET_T = 0.3
WIN_SILL, WIN_HEAD = 0.45, 2.75
WIN_W, WIN_GAP = 1.05, 0.35
FIELD_MARGIN = 0.18        # white frame left around an ochre field
GLASS_OUT, GLASS_IN = -0.13, 0.15             # pane 13 cm back from the face (a real reveal)
FRAME_OUT, FRAME_T = -0.10, 0.08               # frame sits just in front of the pane
FIELD_OUT = 0.035
REVEAL_DEPTH = EXT_WALL + 0.3                  # how far the cutter reaches through the ring
SITE_PAD = 36.0

CURTAIN_KINDS = {"lounge", "study", "kitchen", "amenity", "lobby", "retail", "office"}
BLANK_KINDS = {"corridor", "lift", "riser", "service", "storage", "mechanical", "electrical",
               "generator", "courtyard"}
# Interior floor finish by space kind.
FLOOR_BY_KIND = {
    "room": "plank", "corridor": "carpet", "lounge": "carpet", "study": "carpet", "kitchen": "tile",
    "bathroom": "tile", "laundry": "tile", "office": "carpet", "lobby": "stone", "retail": "stone",
    "amenity": "rubber", "storage": "concrete", "stair": "concrete", "lift": "steel", "service": "concrete",
    "mechanical": "concrete", "electrical": "concrete", "generator": "concrete", "riser": "concrete",
}


# ---- small geometry helpers -----------------------------------------------------------------


class R:
    __slots__ = ("x0", "y0", "x1", "y1")

    def __init__(self, x0, y0, x1, y1):
        self.x0, self.y0, self.x1, self.y1 = float(x0), float(y0), float(x1), float(y1)

    @classmethod
    def of(cls, d):
        return cls(d["x0"], d["y0"], d["x1"], d["y1"])

    @property
    def w(self):
        return self.x1 - self.x0

    @property
    def h(self):
        return self.y1 - self.y0

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2

    def contains(self, x, y, eps=1e-6):
        return self.x0 - eps <= x <= self.x1 + eps and self.y0 - eps <= y <= self.y1 + eps

    def grow(self, d):
        return R(self.x0 - d, self.y0 - d, self.x1 + d, self.y1 + d)


class Cells:
    """A rectilinear region as a set of cells on a grid of all the rect edges (+ offset lines)."""

    def __init__(self, rects, extra_lines=()):
        xs = {r.x0 for r in rects} | {r.x1 for r in rects}
        ys = {r.y0 for r in rects} | {r.y1 for r in rects}
        for d in extra_lines:
            xs |= {x + s * d for x in list(xs) for s in (-1, 1)}
            ys |= {y + s * d for y in list(ys) for s in (-1, 1)}
        self.xs = sorted(xs)
        self.ys = sorted(ys)
        self.cells = set()
        for i in range(len(self.xs) - 1):
            cx = (self.xs[i] + self.xs[i + 1]) / 2
            for j in range(len(self.ys) - 1):
                cy = (self.ys[j] + self.ys[j + 1]) / 2
                if any(r.contains(cx, cy) for r in rects):
                    self.cells.add((i, j))

    def inside(self, x, y):
        i = _bisect(self.xs, x)
        j = _bisect(self.ys, y)
        return (i, j) in self.cells

    def covered(self, rect):
        for i in range(len(self.xs) - 1):
            if self.xs[i] < rect.x0 - 1e-6 or self.xs[i + 1] > rect.x1 + 1e-6:
                continue
            for j in range(len(self.ys) - 1):
                if self.ys[j] < rect.y0 - 1e-6 or self.ys[j + 1] > rect.y1 + 1e-6:
                    continue
                if (i, j) not in self.cells:
                    return False
        return True

    def eroded(self, d):
        out = self._empty()
        for (i, j) in self.cells:
            r = R(self.xs[i], self.ys[j], self.xs[i + 1], self.ys[j + 1]).grow(d)
            if self.covered(r):
                out.cells.add((i, j))
        return out

    def minus(self, other):
        out = self._empty()
        out.cells = self.cells - other.cells
        return out

    def _empty(self):
        out = Cells.__new__(Cells)
        out.xs, out.ys, out.cells = self.xs, self.ys, set()
        return out

    def regrid(self, region):
        """Express another region on this grid."""
        out = self._empty()
        for i in range(len(self.xs) - 1):
            cx = (self.xs[i] + self.xs[i + 1]) / 2
            for j in range(len(self.ys) - 1):
                cy = (self.ys[j] + self.ys[j + 1]) / 2
                if region.inside(cx, cy):
                    out.cells.add((i, j))
        return out

    def bounds(self):
        xs = [self.xs[i] for (i, _) in self.cells] + [self.xs[i + 1] for (i, _) in self.cells]
        ys = [self.ys[j] for (_, j) in self.cells] + [self.ys[j + 1] for (_, j) in self.cells]
        return R(min(xs), min(ys), max(xs), max(ys))


def _bisect(arr, v):
    lo, hi = 0, len(arr) - 1
    if v < arr[0] or v > arr[-1]:
        return -1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if arr[mid] <= v:
            lo = mid
        else:
            hi = mid
    return lo


def add_box(bm, x0, x1, y0, y1, z0, z1, mi=0):
    if x1 - x0 < 1e-4 or y1 - y0 < 1e-4 or z1 - z0 < 1e-4:
        return
    vs = [bm.verts.new((x, y, z)) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
    for f in ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)):
        face = bm.faces.new([vs[i] for i in f])
        face.material_index = mi


def add_cyl(bm, x, y, z0, z1, radius, mi=0, segments=16):
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius,
                                depth=z1 - z0)
    for v in res["verts"]:
        v.co += Vector((x, y, (z0 + z1) / 2))
    new_verts = set(res["verts"])
    for f in bm.faces:
        if any(v in new_verts for v in f.verts):
            f.material_index = mi


def add_prism(bm, cells, z0, z1, mi=0):
    """Extrude a Cells region into a clean solid (coplanar cell faces dissolved)."""
    vcache = {}

    def v(i, j):
        key = (i, j)
        if key not in vcache:
            vcache[key] = bm.verts.new((cells.xs[i], cells.ys[j], z1))
        return vcache[key]

    faces = []
    for (i, j) in cells.cells:
        f = bm.faces.new([v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)])
        faces.append(f)
    if not faces:
        return
    res = bmesh.ops.extrude_face_region(bm, geom=faces)
    moved = [g for g in res["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=moved, vec=(0, 0, z0 - z1))
    touched = set(vcache.values()) | set(moved)
    for f in bm.faces:
        if any(vv in touched for vv in f.verts):
            f.material_index = mi
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1.0), verts=bm.verts[:], edges=bm.edges[:])


def _bevel(ob, width=0.015):
    """A 1.5 cm bevel so edges catch a highlight instead of reading as razor-sharp CG."""
    mod = ob.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = 2
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(60)
    if hasattr(mod, "harden_normals"):
        mod.harden_normals = True


def mesh_object(name, bm, materials, collection, props=None):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in materials:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    if props:
        for k, val in props.items():
            ob[k] = val
    return ob


# ---- procedural materials -------------------------------------------------------------------


def _new_mat(name):
    key = f"BW {name}"
    mat = bpy.data.materials.get(key)
    if mat:
        return mat, None
    mat = bpy.data.materials.new(key)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    return mat, bsdf


def _wall_coords(nt):
    """(x + y, z, 0): a continuous 2D parameter over every axis-aligned wall of the building."""
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    add = nt.nodes.new("ShaderNodeMath")
    add.operation = "ADD"
    nt.links.new(sep.outputs["X"], add.inputs[0])
    nt.links.new(sep.outputs["Y"], add.inputs[1])
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(add.outputs[0], comb.inputs["X"])
    nt.links.new(sep.outputs["Z"], comb.inputs["Y"])
    return comb.outputs[0], tc


def _noise(nt, vec, scale, detail=3.0, roughness=0.5):
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = detail
    n.inputs["Roughness"].default_value = roughness
    if vec is not None:
        nt.links.new(vec, n.inputs["Vector"])
    return n


def _ramp(nt, fac, stops):
    r = nt.nodes.new("ShaderNodeValToRGB")
    el = r.color_ramp.elements
    while len(el) > 1:
        el.remove(el[-1])
    el[0].position, el[0].color = stops[0][0], (*stops[0][1], 1.0)
    for pos, col in stops[1:]:
        e = el.new(pos)
        e.color = (*col, 1.0)
    nt.links.new(fac, r.inputs["Fac"])
    return r


def _bump(nt, height, strength, distance, bsdf):
    b = nt.nodes.new("ShaderNodeBump")
    b.inputs["Strength"].default_value = strength
    b.inputs["Distance"].default_value = distance
    nt.links.new(height, b.inputs["Height"])
    nt.links.new(b.outputs["Normal"], bsdf.inputs["Normal"])
    return b


def _finish(mat, bsdf, rgb, roughness, metallic=0.0, emission=None):
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 2.0
    mat.diffuse_color = (*rgb, 1.0)
    return mat


def mat_plain(name, rgb, roughness=0.6, metallic=0.0, grain=0.0, emission=None):
    """Flat colour with optional faint noise grain in colour + roughness."""
    mat, bsdf = _new_mat(name)
    if bsdf is None:
        return mat
    nt = mat.node_tree
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    if grain > 0:
        vec, _ = _wall_coords(nt)
        n = _noise(nt, vec, 18.0, detail=4.0)
        dark = tuple(max(0.0, c * (1 - grain)) for c in rgb)
        light = tuple(min(1.0, c * (1 + grain)) for c in rgb)
        r = _ramp(nt, n.outputs["Fac"], [(0.35, dark), (0.65, light)])
        nt.links.new(r.outputs["Color"], bsdf.inputs["Base Color"])
        rr = _ramp(nt, n.outputs["Fac"], [(0.0, (roughness * 0.85,) * 3), (1.0, (min(1.0, roughness * 1.15),) * 3)])
        nt.links.new(rr.outputs["Color"], bsdf.inputs["Roughness"])
        _bump(nt, n.outputs["Fac"], 0.06, 0.01, bsdf)
    return _finish(mat, bsdf, rgb, roughness, metallic, emission)


def mat_panels(name, rgb, panel_w=1.2, row_h=1.55, mortar=0.012, roughness=0.5):
    """Fibre-cement rain-screen: large smooth panels with fine recessed joints."""
    mat, bsdf = _new_mat(name)
    if bsdf is None:
        return mat
    nt = mat.node_tree
    vec, _ = _wall_coords(nt)
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.offset = 0.5
    brick.offset_frequency = 2
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Brick Width"].default_value = panel_w
    brick.inputs["Row Height"].default_value = row_h
    brick.inputs["Mortar Size"].default_value = mortar
    brick.inputs["Mortar Smooth"].default_value = 0.3
    brick.inputs["Bias"].default_value = 0.0
    nt.links.new(vec, brick.inputs["Vector"])
    n = _noise(nt, vec, 9.0, detail=5.0)
    base = _ramp(nt, n.outputs["Fac"], [(0.3, tuple(c * 0.95 for c in rgb)), (0.7, tuple(min(1.0, c * 1.03) for c in rgb))])
    joint = tuple(c * 0.45 for c in rgb)
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    nt.links.new(brick.outputs["Fac"], mix.inputs["Factor"])
    nt.links.new(base.outputs["Color"], mix.inputs[6])
    mix.inputs[7].default_value = (*joint, 1.0)
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = "SUBTRACT"
    inv.inputs[0].default_value = 1.0
    nt.links.new(brick.outputs["Fac"], inv.inputs[1])
    _bump(nt, inv.outputs[0], 0.35, 0.012, bsdf)
    rr = _ramp(nt, n.outputs["Fac"], [(0.0, (roughness * 0.9,) * 3), (1.0, (roughness * 1.1,) * 3)])
    nt.links.new(rr.outputs["Color"], bsdf.inputs["Roughness"])
    # Faint vertical weathering streaks (rain run-off): noise stretched along z.
    stretch = nt.nodes.new("ShaderNodeVectorMath")
    stretch.operation = "MULTIPLY"
    stretch.inputs[1].default_value = (6.0, 0.25, 1.0)
    nt.links.new(vec, stretch.inputs[0])
    streaks = _noise(nt, stretch.outputs[0], 1.0, detail=2.0, roughness=0.4)
    sr = _ramp(nt, streaks.outputs["Fac"], [(0.35, (0.94, 0.94, 0.94)), (0.6, (1.0, 1.0, 1.0))])
    dirt = nt.nodes.new("ShaderNodeMix")
    dirt.data_type = "RGBA"
    dirt.blend_type = "MULTIPLY"
    dirt.inputs["Factor"].default_value = 1.0
    nt.links.new(mix.outputs[2], dirt.inputs[6])
    nt.links.new(sr.outputs["Color"], dirt.inputs[7])
    nt.links.new(dirt.outputs[2], bsdf.inputs["Base Color"])
    return _finish(mat, bsdf, rgb, roughness)


def mat_wood(name, dark, light, board_w=0.14, roughness=0.55, vertical=True):
    """Timber boards: wave bands for boards, noise for grain."""
    mat, bsdf = _new_mat(name)
    if bsdf is None:
        return mat
    nt = mat.node_tree
    vec, _ = _wall_coords(nt)
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "X" if vertical else "Y"
    wave.wave_profile = "SAW"
    wave.inputs["Scale"].default_value = 1.0 / board_w
    wave.inputs["Distortion"].default_value = 0.6
    wave.inputs["Detail"].default_value = 3.0
    wave.inputs["Detail Scale"].default_value = 2.0
    nt.links.new(vec, wave.inputs["Vector"])
    grain = _noise(nt, vec, 40.0, detail=6.0, roughness=0.7)
    mixf = nt.nodes.new("ShaderNodeMath")
    mixf.operation = "MULTIPLY_ADD"
    nt.links.new(wave.outputs["Fac"], mixf.inputs[0])
    mixf.inputs[1].default_value = 0.75
    nt.links.new(grain.outputs["Fac"], mixf.inputs[2])
    r = _ramp(nt, mixf.outputs[0], [(0.2, dark), (0.55, light), (0.9, tuple((a + b) / 2 for a, b in zip(dark, light)))])
    nt.links.new(r.outputs["Color"], bsdf.inputs["Base Color"])
    _bump(nt, wave.outputs["Fac"], 0.25, 0.01, bsdf)
    mid = tuple((a + b) / 2 for a, b in zip(dark, light))
    return _finish(mat, bsdf, mid, roughness)


def mat_glass(name, tint=(0.02, 0.045, 0.065)):
    mat, bsdf = _new_mat(name)
    if bsdf is None:
        return mat
    bsdf.inputs["Base Color"].default_value = (*tint, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.08
    bsdf.inputs["Metallic"].default_value = 0.0
    for key, val in (("Coat Weight", 1.0), ("Coat Roughness", 0.04), ("Specular IOR Level", 0.7), ("IOR", 1.45)):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = val
    bsdf.inputs["Emission Color"].default_value = (1.0, 0.82, 0.55, 1.0)
    bsdf.inputs["Emission Strength"].default_value = 0.0
    # See-through, so furnished rooms read from the street; the coat keeps the sky reflection.
    bsdf.inputs["Alpha"].default_value = 0.22
    try:
        mat.surface_render_method = "BLENDED"
    except AttributeError:
        mat.blend_method = "BLEND"
    for attr in ("use_transparency_overlap",):
        if hasattr(mat, attr):
            setattr(mat, attr, True)
    mat.diffuse_color = (*tint, 1.0)
    return mat


def mat_ground(name, rgb, scale=3.0, roughness=0.9, pavers=None):
    """Asphalt / concrete / gravel: layered noise; optional paver joints (size in metres)."""
    mat, bsdf = _new_mat(name)
    if bsdf is None:
        return mat
    nt = mat.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    vec = tc.outputs["Object"]
    n1 = _noise(nt, vec, scale, detail=6.0, roughness=0.6)
    n2 = _noise(nt, vec, scale * 12, detail=8.0, roughness=0.8)
    mixf = nt.nodes.new("ShaderNodeMath")
    mixf.operation = "MULTIPLY_ADD"
    nt.links.new(n1.outputs["Fac"], mixf.inputs[0])
    mixf.inputs[1].default_value = 0.7
    nt.links.new(n2.outputs["Fac"], mixf.inputs[2])
    r = _ramp(nt, mixf.outputs[0], [(0.25, tuple(c * 0.75 for c in rgb)), (0.75, tuple(min(1.0, c * 1.2) for c in rgb))])
    color_out = r.outputs["Color"]
    height_out = n2.outputs["Fac"]
    if pavers:
        brick = nt.nodes.new("ShaderNodeTexBrick")
        brick.offset = 0.5
        brick.inputs["Scale"].default_value = 1.0
        brick.inputs["Brick Width"].default_value = pavers
        brick.inputs["Row Height"].default_value = pavers
        brick.inputs["Mortar Size"].default_value = 0.008
        nt.links.new(vec, brick.inputs["Vector"])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        nt.links.new(brick.outputs["Fac"], mix.inputs["Factor"])
        nt.links.new(color_out, mix.inputs[6])
        mix.inputs[7].default_value = (*(c * 0.5 for c in rgb), 1.0)
        color_out = mix.outputs[2]
        sub = nt.nodes.new("ShaderNodeMath")
        sub.operation = "SUBTRACT"
        nt.links.new(height_out, sub.inputs[0])
        nt.links.new(brick.outputs["Fac"], sub.inputs[1])
        height_out = sub.outputs[0]
    nt.links.new(color_out, bsdf.inputs["Base Color"])
    _bump(nt, height_out, 0.35, 0.02, bsdf)
    rr = _ramp(nt, n1.outputs["Fac"], [(0.0, (roughness * 0.85,) * 3), (1.0, (min(1.0, roughness * 1.1),) * 3)])
    nt.links.new(rr.outputs["Color"], bsdf.inputs["Roughness"])
    return _finish(mat, bsdf, rgb, roughness)


def mat_tiles(name, rgb, tile=0.3, roughness=0.25):
    mat, bsdf = _new_mat(name)
    if bsdf is None:
        return mat
    nt = mat.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.offset = 0.0
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Brick Width"].default_value = tile
    brick.inputs["Row Height"].default_value = tile
    brick.inputs["Mortar Size"].default_value = 0.004
    brick.inputs["Color1"].default_value = (*rgb, 1.0)
    brick.inputs["Color2"].default_value = (*(min(1.0, c * 1.06) for c in rgb), 1.0)
    brick.inputs["Mortar"].default_value = (*(c * 0.55 for c in rgb), 1.0)
    nt.links.new(tc.outputs["Object"], brick.inputs["Vector"])
    nt.links.new(brick.outputs["Color"], bsdf.inputs["Base Color"])
    _bump(nt, brick.outputs["Fac"], 0.3, 0.004, bsdf)
    return _finish(mat, bsdf, rgb, roughness)


def mat_carpet(name, rgb):
    mat, bsdf = _new_mat(name)
    if bsdf is None:
        return mat
    nt = mat.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n = _noise(nt, tc.outputs["Object"], 60.0, detail=8.0, roughness=0.8)
    r = _ramp(nt, n.outputs["Fac"], [(0.3, tuple(c * 0.8 for c in rgb)), (0.7, tuple(min(1.0, c * 1.15) for c in rgb))])
    nt.links.new(r.outputs["Color"], bsdf.inputs["Base Color"])
    _bump(nt, n.outputs["Fac"], 0.4, 0.004, bsdf)
    if "Sheen Weight" in bsdf.inputs:
        bsdf.inputs["Sheen Weight"].default_value = 0.4
    return _finish(mat, bsdf, rgb, 0.95)


def make_materials():
    return {
        # exterior
        "white": mat_panels("panel white", (0.69, 0.69, 0.60), roughness=0.78),
        "ochre": mat_panels("panel ochre", (0.665, 0.376, 0.028), panel_w=1.2, row_h=1.25, roughness=0.75),
        "glass": mat_glass("glass"),
        "frosted": mat_plain("glass frosted", (0.62, 0.72, 0.76), roughness=0.3),
        "frame": mat_plain("frame", (0.045, 0.045, 0.05), roughness=0.32, metallic=0.9, grain=0.05),   # anodized aluminium
        "timber": mat_wood("timber cladding", (0.30, 0.13, 0.05), (0.66, 0.36, 0.13)),
        "soffit": mat_wood("timber soffit", (0.36, 0.20, 0.08), (0.70, 0.46, 0.22), board_w=0.09, vertical=False),
        "concrete": mat_ground("concrete", (0.58, 0.57, 0.54), scale=2.0, roughness=0.85),
        "roof": mat_ground("roof membrane", (0.40, 0.40, 0.42), scale=4.0, roughness=0.95),
        "metal": mat_plain("metal", (0.55, 0.57, 0.60), roughness=0.35, metallic=0.7, grain=0.08),
        "lawn": mat_ground("lawn", (0.28, 0.46, 0.17), scale=6.0, roughness=1.0),
        "gravel": mat_ground("gravel", (0.60, 0.58, 0.53), scale=40.0, roughness=1.0),
        "soil": mat_ground("soil", (0.26, 0.18, 0.11), scale=20.0, roughness=1.0),
        "deck": mat_wood("deck boards", (0.42, 0.25, 0.12), (0.66, 0.44, 0.24), board_w=0.12, vertical=False),
        "paving": mat_ground("paving", (0.70, 0.68, 0.64), scale=2.0, roughness=0.9, pavers=0.6),
        "asphalt": mat_ground("asphalt", (0.11, 0.11, 0.12), scale=1.5, roughness=0.95),
        "sidewalk": mat_ground("sidewalk", (0.60, 0.59, 0.56), scale=2.0, roughness=0.9, pavers=1.5),
        "ground": mat_ground("ground", (0.30, 0.31, 0.28), scale=0.3, roughness=1.0),
        "neighbour": mat_panels("neighbour", (0.42, 0.40, 0.38), panel_w=3.0, row_h=3.0, roughness=0.9),
        "trunk": mat_wood("trunk", (0.18, 0.12, 0.07), (0.34, 0.25, 0.15), board_w=0.05),
        "canopy": mat_plain("canopy", (0.22, 0.42, 0.18), roughness=0.9, grain=0.35),
        # interior
        "paint": mat_plain("paint white", (0.88, 0.88, 0.86), roughness=0.7, grain=0.03),
        "plank": mat_wood("plank floor", (0.58, 0.44, 0.28), (0.80, 0.66, 0.46), board_w=0.16, vertical=False),
        "carpet": mat_carpet("carpet", (0.36, 0.37, 0.39)),
        "tile": mat_tiles("tile", (0.85, 0.85, 0.83)),
        "stone": mat_tiles("stone", (0.16, 0.16, 0.17), tile=0.9, roughness=0.15),
        "rubber": mat_plain("rubber floor", (0.18, 0.18, 0.20), roughness=0.85, grain=0.15),
        "steel": mat_plain("steel", (0.60, 0.61, 0.63), roughness=0.3, metallic=0.8, grain=0.1),
        "laminate": mat_plain("laminate white", (0.90, 0.90, 0.88), roughness=0.35),
        "navy": mat_plain("navy fabric", (0.08, 0.12, 0.30), roughness=0.9, grain=0.2),
        "purple": mat_plain("purple fabric", (0.30, 0.22, 0.42), roughness=0.9, grain=0.2),
        "blue": mat_plain("blue fabric", (0.12, 0.32, 0.55), roughness=0.9, grain=0.2),
        "red": mat_plain("red fabric", (0.62, 0.10, 0.12), roughness=0.9, grain=0.2),
        "lime": mat_plain("lime accent", (0.70, 0.78, 0.20), roughness=0.7),
        "dark": mat_plain("dark grey", (0.12, 0.12, 0.13), roughness=0.6),
        "desk_wood": mat_wood("desk timber", (0.40, 0.24, 0.10), (0.62, 0.42, 0.22), board_w=0.1, vertical=False),
        "switchgear": mat_plain("switchgear", (0.70, 0.71, 0.70), roughness=0.4, metallic=0.5, grain=0.08),
        "generator": mat_plain("generator", (0.16, 0.30, 0.20), roughness=0.5, metallic=0.3, grain=0.1),
        "pipe": mat_plain("pipe", (0.45, 0.47, 0.50), roughness=0.4, metallic=0.8),
        "pipe_blue": mat_plain("pipe blue", (0.15, 0.35, 0.65), roughness=0.5),
        "led": mat_plain("led", (0.2, 1.0, 0.3), roughness=0.3, emission=(0.2, 1.0, 0.3)),
    }


# ---- the build ------------------------------------------------------------------------------

FURN_MATS = ["laminate", "navy", "dark", "purple", "desk_wood", "steel", "red", "frosted", "concrete",
             "blue", "lime", "paint", "tile"]
FM = {k: i for i, k in enumerate(FURN_MATS)}


class Builder:
    def __init__(self, spec, with_site=True, with_interior=True):
        self.spec = spec
        self.with_site = with_site
        self.with_interior = with_interior
        self.levels = {lv["id"]: lv for lv in spec["levels"]}
        self.ordered = sorted(spec["levels"], key=lambda lv: lv["index"])
        self.above = [lv for lv in self.ordered if lv["index"] > 0]
        self.top_level = self.above[-1]
        self.roof_z = self.top_level["elevation"] + self.top_level["height"]
        self.footprint = [R.of(r) for r in spec["footprint"]]
        self.spaces_by_level = {}
        for s in spec["spaces"]:
            self.spaces_by_level.setdefault(s["level"], []).append(s)
        self.space_by_id = {s["id"]: s for s in spec["spaces"]}
        self.courtyards = [R.of(s["rect"]) for s in spec["spaces"] if s["outdoor"]]
        self.mats = make_materials()
        self.col_building = self._collection("Blackwell Hall")
        self.col_shell = self._collection("Shell", parent=self.col_building)
        self.col_windows = self._collection("Windows", parent=self.col_building)
        self.col_interior = self._collection("Interior", parent=self.col_building)
        self.col_plant = self._collection("Plant", parent=self.col_building)
        self.col_site = self._collection("Site")
        self.col_cutters = self._collection("Cutters")   # boolean cutters; hidden, never exported
        self.massing = {}
        self.cutters = {}          # level id -> [(axis, fixed, sign, a0, a1, z0, z1)]
        self._cut_level = None

    @staticmethod
    def _collection(name, parent=None):
        col = bpy.data.collections.get(name)
        if col is None:
            col = bpy.data.collections.new(name)
            (parent or bpy.context.scene.collection).children.link(col)
        return col

    def _props(self, lv, **extra):
        p = {"level": lv["id"], "level_index": lv["index"]}
        p.update(extra)
        return p

    # -- massing ------------------------------------------------------------------------

    def level_region(self, lv):
        rects = [R.of(s["rect"]) for s in self.spaces_by_level.get(lv["id"], []) if not s["outdoor"]]
        if lv["index"] > 0:
            rects += list(self.footprint)
        return Cells(rects, extra_lines=(EXT_WALL, PARAPET_T))

    def build_shell(self):
        m = self.mats
        for lv in self.ordered:
            region = self.level_region(lv)
            self.massing[lv["id"]] = region
            z0, z1 = lv["elevation"], lv["elevation"] + lv["height"]
            bm = bmesh.new()
            add_prism(bm, region, z0, z0 + SLAB, mi=0)
            mesh_object(f"slab_{lv['id']}", bm, [m["concrete"]], self.col_shell, self._props(lv))
            # Exterior wall ring: timber-clad at street level, white panels above, concrete below grade.
            ring = region.minus(region.eroded(EXT_WALL))
            bm = bmesh.new()
            add_prism(bm, ring, z0 + SLAB, z1, mi=0)
            skin = m["timber"] if lv["index"] == 1 else (m["white"] if lv["index"] > 1 else m["concrete"])
            mesh_object(f"walls_ext_{lv['id']}", bm, [skin], self.col_shell, self._props(lv))
            if lv["index"] == 1:
                # Timber soffit band where the white upper floors meet the street level.
                bm = bmesh.new()
                for axis, fixed, lo, hi, sign in self._ring_segments(region):
                    self._wall_box(bm, axis, fixed, sign, lo, hi, z1 - 0.5, z1 - 0.02, 0.08, 0.0, 0)
                mesh_object("soffit_band", bm, [m["soffit"]], self.col_shell, self._props(lv))
        self.build_roof()
        self.build_podium_garden()

    def _ring_segments(self, region):
        """Exterior wall faces of a region as (axis, fixed, lo, hi, outward_sign)."""
        segs = []
        xs, ys = region.xs, region.ys
        for (i, j) in region.cells:
            x0, x1, y0, y1 = xs[i], xs[i + 1], ys[j], ys[j + 1]
            if (i, j - 1) not in region.cells:
                segs.append(("x", y0, x0, x1, -1))
            if (i, j + 1) not in region.cells:
                segs.append(("x", y1, x0, x1, +1))
            if (i - 1, j) not in region.cells:
                segs.append(("y", x0, y0, y1, -1))
            if (i + 1, j) not in region.cells:
                segs.append(("y", x1, y0, y1, +1))
        return _merge_segments(segs)

    def build_roof(self):
        m = self.mats
        top = self.massing[self.top_level["id"]]
        roofp = {"level": "roof", "level_index": 99}
        bm = bmesh.new()
        add_prism(bm, top, self.roof_z - 0.02, self.roof_z + 0.08, mi=0)
        mesh_object("roof_deck", bm, [m["roof"]], self.col_shell, roofp)
        parapet = top.minus(top.eroded(PARAPET_T))
        bm = bmesh.new()
        add_prism(bm, parapet, self.roof_z, self.roof_z + PARAPET_H, mi=0)
        _bevel(mesh_object("parapet", bm, [m["white"]], self.col_shell, roofp))
        lifts = [s for s in self.spaces_by_level[self.top_level["id"]] if s["kind"] == "lift"]
        if lifts:
            x0 = min(R.of(s["rect"]).x0 for s in lifts) - 0.8
            x1 = max(R.of(s["rect"]).x1 for s in lifts) + 3.0
            y0 = min(R.of(s["rect"]).y0 for s in lifts) - 1.0
            y1 = max(R.of(s["rect"]).y1 for s in lifts) + 1.0
            bm = bmesh.new()
            add_box(bm, x0, x1, y0, y1, self.roof_z, self.roof_z + 3.2, 0)
            mesh_object("penthouse", bm, [m["concrete"]], self.col_shell, roofp)
        bm = bmesh.new()
        for y in (30, 45, 60):
            add_box(bm, 2.5, 6.5, y, y + 3.0, self.roof_z + 0.08, self.roof_z + 1.4, 0)
            add_cyl(bm, 4.5, y + 1.5, self.roof_z + 1.4, self.roof_z + 1.75, 0.9, 0, 20)
        add_box(bm, 20, 26, 78.5, 82.5, self.roof_z + 0.08, self.roof_z + 1.6, 0)
        mesh_object("rooftop_units", bm, [m["metal"]], self.col_shell, roofp)

    def build_podium_garden(self):
        """The L2 terrace: the part of the ground-floor roof the upper floors leave open."""
        m = self.mats
        l1 = self.levels["L1"]
        l2 = next(lv for lv in self.above if lv["index"] == 2)
        p = {"level": "L2", "level_index": 2}
        base = Cells([R.of(s["rect"]) for s in self.spaces_by_level["L1"] if not s["outdoor"]] + list(self.footprint),
                     extra_lines=(0.6, 0.12))
        garden = base.minus(base.regrid(self.massing[l2["id"]]))
        if not garden.cells:
            return
        z = l1["elevation"] + l1["height"]
        bm = bmesh.new()
        add_prism(bm, garden, z, z + 0.06, mi=0)
        mesh_object("podium_paving", bm, [m["paving"]], self.col_shell, p)
        b = garden.bounds()
        bm = bmesh.new()
        add_box(bm, b.x0 + 1.0, b.x1 - 1.0, b.y0 + 1.0, b.y0 + 4.5, z + 0.06, z + 0.12, 0)
        mesh_object("podium_deck", bm, [m["deck"]], self.col_shell, p)
        bm = bmesh.new()
        add_box(bm, b.x0 + 1.0, b.x1 - 1.0, b.y0 + 6.0, b.y1 - 1.0, z + 0.06, z + 0.18, 0)
        mesh_object("podium_lawn", bm, [m["lawn"]], self.col_shell, p)
        bm = bmesh.new()
        soil = bmesh.new()
        for (x, y) in ((b.x0 + 3.5, b.y1 - 4.0), (b.x1 - 6.5, b.y1 - 4.0), (b.cx - 1.5, b.y0 + 7.5)):
            add_box(bm, x, x + 3.0, y, y + 2.0, z + 0.06, z + 0.75, 0)
            add_box(soil, x + 0.1, x + 2.9, y + 0.1, y + 1.9, z + 0.6, z + 0.72, 0)
        mesh_object("podium_planters", bm, [m["concrete"]], self.col_shell, p)
        mesh_object("podium_planter_soil", soil, [m["soil"]], self.col_shell, p)
        rail = garden.minus(garden.eroded(0.12))
        bm = bmesh.new()
        add_prism(bm, rail, z, z + 1.1, mi=0)
        mesh_object("podium_rail", bm, [m["frosted"]], self.col_shell, p)
        bm = bmesh.new()
        for (x, y) in ((b.x0 + 5, b.y1 - 3), (b.x1 - 5, b.y1 - 3), (b.x0 + 12, b.y0 + 8.5)):
            self._tree(bm, x, y, z + 0.18, height=4.5, radius=2.0)
        mesh_object("podium_trees", bm, [m["trunk"], m["canopy"]], self.col_shell, p)

    # -- facade -------------------------------------------------------------------------

    def exterior_edges(self, space, region):
        """(axis, fixed, lo, hi, outward_sign, faces_courtyard) for each edge of a space facing open air."""
        r = R.of(space["rect"])
        probe = 0.15
        edges = [("x", r.y0, r.x0, r.x1, -1), ("x", r.y1, r.x0, r.x1, +1),
                 ("y", r.x0, r.y0, r.y1, -1), ("y", r.x1, r.y0, r.y1, +1)]
        for axis, fixed, lo, hi, sign in edges:
            mid = (lo + hi) / 2
            px, py = (mid, fixed + sign * probe) if axis == "x" else (fixed + sign * probe, mid)
            if not region.inside(px, py):
                court = any(c.contains(px, py) for c in self.courtyards)
                yield axis, fixed, lo, hi, sign, court

    def build_facade(self):
        m = self.mats
        for lv in self.above:
            region = self.massing[lv["id"]]
            z_floor = lv["elevation"]
            self._cut_level = lv["id"]
            spaces = sorted(self.spaces_by_level.get(lv["id"], []), key=lambda s: s["id"])
            for idx, space in enumerate(spaces):
                if space["outdoor"] or space["kind"] in BLANK_KINDS:
                    continue
                bm = bmesh.new()
                for axis, fixed, lo, hi, sign, court in self.exterior_edges(space, region):
                    if lv["index"] == 1:
                        self.storefront(bm, space, axis, fixed, lo, hi, sign, z_floor, lv["height"])
                    else:
                        self.upper_bay(bm, space, idx, lv, axis, fixed, lo, hi, sign, z_floor, court)
                if not bm.faces:
                    bm.free()
                    continue
                mesh_object(f"win_{space['id']}", bm, [m["glass"], m["frame"], m["ochre"], m["frosted"], m["timber"]],
                            self.col_windows, self._props(lv, space_id=space["id"], kind=space["kind"]))
        self.build_doors()
        self.build_reveals()

    def _cut(self, axis, fixed, sign, a0, a1, z0, z1):
        self.cutters.setdefault(self._cut_level, []).append((axis, fixed, sign, a0, a1, z0, z1))

    def build_reveals(self):
        """Cut every window and door opening out of its level's wall ring (exact boolean)."""
        for lv_id, cuts in self.cutters.items():
            wall = bpy.data.objects.get(f"walls_ext_{lv_id}")
            if wall is None or not cuts:
                continue
            bm = bmesh.new()
            for (axis, fixed, sign, a0, a1, z0, z1) in cuts:
                self._wall_box(bm, axis, fixed, sign, a0, a1, z0, z1, 0.5, REVEAL_DEPTH, 0)
            ob = mesh_object(f"cutter_{lv_id}", bm, [], self.col_cutters, {"level": lv_id, "level_index": -100})
            ob.display_type = "WIRE"
            ob.hide_render = True
            ob.hide_viewport = True
            mod = wall.modifiers.new("reveals", "BOOLEAN")
            mod.operation = "DIFFERENCE"
            mod.object = ob
            try:
                mod.solver = "EXACT"
                mod.use_hole_tolerant = True
                mod.use_self = True        # the cutter boxes overlap each other (bays + doors)
            except (AttributeError, TypeError):
                pass
            _bevel(wall)

    def _wall_box(self, bm, axis, fixed, sign, a0, a1, z0, z1, out, inward, mi):
        n0, n1 = sorted((fixed + sign * out, fixed - sign * inward))
        if axis == "x":
            add_box(bm, a0, a1, n0, n1, z0, z1, mi)
        else:
            add_box(bm, n0, n1, a0, a1, z0, z1, mi)

    def upper_bay(self, bm, space, idx, lv, axis, fixed, lo, hi, sign, z, court):
        kind = space["kind"]
        length = hi - lo
        z0, z1 = z + WIN_SILL, z + WIN_HEAD
        h = lv["height"]
        ochre = court or (lv["index"] + idx) % 2 == 0
        if kind in CURTAIN_KINDS:
            self.curtain(bm, axis, fixed, lo + 0.25, hi - 0.25, sign, z + SLAB + 0.05, z + h - 0.2)
            return
        # Decide the windows first, then (on ochre bays) lay the accent field around them in strips,
        # so the field never covers a pane and the reveal reads through it.
        wins = []
        glass_mi = 0
        if kind == "bathroom":
            c = (lo + hi) / 2
            wins = [(c - 0.45, c + 0.45, z + 1.5, z + 2.55)]
            glass_mi = 3
        elif kind == "stair":
            c = (lo + hi) / 2
            wins = [(c - 0.35, c + 0.35, z + 0.45, z + h - 0.3)]
            glass_mi = 3
        else:
            n_win = 2 if length >= 2 * WIN_W + WIN_GAP + 1.2 else 1
            group_w = n_win * WIN_W + (n_win - 1) * WIN_GAP
            slack = (length - group_w) / 2
            shift = max(0.0, min(slack - 0.35, 0.6)) * (1 if (idx + lv["index"]) % 2 else -1)
            start = (lo + hi) / 2 - group_w / 2 + shift
            wins = [(start + k * (WIN_W + WIN_GAP), start + k * (WIN_W + WIN_GAP) + WIN_W, z0, z1) for k in range(n_win)]
        if ochre:
            f0, f1, zf0, zf1 = lo + FIELD_MARGIN, hi - FIELD_MARGIN, z + 0.32, z + h - 0.18
            wz0, wz1 = min(w[2] for w in wins) - FRAME_T, max(w[3] for w in wins) + FRAME_T
            self._wall_box(bm, axis, fixed, sign, f0, f1, zf0, wz0, FIELD_OUT, 0.0, 2)
            self._wall_box(bm, axis, fixed, sign, f0, f1, wz1, zf1, FIELD_OUT, 0.0, 2)
            edge = f0
            for (a0, a1, _, _) in sorted(wins):
                self._wall_box(bm, axis, fixed, sign, edge, a0 - FRAME_T, wz0, wz1, FIELD_OUT, 0.0, 2)
                edge = a1 + FRAME_T
            self._wall_box(bm, axis, fixed, sign, edge, f1, wz0, wz1, FIELD_OUT, 0.0, 2)
        for (a0, a1, w0, w1) in wins:
            self._window(bm, axis, fixed, sign, a0, a1, w0, w1, mi_glass=glass_mi)

    def _window(self, bm, axis, fixed, sign, a0, a1, z0, z1, mi_glass=0, out=0.0):
        self._wall_box(bm, axis, fixed, sign, a0, a1, z0, z1, GLASS_OUT + out, GLASS_IN, mi_glass)
        self._frame(bm, axis, fixed, sign, a0, a1, z0, z1, out=out)
        self._cut(axis, fixed, sign, a0 - FRAME_T, a1 + FRAME_T, z0 - FRAME_T, z1 + FRAME_T)

    def _frame(self, bm, axis, fixed, sign, a0, a1, z0, z1, out=0.0):
        t = FRAME_T
        o = FRAME_OUT + out
        inner = -o + 0.07          # frame depth 7 cm, flush behind the recess
        self._wall_box(bm, axis, fixed, sign, a0 - t, a0, z0 - t, z1 + t, o, inner, 1)
        self._wall_box(bm, axis, fixed, sign, a1, a1 + t, z0 - t, z1 + t, o, inner, 1)
        self._wall_box(bm, axis, fixed, sign, a0, a1, z0 - t, z0, o, inner, 1)
        self._wall_box(bm, axis, fixed, sign, a0, a1, z1, z1 + t, o, inner, 1)

    def curtain(self, bm, axis, fixed, lo, hi, sign, z0, z1, bay=1.5, mi_glass=0):
        if hi - lo < 0.6:
            return
        self._wall_box(bm, axis, fixed, sign, lo, hi, z0, z1, GLASS_OUT, GLASS_IN, mi_glass)
        self._frame(bm, axis, fixed, sign, lo, hi, z0, z1)
        self._cut(axis, fixed, sign, lo - FRAME_T, hi + FRAME_T, z0 - FRAME_T, z1 + FRAME_T)
        n = max(1, int(round((hi - lo) / bay)))
        for k in range(1, n):
            a = lo + (hi - lo) * k / n
            self._wall_box(bm, axis, fixed, sign, a - 0.04, a + 0.04, z0, z1, FRAME_OUT, -FRAME_OUT + 0.08, 1)

    def storefront(self, bm, space, axis, fixed, lo, hi, sign, z, height):
        """Street level: glazing between timber fins, as on Durant and Dana."""
        kind = space["kind"]
        if kind in {"stair", "storage", "service", "bathroom", "mechanical", "electrical"}:
            return  # timber-clad wall, no glazing
        fin = 0.6
        n = max(1, int((hi - lo) // 4.0))
        bay_w = (hi - lo) / n
        for k in range(n):
            a0 = lo + k * bay_w + (fin if k > 0 else 0.3)
            a1 = lo + (k + 1) * bay_w - (0.3 if k == n - 1 else 0.0)
            self.curtain(bm, axis, fixed, a0, a1, sign, z + SLAB + 0.05, z + height - 0.55, bay=2.0)
            if k > 0:
                self._wall_box(bm, axis, fixed, sign, lo + k * bay_w, lo + k * bay_w + fin, z + SLAB, z + height - 0.5,
                               0.12, 0.0, 4)

    def build_doors(self):
        m = self.mats
        bm = bmesh.new()
        for o in self.spec["openings"]:
            if o["b"] != "outside":
                continue
            lv = self.levels[o["level"]]
            z = lv["elevation"] + SLAB
            w = max(o["width"], 1.2)
            self._cut_level = lv["id"]
            fixed = o["y"] if o["axis"] == "x" else o["x"]
            centre = o["x"] if o["axis"] == "x" else o["y"]
            sign = -1 if fixed <= 1e-6 else +1
            self._cut(o["axis"], fixed, sign, centre - w / 2 - 0.12, centre + w / 2 + 0.12, z, z + 2.75)
            if o["axis"] == "x":
                add_box(bm, o["x"] - w / 2, o["x"] + w / 2, o["y"] - 0.3, o["y"] + 0.3, z, z + 2.6, 0)
                add_box(bm, o["x"] - w / 2 - 0.12, o["x"] + w / 2 + 0.12, o["y"] - 0.32, o["y"] + 0.32, z + 2.6, z + 2.75, 1)
                add_box(bm, o["x"] - w / 2 - 0.12, o["x"] - w / 2, o["y"] - 0.32, o["y"] + 0.32, z, z + 2.6, 1)
                add_box(bm, o["x"] + w / 2, o["x"] + w / 2 + 0.12, o["y"] - 0.32, o["y"] + 0.32, z, z + 2.6, 1)
            else:
                add_box(bm, o["x"] - 0.3, o["x"] + 0.3, o["y"] - w / 2, o["y"] + w / 2, z, z + 2.6, 0)
                add_box(bm, o["x"] - 0.32, o["x"] + 0.32, o["y"] - w / 2 - 0.12, o["y"] + w / 2 + 0.12, z + 2.6, z + 2.75, 1)
                add_box(bm, o["x"] - 0.32, o["x"] + 0.32, o["y"] - w / 2 - 0.12, o["y"] - w / 2, z, z + 2.6, 1)
                add_box(bm, o["x"] - 0.32, o["x"] + 0.32, o["y"] + w / 2, o["y"] + w / 2 + 0.12, z, z + 2.6, 1)
        mesh_object("street_doors", bm, [m["glass"], m["frame"]], self.col_shell, {"level": "L1", "level_index": 1})

    # -- interiors ----------------------------------------------------------------------

    def build_interiors(self):
        m = self.mats
        floor_mats = ["plank", "carpet", "tile", "stone", "rubber", "concrete", "steel"]
        fmi = {k: i for i, k in enumerate(floor_mats)}
        for lv in self.ordered:
            region = self.massing[lv["id"]]
            z_fin = lv["elevation"] + SLAB
            z_top = lv["elevation"] + lv["height"]
            spaces = [s for s in self.spaces_by_level.get(lv["id"], []) if not s["outdoor"]]
            # One floor tile per space, so the 3D view can tint a room from world state.
            for s in spaces:
                r = R.of(s["rect"])
                finish = FLOOR_BY_KIND.get(s["kind"], "concrete")
                bm = bmesh.new()
                add_box(bm, r.x0, r.x1, r.y0, r.y1, z_fin, z_fin + 0.02, 0)
                mesh_object(f"floor_{s['id']}", bm, [m[finish]], self.col_interior,
                            self._props(lv, space_id=s["id"], kind=s["kind"]))
            bm = bmesh.new()
            for axis, fixed, lo, hi in self.partitions(lv, spaces, region):
                if axis == "x":
                    add_box(bm, lo, hi, fixed - INT_WALL / 2, fixed + INT_WALL / 2, z_fin, z_top, 0)
                else:
                    add_box(bm, fixed - INT_WALL / 2, fixed + INT_WALL / 2, lo, hi, z_fin, z_top, 0)
            mesh_object(f"walls_{lv['id']}", bm, [m["paint"]], self.col_interior, self._props(lv))
            bm = bmesh.new()
            for s in spaces:
                self.furnish(bm, s, lv, region, z_fin + 0.02, z_top)
            if bm.faces:
                mesh_object(f"furniture_{lv['id']}", bm, [m[k] for k in FURN_MATS], self.col_interior, self._props(lv))
            else:
                bm.free()
        self.build_courtyards()
        self.build_plant()

    def partitions(self, lv, spaces, region):
        """Interior wall runs on each wall line: union of space edges minus exterior runs and doors."""
        lines = {}
        for s in spaces:
            r = R.of(s["rect"])
            for axis, fixed, lo, hi, sign in (("x", r.y0, r.x0, r.x1, -1), ("x", r.y1, r.x0, r.x1, +1),
                                               ("y", r.x0, r.y0, r.y1, -1), ("y", r.x1, r.y0, r.y1, +1)):
                mid = (lo + hi) / 2
                px, py = (mid, fixed + sign * 0.15) if axis == "x" else (fixed + sign * 0.15, mid)
                if not region.inside(px, py):
                    continue  # exterior: the ring covers it
                lines.setdefault((axis, round(fixed, 3)), []).append((lo, hi))
        gaps = {}
        for o in self.spec["openings"]:
            if o["level"] != lv["id"] or o["b"] == "outside":
                continue
            fixed = o["y"] if o["axis"] == "x" else o["x"]
            c = o["x"] if o["axis"] == "x" else o["y"]
            gaps.setdefault((o["axis"], round(fixed, 3)), []).append((c - o["width"] / 2, c + o["width"] / 2))
        out = []
        for key, ivs in lines.items():
            axis, fixed = key
            for (lo, hi) in _merge_intervals(ivs):
                pieces = [(lo, hi)]
                for (g0, g1) in gaps.get(key, []):
                    nxt = []
                    for (a, b) in pieces:
                        if g1 <= a or g0 >= b:
                            nxt.append((a, b))
                        else:
                            if g0 > a:
                                nxt.append((a, g0))
                            if g1 < b:
                                nxt.append((g1, b))
                    pieces = nxt
                for (a, b) in pieces:
                    a2 = a + 0.2 if self._on_exterior(axis, fixed, a, region) else a
                    b2 = b - 0.2 if self._on_exterior(axis, fixed, b, region) else b
                    if b2 - a2 > 0.05:
                        out.append((axis, fixed, a2, b2))
        return out

    @staticmethod
    def _on_exterior(axis, fixed, end, region):
        for d in (-0.1, 0.1):
            px, py = (end + d, fixed) if axis == "x" else (fixed, end + d)
            if not region.inside(px, py):
                return True
        return False

    def furnish(self, bm, s, lv, region, z, z_top):
        kind = s["kind"]
        r = R.of(s["rect"])
        if kind == "room":
            self._furnish_room(bm, s, r, region, z)
        elif kind == "bathroom":
            self._stalls(bm, r, z)
        elif kind in ("lounge", "study", "office"):
            self._lounge(bm, r, z, sofas=(kind == "lounge"), colour=FM["blue"] if kind != "office" else FM["dark"], region=region)
        elif kind == "kitchen":
            self._kitchen(bm, r, z)
        elif kind == "laundry":
            self._washers(bm, r, z)
        elif kind == "lobby":
            add_box(bm, r.x0 + 2.0, r.x0 + 6.0, r.y0 + 3.0, r.y0 + 3.9, z, z + 1.1, FM["desk_wood"])
            self._sofa(bm, r.x0 + 8.0, r.y0 + 2.0, "x", z, FM["red"])
            self._sofa(bm, r.x0 + 8.0, r.y0 + 5.5, "x", z, FM["red"])
            add_box(bm, r.x0 + 0.4, r.x0 + 0.46, r.y0 + 2.0, r.y0 + 8.0, z, z + 3.0, FM["desk_wood"])
        elif kind == "retail":
            for k in range(int(r.w // 3.0)):
                x = r.x0 + 1.5 + k * 3.0
                add_box(bm, x, x + 1.0, r.y0 + 1.5, r.y1 - 1.5, z, z + 1.6, FM["laminate"])
        elif kind == "amenity":
            self._amenity(bm, s, r, z, region)
        elif kind == "stair":
            self._stair(bm, r, z, z_top)
        elif kind == "lift":
            add_box(bm, r.x0 + 0.3, r.x1 - 0.3, r.y0 + 0.3, r.y1 - 0.3, z, z + 2.4, FM["steel"])
        elif kind in ("storage", "service"):
            add_box(bm, r.x0 + 0.1, r.x0 + 0.6, r.y0 + 0.3, r.y1 - 0.3, z, z + 2.0, FM["steel"])
            if r.w > 3:
                add_box(bm, r.x1 - 0.6, r.x1 - 0.1, r.y0 + 0.3, r.y1 - 0.3, z, z + 2.0, FM["steel"])
        elif kind == "mechanical":
            add_cyl(bm, r.x0 + 0.5, r.cy, z, z_top - 0.4, 0.08, FM["steel"])
            add_box(bm, r.x0 + 0.2, r.x1 - 0.2, r.cy - 0.1, r.cy + 0.1, z_top - 0.5, z_top - 0.3, FM["steel"])

    def _furnish_room(self, bm, s, r, region, z):
        along_y = r.h >= r.w
        u0, u1 = (r.y0, r.y1) if along_y else (r.x0, r.x1)
        v0, v1 = (r.x0, r.x1) if along_y else (r.y0, r.y1)
        probe_hi = (r.cx, u1 + 0.15) if along_y else (u1 + 0.15, r.cy)
        win_hi = not region.inside(*probe_hi)
        vc = (v0 + v1) / 2

        def box(ua, ub, va, vb, za, zb, mi):
            if not win_hi:
                ua, ub = u0 + (u1 - ub), u0 + (u1 - ua)
            if along_y:
                add_box(bm, va, vb, ua, ub, za, zb, mi)
            else:
                add_box(bm, ua, ub, va, vb, za, zb, mi)

        beds = max(1, min(2, s["capacity"]))
        sides = [(v0 + 0.12, v0 + 1.07, True)] + ([(v1 - 1.07, v1 - 0.12, False)] if beds == 2 else [])
        for (va, vb, left) in sides:
            box(u1 - 2.15, u1 - 0.15, va, vb, z, z + 0.42, FM["laminate"])
            box(u1 - 2.1, u1 - 0.2, va + 0.03, vb - 0.03, z + 0.42, z + 0.62, FM["navy"])
            da, db = (va, va + 0.6) if left else (vb - 0.6, vb)
            box(u1 - 3.7, u1 - 2.4, da, db, z, z + 0.76, FM["laminate"])
            cu = u1 - 3.05
            cv = va + 0.95 if left else vb - 0.95
            box(cu - 0.22, cu + 0.22, cv - 0.22, cv + 0.22, z + 0.42, z + 0.47, FM["dark"])
            back = (cv - 0.22, cv - 0.17) if left else (cv + 0.17, cv + 0.22)
            box(cu - 0.22, cu + 0.22, back[0], back[1], z + 0.47, z + 0.9, FM["dark"])
            box(u0 + 0.12, u0 + 0.72, va, vb, z, z + 2.0, FM["laminate"])
        del vc

    def _stalls(self, bm, r, z):
        along_y = r.h >= r.w
        n = int(max(1, (r.h if along_y else r.w) // 1.4))
        for k in range(n):
            if along_y:
                y = r.y0 + 0.3 + k * 1.4
                add_box(bm, r.x0 + 0.1, r.x0 + 1.5, y, y + 0.05, z, z + 2.1, FM["laminate"])
                add_box(bm, r.x1 - 1.5, r.x1 - 0.1, y, y + 0.05, z, z + 2.1, FM["laminate"])
            else:
                x = r.x0 + 0.3 + k * 1.4
                add_box(bm, x, x + 0.05, r.y0 + 0.1, r.y0 + 1.5, z, z + 2.1, FM["laminate"])
                add_box(bm, x, x + 0.05, r.y1 - 1.5, r.y1 - 0.1, z, z + 2.1, FM["laminate"])
        if along_y:
            add_box(bm, r.cx - 0.3, r.cx + 0.3, r.y0 + 0.5, r.y1 - 0.5, z + 0.8, z + 0.9, FM["laminate"])
        else:
            add_box(bm, r.x0 + 0.5, r.x1 - 0.5, r.cy - 0.3, r.cy + 0.3, z + 0.8, z + 0.9, FM["laminate"])

    def _sofa(self, bm, x, y, axis, z, mi):
        if axis == "x":
            add_box(bm, x, x + 2.0, y, y + 0.9, z, z + 0.45, mi)
            add_box(bm, x, x + 2.0, y, y + 0.25, z + 0.45, z + 0.85, mi)
        else:
            add_box(bm, x, x + 0.9, y, y + 2.0, z, z + 0.45, mi)
            add_box(bm, x, x + 0.25, y, y + 2.0, z + 0.45, z + 0.85, mi)

    def _table(self, bm, x, y, z, radius=0.45, mi=FM["desk_wood"]):
        add_cyl(bm, x, y, z, z + 0.72, 0.04, FM["steel"], 8)
        add_cyl(bm, x, y, z + 0.72, z + 0.75, radius, mi, 16)
        for (dx, dy) in ((0.7, 0), (-0.7, 0), (0, 0.7), (0, -0.7)):
            add_box(bm, x + dx - 0.2, x + dx + 0.2, y + dy - 0.2, y + dy + 0.2, z + 0.42, z + 0.46, FM["dark"])

    def _lounge(self, bm, r, z, sofas=True, colour=FM["blue"], region=None):
        nx, ny = max(1, int(r.w // 2.6)), max(1, int(r.h // 2.6))
        for i in range(nx):
            for j in range(ny):
                x = r.x0 + 1.3 + i * (r.w - 2.6) / (nx - 1) if nx > 1 else r.cx
                y = r.y0 + 1.3 + j * (r.h - 2.6) / (ny - 1) if ny > 1 else r.cy
                if sofas and (i + j) % 2 == 0:
                    self._sofa(bm, x - 1.0, y - 0.45, "x", z, colour if (i % 2 == 0) else FM["purple"])
                else:
                    self._table(bm, x, y, z)
        # Lime accent on a wall that faces another room, so it never shows through exterior glass.
        sides = [("x", r.x0, -1), ("x", r.x1, +1), ("y", r.y0, -1), ("y", r.y1, +1)]
        for axis, fixed, sign in sides:
            px, py = (fixed + sign * 0.15, r.cy) if axis == "x" else (r.cx, fixed + sign * 0.15)
            if region is None or region.inside(px, py):
                if axis == "x":
                    add_box(bm, fixed - sign * 0.10, fixed - sign * 0.08, r.y0 + 0.5, r.y1 - 0.5, z, z + 2.2, FM["lime"])
                else:
                    add_box(bm, r.x0 + 0.5, r.x1 - 0.5, fixed - sign * 0.10, fixed - sign * 0.08, z, z + 2.2, FM["lime"])
                break

    def _kitchen(self, bm, r, z):
        if r.w >= r.h:
            add_box(bm, r.x0 + 0.1, r.x1 - 0.1, r.y1 - 0.72, r.y1 - 0.1, z, z + 0.9, FM["laminate"])
            add_box(bm, r.x0 + 0.1, r.x1 - 0.1, r.y1 - 0.74, r.y1 - 0.1, z + 0.9, z + 0.93, FM["dark"])
        else:
            add_box(bm, r.x1 - 0.72, r.x1 - 0.1, r.y0 + 0.1, r.y1 - 0.1, z, z + 0.9, FM["laminate"])
        self._table(bm, r.cx - 0.6, r.cy, z)
        self._sofa(bm, r.x0 + 0.5, r.y0 + 0.4, "x", z, FM["purple"])

    def _washers(self, bm, r, z):
        along_y = r.h >= r.w
        n = int(max(1, ((r.h if along_y else r.w) - 0.6) // 0.75))
        for k in range(n):
            if along_y:
                y = r.y0 + 0.3 + k * 0.75
                add_box(bm, r.x0 + 0.1, r.x0 + 0.8, y, y + 0.7, z, z + 1.0, FM["laminate"])
                add_box(bm, r.x0 + 0.1, r.x0 + 0.8, y, y + 0.7, z + 1.0, z + 1.1, FM["dark"])
            else:
                x = r.x0 + 0.3 + k * 0.75
                add_box(bm, x, x + 0.7, r.y0 + 0.1, r.y0 + 0.8, z, z + 1.0, FM["laminate"])

    def _amenity(self, bm, s, r, z, region=None):
        name = s["name"].lower()
        if "fitness" in name:
            for i in range(int(r.w // 3.0)):
                for j in range(int(r.h // 3.5)):
                    x, y = r.x0 + 1.5 + i * 3.0, r.y0 + 1.5 + j * 3.5
                    add_box(bm, x, x + 0.8, y, y + 1.9, z, z + 0.25, FM["dark"])
                    add_box(bm, x, x + 0.8, y + 1.5, y + 1.9, z + 0.25, z + 1.4, FM["steel"])
        elif "bike" in name:
            for k in range(int(r.h // 0.6)):
                y = r.y0 + 0.3 + k * 0.6
                add_box(bm, r.x0 + 0.3, r.x0 + 2.0, y, y + 0.05, z, z + 0.9, FM["steel"])
        else:
            self._lounge(bm, r, z, sofas=True, colour=FM["blue"], region=region)

    def _stair(self, bm, r, z, z_top):
        rise = z_top - z
        steps = 8
        along_y = r.h >= r.w
        if along_y:
            run = (r.h - 1.6) / steps
            half = (r.x1 - r.x0) / 2 - 0.05
            for k in range(steps):
                y = r.y0 + 0.2 + k * run
                zk = z + rise / 2 * k / steps
                add_box(bm, r.x0 + 0.05, r.x0 + half, y, y + run, zk, zk + rise / (2 * steps) + 0.02, FM["concrete"])
                yk = r.y1 - 0.2 - (k + 1) * run
                zk2 = z + rise / 2 + rise / 2 * k / steps
                add_box(bm, r.x1 - half, r.x1 - 0.05, yk, yk + run, zk2, zk2 + rise / (2 * steps) + 0.02, FM["concrete"])
            add_box(bm, r.x0 + 0.05, r.x1 - 0.05, r.y1 - 1.4, r.y1 - 0.05, z + rise / 2 - 0.1, z + rise / 2, FM["concrete"])
        else:
            run = (r.w - 1.6) / steps
            half = (r.y1 - r.y0) / 2 - 0.05
            for k in range(steps):
                x = r.x0 + 0.2 + k * run
                zk = z + rise / 2 * k / steps
                add_box(bm, x, x + run, r.y0 + 0.05, r.y0 + half, zk, zk + rise / (2 * steps) + 0.02, FM["concrete"])
                xk = r.x1 - 0.2 - (k + 1) * run
                zk2 = z + rise / 2 + rise / 2 * k / steps
                add_box(bm, xk, xk + run, r.y1 - half, r.y1 - 0.05, zk2, zk2 + rise / (2 * steps) + 0.02, FM["concrete"])
            add_box(bm, r.x1 - 1.4, r.x1 - 0.05, r.y0 + 0.05, r.y1 - 0.05, z + rise / 2 - 0.1, z + rise / 2, FM["concrete"])

    def build_courtyards(self):
        m = self.mats
        for s in self.spaces_by_level.get("L1", []):
            if not s["outdoor"]:
                continue
            r = R.of(s["rect"])
            lv = self.levels["L1"]
            z = lv["elevation"] + SLAB
            bm = bmesh.new()
            add_box(bm, r.x0, r.x1, r.y0, r.y1, z - 0.2, z + 0.02, 0)
            mesh_object(f"court_{s['id']}", bm, [m["gravel"]], self.col_interior, self._props(lv))
            bm = bmesh.new()
            soil = bmesh.new()
            plants = bmesh.new()
            for (x, y, w, h) in ((r.x0 + 2.5, r.y0 + 3.0, 5.0, 2.2), (r.x1 - 7.5, r.y0 + 3.0, 5.0, 2.2),
                                 (r.x0 + 2.5, r.y1 - 5.2, 5.0, 2.2), (r.x1 - 7.5, r.y1 - 5.2, 5.0, 2.2),
                                 (r.cx - 2.5, r.cy - 1.1, 5.0, 2.2)):
                add_box(bm, x, x + w, y, y + h, z, z + 0.6, 0)
                add_box(soil, x + 0.08, x + w - 0.08, y + 0.08, y + h - 0.08, z + 0.5, z + 0.58, 0)
                for k in range(4):
                    self._tree(plants, x + 0.7 + k * (w - 1.4) / 3, y + h / 2, z + 0.58, height=1.6, radius=0.55)
            mesh_object(f"court_planters_{s['id']}", bm, [m["concrete"]], self.col_interior, self._props(lv))
            mesh_object(f"court_soil_{s['id']}", soil, [m["soil"]], self.col_interior, self._props(lv))
            mesh_object(f"court_plants_{s['id']}", plants, [m["trunk"], m["canopy"]], self.col_interior, self._props(lv))
            bm = bmesh.new()
            self._tree(bm, r.x0 + 4.0, r.cy, z + 0.02, height=6.5, radius=2.4)
            self._tree(bm, r.x1 - 4.0, r.cy, z + 0.02, height=6.0, radius=2.2)
            mesh_object(f"court_trees_{s['id']}", bm, [m["trunk"], m["canopy"]], self.col_interior, self._props(lv))

    def build_plant(self):
        """Every equipment item in the spec as its own object, so state can light it up."""
        m = self.mats
        mats = [m["switchgear"], m["dark"], m["pipe"], m["generator"], m["pipe_blue"], m["led"], m["laminate"]]
        for e in self.spec["equipment"]:
            lv = self.levels[e["level"]]
            z = lv["elevation"] + SLAB + 0.02
            x, y, kind = e["x"], e["y"], e["kind"]
            bm = bmesh.new()
            if kind in ("switchboard", "switchboard_section"):
                pad = 0.3 if (e.get("flood_height") or 0) >= 0.3 else 0.1
                add_box(bm, x - 0.45, x + 0.45, y - 0.5, y + 0.5, z, z + pad, 1)
                add_box(bm, x - 0.45, x + 0.45, y - 0.45, y + 0.45, z + pad, z + pad + 2.2, 0)
                add_box(bm, x - 0.35, x + 0.35, y - 0.47, y - 0.45, z + pad + 0.9, z + pad + 1.7, 1)
            elif kind == "transfer_switch":
                add_box(bm, x - 0.4, x + 0.4, y - 0.3, y + 0.3, z, z + 0.1, 1)
                add_box(bm, x - 0.4, x + 0.4, y - 0.25, y + 0.25, z + 0.1, z + 1.9, 0)
            elif kind == "generator":
                add_box(bm, x - 1.0, x + 1.0, y - 2.2, y + 2.2, z, z + 0.3, 1)
                add_box(bm, x - 0.9, x + 0.9, y - 2.0, y + 2.0, z + 0.3, z + 2.0, 3)
                add_cyl(bm, x, y + 1.6, z + 2.0, z + 3.4, 0.12, 2)
            elif kind == "panel":
                add_box(bm, x - 0.3, x + 0.3, y - 0.08, y + 0.08, z + 1.0, z + 2.0, 0)
            elif kind == "elevator_controller":
                add_box(bm, x - 0.5, x + 0.5, y - 0.2, y + 0.2, z, z + 1.8, 0)
            elif kind == "pump":
                for dx in (-0.5, 0.5):
                    add_cyl(bm, x + dx, y, z, z + 0.9, 0.28, 2)
                    add_cyl(bm, x + dx, y, z + 0.9, z + 1.25, 0.22, 4)
                add_box(bm, x - 0.9, x + 0.9, y - 0.5, y + 0.5, z, z + 0.15, 1)
            elif kind == "sump_pump":
                add_box(bm, x - 0.6, x + 0.6, y - 0.6, y + 0.6, z - 0.02, z + 0.08, 1)
                add_cyl(bm, x, y, z + 0.08, z + 0.5, 0.2, 2)
            elif kind == "water_main":
                add_cyl(bm, x, y, z, z + 1.0, 0.09, 4)
                add_box(bm, x - 0.09, x + 0.09, y - 0.6, y + 0.6, z + 0.9, z + 1.08, 4)
            elif kind == "valve":
                add_box(bm, x - 0.2, x + 0.2, y - 0.2, y + 0.2, z + 0.8, z + 1.2, 1)
                add_cyl(bm, x, y, z + 1.2, z + 1.26, 0.25, 6, 20)
            elif kind == "water_riser":
                add_cyl(bm, x, y, z, lv["elevation"] + lv["height"], 0.06, 4)
                add_cyl(bm, x, y, z + 1.0, z + 1.3, 0.1, 1)
            elif kind == "water_heater":
                for dx in (-0.6, 0.6):
                    add_cyl(bm, x + dx, y, z, z + 2.0, 0.45, 0)
            elif kind == "fridge":
                add_box(bm, x - 0.4, x + 0.4, y - 0.38, y + 0.38, z, z + 1.85, 0)
            elif kind == "fire_alarm":
                add_box(bm, x - 0.25, x + 0.25, y - 0.08, y + 0.08, z + 1.2, z + 2.0, 6)
            elif kind == "emergency_lighting":
                add_box(bm, x - 0.3, x + 0.3, y - 0.1, y + 0.1, z + 1.3, z + 1.9, 0)
            elif kind == "sensor":
                add_box(bm, x - 0.06, x + 0.06, y - 0.04, y + 0.04, z, z + 0.05, 1)
                add_box(bm, x - 0.01, x + 0.01, y - 0.01, y + 0.01, z + 0.05, z + 0.07, 5)
            elif kind == "utility_feed":
                add_box(bm, x - 1.2, x + 1.2, y - 0.9, y + 0.9, 0.0, 1.3, 0)
            else:
                bm.free()
                continue
            fh = e.get("flood_height")
            mesh_object(f"eq_{e['id']}", bm, mats, self.col_plant,
                        self._props(lv, equipment_id=e["id"], kind=kind, space_id=e["space"],
                                    flood_height=fh if fh is not None else -1.0))

    # -- site ---------------------------------------------------------------------------

    def _tree(self, bm, x, y, z, height, radius):
        """A street tree: tapered trunk, a few leaning branches, a canopy of jittered leaf clumps."""
        import random
        rnd = random.Random(int(x * 73 + y * 131))
        wood = set()
        trunk_h = height * 0.42
        trunk = bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=radius * 0.11, radius2=radius * 0.07,
                                      depth=trunk_h)
        for v in trunk["verts"]:
            v.co += Vector((x, y, z + trunk_h / 2))
        wood |= set(trunk["verts"])
        for k in range(5):
            ang = rnd.uniform(0, 2 * math.pi)
            tilt = rnd.uniform(0.55, 0.95)
            length = radius * rnd.uniform(0.7, 1.1)
            br = bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=radius * 0.05, radius2=radius * 0.02,
                                       depth=length)
            d = Vector((math.cos(ang) * math.sin(tilt), math.sin(ang) * math.sin(tilt), math.cos(tilt)))
            rot = d.to_track_quat("Z", "Y").to_matrix()
            base = Vector((x, y, z + trunk_h * rnd.uniform(0.75, 1.0)))
            for v in br["verts"]:
                v.co = base + rot @ v.co + d * (length / 2)
            wood |= set(br["verts"])
        for f in bm.faces:
            if any(v in wood for v in f.verts):
                f.material_index = 0
        before = set(bm.faces)
        cz = z + trunk_h + radius * 0.55
        for k in range(14):
            u, vv = rnd.uniform(0, 2 * math.pi), rnd.uniform(-1, 1)
            rr = radius * rnd.uniform(0.25, 0.8)
            c = Vector((x + math.cos(u) * math.sqrt(1 - vv * vv) * rr, y + math.sin(u) * math.sqrt(1 - vv * vv) * rr,
                        cz + vv * rr * 0.8))
            ball = bmesh.ops.create_icosphere(bm, subdivisions=2, radius=radius * rnd.uniform(0.38, 0.55))
            squash = rnd.uniform(0.6, 0.85)
            for v in ball["verts"]:
                n = Vector((v.co.x, v.co.y, v.co.z * squash))
                n *= 1.0 + 0.12 * math.sin(n.x * 9 + n.y * 7) * math.cos(n.z * 11)
                v.co = c + n
        for f in bm.faces:
            if f not in before:
                f.material_index = 1
                f.smooth = True
            elif any(v in wood for v in f.verts):
                f.smooth = True

    def build_site(self):
        m = self.mats
        b = R(min(r.x0 for r in self.footprint), min(r.y0 for r in self.footprint),
              max(r.x1 for r in self.footprint), max(r.y1 for r in self.footprint))
        z = 0.0
        bm = bmesh.new()
        add_box(bm, b.x0 - SITE_PAD, b.x1 + SITE_PAD, b.y0 - SITE_PAD, b.y1 + SITE_PAD, z - 0.6, z - 0.2, 0)
        mesh_object("site_streets", bm, [m["asphalt"]], self.col_site)
        bm = bmesh.new()
        add_box(bm, b.x0 - 6000, b.x1 + 6000, b.y0 - 6000, b.y1 + 6000, z - 1.0, z - 0.62, 0)
        mesh_object("site_ground", bm, [m["ground"]], self.col_site)
        walk = 4.0
        bm = bmesh.new()
        add_box(bm, b.x0 - walk, b.x1 + walk, b.y0 - walk, b.y1 + walk, z - 0.2, z, 0)
        add_box(bm, b.x0 - SITE_PAD, b.x1 + SITE_PAD, b.y0 - SITE_PAD, b.y0 - SITE_PAD + walk, z - 0.2, z, 0)
        add_box(bm, b.x0 - SITE_PAD, b.x1 + SITE_PAD, b.y1 + SITE_PAD - walk, b.y1 + SITE_PAD, z - 0.2, z, 0)
        add_box(bm, b.x0 - SITE_PAD, b.x0 - SITE_PAD + walk, b.y0 - SITE_PAD, b.y1 + SITE_PAD, z - 0.2, z, 0)
        add_box(bm, b.x1 + SITE_PAD - walk, b.x1 + SITE_PAD, b.y0 - SITE_PAD, b.y1 + SITE_PAD, z - 0.2, z, 0)
        mesh_object("site_sidewalk", bm, [m["sidewalk"]], self.col_site)
        bm = bmesh.new()
        for k in range(8):
            add_box(bm, b.x0 - 2.5 + k * 1.2, b.x0 - 2.5 + k * 1.2 + 0.6, b.y0 - 16, b.y0 - 5, z - 0.199, z - 0.19, 0)
            add_box(bm, b.x0 - 16, b.x0 - 5, b.y0 - 2.5 + k * 1.2, b.y0 - 2.5 + k * 1.2 + 0.6, z - 0.199, z - 0.19, 0)
        for k in range(0, 150, 6):
            add_box(bm, b.x0 - 12.1, b.x0 - 11.9, b.y0 - SITE_PAD + k, b.y0 - SITE_PAD + k + 3, z - 0.199, z - 0.19, 0)
            add_box(bm, b.x0 - SITE_PAD + k, b.x0 - SITE_PAD + k + 3, b.y0 - 12.1, b.y0 - 11.9, z - 0.199, z - 0.19, 0)
        mesh_object("site_markings", bm, [m["laminate"]], self.col_site)
        bm = bmesh.new()
        for (x0, y0, x1, y1, h) in ((b.x1 + 14, 4, b.x1 + 34, 30, 9), (b.x1 + 14, 38, b.x1 + 30, 80, 12),
                                    (-30, 6, -14, 40, 7), (-30, 48, -14, 80, 10), (6, -34, 40, -14, 8),
                                    (10, b.y1 + 14, 44, b.y1 + 32, 11)):
            add_box(bm, x0, x1, y0, y1, z, z + h, 0)
        mesh_object("site_neighbours", bm, [m["neighbour"]], self.col_site)
        bm = bmesh.new()
        for y in range(8, int(b.y1) - 4, 12):
            self._tree(bm, b.x0 - 2.0, y, z, height=7.0, radius=2.4)
        for x in range(10, int(b.x1) - 4, 12):
            self._tree(bm, x, b.y0 - 2.0, z, height=7.0, radius=2.4)
            self._tree(bm, x, b.y1 + 2.0, z, height=7.0, radius=2.4)
        mesh_object("site_trees", bm, [m["trunk"], m["canopy"]], self.col_site)
        bm = bmesh.new()
        for (x, y) in ((b.x0 - 1.5, b.y0 - 1.5), (b.x1 + 1.5, b.y0 - 1.5), (b.x0 - 1.5, b.y1 + 1.5), (b.x0 - 1.5, 40)):
            add_cyl(bm, x, y, z, z + 7.0, 0.1, 0, 8)
            add_box(bm, x - 0.3, x + 0.3, y - 0.12, y + 0.12, z + 6.8, z + 7.0, 0)
        mesh_object("site_lampposts", bm, [m["metal"]], self.col_site)
        self.build_street_furniture(b)

    def build_street_furniture(self, b):
        m = self.mats
        z = 0.0
        # Building name on both street faces of the corner, like the real signage.
        for (loc, rot) in (((b.x0 + 9.0, b.y0 - 0.06, 4.05), (math.radians(90), 0, 0)),
                           ((b.x0 - 0.06, b.y0 + 15.5, 4.05), (math.radians(90), 0, math.radians(-90)))):
            curve = bpy.data.curves.new("sign", "FONT")
            curve.body = "DAVID BLACKWELL HALL"
            curve.size = 0.55
            curve.extrude = 0.025
            curve.align_x = "LEFT"
            ob = bpy.data.objects.new("site_sign", curve)
            ob.location = loc
            ob.rotation_euler = rot
            ob.data.materials.append(m["frame"])
            self.col_site.objects.link(ob)
        # Traffic signals on the near corners of the intersection, bike racks, benches, bins.
        bm = bmesh.new()
        for (x, y) in ((b.x0 - 6.0, b.y0 - 6.0), (b.x0 - 6.0, b.y0 - 30.0), (b.x0 - 30.0, b.y0 - 6.0)):
            add_cyl(bm, x, y, z, z + 5.5, 0.09, 0, 8)
            add_box(bm, x - 0.3, x + 0.3, y - 0.3, y + 0.3, z + 2.6, z + 3.5, 1)
            add_box(bm, x, x + 4.0, y - 0.08, y + 0.08, z + 5.3, z + 5.45, 0)
            add_box(bm, x + 3.6, x + 3.95, y - 0.2, y + 0.2, z + 4.3, z + 5.3, 1)
        for k in range(4):
            x = b.x0 - 2.4
            y = b.y0 + 26 + k * 1.0
            add_cyl(bm, x - 0.35, y, z, z + 0.75, 0.025, 0, 6)
            add_cyl(bm, x + 0.35, y, z, z + 0.75, 0.025, 0, 6)
            add_box(bm, x - 0.37, x + 0.37, y - 0.025, y + 0.025, z + 0.72, z + 0.78, 0)
        for (x, y, ax) in ((b.x0 - 2.6, 46.0, "y"), (18.0, b.y0 - 2.6, "x"), (b.x0 - 2.6, 62.0, "y")):
            if ax == "y":
                add_box(bm, x - 0.25, x + 0.25, y - 0.9, y + 0.9, z + 0.42, z + 0.47, 2)
                add_box(bm, x - 0.25, x - 0.18, y - 0.9, y + 0.9, z + 0.47, z + 0.85, 2)
                for yy in (y - 0.8, y + 0.8):
                    add_box(bm, x - 0.22, x + 0.22, yy - 0.04, yy + 0.04, z, z + 0.42, 1)
            else:
                add_box(bm, x - 0.9, x + 0.9, y - 0.25, y + 0.25, z + 0.42, z + 0.47, 2)
                add_box(bm, x - 0.9, x + 0.9, y - 0.25, y - 0.18, z + 0.47, z + 0.85, 2)
                for xx in (x - 0.8, x + 0.8):
                    add_box(bm, xx - 0.04, xx + 0.04, y - 0.22, y + 0.22, z, z + 0.42, 1)
        for (x, y) in ((b.x0 - 2.0, b.y0 + 2.5), (b.x0 + 30.0, b.y0 - 2.0), (b.x0 - 2.0, b.y1 - 3.0)):
            add_cyl(bm, x, y, z, z + 0.95, 0.3, 1, 12)
            add_cyl(bm, x, y, z + 0.95, z + 1.0, 0.33, 1, 12)
        mesh_object("site_furniture", bm, [m["metal"], m["dark"], m["deck"]], self.col_site)
        # Curb stones: a slightly darker lip along the sidewalk edge.
        bm = bmesh.new()
        add_box(bm, b.x0 - 4.0, b.x1 + 4.0, b.y0 - 4.0, b.y0 - 3.85, z - 0.2, z + 0.005, 0)
        add_box(bm, b.x0 - 4.0, b.x0 - 3.85, b.y0 - 4.0, b.y1 + 4.0, z - 0.2, z + 0.005, 0)
        add_box(bm, b.x0 - 4.0, b.x1 + 4.0, b.y1 + 3.85, b.y1 + 4.0, z - 0.2, z + 0.005, 0)
        add_box(bm, b.x1 + 3.85, b.x1 + 4.0, b.y0 - 4.0, b.y1 + 4.0, z - 0.2, z + 0.005, 0)
        mesh_object("site_curbs", bm, [m["concrete"]], self.col_site)

    # -- scene --------------------------------------------------------------------------

    def build_scene(self):
        scene = bpy.context.scene
        b = R(min(r.x0 for r in self.footprint), min(r.y0 for r in self.footprint),
              max(r.x1 for r in self.footprint), max(r.y1 for r in self.footprint))

        def camera(name, loc, target, lens):
            cam_data = bpy.data.cameras.new(name)
            cam_data.lens = lens
            cam_data.clip_end = 20000.0
            cam = bpy.data.objects.new(name, cam_data)
            scene.collection.objects.link(cam)
            cam.location = Vector(loc)
            cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
            return cam

        hero = camera("HeroCam", (b.x0 - 48, b.y0 - 54, 30), ((b.x0 + b.x1) / 2 - 4, (b.y0 + b.y1) / 2 - 10, self.roof_z * 0.45), 32)
        camera("StreetCam", (b.x0 - 15, b.y0 - 19, 2.4), (b.x0 + 9, b.y0 + 12, 9.5), 20)
        camera("CutawayCam", (b.x0 - 58, b.y0 - 36, 78), ((b.x0 + b.x1) / 2 - 2, (b.y0 + b.y1) / 2 - 2, 6), 35)
        camera("PlantCam", (b.x0 - 4, b.y0 - 10, 11), (b.x0 + 20, b.y0 + 20, -3.5), 28)
        # A flat world for below-grade cutaways (the sky is black under the horizon).
        flat = bpy.data.worlds.get("World Flat") or bpy.data.worlds.new("World Flat")
        flat.use_nodes = True
        fbg = next((n for n in flat.node_tree.nodes if n.type == "BACKGROUND"), None)
        if fbg:
            fbg.inputs[0].default_value = (0.55, 0.60, 0.66, 1.0)
            fbg.inputs[1].default_value = 0.9
        scene.camera = hero
        sun_data = bpy.data.lights.new("Sun", "SUN")
        sun_data.energy = 5.5
        sun_data.angle = math.radians(1.5)
        sun_data.color = (1.0, 0.96, 0.9)
        sun = bpy.data.objects.new("Sun", sun_data)
        scene.collection.objects.link(sun)
        sun.rotation_euler = (math.radians(42), 0, math.radians(-40))
        world = scene.world or bpy.data.worlds.new("World")
        scene.world = world
        world.use_nodes = True
        bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
        if bg:
            # Start from a clean world tree: repeated builds must not pile up sky nodes.
            for n in list(world.node_tree.nodes):
                if n.type == "TEX_SKY":
                    world.node_tree.nodes.remove(n)
            sky = world.node_tree.nodes.new("ShaderNodeTexSky")
            models = [i.identifier for i in sky.bl_rna.properties["sky_type"].enum_items]
            # Hosek-Wilkie renders black in EEVEE on Blender 5.2; the physical multiple-scattering sky works.
            sky.sky_type = next((mm for mm in ("MULTIPLE_SCATTERING", "NISHITA") if mm in models), models[0])
            if hasattr(sky, "sun_intensity"):
                sky.sun_intensity = 0.0
                sky.sun_elevation = math.radians(48)
                sky.sun_rotation = math.radians(230)
            if hasattr(sky, "sun_disc"):
                sky.sun_disc = False
            bg.inputs[1].default_value = 0.03
            world.node_tree.links.new(sky.outputs[0], bg.inputs[0])
        scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
        try:
            scene.view_settings.view_transform = "AgX"
            scene.view_settings.look = "AgX - Medium High Contrast"
        except TypeError:
            pass
        for attr, val in (("use_raytracing", True), ("use_shadows", True), ("use_gtao", True),
                          ("taa_render_samples", 64)):
            if hasattr(scene.eevee, attr):
                setattr(scene.eevee, attr, val)
        try:
            scene.render.engine = "BLENDER_EEVEE_NEXT"
        except TypeError:
            try:
                scene.render.engine = "BLENDER_EEVEE"
            except TypeError:
                pass
        self.build_compositor()

    def build_compositor(self):
        """Camera-like finishing: a touch of bloom and chromatic aberration."""
        scene = bpy.context.scene
        try:
            if hasattr(scene, "compositing_node_group"):      # Blender 5.x: the compositor is a node group
                nt = bpy.data.node_groups.get("HAVEN compositor")
                if nt is None:
                    nt = bpy.data.node_groups.new("HAVEN compositor", "CompositorNodeTree")
                for n in list(nt.nodes):
                    nt.nodes.remove(n)
                for item in list(nt.interface.items_tree):
                    nt.interface.remove(item)
                nt.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
                comp = nt.nodes.new("NodeGroupOutput")
                scene.compositing_node_group = None      # attach only after the tree is complete
            else:                                              # Blender 4.x
                scene.use_nodes = True
                nt = scene.node_tree
                for n in list(nt.nodes):
                    nt.nodes.remove(n)
                comp = nt.nodes.new("CompositorNodeComposite")
            rl = nt.nodes.new("CompositorNodeRLayers")
            glare = nt.nodes.new("CompositorNodeGlare")
            if hasattr(glare, "glare_type"):                       # 4.x properties
                glare.glare_type = "FOG_GLOW"
                glare.threshold, glare.mix, glare.size = 1.2, -0.75, 7
            else:                                                  # 5.x: everything is a socket
                for key, val in (("Type", "Fog Glow"), ("Threshold", 1.2), ("Strength", 0.12), ("Size", 0.4)):
                    if key in glare.inputs:
                        try:
                            glare.inputs[key].default_value = val
                        except (TypeError, ValueError):
                            pass
            lens = nt.nodes.new("CompositorNodeLensdist")
            for key, val in (("Distortion", 0.0), ("Dispersion", 0.012), ("Fit", True)):
                if key in lens.inputs:
                    try:
                        lens.inputs[key].default_value = val
                    except (TypeError, ValueError):
                        pass
            if hasattr(lens, "use_fit"):
                lens.use_fit = True
            nt.links.new(rl.outputs["Image"], glare.inputs["Image"])
            nt.links.new(glare.outputs["Image"], lens.inputs["Image"])
            nt.links.new(lens.outputs["Image"], comp.inputs["Image"])
            if hasattr(scene, "compositing_node_group"):
                scene.compositing_node_group = nt
        except Exception as exc:  # compositor API differs between versions; never fail the build on it
            print("compositor skipped:", exc)

    def build(self):
        self.build_shell()
        self.build_facade()
        if self.with_interior:
            self.build_interiors()
        if self.with_site:
            self.build_site()
        self.build_scene()


# ---- helpers --------------------------------------------------------------------------------


def _merge_intervals(ivs):
    ivs = sorted(ivs)
    out = []
    for lo, hi in ivs:
        if out and lo <= out[-1][1] + 1e-6:
            out[-1] = (out[-1][0], max(out[-1][1], hi))
        else:
            out.append((lo, hi))
    return out


def _merge_segments(segs):
    groups = {}
    for axis, fixed, lo, hi, sign in segs:
        groups.setdefault((axis, round(fixed, 4), sign), []).append((lo, hi))
    out = []
    for (axis, fixed, sign), ivs in groups.items():
        for lo, hi in _merge_intervals(ivs):
            out.append((axis, fixed, lo, hi, sign))
    return out


# ---- entry points ---------------------------------------------------------------------------


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for col in list(bpy.data.collections):
        bpy.data.collections.remove(col)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for datablock in list(block):
            if datablock.users == 0:
                block.remove(datablock)


def use_cycles(samples=128):
    """Path-traced stills: GPU when one is configured, denoised, a few minutes per frame on CPU."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.get_devices()
        for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
            try:
                prefs.compute_device_type = kind
            except TypeError:
                continue
            gpus = [d for d in prefs.devices if d.type != "CPU"]
            if gpus:
                for d in prefs.devices:
                    d.use = True
                scene.cycles.device = "GPU"
                print("cycles on", kind, [d.name for d in gpus])
                break
    except Exception as exc:
        print("cycles GPU not configured, using CPU:", exc)


def export_glb(path, collections=("Shell", "Windows")):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    bevels = []
    for name in collections:
        for ob in bpy.data.collections[name].all_objects:
            ob.select_set(True)
            for mod in ob.modifiers:
                if mod.type == "BEVEL" and mod.show_viewport:
                    mod.show_viewport = False        # render-only polish; keeps the GLB small
                    bevels.append(mod)
    try:
        bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True,
                                  export_apply=True, export_yup=True, export_extras=True,
                                  export_materials="EXPORT")
    finally:
        for mod in bevels:
            mod.show_viewport = True
    print(f"wrote {path}")


def render(path, camera="HeroCam"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    prev = scene.camera
    scene.camera = bpy.data.objects[camera]
    scene.render.filepath = str(path)
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    scene.camera = prev
    print(f"rendered {path}")


def cutaway(level_id, spec_levels):
    """Hide everything above a level (and the site, below grade) so a render looks down into it."""
    target = next(lv["index"] for lv in spec_levels if lv["id"] == level_id)
    hidden = []
    for ob in bpy.data.objects:
        idx = ob.get("level_index")
        above = idx is not None and idx > target
        site = ob.name.startswith("site_") and target < 1
        if above or site:
            ob.hide_render = True
            hidden.append(ob)
    scene = bpy.context.scene
    world = scene.world
    if target < 1 and bpy.data.worlds.get("World Flat"):
        scene.world = bpy.data.worlds["World Flat"]
    return hidden, world


def restore(state):
    hidden, world = state
    for ob in hidden:
        ob.hide_render = False
    bpy.context.scene.world = world


def main(argv=None):
    argv = list(argv) if argv is not None else (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    opts = {"glb": None, "glb-interior": None, "render": None, "site": True, "interior": True, "blend": None,
            "cutaway": [], "engine": "eevee", "samples": 128}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--cutaway":
            opts["cutaway"].append(argv[i + 1])
            i += 2
        elif a in ("--glb", "--glb-interior", "--render", "--blend", "--engine"):
            opts[a[2:]] = argv[i + 1]
            i += 2
        elif a == "--samples":
            opts["samples"] = int(argv[i + 1])
            i += 2
        elif a == "--no-site":
            opts["site"] = False
            i += 1
        elif a == "--no-interior":
            opts["interior"] = False
            i += 1
        else:
            i += 1

    def resolve(p):
        return Path(p) if Path(p).is_absolute() else ROOT / p

    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    clear_scene()
    builder = Builder(spec, with_site=opts["site"], with_interior=opts["interior"])
    builder.build()
    n_win = len(bpy.data.collections["Windows"].objects)
    print(f"built {spec['name']}: {len(bpy.data.objects)} objects, {n_win} window groups, roof at {builder.roof_z} m")
    if opts["engine"].lower() == "cycles":
        use_cycles(opts["samples"])
    if opts["glb"]:
        export_glb(resolve(opts["glb"]))
    if opts["glb-interior"]:
        export_glb(resolve(opts["glb-interior"]), collections=("Interior", "Plant"))
    if opts["blend"]:
        p = resolve(opts["blend"])
        p.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(p))
    if opts["render"]:
        render(resolve(opts["render"]))
        render(resolve(opts["render"]).with_name("street.png"), camera="StreetCam")
    for level_id in opts["cutaway"]:
        state = cutaway(level_id, spec["levels"])
        below = next(lv["index"] for lv in spec["levels"] if lv["id"] == level_id) < 1
        render(ROOT / "blender" / "renders" / f"cutaway_{level_id}.png", camera="PlantCam" if below else "CutawayCam")
        restore(state)
    return builder


if __name__ == "__main__" or "HAVEN_ROOT" in globals():
    main(globals().get("HAVEN_ARGS"))
