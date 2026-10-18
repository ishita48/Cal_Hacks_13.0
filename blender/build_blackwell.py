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

Materials are procedural, so the scene renders fully textured with nothing downloaded. When
``blender/fetch_textures.py`` has run, scanned CC0 Poly Haven sets (albedo, roughness, normal) are layered
over the procedural shaders through box-projected UVs, and a partly cloudy sky HDRI lights the scene; those
image maps also travel into the GLBs. ``--no-textures`` keeps everything procedural.

Run headless (Store install exposes ``blender-launcher.exe``; a zip install exposes ``blender``):

    blender -b -P blender/build_blackwell.py -- --glb frontend/public/models/blackwell.glb \
        --glb-interior frontend/public/models/blackwell_interior.glb \
        --glb-furniture frontend/public/models/blackwell_furniture.glb --render blender/renders/hero.png \
        --cutaway L4 --cutaway L1 --cutaway B1 --blend blender/blackwell.blend

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
from mathutils import Matrix, Vector

# ---- locate the repo ------------------------------------------------------------------------

if "HAVEN_ROOT" in globals():
    ROOT = Path(globals()["HAVEN_ROOT"])
elif "__file__" in globals():
    ROOT = Path(__file__).resolve().parents[1]
else:
    ROOT = Path.cwd()
SPEC_PATH = ROOT / "shared" / "blackwell_hall.json"
TEX_DIR = ROOT / "blender" / "textures"                 # written by blender/fetch_textures.py (git-ignored)
TEXTURES_ON = True                                       # --no-textures turns the scanned layer off
BAKE_ON = False                                          # --bake: procedural materials -> textures for the GLBs
REBAKE = False                                           # --rebake: ignore the cached tiles
BAKE_DIR = TEX_DIR / "baked"
BAKED = {}                                               # source material -> baked twin (export swaps them)


def _manifest():
    p = TEX_DIR / "manifest.json"
    try:
        return json.loads(p.read_text(encoding="utf-8")) if TEXTURES_ON and p.exists() else {}
    except (OSError, ValueError):
        return {}

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
SITE_PAD = 20.0            # curb line of the building to the far face of the facing block

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


def add_disc(bm, x, y, z, radius, thickness, axis, mi=0, segments=20):
    """A thin disc whose normal points along `axis` ('x', 'y' or 'z')."""
    from mathutils import Matrix
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=thickness)
    rot = Matrix.Rotation(math.radians(90), 4, "Y" if axis == "x" else "X") if axis != "z" else Matrix.Identity(4)
    for v in res["verts"]:
        v.co = rot @ v.co + Vector((x, y, z))
    new_verts = set(res["verts"])
    for f in bm.faces:
        if any(v in new_verts for v in f.verts):
            f.material_index = mi


def add_bar(bm, p0, p1, radius, mi=0, segments=8):
    """A cylinder from p0 to p1 (handrails, pipes, conduit)."""
    a, b = Vector(p0), Vector(p1)
    d = b - a
    if d.length < 1e-4:
        return
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=d.length)
    rot = d.normalized().to_track_quat("Z", "Y").to_matrix()
    mid = (a + b) / 2
    for v in res["verts"]:
        v.co = mid + rot @ v.co
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


def _box_uvs(bm):
    """Box-project every face onto its dominant axis, in metres: image textures tile in world units and the
    same UVs go out in the GLBs. Faces of one box share seams at the edges, like a real cladding corner."""
    uv = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for lp in f.loops:
            c = lp.vert.co
            if ax == 0:
                lp[uv].uv = (c.y if n.x > 0 else -c.y, c.z)
            elif ax == 1:
                lp[uv].uv = (-c.x if n.y > 0 else c.x, c.z)
            else:
                lp[uv].uv = (c.x, c.y if n.z > 0 else -c.y)


def mesh_object(name, bm, materials, collection, props=None):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.normal_update()
    _box_uvs(bm)
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


def _image(path, srgb):
    img = bpy.data.images.load(str(path), check_existing=True)
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    return img


def _pbr_maps(nt, asset, size=None, rot=0.0):
    """Image texture nodes for a downloaded set, on the box UVs; None when the set is not on disk."""
    entry = _manifest().get("textures", {}).get(asset)
    if not entry or "diff" not in entry["files"]:
        return None
    sx, sy = size if size else entry["size"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.0 / sx, 1.0 / sy, 1.0)
    mp.inputs["Rotation"].default_value = (0.0, 0.0, math.radians(rot))
    nt.links.new(tc.outputs["UV"], mp.inputs["Vector"])
    out = {}
    for key, srgb in (("diff", True), ("rough", False), ("nor", False)):
        rel = entry["files"].get(key)
        if not rel:
            continue
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = _image(TEX_DIR / rel, srgb)
        node.interpolation = "Cubic" if key == "diff" else "Linear"
        nt.links.new(mp.outputs["Vector"], node.inputs["Vector"])
        out[key] = node
    return out


def _texture(mat, asset, mode="albedo", amount=0.6, size=None, rot=0.0, tint=None,
             normal_strength=1.0, rough_mul=1.0, rough_mix=0.7):
    """Layer a scanned set over a finished procedural material.

    ``albedo``: the scan's colour, modulated by the procedural large-scale variation (which hides the tile
    repeat) and an optional tint.  ``overlay``: keep the designed colour, add the scan's detail on top.
    Roughness comes from the scan; the normal map feeds the existing bump chain so fine grain and the
    procedural relief (panel joints, paver edges) both survive."""
    if mat is None or not mat.use_nodes:
        return mat
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None or any(n.type == "TEX_IMAGE" for n in nt.nodes):
        return mat
    maps = _pbr_maps(nt, asset, size, rot)
    if not maps:
        return mat

    def current(name):
        link = next((lk for lk in nt.links if lk.to_node == bsdf and lk.to_socket.name == name), None)
        return link.from_socket if link else None

    rgb = tuple(mat.diffuse_color)[:3]
    cur_col = current("Base Color")
    col = maps["diff"].outputs["Color"]
    if mode == "albedo":
        if tint is not None:
            m = nt.nodes.new("ShaderNodeMix")
            m.data_type = "RGBA"
            m.blend_type = "MULTIPLY"
            m.inputs["Factor"].default_value = 1.0
            nt.links.new(col, m.inputs[6])
            m.inputs[7].default_value = (*tint, 1.0)
            col = m.outputs[2]
        if cur_col is not None:
            # procedural colour / designed colour = a large-scale variation around 1, clamped
            div = nt.nodes.new("ShaderNodeVectorMath")
            div.operation = "DIVIDE"
            nt.links.new(cur_col, div.inputs[0])
            div.inputs[1].default_value = tuple(max(c, 0.02) for c in rgb)
            lo = nt.nodes.new("ShaderNodeVectorMath")
            lo.operation = "MAXIMUM"
            lo.inputs[1].default_value = (0.55, 0.55, 0.55)
            nt.links.new(div.outputs[0], lo.inputs[0])
            hi = nt.nodes.new("ShaderNodeVectorMath")
            hi.operation = "MINIMUM"
            hi.inputs[1].default_value = (1.45, 1.45, 1.45)
            nt.links.new(lo.outputs[0], hi.inputs[0])
            mul = nt.nodes.new("ShaderNodeVectorMath")
            mul.operation = "MULTIPLY"
            nt.links.new(col, mul.inputs[0])
            nt.links.new(hi.outputs[0], mul.inputs[1])
            col = mul.outputs[0]
    else:
        m = nt.nodes.new("ShaderNodeMix")
        m.data_type = "RGBA"
        m.blend_type = "OVERLAY"
        m.inputs["Factor"].default_value = amount
        if cur_col is not None:
            nt.links.new(cur_col, m.inputs[6])
        else:
            m.inputs[6].default_value = bsdf.inputs["Base Color"].default_value
        nt.links.new(col, m.inputs[7])
        col = m.outputs[2]
    nt.links.new(col, bsdf.inputs["Base Color"])

    if "rough" in maps:
        r = maps["rough"].outputs["Color"]
        if rough_mul != 1.0:
            mm = nt.nodes.new("ShaderNodeMath")
            mm.operation = "MULTIPLY"
            mm.inputs[1].default_value = rough_mul
            nt.links.new(r, mm.inputs[0])
            r = mm.outputs[0]
        cur_r = current("Roughness")
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "FLOAT"
        mix.inputs["Factor"].default_value = rough_mix if mode == "albedo" else rough_mix * 0.7
        if cur_r is not None:
            nt.links.new(cur_r, mix.inputs[2])
        else:
            mix.inputs[2].default_value = bsdf.inputs["Roughness"].default_value
        nt.links.new(r, mix.inputs[3])
        nt.links.new(mix.outputs[0], bsdf.inputs["Roughness"])

    if "nor" in maps and normal_strength > 0:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.space = "TANGENT"
        nm.uv_map = "UVMap"
        nm.inputs["Strength"].default_value = normal_strength
        nt.links.new(maps["nor"].outputs["Color"], nm.inputs["Color"])
        cur_n = current("Normal")
        if cur_n is not None and cur_n.node.type == "BUMP":
            nt.links.new(nm.outputs["Normal"], cur_n.node.inputs["Normal"])
        else:
            nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
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
    brick.offset = 0.5 if "brick" in name or "roof" in name else 0.0
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Brick Width"].default_value = tile
    brick.inputs["Row Height"].default_value = tile * (0.33 if "brick" in name else 1.0)
    brick.inputs["Mortar Size"].default_value = 0.004
    brick.inputs["Color1"].default_value = (*rgb, 1.0)
    brick.inputs["Color2"].default_value = (*(min(1.0, c * 1.06) for c in rgb), 1.0)
    brick.inputs["Mortar"].default_value = (*(c * 0.55 for c in rgb), 1.0)
    nt.links.new(tc.outputs["Object"], brick.inputs["Vector"])
    nt.links.new(brick.outputs["Color"], bsdf.inputs["Base Color"])
    _bump(nt, brick.outputs["Fac"], 0.3, 0.004, bsdf)
    return _finish(mat, bsdf, rgb, roughness)


def mat_far_facade(name, rgb, bay=3.6, storey=3.2):
    """Distant city blocks: wall colour with a grid of dark window rectangles, no geometry needed."""
    mat, bsdf = _new_mat(name)
    if bsdf is None:
        return mat
    nt = mat.node_tree
    vec, _ = _wall_coords(nt)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(vec, sep.inputs[0])

    def frac(sock, period):
        d = nt.nodes.new("ShaderNodeMath")
        d.operation = "DIVIDE"
        nt.links.new(sock, d.inputs[0])
        d.inputs[1].default_value = period
        f = nt.nodes.new("ShaderNodeMath")
        f.operation = "FRACT"
        nt.links.new(d.outputs[0], f.inputs[0])
        return f.outputs[0]

    def band(sock, lo, hi):
        a = nt.nodes.new("ShaderNodeMath")
        a.operation = "GREATER_THAN"
        nt.links.new(sock, a.inputs[0])
        a.inputs[1].default_value = lo
        b = nt.nodes.new("ShaderNodeMath")
        b.operation = "LESS_THAN"
        nt.links.new(sock, b.inputs[0])
        b.inputs[1].default_value = hi
        m = nt.nodes.new("ShaderNodeMath")
        m.operation = "MULTIPLY"
        nt.links.new(a.outputs[0], m.inputs[0])
        nt.links.new(b.outputs[0], m.inputs[1])
        return m.outputs[0]

    win = nt.nodes.new("ShaderNodeMath")
    win.operation = "MULTIPLY"
    nt.links.new(band(frac(sep.outputs["X"], bay), 0.22, 0.62), win.inputs[0])
    nt.links.new(band(frac(sep.outputs["Y"], storey), 0.30, 0.80), win.inputs[1])   # wall coords are (x + y, z)
    # not below 1 m (ground floor plinth) and never on roofs (faces whose normal is vertical)
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    nsep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Normal"], nsep.inputs[0])
    absz = nt.nodes.new("ShaderNodeMath")
    absz.operation = "ABSOLUTE"
    nt.links.new(nsep.outputs["Z"], absz.inputs[0])
    wall = nt.nodes.new("ShaderNodeMath")
    wall.operation = "LESS_THAN"
    nt.links.new(absz.outputs[0], wall.inputs[0])
    wall.inputs[1].default_value = 0.5
    mask = nt.nodes.new("ShaderNodeMath")
    mask.operation = "MULTIPLY"
    nt.links.new(win.outputs[0], mask.inputs[0])
    nt.links.new(wall.outputs[0], mask.inputs[1])
    n = _noise(nt, vec, 0.15, detail=2.0)
    tone = _ramp(nt, n.outputs["Fac"], [(0.3, tuple(c * 0.85 for c in rgb)), (0.7, tuple(min(1.0, c * 1.1) for c in rgb))])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    nt.links.new(mask.outputs[0], mix.inputs["Factor"])
    nt.links.new(tone.outputs["Color"], mix.inputs[6])
    mix.inputs[7].default_value = (0.05, 0.07, 0.09, 1.0)
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    rough = nt.nodes.new("ShaderNodeMix")
    rough.data_type = "FLOAT"
    nt.links.new(mask.outputs[0], rough.inputs["Factor"])
    rough.inputs[2].default_value = 0.9
    rough.inputs[3].default_value = 0.15
    nt.links.new(rough.outputs[0], bsdf.inputs["Roughness"])
    return _finish(mat, bsdf, rgb, 0.9)


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


# Scanned layer per material key (Poly Haven asset ids; see fetch_textures.py). Sizes in metres.
SCANS = {
    "panel_white": dict(asset="concrete_wall_008", mode="overlay", amount=0.35, normal_strength=0.25, size=(2.7, 2.7)),
    "ochre": dict(asset="concrete_wall_008", mode="overlay", amount=0.30, normal_strength=0.25, size=(2.7, 2.7)),
    "timber": dict(asset="wood_floor_deck", rot=90.0, tint=(1.0, 0.92, 0.82)),
    "soffit": dict(asset="wood_planks", tint=(1.05, 0.95, 0.85)),
    "deck": dict(asset="wood_floor_deck"),
    "concrete": dict(asset="concrete_wall_008"),
    "roof": dict(asset="concrete_floor_worn_001", mode="overlay", amount=0.5, normal_strength=0.5),
    "lawn": dict(asset="leafy_grass", mode="overlay", amount=0.65),   # the scan is dry-leafy; keep the green
    "gravel": dict(asset="gravel_floor_02"),
    "soil": dict(asset="brown_mud"),
    "paving": dict(asset="concrete_tiles_02"),
    "asphalt": dict(asset="asphalt_01"),
    "bike_lane": dict(asset="asphalt_01", mode="overlay", amount=0.6),
    "sidewalk": dict(asset="concrete_pavement"),
    "ground": dict(asset="asphalt_01", mode="overlay", amount=0.6),
    "neighbour": dict(asset="grey_plaster_02", mode="overlay", amount=0.5, size=(2.0, 2.0)),
    "trunk": dict(asset="bark_brown_02", size=(0.9, 0.9)),
    "paint": dict(asset="plastered_wall_05", mode="overlay", amount=0.3, normal_strength=0.3),
    "plank": dict(asset="laminate_floor_02"),
    "carpet": dict(asset="dirty_carpet", size=(1.2, 1.2), tint=(1.3, 1.3, 1.35)),
    "rug": dict(asset="dirty_carpet", size=(1.2, 1.2), tint=(1.1, 1.0, 1.1)),
    "tile": dict(asset="interior_tiles", tint=(1.1, 1.1, 1.08)),
    "stone": dict(asset="concrete_floor_worn_001", mode="overlay", amount=0.6, normal_strength=0.4),
    "rubber": dict(asset="rubber_tiles"),
    "desk_wood": dict(asset="wood_planks", size=(1.0, 1.0)),
    "slat": dict(asset="wood_planks", size=(1.0, 1.0)),
    "stucco_cream": dict(asset="grey_plaster_02", mode="overlay", amount=0.5, size=(2.0, 2.0)),
    "stucco_sage": dict(asset="grey_plaster_02", mode="overlay", amount=0.5, size=(2.0, 2.0)),
    "stucco_terracotta": dict(asset="grey_plaster_02", mode="overlay", amount=0.5, size=(2.0, 2.0)),
    "stucco_grey": dict(asset="grey_plaster_02", mode="overlay", amount=0.5, size=(2.0, 2.0)),
    "brick": dict(asset="red_brick_03"),
    "roof_tile": dict(asset="roof_tiles_14"),
}


def make_materials():
    mats = _base_materials()
    for key, mat in mats.items():
        if key.startswith("car_") and mat.use_nodes:     # car paint: clear coat over the colour
            bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf is not None:
                for name, val in (("Coat Weight", 1.0), ("Coat Roughness", 0.03)):
                    if name in bsdf.inputs:
                        bsdf.inputs[name].default_value = val
    for key, spec in SCANS.items():
        if key in mats:
            _texture(mats[key], **spec)
    return mats


def _base_materials():
    return {
        # exterior
        "panel_white": mat_panels("panel white", (0.76, 0.76, 0.68), roughness=0.78),
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
        "ground": mat_ground("ground", (0.17, 0.17, 0.175), scale=0.3, roughness=0.95),
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
        "white": mat_plain("white", (0.90, 0.90, 0.90), roughness=0.55),
        "cork": mat_plain("cork", (0.55, 0.38, 0.20), roughness=0.9, grain=0.3),
        "rug": mat_carpet("rug", (0.30, 0.28, 0.30)),
        "lightpanel": mat_plain("light panel", (1.0, 0.97, 0.9), roughness=0.4, emission=(1.0, 0.95, 0.85)),
        "amber": mat_plain("amber light", (1.0, 0.72, 0.18), roughness=0.4, emission=(1.0, 0.68, 0.12)),
        "slat": mat_wood("ceiling slats", (0.40, 0.24, 0.10), (0.72, 0.50, 0.26), board_w=0.06, vertical=False),
        "mirror": mat_plain("mirror", (0.92, 0.93, 0.95), roughness=0.02, metallic=1.0),
        "felt": mat_plain("pool felt", (0.05, 0.18, 0.48), roughness=1.0, grain=0.15),
        # neighbourhood
        "stucco_cream": mat_ground("stucco cream", (0.80, 0.74, 0.58), scale=6.0, roughness=0.9),
        "stucco_sage": mat_ground("stucco sage", (0.52, 0.58, 0.46), scale=6.0, roughness=0.9),
        "stucco_terracotta": mat_ground("stucco terracotta", (0.62, 0.36, 0.24), scale=6.0, roughness=0.9),
        "stucco_grey": mat_ground("stucco grey", (0.55, 0.55, 0.53), scale=6.0, roughness=0.9),
        "brick": mat_tiles("brick", (0.50, 0.24, 0.16), tile=0.22, roughness=0.85),
        "roof_tile": mat_tiles("roof tile", (0.42, 0.20, 0.14), tile=0.35, roughness=0.8),
        "awning_red": mat_plain("awning red", (0.55, 0.08, 0.08), roughness=0.9, grain=0.1),
        "awning_green": mat_plain("awning green", (0.08, 0.30, 0.14), roughness=0.9, grain=0.1),
        "awning_blue": mat_plain("awning blue", (0.08, 0.16, 0.40), roughness=0.9, grain=0.1),
        "bike_lane": mat_ground("bike lane", (0.10, 0.42, 0.22), scale=1.5, roughness=0.95),
        "far_cream": mat_far_facade("far cream", (0.66, 0.60, 0.47)),
        "far_white": mat_far_facade("far white", (0.68, 0.68, 0.64)),
        "far_grey": mat_far_facade("far grey", (0.42, 0.42, 0.40)),
        "far_brick": mat_far_facade("far brick", (0.40, 0.21, 0.15)),
        "far_sage": mat_far_facade("far sage", (0.42, 0.48, 0.37)),
        "far_tan": mat_far_facade("far tan", (0.54, 0.44, 0.32)),
        # people
        "skin_a": mat_plain("skin light", (0.80, 0.60, 0.48), roughness=0.55, grain=0.05),
        "skin_b": mat_plain("skin medium", (0.60, 0.42, 0.30), roughness=0.55, grain=0.05),
        "skin_c": mat_plain("skin dark", (0.36, 0.24, 0.17), roughness=0.55, grain=0.05),
        "hair": mat_plain("hair", (0.08, 0.06, 0.05), roughness=0.7),
        "jeans": mat_plain("jeans", (0.18, 0.24, 0.38), roughness=0.9, grain=0.15),
        "slacks": mat_plain("slacks", (0.20, 0.20, 0.22), roughness=0.9, grain=0.1),
        "shoe": mat_plain("shoe", (0.10, 0.10, 0.10), roughness=0.5),
        "shirt_white": mat_plain("shirt white", (0.85, 0.85, 0.85), roughness=0.9, grain=0.1),
        "shirt_navy": mat_plain("shirt navy", (0.10, 0.14, 0.32), roughness=0.9, grain=0.1),
        "shirt_red": mat_plain("shirt red", (0.60, 0.12, 0.10), roughness=0.9, grain=0.1),
        "shirt_green": mat_plain("shirt green", (0.15, 0.40, 0.22), roughness=0.9, grain=0.1),
        "shirt_yellow": mat_plain("shirt yellow", (0.85, 0.70, 0.20), roughness=0.9, grain=0.1),
        "shirt_grey": mat_plain("shirt grey", (0.50, 0.50, 0.52), roughness=0.9, grain=0.1),
        "car_white": mat_plain("car white", (0.85, 0.85, 0.84), roughness=0.2, metallic=0.1),
        "car_silver": mat_plain("car silver", (0.55, 0.56, 0.58), roughness=0.25, metallic=0.8),
        "car_black": mat_plain("car black", (0.03, 0.03, 0.035), roughness=0.2, metallic=0.3),
        "car_red": mat_plain("car red", (0.45, 0.04, 0.04), roughness=0.25, metallic=0.2),
        "car_blue": mat_plain("car blue", (0.05, 0.10, 0.30), roughness=0.25, metallic=0.4),
    }


# ---- baking: procedural materials -> mirrored tiles the GLBs can carry -----------------------

BAKE_SKIP = {"glass", "led", "lightpanel", "amber", "mirror"}
BAKE_TILE = {   # metres covered by one tile; multiples of the material's grid so mirrored repeat keeps it continuous
    "panel_white": (4.8, 4.65), "ochre": (4.8, 5.0), "timber": (4.2, 4.2), "soffit": (3.6, 3.6), "deck": (3.6, 3.6),
    "brick": (4.4, 4.4), "paving": (4.8, 4.8), "sidewalk": (4.5, 4.5), "tile": (4.5, 4.5), "stone": (4.5, 4.5),
    "roof_tile": (4.2, 4.2), "plank": (3.2, 3.2), "slat": (3.0, 3.0), "desk_wood": (3.0, 3.0), "neighbour": (6.0, 6.0),
}
BAKE_RES = {"panel_white": 2048, "ochre": 2048, "timber": 2048, "asphalt": 2048, "sidewalk": 2048, "concrete": 2048}


def _bake_tile_size(key):
    if key.startswith("far_"):
        return (7.2, 6.4)                       # two bays by two storeys of the window grid
    return BAKE_TILE.get(key, (4.0, 4.0))


def _baked_material(key, src, paths, tile):
    """A plain PBR twin of `src` fed by the baked tiles on the box UVs (metres), mirrored every tile."""
    name = f"{src.name} baked"
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    sb = next((n for n in src.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.0 / tile[0], 1.0 / tile[1], 1.0)
    nt.links.new(tc.outputs["UV"], mp.inputs["Vector"])
    for kind, socket in (("diff", "Base Color"), ("rough", "Roughness"), ("nor", "Normal")):
        path = paths.get(kind)
        if not path or not Path(path).exists():
            continue
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = bpy.data.images.load(str(path), check_existing=True)
        node.image.colorspace_settings.name = "sRGB" if kind == "diff" else "Non-Color"
        node.extension = "MIRROR"
        nt.links.new(mp.outputs["Vector"], node.inputs["Vector"])
        if kind == "nor":
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nm.uv_map = "UVMap"
            nt.links.new(node.outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        else:
            nt.links.new(node.outputs["Color"], bsdf.inputs[socket])
    if sb is not None:
        bsdf.inputs["Metallic"].default_value = sb.inputs["Metallic"].default_value
        for extra in ("Coat Weight", "Coat Roughness", "Sheen Weight", "Alpha"):
            if extra in sb.inputs and extra in bsdf.inputs:
                bsdf.inputs[extra].default_value = sb.inputs[extra].default_value
    mat.diffuse_color = src.diffuse_color
    for attr in ("surface_render_method", "blend_method"):
        if hasattr(src, attr):
            try:
                setattr(mat, attr, getattr(src, attr))
            except (AttributeError, TypeError):
                pass
    return mat


def bake_materials(mats):
    """Bake every procedural material once onto a wall-sized tile (colour, roughness, tangent normal) with
    Cycles at one sample, cache the PNGs in textures/baked/, and register a baked twin for export. Runs on
    an otherwise empty scene, so each bake syncs in a second."""
    scene = bpy.context.scene
    BAKE_DIR.mkdir(parents=True, exist_ok=True)
    todo = [(k, m) for k, m in mats.items() if k not in BAKE_SKIP and m.use_nodes]
    prev_engine = scene.render.engine
    col = bpy.data.collections.get("Bake") or bpy.data.collections.new("Bake")
    if col.name not in scene.collection.children:
        scene.collection.children.link(col)
    baked_now = 0
    try:
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 1
        scene.cycles.device = "CPU"
        scene.render.bake.margin = 8
        for key, mat in todo:
            tile = _bake_tile_size(key)
            res = BAKE_RES.get(key, 1024)
            paths = {kind: BAKE_DIR / f"{key}_{kind}.png" for kind in ("diff", "rough", "nor")}
            if REBAKE or not all(p.exists() for p in paths.values()):
                bm = bmesh.new()
                tw, th = tile
                vs = [bm.verts.new(c) for c in ((0, 0, 0), (tw, 0, 0), (tw, 0, th), (0, 0, th))]
                bm.faces.new(vs)                                # normal -y: box UV = (x, z), like a south wall
                ob = mesh_object(f"bake_{key}", bm, [mat], col)
                # Materials read the metre UVs ("UVMap", kept as the render UV); the bake target is a second,
                # normalised layer so the whole tile lands in the image.
                me = ob.data
                bake_uv = me.uv_layers.new(name="BakeUV")
                for li, loop in enumerate(me.loops):
                    co = me.vertices[loop.vertex_index].co
                    bake_uv.data[li].uv = (co.x / tw, co.z / th)
                me.uv_layers["UVMap"].active_render = True
                me.uv_layers.active = bake_uv
                bpy.ops.object.select_all(action="DESELECT")
                ob.select_set(True)
                bpy.context.view_layer.objects.active = ob
                nt = mat.node_tree
                for kind, btype, extra in (("diff", "DIFFUSE", {"pass_filter": {"COLOR"}}),
                                           ("rough", "ROUGHNESS", {}), ("nor", "NORMAL", {})):
                    r = res if kind == "diff" else max(512, res // 2)
                    img = bpy.data.images.new(f"bake_{key}_{kind}", r, r, alpha=False, is_data=(kind != "diff"))
                    node = nt.nodes.new("ShaderNodeTexImage")
                    node.image = img
                    nt.nodes.active = node
                    try:
                        bpy.ops.object.bake(type=btype, margin=8, use_clear=True, **extra)
                        img.filepath_raw = str(paths[kind])
                        img.file_format = "PNG"
                        img.save()
                    except Exception as exc:
                        print(f"bake {key} {kind} failed: {exc}")
                    nt.nodes.remove(node)
                    bpy.data.images.remove(img)
                bpy.data.objects.remove(ob, do_unlink=True)
                baked_now += 1
            BAKED[mat] = _baked_material(key, mat, paths, tile)
    finally:
        scene.render.engine = prev_engine
    print(f"baked {baked_now} materials, {len(BAKED)} baked twins ready in {BAKE_DIR}")


# ---- photoscanned props (Poly Haven models, fetched by fetch_textures.py) --------------------

MODEL_LOD = {"island_tree_02": 0.2, "tree_small_02": 0.12}     # decimate ratio for the million-triangle scans
MODEL_CENTRE = {"fire_hydrant", "shrub_02", "shrub_04", "covered_car", "modular_street_seating"}


class PropLibrary:
    """Each downloaded model is imported once (decimated and cached as <asset>_lod.blend beside its glTF) into
    an excluded `Library` collection; placements are collection instances, so thirty trees share one mesh."""

    def __init__(self):
        self.cols, self.bounds, self.root = {}, {}, None

    def get(self, asset):
        if asset in self.cols:
            return self.cols[asset]
        entry = _manifest().get("models", {}).get(asset)
        path = TEX_DIR / entry["gltf"] if entry else None
        if not path or not path.exists():
            self.cols[asset] = None
            return None
        try:
            objs = self._load(asset, path)
        except Exception as exc:
            print(f"prop {asset} failed to load: {exc}")
            self.cols[asset] = None
            return None
        if self.root is None:
            self.root = bpy.data.collections.new("Library")
            bpy.context.scene.collection.children.link(self.root)
        col = bpy.data.collections.new(f"lib_{asset}")
        self.root.children.link(col)
        lo = Vector((1e9, 1e9, 1e9))
        hi = Vector((-1e9, -1e9, -1e9))
        bpy.context.view_layer.update()      # appended objects have no world matrix until evaluated
        for ob in objs:
            for c in list(ob.users_collection):
                c.objects.unlink(ob)
            col.objects.link(ob)
            if ob.type == "MESH":
                for corner in ob.bound_box:
                    w = ob.matrix_world @ Vector(corner)
                    lo = Vector(map(min, lo, w))
                    hi = Vector(map(max, hi, w))
        if asset in MODEL_CENTRE:
            col.instance_offset = ((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z)
        try:
            bpy.context.view_layer.layer_collection.children["Library"].exclude = True
        except KeyError:
            pass
        self.cols[asset], self.bounds[asset] = col, (lo, hi)
        print(f"prop {asset}: {len(objs)} objects, {hi.z - lo.z:.2f} m tall")
        return col

    def height(self, asset):
        lo, hi = self.bounds[asset]
        return hi.z - lo.z

    def _load(self, asset, path):
        cache = path.with_name(f"{asset}_lod.blend")
        if cache.exists():
            with bpy.data.libraries.load(str(cache), link=False) as (src, dst):
                dst.objects = list(src.objects)
            objs = [o for o in dst.objects if o is not None]
            for o in objs:
                bpy.context.scene.collection.objects.link(o)
            return objs
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(path))
        fresh = [o for o in bpy.data.objects if o not in before]
        objs = [o for o in fresh if "_aged" not in o.name]        # the hydrant ships a fresh and an aged copy
        for o in fresh:
            if o not in objs:
                bpy.data.objects.remove(o, do_unlink=True)
        ratio = MODEL_LOD.get(asset)
        if ratio:
            for ob in objs:
                if ob.type != "MESH":
                    continue
                mod = ob.modifiers.new("lod", "DECIMATE")
                mod.ratio = ratio
                mod.use_collapse_triangulate = True
            dg = bpy.context.evaluated_depsgraph_get()
            for ob in objs:
                if ob.type != "MESH":
                    continue
                me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
                old = ob.data
                ob.modifiers.clear()
                ob.data = me
                me.name = old.name
                bpy.data.meshes.remove(old)
        for ob in objs:
            if ob.type != "MESH":
                continue
            for mat in ob.data.materials:
                if mat is None:
                    continue
                try:
                    mat.surface_render_method = "DITHERED"   # sorted blending breaks on leaf cards in EEVEE
                except AttributeError:
                    pass
                mat.use_backface_culling = False
        try:
            bpy.data.libraries.write(str(cache), set(objs), path_remap="ABSOLUTE")
        except Exception as exc:
            print(f"prop cache for {asset} not written: {exc}")
        return objs

    def place(self, asset, x, y, z, rot=0.0, scale=1.0, name="prop", collection=None, props=None):
        col = self.get(asset)
        if col is None:
            return None
        ob = bpy.data.objects.new(name, None)
        ob.instance_type = "COLLECTION"
        ob.instance_collection = col
        ob.location = (x, y, z)
        ob.rotation_euler = (0.0, 0.0, rot)
        ob.scale = (scale, scale, scale)
        ob.empty_display_size = 0.2
        (collection or bpy.context.scene.collection).objects.link(ob)
        for k, v in (props or {}).items():
            ob[k] = v
        return ob


# ---- the build ------------------------------------------------------------------------------

FURN_MATS = ["laminate", "navy", "dark", "purple", "desk_wood", "steel", "red", "frosted", "concrete",
             "blue", "lime", "paint", "tile", "white", "cork", "rug", "lightpanel", "amber", "slat", "mirror",
             "felt", "canopy", "led", "pipe_blue"]
FM = {k: i for i, k in enumerate(FURN_MATS)}
PEOPLE_MATS = ["skin_a", "skin_b", "skin_c", "hair", "jeans", "slacks", "shoe",
               "shirt_white", "shirt_navy", "shirt_red", "shirt_green", "shirt_yellow", "shirt_grey"]
PM = {k: i for i, k in enumerate(PEOPLE_MATS)}


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
        self.col_props = self._collection("Props")             # photoscanned instances; never exported
        self.props = PropLibrary()
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
            skin = m["timber"] if lv["index"] == 1 else (m["panel_white"] if lv["index"] > 1 else m["concrete"])
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
        _bevel(mesh_object("parapet", bm, [m["panel_white"]], self.col_shell, roofp))
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
        bm = bmesh.new()
        for row in range(5):
            y = 50 + row * 4.0
            for col in range(3):
                x = 16 + col * 5.2
                add_box(bm, x, x + 4.8, y, y + 2.0, self.roof_z + 0.4, self.roof_z + 0.45, 0)
                add_box(bm, x + 0.2, x + 4.6, y + 0.2, y + 1.8, self.roof_z + 0.45, self.roof_z + 0.47, 1)
                for dx in (0.3, 4.3):
                    add_box(bm, x + dx, x + dx + 0.1, y + 0.3, y + 0.4, self.roof_z + 0.08, self.roof_z + 0.4, 0)
                    add_box(bm, x + dx, x + dx + 0.1, y + 1.6, y + 1.7, self.roof_z + 0.08, self.roof_z + 0.6, 0)
        mesh_object("rooftop_pv", bm, [m["metal"], m["glass"]], self.col_shell, roofp)

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
        planters = ((b.x0 + 3.5, b.y1 - 4.0), (b.x1 - 6.5, b.y1 - 4.0), (b.cx - 1.5, b.y0 + 7.5))
        for (x, y) in planters:
            add_box(bm, x, x + 3.0, y, y + 2.0, z + 0.06, z + 0.75, 0)
            add_box(soil, x + 0.1, x + 2.9, y + 0.1, y + 1.9, z + 0.6, z + 0.72, 0)
        for i, (x, y) in enumerate(planters):
            self.props.place("shrub_02", x + 1.5, y + 1.0, z + 0.55, scale=0.4, name=f"podium_shrubs_{i}",
                             collection=self.col_props, props=p)
        mesh_object("podium_planters", bm, [m["concrete"]], self.col_shell, p)
        mesh_object("podium_planter_soil", soil, [m["soil"]], self.col_shell, p)
        rail = garden.minus(garden.eroded(0.12))
        bm = bmesh.new()
        add_prism(bm, rail, z, z + 1.1, mi=0)
        mesh_object("podium_rail", bm, [m["frosted"]], self.col_shell, p)
        self.trees([(x, y, z + 0.18, 4.5, 2.0) for (x, y) in ((b.x0 + 5, b.y1 - 3), (b.x1 - 5, b.y1 - 3), (b.x0 + 12, b.y0 + 8.5))],
                   self.col_shell, "podium_trees", p)

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
            walls, glazed = self.partitions(lv, spaces, region)
            bm = bmesh.new()
            for axis, fixed, lo, hi in walls:
                if axis == "x":
                    add_box(bm, lo, hi, fixed - INT_WALL / 2, fixed + INT_WALL / 2, z_fin, z_top, 0)
                else:
                    add_box(bm, fixed - INT_WALL / 2, fixed + INT_WALL / 2, lo, hi, z_fin, z_top, 0)
            mesh_object(f"walls_{lv['id']}", bm, [m["paint"]], self.col_interior, self._props(lv))
            # Glazed partitions (study rooms and lounges open to the corridor behind glass).
            bm = bmesh.new()
            for axis, fixed, lo, hi in glazed:
                self._glass_wall(bm, axis, fixed, lo, hi, z_fin, z_top)
            if bm.faces:
                mesh_object(f"glazing_{lv['id']}", bm, [m["glass"], m["frame"]], self.col_interior, self._props(lv))
            else:
                bm.free()
            bm = bmesh.new()
            for s in spaces:
                self.furnish(bm, s, lv, region, z_fin + 0.02, z_top)
            self.doors_and_signs(bm, lv, z_fin + 0.02)
            if bm.faces:
                furn = mesh_object(f"furniture_{lv['id']}", bm, [m[k] for k in FURN_MATS], self.col_interior, self._props(lv))
                _bevel(furn, 0.02)       # mattresses, desks and chairs stop reading as razor-edged boxes
            else:
                bm.free()
        self.build_courtyards()
        self.build_plant()

    GLAZED_TO_CORRIDOR = {"study", "lounge", "kitchen"}

    def partitions(self, lv, spaces, region):
        """Interior wall runs per wall line: union of space edges minus exterior runs, doors and glazing.

        Returns (walls, glazed): both lists of (axis, fixed, lo, hi)."""
        lines = {}
        glazed = {}
        corridors = [R.of(s["rect"]) for s in spaces if s["kind"] in ("corridor", "lobby")]
        for s in spaces:
            r = R.of(s["rect"])
            for axis, fixed, lo, hi, sign in (("x", r.y0, r.x0, r.x1, -1), ("x", r.y1, r.x0, r.x1, +1),
                                               ("y", r.x0, r.y0, r.y1, -1), ("y", r.x1, r.y0, r.y1, +1)):
                mid = (lo + hi) / 2
                px, py = (mid, fixed + sign * 0.15) if axis == "x" else (fixed + sign * 0.15, mid)
                if not region.inside(px, py):
                    continue  # exterior: the ring covers it
                key = (axis, round(fixed, 3))
                if s["kind"] in self.GLAZED_TO_CORRIDOR and any(c.contains(px, py) for c in corridors):
                    # Only the stretch actually shared with the corridor is glass.
                    for c in corridors:
                        if not c.contains(px, py):
                            continue
                        a, b = (max(lo, c.x0), min(hi, c.x1)) if axis == "x" else (max(lo, c.y0), min(hi, c.y1))
                        if b - a > 0.5:
                            glazed.setdefault(key, []).append((a, b))
                lines.setdefault(key, []).append((lo, hi))
        gaps = {}
        for o in self.spec["openings"]:
            if o["level"] != lv["id"] or o["b"] == "outside":
                continue
            fixed = o["y"] if o["axis"] == "x" else o["x"]
            c = o["x"] if o["axis"] == "x" else o["y"]
            gaps.setdefault((o["axis"], round(fixed, 3)), []).append((c - o["width"] / 2, c + o["width"] / 2))

        def cut(pieces, cuts):
            for (g0, g1) in cuts:
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
            return pieces

        walls, panes = [], []
        for key, ivs in lines.items():
            axis, fixed = key
            glass_runs = _merge_intervals(glazed.get(key, []))
            for (lo, hi) in _merge_intervals(ivs):
                for (a, b) in cut([(lo, hi)], gaps.get(key, []) + glass_runs):
                    a2 = a + 0.2 if self._on_exterior(axis, fixed, a, region) else a
                    b2 = b - 0.2 if self._on_exterior(axis, fixed, b, region) else b
                    if b2 - a2 > 0.05:
                        walls.append((axis, fixed, a2, b2))
            for (a, b) in glass_runs:
                for (a2, b2) in cut([(a, b)], gaps.get(key, [])):
                    if b2 - a2 > 0.3:
                        panes.append((axis, fixed, a2, b2))
        return walls, panes

    @staticmethod
    def _on_exterior(axis, fixed, end, region):
        for d in (-0.1, 0.1):
            px, py = (end + d, fixed) if axis == "x" else (fixed, end + d)
            if not region.inside(px, py):
                return True
        return False

    def _glass_wall(self, bm, axis, fixed, lo, hi, z0, z1, bay=1.2):
        t = INT_WALL / 2

        def box(a0, a1, n0, n1, za, zb, mi):
            if axis == "x":
                add_box(bm, a0, a1, fixed + n0, fixed + n1, za, zb, mi)
            else:
                add_box(bm, fixed + n0, fixed + n1, a0, a1, za, zb, mi)

        box(lo, hi, -0.006, 0.006, z0 + 0.1, z1 - 0.1, 0)                 # pane
        box(lo, hi, -t, t, z0, z0 + 0.1, 1)                                # bottom rail
        box(lo, hi, -t, t, z1 - 0.1, z1, 1)                                # head
        n = max(1, int(round((hi - lo) / bay)))
        for k in range(n + 1):
            a = lo + (hi - lo) * k / n
            box(a - 0.025, a + 0.025, -t, t, z0, z1, 1)                    # mullions

    # -- furniture by room kind ----------------------------------------------------------

    def furnish(self, bm, s, lv, region, z, z_top):
        kind = s["kind"]
        r = R.of(s["rect"])
        name = s["name"].lower()
        if kind == "room":
            self._furnish_room(bm, s, r, region, z, z_top)
        elif kind == "bathroom":
            self._bathroom(bm, r, z, z_top, region)
        elif kind == "lounge":
            self._lounge(bm, r, z, z_top, region, sofas=True)
        elif kind == "study":
            self._study(bm, r, z, z_top, region)
        elif kind == "office":
            self._office(bm, r, z, z_top)
        elif kind == "kitchen":
            self._kitchen(bm, r, z, z_top, region)
        elif kind == "laundry":
            self._laundry(bm, r, z, z_top, region)
        elif kind == "lobby":
            self._lobby(bm, r, z, z_top)
        elif kind == "retail":
            self._retail(bm, r, z, z_top)
        elif kind == "amenity":
            self._amenity(bm, s, r, z, z_top, region)
        elif kind == "stair":
            self._stair(bm, r, z, z_top)
        elif kind == "lift":
            add_box(bm, r.x0 + 0.3, r.x1 - 0.3, r.y0 + 0.3, r.y1 - 0.3, z, z + 2.4, FM["steel"])
            self._ceiling_panel(bm, r.cx, r.cy, z + 2.38, 0.6, 0.6)
        elif kind == "service":
            if "mail" in name:
                self._mailboxes(bm, r, z)
            elif "trash" in name or "lift machine" in name:
                self._trash_room(bm, r, z, z_top)
            else:
                self._shelving(bm, r, z)
        elif kind == "riser":
            self._riser(bm, r, z, z_top)
        elif kind == "storage":
            if "bike" in name:
                self._bike_racks(bm, r, z)
            else:
                self._shelving(bm, r, z)
        elif kind == "mechanical":
            self._plant_room(bm, r, z, z_top, pipes=True)
        elif kind in ("electrical", "generator"):
            self._plant_room(bm, r, z, z_top, pipes=False)
        elif kind == "corridor":
            self._corridor(bm, r, z, z_top, lv)
        if kind in ("room", "office", "bathroom", "laundry", "storage", "service", "mechanical", "electrical",
                    "generator", "stair"):
            self._ceiling_panel(bm, r.cx, r.cy, z_top - 0.03, min(1.2, r.w * 0.4), min(0.3, r.h * 0.3))

    # small shared parts
    def _ceiling_panel(self, bm, x, y, z, w, d):
        add_box(bm, x - w / 2, x + w / 2, y - d / 2, y + d / 2, z - 0.02, z, FM["lightpanel"])

    def _chair(self, bm, x, y, z, facing="+y", mi=FM["dark"]):
        s = 0.22
        add_box(bm, x - s, x + s, y - s, y + s, z + 0.42, z + 0.46, mi)
        for dx, dy in ((-s + 0.03, -s + 0.03), (s - 0.03, -s + 0.03), (-s + 0.03, s - 0.03), (s - 0.03, s - 0.03)):
            add_box(bm, x + dx - 0.015, x + dx + 0.015, y + dy - 0.015, y + dy + 0.015, z, z + 0.42, FM["steel"])
        if facing == "+y":
            add_box(bm, x - s, x + s, y - s, y - s + 0.04, z + 0.46, z + 0.92, mi)
        elif facing == "-y":
            add_box(bm, x - s, x + s, y + s - 0.04, y + s, z + 0.46, z + 0.92, mi)
        elif facing == "+x":
            add_box(bm, x - s, x - s + 0.04, y - s, y + s, z + 0.46, z + 0.92, mi)
        else:
            add_box(bm, x + s - 0.04, x + s, y - s, y + s, z + 0.46, z + 0.92, mi)

    def _sofa(self, bm, x, y, axis, z, mi, length=2.0):
        d = 0.9
        if axis == "x":
            add_box(bm, x, x + length, y, y + d, z + 0.1, z + 0.42, mi)                 # seat
            add_box(bm, x, x + length, y, y + 0.28, z + 0.42, z + 0.88, mi)             # back
            add_box(bm, x, x + 0.2, y, y + d, z + 0.42, z + 0.62, mi)                   # arms
            add_box(bm, x + length - 0.2, x + length, y, y + d, z + 0.42, z + 0.62, mi)
            add_box(bm, x + 0.05, x + length - 0.05, y + 0.3, y + d - 0.05, z + 0.42, z + 0.5, mi)  # cushions
            add_box(bm, x + 0.05, x + length - 0.05, y + 0.05, y + d - 0.05, z, z + 0.1, FM["dark"])
        else:
            add_box(bm, x, x + d, y, y + length, z + 0.1, z + 0.42, mi)
            add_box(bm, x, x + 0.28, y, y + length, z + 0.42, z + 0.88, mi)
            add_box(bm, x, x + d, y, y + 0.2, z + 0.42, z + 0.62, mi)
            add_box(bm, x, x + d, y + length - 0.2, y + length, z + 0.42, z + 0.62, mi)
            add_box(bm, x + 0.3, x + d - 0.05, y + 0.05, y + length - 0.05, z + 0.42, z + 0.5, mi)
            add_box(bm, x + 0.05, x + d - 0.05, y + 0.05, y + length - 0.05, z, z + 0.1, FM["dark"])

    def _table(self, bm, x, y, z, radius=0.45, mi=FM["desk_wood"], chairs=4):
        add_cyl(bm, x, y, z, z + 0.72, 0.04, FM["steel"], 8)
        add_cyl(bm, x, y, z, z + 0.03, 0.3, FM["steel"], 12)
        add_cyl(bm, x, y, z + 0.72, z + 0.75, radius, mi, 20)
        if chairs:
            for (dx, dy, f) in ((0.75, 0, "-x"), (-0.75, 0, "+x"), (0, 0.75, "-y"), (0, -0.75, "+y"))[:chairs]:
                self._chair(bm, x + dx, y + dy, z, f)

    def _long_table(self, bm, x0, x1, y0, y1, z, mi=FM["laminate"], chairs=True):
        add_box(bm, x0, x1, y0, y1, z + 0.72, z + 0.76, mi)
        for (x, y) in ((x0 + 0.05, y0 + 0.05), (x1 - 0.05, y0 + 0.05), (x0 + 0.05, y1 - 0.05), (x1 - 0.05, y1 - 0.05)):
            add_box(bm, x - 0.03, x + 0.03, y - 0.03, y + 0.03, z, z + 0.72, FM["steel"])
        if chairs:
            n = max(1, int((x1 - x0) // 0.8))
            for k in range(n):
                cx = x0 + (x1 - x0) * (k + 0.5) / n
                self._chair(bm, cx, y0 - 0.4, z, "+y")
                self._chair(bm, cx, y1 + 0.4, z, "-y")

    def _pendant(self, bm, x, y, z_top, drop=0.9):
        add_cyl(bm, x, y, z_top - drop, z_top, 0.008, FM["dark"], 6)
        add_cyl(bm, x, y, z_top - drop - 0.25, z_top - drop, 0.16, FM["amber"], 14)

    def _slat_ceiling(self, bm, r, z_top, inset=0.3, pitch=0.22):
        """Timber slat ceiling (as in the lounges and lobby): strips under the slab above."""
        n = int((r.w - 2 * inset) // pitch)
        for k in range(n):
            x = r.x0 + inset + k * pitch
            add_box(bm, x, x + 0.06, r.y0 + inset, r.y1 - inset, z_top - 0.12, z_top - 0.02, FM["slat"])

    def _plant_pot(self, bm, x, y, z, h=1.1):
        add_cyl(bm, x, y, z, z + 0.4, 0.22, FM["concrete"], 12)
        add_cyl(bm, x, y, z + 0.4, z + 0.45, 0.04, FM["canopy"], 6)
        res = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.38)
        for v in res["verts"]:
            v.co = Vector((x, y, z + 0.4 + h * 0.45)) + Vector((v.co.x, v.co.y, v.co.z * 1.3))
        for f in bm.faces:
            if any(v in set(res["verts"]) for v in f.verts):
                f.material_index = FM["canopy"]
                f.smooth = True

    def _shelving(self, bm, r, z):
        along_y = r.h >= r.w
        if along_y:
            for x in (r.x0 + 0.1, r.x1 - 0.6):
                for k in range(5):
                    add_box(bm, x, x + 0.5, r.y0 + 0.2, r.y1 - 0.2, z + 0.1 + k * 0.45, z + 0.13 + k * 0.45, FM["steel"])
                add_box(bm, x, x + 0.02, r.y0 + 0.2, r.y1 - 0.2, z, z + 2.0, FM["steel"])
                add_box(bm, x + 0.48, x + 0.5, r.y0 + 0.2, r.y1 - 0.2, z, z + 2.0, FM["steel"])
        else:
            for y in (r.y0 + 0.1, r.y1 - 0.6):
                for k in range(5):
                    add_box(bm, r.x0 + 0.2, r.x1 - 0.2, y, y + 0.5, z + 0.1 + k * 0.45, z + 0.13 + k * 0.45, FM["steel"])
        # a few bins on the shelves
        for k in range(3):
            add_box(bm, r.x0 + 0.15 + k * 0.5, r.x0 + 0.55 + k * 0.5, r.y0 + 0.3, r.y0 + 0.7, z + 0.13, z + 0.45, FM["blue"])

    def _mailboxes(self, bm, r, z):
        cols = int((r.h - 0.4) // 0.3)
        for i in range(cols):
            for j in range(6):
                y = r.y0 + 0.2 + i * 0.3
                add_box(bm, r.x1 - 0.4, r.x1 - 0.05, y, y + 0.28, z + 0.5 + j * 0.3, z + 0.78 + j * 0.3, FM["steel"])
                add_box(bm, r.x1 - 0.41, r.x1 - 0.4, y + 0.02, y + 0.26, z + 0.52 + j * 0.3, z + 0.76 + j * 0.3, FM["dark"])
        add_box(bm, r.x0 + 0.3, r.x0 + 1.5, r.cy - 0.4, r.cy + 0.4, z + 0.85, z + 0.9, FM["laminate"])

    def _bike_racks(self, bm, r, z):
        for k in range(int(r.h // 0.7)):
            y = r.y0 + 0.4 + k * 0.7
            add_box(bm, r.x0 + 0.3, r.x0 + 2.0, y, y + 0.05, z, z + 0.9, FM["steel"])
            # a parked bike: two wheels and a frame
            if k % 2 == 0:
                add_disc(bm, r.x0 + 0.7, y + 0.3, z + 0.34, 0.34, 0.03, "y", FM["dark"])
                add_disc(bm, r.x0 + 1.7, y + 0.3, z + 0.34, 0.34, 0.03, "y", FM["dark"])
                add_bar(bm, (r.x0 + 0.7, y + 0.3, z + 0.34), (r.x0 + 1.25, y + 0.3, z + 0.85), 0.015, FM["blue"])
                add_bar(bm, (r.x0 + 1.7, y + 0.3, z + 0.34), (r.x0 + 1.25, y + 0.3, z + 0.85), 0.015, FM["blue"])

    # -- rooms --------------------------------------------------------------------------

    def _furnish_room(self, bm, s, r, region, z, z_top):
        along_y = r.h >= r.w
        u0, u1 = (r.y0, r.y1) if along_y else (r.x0, r.x1)
        v0, v1 = (r.x0, r.x1) if along_y else (r.y0, r.y1)
        probe_hi = (r.cx, u1 + 0.15) if along_y else (u1 + 0.15, r.cy)
        win_hi = not region.inside(*probe_hi)

        def box(ua, ub, va, vb, za, zb, mi):
            if not win_hi:
                ua, ub = u0 + (u1 - ub), u0 + (u1 - ua)
            if along_y:
                add_box(bm, va, vb, ua, ub, za, zb, mi)
            else:
                add_box(bm, ua, ub, va, vb, za, zb, mi)

        def pt(u, v):
            if not win_hi:
                u = u0 + (u1 - u)
            return (v, u) if along_y else (u, v)

        beds = max(1, min(2, s["capacity"]))
        sides = [(v0 + 0.12, v0 + 1.07, True)] + ([(v1 - 1.07, v1 - 0.12, False)] if beds == 2 else [])
        for (va, vb, left) in sides:
            # Bed: frame with two under-bed drawers, mattress, navy duvet, pillow, headboard at the window end.
            box(u1 - 2.15, u1 - 0.15, va, vb, z + 0.25, z + 0.45, FM["laminate"])
            box(u1 - 2.1, u1 - 1.2, va + 0.02, vb - 0.02, z, z + 0.25, FM["laminate"])
            box(u1 - 1.1, u1 - 0.2, va + 0.02, vb - 0.02, z, z + 0.25, FM["laminate"])
            box(u1 - 2.1, u1 - 0.2, va + 0.03, vb - 0.03, z + 0.45, z + 0.63, FM["white"])
            box(u1 - 1.65, u1 - 0.22, va + 0.05, vb - 0.05, z + 0.6, z + 0.7, FM["navy"])
            box(u1 - 0.65, u1 - 0.25, va + 0.12, vb - 0.12, z + 0.63, z + 0.75, FM["white"])
            box(u1 - 0.2, u1 - 0.15, va, vb, z + 0.45, z + 1.0, FM["laminate"])
            # Desk with a hutch shelf, lamp, and a task chair.
            da, db = (va, va + 0.6) if left else (vb - 0.6, vb)
            box(u1 - 3.7, u1 - 2.4, da, db, z + 0.72, z + 0.76, FM["laminate"])
            box(u1 - 3.7, u1 - 3.65, da, db, z, z + 0.72, FM["laminate"])
            box(u1 - 2.45, u1 - 2.4, da, db, z, z + 0.72, FM["laminate"])
            box(u1 - 3.7, u1 - 2.4, da if left else db - 0.25, da + 0.25 if left else db, z + 1.15, z + 1.19, FM["laminate"])
            box(u1 - 3.7, u1 - 2.4, da if left else db - 0.02, da + 0.02 if left else db, z + 0.76, z + 1.19, FM["laminate"])
            lx, ly = pt(u1 - 2.65, da + 0.15 if left else db - 0.15)
            add_cyl(bm, lx, ly, z + 0.76, z + 1.1, 0.012, FM["dark"], 6)
            add_cyl(bm, lx, ly, z + 1.1, z + 1.16, 0.08, FM["dark"], 10)
            cx, cy = pt(u1 - 3.05, va + 0.95 if left else vb - 0.95)
            facing = ("-x" if left else "+x") if along_y else ("-y" if left else "+y")
            self._chair(bm, cx, cy, z, facing)
            # Wardrobe by the door with a door seam and handle.
            box(u0 + 0.12, u0 + 0.72, va, vb, z, z + 2.0, FM["laminate"])
            box(u0 + 0.72, u0 + 0.725, va + 0.05, vb - 0.05, z + 0.3, z + 1.9, FM["dark"])
            box(u0 + 0.72, u0 + 0.75, (va + vb) / 2 - 0.05, (va + vb) / 2 + 0.05, z + 1.0, z + 1.15, FM["steel"])
            # Shelf over the desk with a few books.
            for k in range(4):
                box(u1 - 3.6 + k * 0.18, u1 - 3.48 + k * 0.18, da if left else db - 0.22, da + 0.22 if left else db,
                    z + 1.19, z + 1.42, [FM["blue"], FM["red"], FM["navy"], FM["lime"]][k])
        # Pin board on the wall between the desks and a floor rug between the beds.
        box(u1 - 3.4, u1 - 2.4, v0 + 0.015 if beds == 2 else v1 - 0.03, v0 + 0.03 if beds == 2 else v1 - 0.015,
            z + 1.2, z + 1.8, FM["cork"])
        box(u1 - 3.8, u1 - 0.5, v0 + 1.25, v1 - 1.25 if beds == 2 else v1 - 0.3, z, z + 0.012, FM["rug"])
        # Roller blind box and a partly-drawn blind on the window wall.
        box(u1 - 0.2, u1 - 0.12, v0 + 0.3, v1 - 0.3, z + 2.55, z + 2.7, FM["white"])
        import random
        drop = random.Random(int(r.x0 * 7 + r.y0 * 13)).uniform(0.15, 0.6)
        box(u1 - 0.17, u1 - 0.15, v0 + 0.35, v1 - 0.35, z + 2.55 - drop * 2.0, z + 2.55, FM["white"])

    def _bathroom(self, bm, r, z, z_top, region):
        """Single-occupant bathroom pods off a wash-up area with a mirror wall, as in Blackwell."""
        along_y = r.h >= r.w
        L = r.h if along_y else r.w
        n = int(max(1, (L - 0.4) // 1.5))
        for k in range(n):
            a = (r.y0 if along_y else r.x0) + 0.2 + k * 1.5
            # Pod partitions + door + toilet or shower.
            if along_y:
                add_box(bm, r.x0 + 0.1, r.x0 + 2.0, a, a + 0.05, z, z + 2.3, FM["laminate"])
                add_box(bm, r.x0 + 2.0, r.x0 + 2.05, a, a + 1.45, z, z + 2.3, FM["laminate"])
                add_box(bm, r.x0 + 2.0, r.x0 + 2.04, a + 0.25, a + 1.1, z, z + 2.1, FM["desk_wood"])
                add_box(bm, r.x0 + 2.04, r.x0 + 2.07, a + 0.95, a + 1.02, z + 1.0, z + 1.1, FM["steel"])
                if k % 2 == 0:
                    add_box(bm, r.x0 + 0.15, r.x0 + 0.5, a + 0.5, a + 1.0, z, z + 0.8, FM["white"])        # cistern
                    add_cyl(bm, r.x0 + 0.75, a + 0.75, z, z + 0.42, 0.22, FM["white"], 14)                # bowl
                else:
                    add_box(bm, r.x0 + 0.15, r.x0 + 1.05, a + 0.1, a + 1.4, z, z + 0.04, FM["tile"])       # shower tray
                    add_box(bm, r.x0 + 1.05, r.x0 + 1.07, a + 0.1, a + 1.4, z + 0.04, z + 2.0, FM["frosted"])
                    add_cyl(bm, r.x0 + 0.5, a + 0.75, z + 2.0, z + 2.05, 0.1, FM["steel"], 10)
                    add_cyl(bm, r.x0 + 0.5, a + 0.75, z + 1.95, z + 2.0, 0.02, FM["steel"], 6)
            else:
                add_box(bm, a, a + 0.05, r.y0 + 0.1, r.y0 + 2.0, z, z + 2.3, FM["laminate"])
                add_box(bm, a, a + 1.45, r.y0 + 2.0, r.y0 + 2.05, z, z + 2.3, FM["laminate"])
                add_box(bm, a + 0.25, a + 1.1, r.y0 + 2.0, r.y0 + 2.04, z, z + 2.1, FM["desk_wood"])
                if k % 2 == 0:
                    add_box(bm, a + 0.5, a + 1.0, r.y0 + 0.15, r.y0 + 0.5, z, z + 0.8, FM["white"])
                    add_cyl(bm, a + 0.75, r.y0 + 0.75, z, z + 0.42, 0.22, FM["white"], 14)
                else:
                    add_box(bm, a + 0.1, a + 1.4, r.y0 + 0.15, r.y0 + 1.05, z, z + 0.04, FM["tile"])
                    add_box(bm, a + 0.1, a + 1.4, r.y0 + 1.05, r.y0 + 1.07, z + 0.04, z + 2.0, FM["frosted"])
                    add_cyl(bm, a + 0.75, r.y0 + 0.5, z + 2.0, z + 2.05, 0.1, FM["steel"], 10)
        # Wash-up: counter with basins, mirror with vertical light strips.
        if along_y:
            add_box(bm, r.x1 - 0.6, r.x1 - 0.05, r.y0 + 0.3, r.y1 - 0.3, z + 0.82, z + 0.88, FM["laminate"])
            add_box(bm, r.x1 - 0.6, r.x1 - 0.55, r.y0 + 0.3, r.y1 - 0.3, z + 0.1, z + 0.82, FM["laminate"])
            add_box(bm, r.x1 - 0.07, r.x1 - 0.05, r.y0 + 0.4, r.y1 - 0.4, z + 1.0, z + 2.0, FM["mirror"])
            for k in range(int((r.h - 0.6) // 1.2)):
                y = r.y0 + 0.9 + k * 1.2
                add_cyl(bm, r.x1 - 0.32, y, z + 0.88, z + 0.9, 0.18, FM["white"], 14)
                add_cyl(bm, r.x1 - 0.12, y, z + 0.88, z + 1.15, 0.012, FM["steel"], 6)
                add_box(bm, r.x1 - 0.08, r.x1 - 0.07, y + 0.45, y + 0.48, z + 1.05, z + 1.95, FM["lightpanel"])
        else:
            add_box(bm, r.x0 + 0.3, r.x1 - 0.3, r.y1 - 0.6, r.y1 - 0.05, z + 0.82, z + 0.88, FM["laminate"])
            add_box(bm, r.x0 + 0.3, r.x1 - 0.3, r.y1 - 0.6, r.y1 - 0.55, z + 0.1, z + 0.82, FM["laminate"])
            add_box(bm, r.x0 + 0.4, r.x1 - 0.4, r.y1 - 0.07, r.y1 - 0.05, z + 1.0, z + 2.0, FM["mirror"])
            for k in range(int((r.w - 0.6) // 1.2)):
                x = r.x0 + 0.9 + k * 1.2
                add_cyl(bm, x, r.y1 - 0.32, z + 0.88, z + 0.9, 0.18, FM["white"], 14)
                add_cyl(bm, x, r.y1 - 0.12, z + 0.88, z + 1.15, 0.012, FM["steel"], 6)
                add_box(bm, x + 0.45, x + 0.48, r.y1 - 0.08, r.y1 - 0.07, z + 1.05, z + 1.95, FM["lightpanel"])

    def _lounge(self, bm, r, z, z_top, region, sofas=True, colour=FM["blue"]):
        nx, ny = max(1, int(r.w // 2.8)), max(1, int(r.h // 2.8))
        for i in range(nx):
            for j in range(ny):
                x = r.x0 + 1.4 + i * (r.w - 2.8) / (nx - 1) if nx > 1 else r.cx
                y = r.y0 + 1.4 + j * (r.h - 2.8) / (ny - 1) if ny > 1 else r.cy
                if sofas and (i + j) % 2 == 0:
                    self._sofa(bm, x - 1.0, y - 0.45, "x", z, colour if (i % 2 == 0) else FM["purple"])
                    add_cyl(bm, x, y + 1.0, z + 0.38, z + 0.42, 0.4, FM["desk_wood"], 16)
                    add_cyl(bm, x, y + 1.0, z, z + 0.38, 0.03, FM["steel"], 6)
                else:
                    self._table(bm, x, y, z)
                self._pendant(bm, x, y, z_top)
        self._accent_wall(bm, r, z, region)
        self._tv(bm, r, z, region)
        self._slat_ceiling(bm, r, z_top)
        self._plant_pot(bm, r.x0 + 0.5, r.y0 + 0.5, z)
        self._plant_pot(bm, r.x1 - 0.5, r.y1 - 0.5, z)

    def _accent_wall(self, bm, r, z, region, mi=FM["lime"]):
        """Painted accent on a wall that faces another room, so it never shows through exterior glass."""
        for axis, fixed, sign in (("x", r.x0, -1), ("x", r.x1, +1), ("y", r.y0, -1), ("y", r.y1, +1)):
            px, py = (fixed + sign * 0.15, r.cy) if axis == "x" else (r.cx, fixed + sign * 0.15)
            if region is None or region.inside(px, py):
                if axis == "x":
                    add_box(bm, fixed - sign * 0.10, fixed - sign * 0.08, r.y0 + 0.5, r.y1 - 0.5, z, z + 2.2, mi)
                else:
                    add_box(bm, r.x0 + 0.5, r.x1 - 0.5, fixed - sign * 0.10, fixed - sign * 0.08, z, z + 2.2, mi)
                return (axis, fixed, sign)
        return None

    def _tv(self, bm, r, z, region):
        for axis, fixed, sign in (("y", r.y1, +1), ("y", r.y0, -1), ("x", r.x1, +1), ("x", r.x0, -1)):
            px, py = (fixed + sign * 0.15, r.cy) if axis == "x" else (r.cx, fixed + sign * 0.15)
            if region is not None and not region.inside(px, py):
                continue
            if axis == "x":
                add_box(bm, fixed - sign * 0.13, fixed - sign * 0.09, r.cy - 0.8, r.cy + 0.8, z + 1.2, z + 2.1, FM["dark"])
            else:
                add_box(bm, r.cx - 0.8, r.cx + 0.8, fixed - sign * 0.13, fixed - sign * 0.09, z + 1.2, z + 2.1, FM["dark"])
            return

    def _study(self, bm, r, z, z_top, region):
        if r.w >= r.h:
            self._long_table(bm, r.x0 + 1.0, r.x1 - 1.0, r.cy - 0.5, r.cy + 0.5, z)
        else:
            self._long_table(bm, r.cx - 0.5, r.cx + 0.5, r.y0 + 1.0, r.y1 - 1.0, z, chairs=False)
            n = max(1, int((r.h - 2.0) // 0.8))
            for k in range(n):
                cy = r.y0 + 1.0 + (r.h - 2.0) * (k + 0.5) / n
                self._chair(bm, r.cx - 0.9, cy, z, "+x")
                self._chair(bm, r.cx + 0.9, cy, z, "-x")
        self._accent_wall(bm, r, z, region, mi=FM["white"])   # whiteboard wall
        for k in range(2):
            self._pendant(bm, r.cx + (k - 0.5) * min(2.0, r.w * 0.4), r.cy, z_top, drop=0.7)
        self._plant_pot(bm, r.x0 + 0.45, r.y1 - 0.45, z, h=0.9)

    def _office(self, bm, r, z, z_top):
        n = max(1, int(r.h // 2.4))
        for k in range(n):
            y = r.y0 + 1.2 + k * 2.4
            add_box(bm, r.x0 + 0.3, r.x0 + 1.9, y - 0.4, y + 0.4, z + 0.72, z + 0.76, FM["laminate"])
            add_box(bm, r.x0 + 0.3, r.x0 + 0.35, y - 0.4, y + 0.4, z, z + 0.72, FM["laminate"])
            add_box(bm, r.x0 + 1.85, r.x0 + 1.9, y - 0.4, y + 0.4, z, z + 0.72, FM["laminate"])
            add_box(bm, r.x0 + 0.9, r.x0 + 1.4, y - 0.15, y + 0.15, z + 0.76, z + 1.1, FM["dark"])   # monitor
            self._chair(bm, r.x0 + 1.1, y + 0.9, z, "-y")
        add_box(bm, r.x1 - 0.45, r.x1 - 0.1, r.y0 + 0.3, r.y1 - 0.3, z, z + 1.9, FM["laminate"])         # cabinets

    def _kitchen(self, bm, r, z, z_top, region):
        horiz = r.w >= r.h
        # Counter run with sink, cooktop and upper cabinets along the inside wall; island with stools.
        if horiz:
            y0, y1 = r.y1 - 0.72, r.y1 - 0.1
            add_box(bm, r.x0 + 0.1, r.x1 - 0.1, y0, y1, z, z + 0.88, FM["laminate"])
            add_box(bm, r.x0 + 0.1, r.x1 - 0.1, y0 - 0.02, y1, z + 0.88, z + 0.92, FM["dark"])
            add_box(bm, r.x0 + 0.1, r.x1 - 0.1, y1 - 0.38, y1, z + 1.5, z + 2.25, FM["laminate"])
            add_box(bm, r.x0 + 1.0, r.x0 + 1.8, y0 + 0.12, y1 - 0.12, z + 0.90, z + 0.925, FM["steel"])   # sink
            add_cyl(bm, r.x0 + 1.4, y1 - 0.15, z + 0.92, z + 1.2, 0.012, FM["steel"], 6)
            add_box(bm, r.x0 + 2.6, r.x0 + 3.4, y0 + 0.08, y1 - 0.08, z + 0.92, z + 0.935, FM["dark"])      # cooktop
            for (dx, dy) in ((0.2, 0.15), (0.6, 0.15), (0.2, 0.45), (0.6, 0.45)):
                add_cyl(bm, r.x0 + 2.6 + dx, y0 + dy, z + 0.935, z + 0.945, 0.08, FM["steel"], 12)
            ix0, ix1 = r.x0 + 1.0, min(r.x1 - 1.0, r.x0 + 3.6)
            add_box(bm, ix0, ix1, r.cy - 0.45, r.cy + 0.45, z, z + 0.9, FM["desk_wood"])
            add_box(bm, ix0 - 0.05, ix1 + 0.05, r.cy - 0.5, r.cy + 0.5, z + 0.9, z + 0.94, FM["white"])
            for k in range(3):
                x = ix0 + (ix1 - ix0) * (k + 0.5) / 3
                add_cyl(bm, x, r.cy - 0.85, z, z + 0.7, 0.02, FM["steel"], 6)
                add_cyl(bm, x, r.cy - 0.85, z + 0.7, z + 0.75, 0.17, FM["dark"], 12)
                self._pendant(bm, x, r.cy, z_top, drop=1.0)
            tx0 = ix1 + 0.8
            if r.x1 - 0.8 - tx0 > 1.6:
                self._long_table(bm, tx0, r.x1 - 0.8, r.cy - 0.45, r.cy + 0.45, z, mi=FM["desk_wood"])
        else:
            x0, x1 = r.x1 - 0.72, r.x1 - 0.1
            add_box(bm, x0, x1, r.y0 + 0.1, r.y1 - 0.1, z, z + 0.88, FM["laminate"])
            add_box(bm, x0 - 0.02, x1, r.y0 + 0.1, r.y1 - 0.1, z + 0.88, z + 0.92, FM["dark"])
            add_box(bm, x1 - 0.38, x1, r.y0 + 0.1, r.y1 - 0.1, z + 1.5, z + 2.25, FM["laminate"])
            self._table(bm, r.cx - 0.5, r.cy, z)
        self._sofa(bm, r.x0 + 0.4, r.y0 + 0.3, "x", z, FM["purple"])
        self._tv(bm, r, z, region)
        self._slat_ceiling(bm, r, z_top)
        self._plant_pot(bm, r.x0 + 0.5, r.y1 - 0.5, z)

    def _laundry(self, bm, r, z, z_top, region):
        along_y = r.h >= r.w
        L = r.h if along_y else r.w
        n = int(max(1, (L - 0.6) // 0.8))
        for k in range(n):
            a = (r.y0 if along_y else r.x0) + 0.3 + k * 0.8
            if along_y:
                add_box(bm, r.x0 + 0.1, r.x0 + 0.8, a, a + 0.7, z, z + 1.95, FM["white"])          # stacked pair
                add_disc(bm, r.x0 + 0.8, a + 0.35, z + 0.55, 0.26, 0.02, "x", FM["dark"])
                add_disc(bm, r.x0 + 0.8, a + 0.35, z + 1.45, 0.26, 0.02, "x", FM["dark"])
                add_box(bm, r.x0 + 0.8, r.x0 + 0.82, a + 0.05, a + 0.65, z + 0.95, z + 1.05, FM["steel"])
            else:
                add_box(bm, a, a + 0.7, r.y0 + 0.1, r.y0 + 0.8, z, z + 1.95, FM["white"])
                add_disc(bm, a + 0.35, r.y0 + 0.8, z + 0.55, 0.26, 0.02, "y", FM["dark"])
                add_disc(bm, a + 0.35, r.y0 + 0.8, z + 1.45, 0.26, 0.02, "y", FM["dark"])
        # Folding table, a chair and the blue graphic wall.
        if along_y:
            add_box(bm, r.x1 - 0.8, r.x1 - 0.2, r.y0 + 0.5, r.y1 - 0.5, z + 0.85, z + 0.9, FM["laminate"])
            add_box(bm, r.x1 - 0.8, r.x1 - 0.75, r.y0 + 0.5, r.y1 - 0.5, z, z + 0.85, FM["laminate"])
        else:
            add_box(bm, r.x0 + 0.5, r.x1 - 0.5, r.y1 - 0.8, r.y1 - 0.2, z + 0.85, z + 0.9, FM["laminate"])
        self._accent_wall(bm, r, z, region, mi=FM["blue"])
        self._chair(bm, r.cx, r.cy, z, "+y")

    def _lobby(self, bm, r, z, z_top):
        # Front desk with timber front and white top, timber slat feature wall behind it, seating, planters.
        add_box(bm, r.x0 + 2.0, r.x0 + 6.0, r.y0 + 3.0, r.y0 + 3.9, z, z + 1.05, FM["desk_wood"])
        add_box(bm, r.x0 + 1.95, r.x0 + 6.05, r.y0 + 2.95, r.y0 + 3.95, z + 1.05, z + 1.1, FM["white"])
        add_box(bm, r.x0 + 2.2, r.x0 + 5.8, r.y0 + 3.3, r.y0 + 3.9, z + 0.7, z + 0.74, FM["laminate"])
        for k in range(int((r.y1 - r.y0 - 4.0) // 0.12)):
            y = r.y0 + 2.0 + k * 0.12
            add_box(bm, r.x0 + 0.13, r.x0 + 0.19, y, y + 0.06, z, z + 3.2, FM["slat"])
        self._sofa(bm, r.x0 + 8.0, r.y0 + 2.0, "x", z, FM["red"], length=2.4)
        self._sofa(bm, r.x0 + 8.0, r.y0 + 5.5, "x", z, FM["red"], length=2.4)
        add_cyl(bm, r.x0 + 9.2, r.y0 + 4.2, z + 0.38, z + 0.42, 0.5, FM["desk_wood"], 18)
        add_cyl(bm, r.x0 + 9.2, r.y0 + 4.2, z, z + 0.38, 0.04, FM["steel"], 6)
        for (x, y) in ((r.x0 + 11.5, r.y0 + 2.0), (r.x0 + 11.5, r.y0 + 6.2)):
            self._chair(bm, x, y, z, "-x", mi=FM["purple"])
        self._plant_pot(bm, r.x0 + 1.0, r.y0 + 1.0, z, h=1.6)
        self._plant_pot(bm, r.x0 + 12.5, r.y0 + 8.5, z, h=1.6)
        self._slat_ceiling(bm, R(r.x0, r.y0, r.x0 + 7.0, r.y1), z_top, inset=0.4)
        for (x, y) in ((r.x0 + 4.0, r.y0 + 6.0), (r.x0 + 9.0, r.y0 + 8.5)):
            self._pendant(bm, x, y, z_top, drop=1.2)
        # Lift lobby call plates and a notice board.
        add_box(bm, r.x0 + 6.0, r.x0 + 7.2, r.y1 - 0.03, r.y1 - 0.01, z + 1.2, z + 2.0, FM["cork"])

    def _retail(self, bm, r, z, z_top):
        # A cafe: counter with espresso machine and stools, shelving, small tables by the glass.
        add_box(bm, r.x0 + 1.0, r.x0 + 6.0, r.y1 - 2.2, r.y1 - 1.4, z, z + 0.95, FM["desk_wood"])
        add_box(bm, r.x0 + 0.95, r.x0 + 6.05, r.y1 - 2.25, r.y1 - 1.35, z + 0.95, z + 1.0, FM["dark"])
        add_box(bm, r.x0 + 2.0, r.x0 + 2.9, r.y1 - 2.1, r.y1 - 1.5, z + 1.0, z + 1.5, FM["steel"])
        add_box(bm, r.x0 + 1.0, r.x0 + 6.0, r.y1 - 0.5, r.y1 - 0.1, z, z + 2.2, FM["laminate"])
        for k in range(4):
            add_box(bm, r.x0 + 1.1, r.x0 + 5.9, r.y1 - 0.5, r.y1 - 0.12, z + 0.5 + k * 0.45, z + 0.53 + k * 0.45, FM["desk_wood"])
        for k in range(5):
            x = r.x0 + 1.4 + k * 1.0
            add_cyl(bm, x, r.y1 - 2.7, z, z + 0.7, 0.02, FM["steel"], 6)
            add_cyl(bm, x, r.y1 - 2.7, z + 0.7, z + 0.75, 0.17, FM["dark"], 12)
        nx = max(1, int((r.w - 2.0) // 2.6))
        for i in range(nx):
            self._table(bm, r.x0 + 1.5 + i * 2.6, r.y0 + 1.6, z, radius=0.35, chairs=2)
            self._pendant(bm, r.x0 + 1.5 + i * 2.6, r.y0 + 1.6, z_top, drop=1.1)
        self._slat_ceiling(bm, r, z_top)

    def _amenity(self, bm, s, r, z, z_top, region):
        name = s["name"].lower()
        if "fitness" in name:
            for i in range(int((r.w - 2.0) // 3.0)):
                for j in range(int((r.h - 2.0) // 3.5)):
                    x, y = r.x0 + 1.5 + i * 3.0, r.y0 + 1.5 + j * 3.5
                    if j % 2 == 0:   # treadmill
                        add_box(bm, x, x + 0.8, y, y + 1.9, z, z + 0.25, FM["dark"])
                        add_box(bm, x, x + 0.8, y + 1.5, y + 1.9, z + 0.25, z + 1.4, FM["steel"])
                        add_box(bm, x + 0.05, x + 0.75, y + 1.6, y + 1.9, z + 1.25, z + 1.3, FM["dark"])
                    else:            # weight bench + rack
                        add_box(bm, x + 0.15, x + 0.65, y + 0.2, y + 1.5, z + 0.4, z + 0.48, FM["dark"])
                        add_bar(bm, (x - 0.5, y + 1.3, z + 1.1), (x + 1.3, y + 1.3, z + 1.1), 0.015, FM["steel"])
                        add_cyl(bm, x - 0.3, y + 1.3, z + 0.9, z + 1.3, 0.12, FM["dark"], 12)
                        add_cyl(bm, x + 1.1, y + 1.3, z + 0.9, z + 1.3, 0.12, FM["dark"], 12)
            add_box(bm, r.x0 + 0.5, r.x1 - 0.5, r.y1 - 0.04, r.y1 - 0.02, z + 0.3, z + 2.3, FM["mirror"])
            self._accent_wall(bm, r, z, region, mi=FM["navy"])
        elif "recreation" in name or "rec" == name[:3]:
            add_box(bm, r.cx - 1.3, r.cx + 1.3, r.cy - 0.7, r.cy + 0.7, z + 0.7, z + 0.82, FM["desk_wood"])
            add_box(bm, r.cx - 1.2, r.cx + 1.2, r.cy - 0.6, r.cy + 0.6, z + 0.82, z + 0.83, FM["felt"])
            for (dx, dy) in ((-1.15, -0.55), (1.15, -0.55), (-1.15, 0.55), (1.15, 0.55)):
                add_box(bm, r.cx + dx - 0.08, r.cx + dx + 0.08, r.cy + dy - 0.08, r.cy + dy + 0.08, z, z + 0.7, FM["dark"])
            self._pendant(bm, r.cx, r.cy, z_top, drop=1.2)
            self._sofa(bm, r.x0 + 0.4, r.y0 + 0.4, "y", z, FM["blue"])
            self._sofa(bm, r.x1 - 1.3, r.y1 - 2.4, "y", z, FM["purple"])
            self._tv(bm, r, z, region)
            self._accent_wall(bm, r, z, region, mi=FM["navy"])
        elif "music" in name:
            add_box(bm, r.x0 + 0.6, r.x0 + 2.1, r.y0 + 0.6, r.y0 + 1.2, z + 0.7, z + 1.0, FM["dark"])   # upright piano
            add_box(bm, r.x0 + 0.6, r.x0 + 2.1, r.y0 + 0.9, r.y0 + 1.2, z, z + 0.7, FM["dark"])
            add_box(bm, r.x0 + 0.6, r.x0 + 2.1, r.y0 + 0.6, r.y0 + 1.2, z + 1.0, z + 1.3, FM["dark"])
            add_box(bm, r.x0 + 0.9, r.x0 + 1.8, r.y0 + 1.5, r.y0 + 1.9, z, z + 0.5, FM["desk_wood"])
            for k in range(3):
                add_box(bm, r.x1 - 0.5, r.x1 - 0.2, r.y0 + 0.5 + k * 1.2, r.y0 + 0.8 + k * 1.2, z + 1.0, z + 1.9, FM["dark"])
        elif "courtyard" in name:
            for k in range(max(1, int(r.w // 5))):
                x = r.x0 + 1.0 + k * 5.0
                self._sofa(bm, x, r.cy - 0.45, "x", z, FM["blue"] if k % 2 else FM["purple"], length=2.4)
                add_cyl(bm, x + 1.2, r.cy + 1.1, z + 0.38, z + 0.42, 0.4, FM["desk_wood"], 16)
                add_cyl(bm, x + 1.2, r.cy + 1.1, z, z + 0.38, 0.03, FM["steel"], 6)
            self._slat_ceiling(bm, r, z_top)
        elif "academic" in name or "stiles" in name:
            nx, ny = max(1, int((r.w - 2) // 3.2)), max(1, int((r.h - 2) // 2.6))
            for i in range(nx):
                for j in range(ny):
                    x, y = r.x0 + 1.5 + i * 3.2, r.y0 + 1.5 + j * 2.6
                    self._long_table(bm, x, x + 2.0, y, y + 0.8, z)
            self._accent_wall(bm, r, z, region, mi=FM["white"])
            self._accent_wall(bm, R(r.x0, r.y0, r.x1, r.y0 + 1), z, None, mi=FM["lime"])
            for k in range(max(1, int(r.w // 6))):
                self._pendant(bm, r.x0 + 3 + k * 6, r.cy, z_top, drop=0.9)
            self._slat_ceiling(bm, r, z_top)
        else:
            self._lounge(bm, r, z, z_top, region, sofas=True)

    def _corridor(self, bm, r, z, z_top, lv):
        # Continuous light strip down the middle; the yellow light "halo" graphics from the real corridors;
        # a fire extinguisher cabinet every ~25 m and a drinking fountain on long runs.
        horiz = r.w >= r.h
        L = r.w if horiz else r.h
        for k in range(int(L // 25) + 1):
            a = (r.x0 if horiz else r.y0) + 6.0 + k * 25.0
            if a > (r.x1 if horiz else r.y1) - 2:
                break
            if horiz:
                add_box(bm, a, a + 0.3, r.y0 + 0.02, r.y0 + 0.12, z + 1.0, z + 1.75, FM["red"])
                add_box(bm, a + 0.02, a + 0.28, r.y0 + 0.12, r.y0 + 0.125, z + 1.05, z + 1.7, FM["frosted"])
            else:
                add_box(bm, r.x0 + 0.02, r.x0 + 0.12, a, a + 0.3, z + 1.0, z + 1.75, FM["red"])
                add_box(bm, r.x0 + 0.12, r.x0 + 0.125, a + 0.02, a + 0.28, z + 1.05, z + 1.7, FM["frosted"])
        if L > 30:
            if horiz:
                add_box(bm, r.cx - 0.2, r.cx + 0.2, r.y0 + 0.02, r.y0 + 0.4, z + 0.5, z + 0.85, FM["steel"])
            else:
                add_box(bm, r.x0 + 0.02, r.x0 + 0.4, r.cy - 0.2, r.cy + 0.2, z + 0.5, z + 0.85, FM["steel"])
        if horiz:
            add_box(bm, r.x0 + 0.5, r.x1 - 0.5, r.cy - 0.08, r.cy + 0.08, z_top - 0.05, z_top - 0.02, FM["lightpanel"])
            n = int((r.w - 4) // 9)
            for k in range(n):
                x = r.x0 + 4.5 + k * 9
                add_disc(bm, x, r.y1 - 0.07, z + 1.6, 0.7, 0.01, "y", FM["amber"])
                add_disc(bm, x, r.y1 - 0.08, z + 1.6, 0.35, 0.012, "y", FM["white"])
        else:
            add_box(bm, r.cx - 0.08, r.cx + 0.08, r.y0 + 0.5, r.y1 - 0.5, z_top - 0.05, z_top - 0.02, FM["lightpanel"])
            n = int((r.h - 4) // 9)
            for k in range(n):
                y = r.y0 + 4.5 + k * 9
                add_disc(bm, r.x0 + 0.07, y, z + 1.6, 0.7, 0.01, "x", FM["amber"])
                add_disc(bm, r.x0 + 0.08, y, z + 1.6, 0.35, 0.012, "x", FM["white"])

    def _trash_room(self, bm, r, z, z_top):
        n = int(max(1, (r.w - 0.4) // 0.9))
        for k in range(n):
            x = r.x0 + 0.3 + k * 0.9
            mi = (FM["dark"], FM["blue"], FM["lime"])[k % 3]
            add_box(bm, x, x + 0.7, r.y0 + 0.3, r.y0 + 1.1, z + 0.15, z + 1.15, mi)
            add_box(bm, x - 0.02, x + 0.72, r.y0 + 0.28, r.y0 + 1.12, z + 1.15, z + 1.2, mi)
            for (dx, dy) in ((0.1, 0.4), (0.6, 0.4), (0.1, 1.0), (0.6, 1.0)):
                add_cyl(bm, x + dx, r.y0 + dy, z, z + 0.15, 0.06, FM["dark"], 8)
        add_box(bm, r.x0 + 0.2, r.x1 - 0.2, r.y1 - 0.6, r.y1 - 0.2, z, z + 0.9, FM["steel"])       # chute hopper
        add_box(bm, r.cx - 0.4, r.cx + 0.4, r.y1 - 0.9, r.y1 - 0.1, z + 0.9, z_top - 0.3, FM["steel"])

    def _riser(self, bm, r, z, z_top):
        # Cable tray up the shaft, conduit drops, the floor panel itself comes from the equipment list.
        add_box(bm, r.cx - 0.25, r.cx + 0.25, r.y0 + 0.15, r.y0 + 0.25, z, z_top, FM["steel"])
        for k in range(4):
            x = r.x0 + 0.4 + k * (r.w - 0.8) / 3
            add_bar(bm, (x, r.y0 + 0.3, z), (x, r.y0 + 0.3, z_top), 0.02, FM["steel"])
        add_bar(bm, (r.x1 - 0.3, r.cy, z), (r.x1 - 0.3, r.cy, z_top), 0.08, FM["pipe_blue"])

    def _plant_room(self, bm, r, z, z_top, pipes=True):
        # Cable tray / pipe runs along the ceiling, conduit drops, a bollard-yellow floor line.
        if pipes:
            for k, off in enumerate((-0.6, 0.0, 0.6)):
                add_bar(bm, (r.x0 + 0.3, r.cy + off, z_top - 0.4), (r.x1 - 0.3, r.cy + off, z_top - 0.4), 0.06 + 0.03 * (k % 2), FM["pipe_blue"] if k == 1 else FM["steel"])
            add_bar(bm, (r.x0 + 1.0, r.cy, z + 0.1), (r.x0 + 1.0, r.cy, z_top - 0.4), 0.06, FM["pipe_blue"])
        else:
            add_box(bm, r.x0 + 0.3, r.x1 - 0.3, r.cy - 0.25, r.cy + 0.25, z_top - 0.45, z_top - 0.35, FM["steel"])
            for k in range(int((r.w - 1) // 2.5)):
                x = r.x0 + 1.0 + k * 2.5
                add_bar(bm, (x, r.cy, z + 2.2), (x, r.cy, z_top - 0.45), 0.025, FM["steel"])
        add_box(bm, r.x0 + 0.2, r.x1 - 0.2, r.y0 + 0.9, r.y0 + 0.98, z, z + 0.004, FM["amber"])

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
            add_bar(bm, (r.cx, r.y0 + 0.2, z + 0.9), (r.cx, r.y1 - 1.4, z + rise / 2 + 0.9), 0.02, FM["steel"])
            add_bar(bm, (r.cx, r.y1 - 1.4, z + rise / 2 + 0.9), (r.cx, r.y0 + 0.2, z + rise + 0.9), 0.02, FM["steel"])
            for k in range(0, steps, 2):
                y = r.y0 + 0.2 + k * run
                add_bar(bm, (r.cx, y, z + rise / 2 * k / steps), (r.cx, y, z + rise / 2 * k / steps + 0.9), 0.012, FM["steel"])
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
            add_bar(bm, (r.x0 + 0.2, r.cy, z + 0.9), (r.x1 - 1.4, r.cy, z + rise / 2 + 0.9), 0.02, FM["steel"])
            add_bar(bm, (r.x1 - 1.4, r.cy, z + rise / 2 + 0.9), (r.x0 + 0.2, r.cy, z + rise + 0.9), 0.02, FM["steel"])

    def doors_and_signs(self, bm, lv, z):
        """A door leaf in every opening of this level, exit signs over the stair doors."""
        for o in self.spec["openings"]:
            if o["level"] != lv["id"] or o["b"] == "outside" or o["kind"] == "opening":
                continue
            w = min(o["width"], 2.0)
            fixed = o["y"] if o["axis"] == "x" else o["x"]
            c = o["x"] if o["axis"] == "x" else o["y"]
            t = INT_WALL / 2
            if o["kind"] == "lift_door":
                mi, h = FM["steel"], 2.2
            elif o["kind"] == "fire_door":
                mi, h = FM["dark"], 2.1
            else:
                mi, h = FM["desk_wood"], 2.1

            def box(a0, a1, n0, n1, za, zb, m):
                if o["axis"] == "x":
                    add_box(bm, a0, a1, fixed + n0, fixed + n1, za, zb, m)
                else:
                    add_box(bm, fixed + n0, fixed + n1, a0, a1, za, zb, m)

            box(c - w / 2, c + w / 2, -0.02, 0.02, z, z + h, mi)                       # leaf (closed)
            box(c - w / 2 - 0.05, c - w / 2, -t, t, z, z + h + 0.05, FM["dark"])        # jambs + head
            box(c + w / 2, c + w / 2 + 0.05, -t, t, z, z + h + 0.05, FM["dark"])
            box(c - w / 2 - 0.05, c + w / 2 + 0.05, -t, t, z + h, z + h + 0.05, FM["dark"])
            if o["kind"] == "lift_door":
                box(c - 0.01, c + 0.01, -0.025, 0.025, z, z + h, FM["dark"])              # centre seam
            else:
                box(c + w / 2 - 0.12, c + w / 2 - 0.04, -0.05, 0.05, z + 1.0, z + 1.03, FM["steel"])  # handle
            if o["kind"] == "fire_door":
                box(c - 0.18, c + 0.18, -0.03, 0.03, z + h + 0.12, z + h + 0.3, FM["led"])      # exit sign
            if o["kind"] == "lift_door":
                box(c + w / 2 + 0.15, c + w / 2 + 0.25, -t - 0.005, -t, z + 1.0, z + 1.15, FM["steel"])  # call plate

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
                if not self.props.place("shrub_02", x + w / 2, y + h / 2, z + 0.4, scale=(w - 0.8) / 6.6,
                                        name=f"court_shrubs_{s['id']}_{int(x)}_{int(y)}", collection=self.col_props,
                                        props=self._props(lv)):
                    for k in range(4):
                        self._tree(plants, x + 0.7 + k * (w - 1.4) / 3, y + h / 2, z + 0.58, height=1.6, radius=0.55)
            mesh_object(f"court_planters_{s['id']}", bm, [m["concrete"]], self.col_interior, self._props(lv))
            mesh_object(f"court_soil_{s['id']}", soil, [m["soil"]], self.col_interior, self._props(lv))
            mesh_object(f"court_plants_{s['id']}", plants, [m["trunk"], m["canopy"]], self.col_interior, self._props(lv))
            self.trees([(r.x0 + 4.0, r.cy, z + 0.02, 6.5, 2.4, 0.0), (r.x1 - 4.0, r.cy, z + 0.02, 6.0, 2.2, math.pi)],
                       self.col_interior, f"court_trees_{s['id']}", self._props(lv))

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

    def _person(self, bm, x, y, z, rot, pose, rnd):
        """A mannequin about 1.75 m tall from spheres and bars, facing `rot`; pose "stand" or "walk".

        Built in its own bmesh (so every vertex is the figure's), posed, then appended to `bm`."""
        pb = bmesh.new()
        skin = PM[rnd.choice(("skin_a", "skin_b", "skin_c"))]
        shirt = PM[rnd.choice(("shirt_white", "shirt_navy", "shirt_red", "shirt_green", "shirt_yellow", "shirt_grey"))]
        pants = PM[rnd.choice(("jeans", "slacks"))]
        sc = rnd.uniform(0.92, 1.06)
        walk = pose == "walk"
        swing = rnd.uniform(0.6, 1.0) if walk else 0.0

        def paint(nf, mi):
            pb.faces.ensure_lookup_table()
            for f in pb.faces[nf:]:
                f.material_index = mi

        def ball(p, r, mi, sz=1.0):
            nf = len(pb.faces)
            res = bmesh.ops.create_icosphere(pb, subdivisions=2, radius=r)
            for v in res["verts"]:
                v.co = Vector(p) + Vector((v.co.x, v.co.y, v.co.z * sz))
            paint(nf, mi)

        def tube(p0, p1, r0, r1, mi, flat=1.0):
            a, b = Vector(p0), Vector(p1)
            d = b - a
            nf = len(pb.faces)
            res = bmesh.ops.create_cone(pb, cap_ends=True, segments=10, radius1=r0, radius2=r1, depth=d.length)
            m = d.normalized().to_track_quat("Z", "Y").to_matrix()
            mid = (a + b) / 2
            for v in res["verts"]:
                v.co = mid + m @ Vector((v.co.x * flat, v.co.y, v.co.z))
            paint(nf, mi)

        # local frame: +x forward, +y left, +z up
        tube((0, 0, 0.92), (0, 0, 1.45), 0.15, 0.19, shirt, flat=0.62)        # torso
        tube((0, 0, 0.80), (0, 0, 0.93), 0.15, 0.16, pants, flat=0.68)        # hips
        tube((0, 0, 1.43), (0, 0, 1.56), 0.045, 0.045, skin)                   # neck
        ball((0, 0, 1.65), 0.105, skin)                                        # head
        ball((0, 0, 1.69), 0.108, PM["hair"], sz=0.72)                         # hair cap
        for side in (1, -1):
            fwd = swing * 0.17 * side                                           # legs scissor, arms counter-swing
            hip = (0, side * 0.09, 0.84)
            knee = (fwd, side * 0.09, 0.46)
            ankle = (fwd * 1.5, side * 0.09, 0.06)
            tube(hip, knee, 0.075, 0.06, pants)
            ball(knee, 0.06, pants)
            tube(knee, ankle, 0.06, 0.05, pants)
            tube((ankle[0] - 0.06, ankle[1], 0.04), (ankle[0] + 0.14, ankle[1], 0.04), 0.045, 0.04, PM["shoe"])
            sh = (0, side * 0.23, 1.42)
            elbow = (-fwd * 0.8, side * 0.25, 1.15)
            hand = (-fwd * 1.2 + 0.04, side * 0.25, 0.90)
            tube(sh, elbow, 0.05, 0.045, shirt)
            ball(elbow, 0.045, shirt)
            tube(elbow, hand, 0.045, 0.04, skin)
            ball(hand, 0.045, skin)
        ball((0, 0.23, 1.42), 0.055, shirt)
        ball((0, -0.23, 1.42), 0.055, shirt)
        c, sn = math.cos(rot), math.sin(rot)
        for v in pb.verts:
            lx, ly, lz = v.co.x * sc, v.co.y * sc, v.co.z * sc
            v.co = Vector((x + c * lx - sn * ly, y + sn * lx + c * ly, z + lz))
        for f in pb.faces:
            f.smooth = True
        tmp = bpy.data.meshes.new("tmp_person")
        pb.to_mesh(tmp)
        pb.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)

    def build_people(self):
        """Mannequins on the sidewalks, at the entrance and bus stop, in the courtyards, lobby, lounges,
        corridors and a share of the rooms. Static dressing only: the live link draws the real residents."""
        import random
        rnd = random.Random(23)
        m = self.mats
        mats = [m[k] for k in PEOPLE_MATS]
        inside = lambda r, x, y: r.x0 + 0.6 <= x <= r.x1 - 0.6 and r.y0 + 0.6 <= y <= r.y1 - 0.6
        if self.with_site:
            b = R(min(r.x0 for r in self.footprint), min(r.y0 for r in self.footprint),
                  max(r.x1 for r in self.footprint), max(r.y1 for r in self.footprint))
            bm = bmesh.new()
            for _ in range(9):     # Dana St sidewalk
                self._person(bm, rnd.uniform(b.x0 - 3.4, b.x0 - 0.9), rnd.uniform(b.y0 - 3, b.y1 + 3), 0.0,
                             rnd.choice((math.pi / 2, -math.pi / 2)) + rnd.uniform(-0.3, 0.3), "walk", rnd)
            for _ in range(8):     # Durant Ave sidewalk
                self._person(bm, rnd.uniform(b.x0 - 3, b.x1 + 3), rnd.uniform(b.y0 - 3.4, b.y0 - 0.9), 0.0,
                             rnd.choice((0.0, math.pi)) + rnd.uniform(-0.3, 0.3), "walk", rnd)
            for _ in range(4):     # Bancroft side
                self._person(bm, rnd.uniform(b.x0 - 3, b.x1 + 3), rnd.uniform(b.y1 + 0.9, b.y1 + 3.4), 0.0,
                             rnd.choice((0.0, math.pi)) + rnd.uniform(-0.3, 0.3), "walk", rnd)
            for _ in range(5):     # far sidewalks across the streets
                if rnd.random() < 0.5:
                    self._person(bm, rnd.uniform(b.x0 - SITE_PAD + 0.9, b.x0 - SITE_PAD + 3.2), rnd.uniform(b.y0 - 10, b.y1 + 10),
                                 0.0, rnd.choice((math.pi / 2, -math.pi / 2)), "walk", rnd)
                else:
                    self._person(bm, rnd.uniform(b.x0 - 10, b.x1 + 10), rnd.uniform(b.y0 - SITE_PAD + 0.9, b.y0 - SITE_PAD + 3.2),
                                 0.0, rnd.choice((0.0, math.pi)), "walk", rnd)
            # a pair talking by the main entrance, two waiting at the bus stop
            self._person(bm, b.x0 + 5.6, b.y0 - 1.7, 0.0, 0.0, "stand", rnd)
            self._person(bm, b.x0 + 6.6, b.y0 - 1.9, 0.0, math.pi, "stand", rnd)
            self._person(bm, b.x0 + 12.6, b.y0 - 2.2, 0.0, -math.pi / 2, "stand", rnd)
            self._person(bm, b.x0 + 14.2, b.y0 - 1.9, 0.0, -math.pi / 2 - 0.4, "stand", rnd)
            mesh_object("site_people", bm, mats, self.col_props)
        if not self.with_interior:
            return
        for lv in self.ordered:
            z = lv["elevation"] + SLAB + 0.02
            bm = bmesh.new()
            for sp in self.spaces_by_level.get(lv["id"], []):
                r = R.of(sp["rect"])
                kind = sp["kind"]
                if sp["outdoor"]:
                    if kind == "courtyard":
                        for (dx, dy) in ((-4.5, 2.6), (4.2, -3.1), (-1.2, 3.6), (3.6, 3.2)):
                            if inside(r, r.cx + dx, r.cy + dy):
                                self._person(bm, r.cx + dx, r.cy + dy, z, rnd.uniform(0, 2 * math.pi), rnd.choice(("stand", "walk")), rnd)
                    continue
                if kind == "lobby":
                    self._person(bm, r.cx - 0.6, r.cy + 1.0, z, 0.3, "stand", rnd)
                    self._person(bm, r.cx + 0.5, r.cy + 1.1, z, math.pi - 0.3, "stand", rnd)
                    self._person(bm, r.cx - 3.0, r.cy - 3.0, z, math.pi / 2, "walk", rnd)
                    self._person(bm, r.cx + 3.5, r.cy - 1.0, z, -math.pi / 2, "walk", rnd)
                elif kind in ("lounge", "study", "kitchen", "amenity") and r.w > 3 and r.h > 3:
                    n = 2 if kind == "lounge" else 1
                    for k in range(n):
                        self._person(bm, r.cx + rnd.uniform(-0.8, 0.8), r.cy + rnd.uniform(-0.8, 0.8), z,
                                     rnd.uniform(0, 2 * math.pi), "stand", rnd)
                elif kind == "corridor":
                    length = max(r.w, r.h)
                    for k in range(int(length // 18)):
                        t = (k + 0.5) / max(1, int(length // 18))
                        if r.w > r.h:
                            self._person(bm, r.x0 + t * r.w, r.cy, z, rnd.choice((0.0, math.pi)), "walk", rnd)
                        else:
                            self._person(bm, r.cx, r.y0 + t * r.h, z, rnd.choice((math.pi / 2, -math.pi / 2)), "walk", rnd)
                elif kind == "room" and rnd.random() < 0.22:
                    self._person(bm, r.cx, r.cy, z, rnd.uniform(0, 2 * math.pi), "stand", rnd)
            if bm.faces:
                mesh_object(f"people_{lv['id']}", bm, mats, self.col_props, self._props(lv))
            else:
                bm.free()

    def trees(self, items, collection, name, props=None):
        """Trees at (x, y, z, height, radius): photoscanned instances when the models are downloaded (a small
        upright species under 5 m, a broad one above), otherwise the procedural clumps into `collection`."""
        import random
        rnd = random.Random(sum(map(ord, name)))
        placed = 0
        for i, item in enumerate(items):
            x, y, z, h, r = item[:5]
            away = item[5] if len(item) > 5 else None
            # both scans spread furthest along local -y; turn that side towards `away` (radians) when given
            rot = (away + math.pi / 2 + rnd.uniform(-0.3, 0.3)) if away is not None else rnd.uniform(0, 2 * math.pi)
            asset = "tree_small_02" if h <= 5.0 else "island_tree_02"
            if self.props.get(asset) is None:
                asset = "island_tree_02" if asset == "tree_small_02" else "tree_small_02"
            if self.props.get(asset) is None:
                break
            scale = min(h / self.props.height(asset), 3.2) * rnd.uniform(0.92, 1.08)
            ob = self.props.place(asset, x, y, z, rot=rot, scale=scale,
                                  name=f"{name}_{i}", collection=self.col_props, props=props)
            placed += ob is not None
        if placed:
            return
        bm = bmesh.new()
        for item in items:
            self._tree(bm, *item[:5])
        mesh_object(name, bm, [self.mats["trunk"], self.mats["canopy"]], collection, props)

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
        add_box(bm, b.x0 - 6000, b.x1 + 6000, b.y0 - 6000, b.y1 + 6000, z - 1.0, z - 0.21, 0)
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
        road_far = SITE_PAD - 4.0          # far curb of each street
        for k in range(8):
            add_box(bm, b.x0 - 2.5 + k * 1.2, b.x0 - 2.5 + k * 1.2 + 0.6, b.y0 - road_far + 1, b.y0 - 5, z - 0.199, z - 0.19, 0)
            add_box(bm, b.x0 - road_far + 1, b.x0 - 5, b.y0 - 2.5 + k * 1.2, b.y0 - 2.5 + k * 1.2 + 0.6, z - 0.199, z - 0.19, 0)
        mid = (4.0 + road_far) / 2
        for k in range(0, 120, 6):
            add_box(bm, b.x0 - mid - 0.1, b.x0 - mid + 0.1, b.y0 - SITE_PAD + k, b.y0 - SITE_PAD + k + 3, z - 0.199, z - 0.19, 0)
            add_box(bm, b.x0 - SITE_PAD + k, b.x0 - SITE_PAD + k + 3, b.y0 - mid - 0.1, b.y0 - mid + 0.1, z - 0.199, z - 0.19, 0)
        mesh_object("site_markings", bm, [m["laminate"]], self.col_site)
        self.build_neighbourhood(b, z)
        self.build_far_city(b, z)
        items = [(b.x0 - 2.7, y, z, 6.5, 2.4, math.pi) for y in range(8, int(b.y1) - 4, 12)]
        for x in range(10, int(b.x1) - 4, 12):
            items += [(x, b.y0 - 2.7, z, 6.5, 2.4, -math.pi / 2), (x, b.y1 + 2.7, z, 6.5, 2.4, math.pi / 2)]
        self.trees(items, self.col_site, "site_trees")
        bm = bmesh.new()
        for (x, y) in ((b.x0 - 1.5, b.y0 - 1.5), (b.x1 + 1.5, b.y0 - 1.5), (b.x0 - 1.5, b.y1 + 1.5), (b.x0 - 1.5, 40)):
            add_cyl(bm, x, y, z, z + 7.0, 0.1, 0, 8)
            add_box(bm, x - 0.3, x + 0.3, y - 0.12, y + 0.12, z + 6.8, z + 7.0, 0)
        mesh_object("site_lampposts", bm, [m["metal"]], self.col_site)
        self.build_street_furniture(b)

    def build_far_city(self, b, z):
        """Blocks of plain buildings from beyond the modelled neighbours out to ~450 m, so the hero and street
        cameras see a city skyline instead of bare ground. Lower and greener to the north (campus)."""
        import random
        rnd = random.Random(11)
        m = self.mats
        keys = ["far_cream", "far_white", "far_grey", "far_brick", "far_sage", "far_tan"]
        meshes = {k: bmesh.new() for k in keys}
        trees = []
        pitch, near, far = 38.0, 78.0, 460.0
        cx, cy = (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2
        walk = 4.0
        # right-of-way of Dana St (x range), Durant Ave and Bancroft Way (y ranges), curb to curb plus sidewalks
        dana = (b.x0 - SITE_PAD, b.x0)
        durant = (b.y0 - SITE_PAD, b.y0)
        bancroft = (b.y1, b.y1 + SITE_PAD)

        def on_street(x0, x1, y0, y1):
            return (x0 < dana[1] and x1 > dana[0]) or (y0 < durant[1] and y1 > durant[0]) or (y0 < bancroft[1] and y1 > bancroft[0])

        roads, walks, dashes = bmesh.new(), bmesh.new(), bmesh.new()
        # Beyond the modelled blocks only: Dana St runs south (it ends at Bancroft, the campus edge);
        # Durant Ave and Bancroft Way run east and west.
        lo, hi = dana
        ya, yb = cy - far, b.y0 - SITE_PAD - 26
        add_box(roads, lo + walk, hi - walk, ya, yb, z - 0.6, z - 0.2, 0)
        add_box(walks, lo, lo + walk, ya, yb, z - 0.2, z, 0)
        add_box(walks, hi - walk, hi, ya, yb, z - 0.2, z, 0)
        for k in range(int(ya), int(yb) - 3, 6):
            add_box(dashes, (lo + hi) / 2 - 0.1, (lo + hi) / 2 + 0.1, k, k + 3, z - 0.199, z - 0.19, 0)
        for (lo, hi) in (durant, bancroft):
            for (xa, xb) in ((cx - far, b.x0 - SITE_PAD - 24), (b.x1 + SITE_PAD + 24, cx + far)):
                add_box(roads, xa, xb, lo + walk, hi - walk, z - 0.6, z - 0.2, 0)
                add_box(walks, xa, xb, lo, lo + walk, z - 0.2, z, 0)
                add_box(walks, xa, xb, hi - walk, hi, z - 0.2, z, 0)
                for k in range(int(xa), int(xb) - 3, 6):
                    add_box(dashes, k, k + 3, (lo + hi) / 2 - 0.1, (lo + hi) / 2 + 0.1, z - 0.199, z - 0.19, 0)
        mesh_object("site_far_roads", roads, [m["asphalt"]], self.col_site)
        mesh_object("site_far_walks", walks, [m["sidewalk"]], self.col_site)
        mesh_object("site_far_dashes", dashes, [m["laminate"]], self.col_site)
        gx0, gx1 = int((cx - far) // pitch), int((cx + far) // pitch) + 1
        gy0, gy1 = int((cy - far) // pitch), int((cy + far) // pitch) + 1
        for i in range(gx0, gx1):
            for j in range(gy0, gy1):
                x, y = i * pitch, j * pitch
                if b.x0 - near < x + pitch and x < b.x1 + near and b.y0 - near < y + pitch and y < b.y1 + near:
                    continue                                   # the modelled blocks live here
                if y > b.y1 + near and rnd.random() < 0.45:   # campus: open ground and trees
                    if rnd.random() < 0.6:
                        trees.append((x + rnd.uniform(6, pitch - 6), y + rnd.uniform(6, pitch - 6), z, rnd.uniform(9, 14), 4.0))
                    continue
                if rnd.random() < 0.08:
                    continue
                w = rnd.uniform(14, pitch - 10)
                d = rnd.uniform(14, pitch - 10)
                ox = x + rnd.uniform(3, pitch - 3 - w)
                oy = y + rnd.uniform(3, pitch - 3 - d)
                if on_street(ox - 3, ox + w + 3, oy - 3, oy + d + 3):
                    continue
                dist = math.hypot(max(0.0, abs(x - cx) - (b.x1 - b.x0) / 2), max(0.0, abs(y - cy) - (b.y1 - b.y0) / 2))
                h = rnd.choice((6.5, 9.5, 9.5, 12.5, 12.5, 16.0)) * (1.0 + 0.0015 * dist)
                bm = meshes[rnd.choice(keys)]
                add_box(bm, ox, ox + w, oy, oy + d, z - 0.6, z + h, 0)
                if rnd.random() < 0.5:                        # a stair / lift box on the roof
                    add_box(bm, ox + 2, ox + 6, oy + 2, oy + 5, z + h, z + h + 2.6, 0)
        for k, bm in meshes.items():
            mesh_object(f"site_far_{k}", bm, [m[k]], self.col_site)
        if trees:
            self.trees(trees, self.col_site, "site_far_trees")

    def build_neighbourhood(self, b, z):
        """Berkeley-style neighbours: stucco apartment blocks with punched windows and shopfronts, a few
        gabled houses, the campus edge north of Bancroft with lawn and big trees, parked cars, poles."""
        m = self.mats
        import random
        rnd = random.Random(7)
        stucco = [m["stucco_cream"], m["stucco_sage"], m["stucco_terracotta"], m["stucco_grey"], m["brick"]]
        e, w, so = b.x1 + SITE_PAD, b.x0 - SITE_PAD, b.y0 - SITE_PAD
        blocks = [  # (x0, y0, x1, y1, storeys, kind)
            (e, 2, e + 22, 30, 3, "apartments"),
            (e, 34, e + 18, 56, 4, "apartments"),
            (e, 60, e + 22, 82, 2, "houses"),
            (w - 22, 2, w, 24, 4, "apartments"),
            (w - 22, 28, w, 46, 2, "houses"),
            (w - 22, 50, w, 82, 3, "apartments"),
            (w - 22, so - 24, w, so, 3, "apartments"),
            (w + 4, so - 24, 40, so, 2, "shops"),
            (46, so - 24, 70, so, 3, "apartments"),
        ]
        walls = bmesh.new()      # per-material faces -> material index = stucco choice
        glass = bmesh.new()
        trim = bmesh.new()
        roofs = bmesh.new()
        for (x0, y0, x1, y1, storeys, kind) in blocks:
            mi = rnd.randrange(len(stucco))
            if kind == "houses":
                n = max(1, int((x1 - x0) // 9))
                for k in range(n):
                    hx0 = x0 + k * (x1 - x0) / n + 0.8
                    hx1 = x0 + (k + 1) * (x1 - x0) / n - 0.8
                    hy0, hy1 = y0 + 2.0, y1 - 4.0
                    h = 6.5
                    add_box(walls, hx0, hx1, hy0, hy1, z, z + h, mi)
                    # gable roof: two sloped slabs
                    ridge = (hy0 + hy1) / 2
                    for (ya, yb, flip) in ((hy0 - 0.4, ridge, False), (ridge, hy1 + 0.4, True)):
                        vs = [roofs.verts.new(c) for c in (
                            (hx0 - 0.4, ya, z + h - 0.1 if not flip else z + h + 2.2),
                            (hx1 + 0.4, ya, z + h - 0.1 if not flip else z + h + 2.2),
                            (hx1 + 0.4, yb, z + h + 2.2 if not flip else z + h - 0.1),
                            (hx0 - 0.4, yb, z + h + 2.2 if not flip else z + h - 0.1))]
                        f = roofs.faces.new(vs)
                        f.material_index = 0
                    for (yv, zv) in ((hy0, z + h), (hy1, z + h)):
                        pass
                    # windows + door on the street side
                    for wx in (hx0 + 1.2, hx0 + 3.6):
                        for wz in (z + 1.0, z + 3.9):
                            self._punched(glass, trim, "x", hy0, -1, wx, wx + 1.2, wz, wz + 1.5)
                    self._punched(glass, trim, "x", hy0, -1, hx1 - 2.2, hx1 - 1.2, z, z + 2.1, door=True)
                    add_box(trim, hx1 - 2.6, hx1 - 0.8, hy0 - 1.2, hy0, z + 2.2, z + 2.35, 0)   # porch roof
                    add_cyl(trim, hx1 - 2.5, hy0 - 1.1, z, z + 2.2, 0.06, 0, 8)
                    add_cyl(trim, hx1 - 0.9, hy0 - 1.1, z, z + 2.2, 0.06, 0, 8)
                continue
            h = storeys * 3.3 + (1.5 if kind == "shops" else 0.6)
            add_box(walls, x0, x1, y0, y1, z, z + h, mi)
            add_box(roofs, x0 - 0.1, x1 + 0.1, y0 - 0.1, y1 + 0.1, z + h, z + h + 0.6, 1)           # parapet
            add_box(roofs, x0 + 0.3, x1 - 0.3, y0 + 0.3, y1 - 0.3, z + h + 0.02, z + h + 0.1, 2)   # membrane
            for (ux, uy) in ((x0 + 3, y0 + 3), (x1 - 5, y1 - 4)):
                add_box(roofs, ux, ux + 2.2, uy, uy + 1.4, z + h + 0.1, z + h + 1.2, 1)
            # which faces look at a street (the building sits between the streets and these blocks)
            faces = []
            if x0 > b.x1:
                faces.append(("y", x0, -1, y0, y1))
            if x1 < b.x0:
                faces.append(("y", x1, +1, y0, y1))
            if y1 < b.y0:
                faces.append(("x", y1, +1, x0, x1))
            if y0 > b.y1:
                faces.append(("x", y0, -1, x0, x1))
            for (axis, fixed, sign, lo, hi) in faces:
                for st in range(storeys):
                    zb = z + st * 3.3 + (1.5 if (kind == "shops" and st > 0) else 0)
                    if kind == "shops" and st == 0:
                        n = max(1, int((hi - lo) // 6))
                        for k in range(n):
                            a0 = lo + k * (hi - lo) / n + 0.5
                            a1 = lo + (k + 1) * (hi - lo) / n - 0.5
                            self._punched(glass, trim, axis, fixed, sign, a0, a1, z + 0.3, z + 3.6, shop=True)
                            self._awning(trim, axis, fixed, sign, a0, a1, z + 3.7, k % 3)
                        continue
                    pitch = 3.0
                    n = max(1, int((hi - lo) // pitch))
                    for k in range(n):
                        c = lo + (hi - lo) * (k + 0.5) / n
                        if rnd.random() < 0.08:
                            continue
                        self._punched(glass, trim, axis, fixed, sign, c - 0.7, c + 0.7, zb + 0.9, zb + 2.6)
        mesh_object("site_neighbours", walls, stucco, self.col_site)
        mesh_object("site_neighbour_glass", glass, [m["glass"]], self.col_site)
        mesh_object("site_neighbour_trim", trim, [m["frame"], m["awning_red"], m["awning_green"], m["awning_blue"]], self.col_site)
        mesh_object("site_neighbour_roofs", roofs, [m["roof_tile"], m["stucco_cream"], m["roof"]], self.col_site)
        # Campus edge north of Bancroft: lawn, path, big trees, a low campus wall.
        bm = bmesh.new()
        n0 = b.y1 + SITE_PAD
        add_box(bm, b.x0 - 42, 70, n0, n0 + 60, z - 0.05, z + 0.1, 0)
        add_box(bm, b.x0 - 42, 70, n0, n0 + 0.6, z + 0.1, z + 0.6, 1)
        add_box(bm, 14, 18, n0, n0 + 60, z + 0.1, z + 0.12, 2)
        mesh_object("site_campus", bm, [m["lawn"], m["concrete"], m["paving"]], self.col_site)
        self.trees([(x, y, z + 0.1, hgt, rad) for (x, y, hgt, rad) in
                    ((-20, n0 + 10, 14, 5.5), (0, n0 + 18, 16, 6.5), (26, n0 + 8, 13, 5.0),
                     (44, n0 + 20, 17, 7.0), (60, n0 + 6, 12, 4.8), (10, n0 + 34, 15, 6.0))],
                   self.col_site, "site_campus_trees")
        # Parked cars along the curbs, utility poles with wires on the far side of Dana, a bus stop.
        bm = bmesh.new()
        colours = [m["car_white"], m["car_silver"], m["car_black"], m["car_red"], m["car_blue"]]
        k = 0
        for y in range(6, int(b.y1) - 6, 7):
            if rnd.random() < 0.7:
                self._car(bm, b.x0 - 6.2, y, "y", k % len(colours)); k += 1
            if rnd.random() < 0.6:
                self._car(bm, b.x0 - SITE_PAD + 6.2, y + 3, "y", k % len(colours)); k += 1
        for x in range(8, int(b.x1) - 6, 7):
            if rnd.random() < 0.7:
                self._car(bm, x, b.y0 - 6.2, "x", k % len(colours)); k += 1
            if rnd.random() < 0.6:
                self._car(bm, x + 3, b.y0 - SITE_PAD + 6.2, "x", k % len(colours)); k += 1
        cars = mesh_object("site_cars", bm, colours + [m["glass"], m["dark"]], self.col_site)
        for poly in cars.data.polygons:
            poly.use_smooth = True
        mod = cars.modifiers.new("round", "BEVEL")     # a wide bevel turns the boxes into body shells
        mod.width, mod.segments = 0.16, 4
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(50)
        if hasattr(mod, "harden_normals"):
            mod.harden_normals = True
        bm = bmesh.new()
        px = b.x0 - SITE_PAD + 2.0
        poles = [(px, y) for y in range(-30, int(b.y1) + 30, 30)]
        for (x, y) in poles:
            add_cyl(bm, x, y, z, z + 10.0, 0.14, 0, 8)
            add_box(bm, x - 1.1, x + 1.1, y - 0.08, y + 0.08, z + 9.2, z + 9.35, 0)
        for i in range(len(poles) - 1):
            (xa, ya), (xb, yb) = poles[i], poles[i + 1]
            for dx in (-0.9, 0.0, 0.9):
                add_bar(bm, (xa + dx, ya, z + 9.35), (xb + dx, yb, z + 9.35 - 0.0), 0.012, 1)
        mesh_object("site_poles", bm, [m["trunk"], m["dark"]], self.col_site)
        bm = bmesh.new()
        sx, sy = b.x0 + 12.0, b.y0 - 2.4
        for (x, y) in ((sx, sy - 0.9), (sx + 3.6, sy - 0.9), (sx, sy + 0.9), (sx + 3.6, sy + 0.9)):
            add_cyl(bm, x, y, z, z + 2.5, 0.04, 0, 8)
        add_box(bm, sx - 0.3, sx + 3.9, sy - 1.2, sy + 1.2, z + 2.5, z + 2.6, 0)
        add_box(bm, sx - 0.3, sx + 3.9, sy + 0.9, sy + 0.95, z + 0.3, z + 2.5, 1)
        add_box(bm, sx, sx + 3.6, sy - 0.2, sy + 0.3, z + 0.45, z + 0.5, 0)
        if not self.props.place("fire_hydrant", sx - 1.0, sy, z, rot=math.radians(90), name="site_hydrant",
                                collection=self.col_props):
            add_cyl(bm, sx - 1.0, sy, z, z + 0.75, 0.12, 2, 10)                  # hydrant
            add_cyl(bm, sx - 1.0, sy, z + 0.75, z + 0.85, 0.08, 2, 10)
        mesh_object("site_bus_stop", bm, [m["metal"], m["frosted"], m["awning_red"]], self.col_site)
        # Bancroft Way bike lane (green) and lane arrows.
        bm = bmesh.new()
        add_box(bm, b.x0 - SITE_PAD, b.x1 + SITE_PAD, b.y1 + 4.2, b.y1 + 6.4, z - 0.199, z - 0.192, 0)
        add_box(bm, b.x0 - SITE_PAD, b.x1 + SITE_PAD, b.y1 + 6.4, b.y1 + 6.55, z - 0.199, z - 0.19, 1)
        mesh_object("site_bike_lane", bm, [m["bike_lane"], m["laminate"]], self.col_site)

    def _punched(self, glass, trim, axis, fixed, sign, a0, a1, z0, z1, door=False, shop=False):
        """A window (or door / shopfront) on a neighbour facade: dark frame, glass set 12 cm back."""
        def box(bm, lo, hi, n0, n1, za, zb, mi):
            p0, p1 = sorted((fixed + sign * n0, fixed + sign * n1))
            if axis == "x":
                add_box(bm, lo, hi, p0, p1, za, zb, mi)
            else:
                add_box(bm, p0, p1, lo, hi, za, zb, mi)
        t = 0.08
        box(glass, a0, a1, 0.01, -0.12, z0, z1, 0)
        box(trim, a0 - t, a0, 0.02, -0.14, z0 - t, z1 + t, 0)
        box(trim, a1, a1 + t, 0.02, -0.14, z0 - t, z1 + t, 0)
        box(trim, a0, a1, 0.02, -0.14, z1, z1 + t, 0)
        box(trim, a0 - t, a1 + t, 0.06, -0.14, z0 - t, z0, 0)                       # sill
        if door:
            box(trim, (a0 + a1) / 2 - 0.02, (a0 + a1) / 2 + 0.02, 0.0, -0.1, z0, z1, 0)
        if shop:
            n = max(1, int((a1 - a0) // 2.0))
            for k in range(1, n):
                a = a0 + (a1 - a0) * k / n
                box(trim, a - 0.03, a + 0.03, 0.02, -0.12, z0, z1, 0)

    def _awning(self, trim, axis, fixed, sign, a0, a1, z, colour):
        n0, n1 = sorted((fixed + sign * 0.0, fixed + sign * 1.3))
        if axis == "x":
            add_box(trim, a0, a1, n0, n1, z, z + 0.08, 1 + colour)
            add_box(trim, a0, a1, n0 if sign > 0 else n1 - 0.05, n0 + 0.05 if sign > 0 else n1, z - 0.25, z, 1 + colour)
        else:
            add_box(trim, n0, n1, a0, a1, z, z + 0.08, 1 + colour)
            add_box(trim, n0 if sign > 0 else n1 - 0.05, n0 + 0.05 if sign > 0 else n1, a0, a1, z - 0.25, z, 1 + colour)

    def _car(self, bm, x, y, axis, colour):
        """A parked car: two stacked bodies, glass cabin, four wheels. `x, y` is the centre."""
        L, W = 4.4, 1.8
        self._car_n = getattr(self, "_car_n", 0) + 1
        if self._car_n % 4 == 0 and self.props.place("covered_car", x, y, 0.0, rot=0.0 if axis == "y" else math.radians(90),
                                                     name=f"site_car_covered_{self._car_n}", collection=self.col_props):
            return
        if axis == "y":
            x0, x1, y0, y1 = x - W / 2, x + W / 2, y - L / 2, y + L / 2
            add_box(bm, x0, x1, y0, y1, 0.3, 0.85, colour)
            add_box(bm, x0 + 0.12, x1 - 0.12, y0 + 0.9, y1 - 1.1, 0.85, 1.42, 5)        # cabin glass
            add_box(bm, x0 + 0.08, x1 - 0.08, y0 + 1.15, y1 - 1.35, 1.38, 1.46, colour)  # roof
            for (dx, dy) in ((0, 0.75), (0, L - 0.75)):
                add_disc(bm, x0 - 0.02, y0 + dy, 0.32, 0.32, 0.22, "x", 6)
                add_disc(bm, x1 + 0.02, y0 + dy, 0.32, 0.32, 0.22, "x", 6)
        else:
            x0, x1, y0, y1 = x - L / 2, x + L / 2, y - W / 2, y + W / 2
            add_box(bm, x0, x1, y0, y1, 0.3, 0.85, colour)
            add_box(bm, x0 + 0.9, x1 - 1.1, y0 + 0.12, y1 - 0.12, 0.85, 1.42, 5)
            add_box(bm, x0 + 1.15, x1 - 1.35, y0 + 0.08, y1 - 0.08, 1.38, 1.46, colour)
            for dx in (0.75, L - 0.75):
                add_disc(bm, x0 + dx, y0 - 0.02, 0.32, 0.32, 0.22, "y", 6)
                add_disc(bm, x0 + dx, y1 + 0.02, 0.32, 0.32, 0.22, "y", 6)

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
        for (x, y) in ((b.x0 - 6.0, b.y0 - 6.0), (b.x0 - 6.0, b.y0 - SITE_PAD + 2.5), (b.x0 - SITE_PAD + 2.5, b.y0 - 6.0)):
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

        hero = camera("HeroCam", (b.x0 - 34, b.y0 - 40, 36), ((b.x0 + b.x1) / 2 - 2, (b.y0 + b.y1) / 2 - 8, self.roof_z * 0.4), 30)
        camera("StreetCam", (b.x0 - 11, b.y0 - 14, 2.4), (b.x0 + 9, b.y0 + 12, 9.5), 20)
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
        sun_data.energy = 8.0
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
            if hasattr(sky, "dust_density"):
                sky.dust_density = 0.35                 # less haze: a deeper blue down to the horizon
            bg.inputs[1].default_value = 0.03
            world.node_tree.links.new(sky.outputs[0], bg.inputs[0])
            self.build_hdri(world, bg, sun)
        scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
        try:
            scene.view_settings.view_transform = "AgX"
            scene.view_settings.exposure = 0.65
            for look in ("AgX - Punchy", "AgX - High Contrast", "AgX - Medium High Contrast"):
                try:
                    scene.view_settings.look = look
                    break
                except TypeError:
                    continue
            print("view transform:", scene.view_settings.view_transform, "/", scene.view_settings.look)
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

    def build_hdri(self, world, bg, sun):
        """A partly cloudy sky HDRI (when downloaded) for ambient light and glass reflections, turned so its
        sun sits behind the Sun lamp, with its hot spot clamped so the lamp stays the only hard shadow."""
        hdri = _manifest().get("hdri")
        path = TEX_DIR / hdri["file"] if hdri else None
        if not path or not path.exists():
            return
        nt = world.node_tree
        for n in list(nt.nodes):
            if n.type == "TEX_ENVIRONMENT":
                nt.nodes.remove(n)
        sky_link = next((lk for lk in nt.links if lk.to_node == bg and lk.to_socket.name == "Color"), None)
        sky_out = sky_link.from_socket if sky_link else None
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(str(path), check_existing=True)
        img = env.image
        # Brightest pixel -> the HDRI's sun direction (Blender equirect: u = 0.5 - atan2(y, x) / 2pi).
        try:
            import numpy as np
            w, h = img.size
            buf = np.empty(w * h * img.channels, dtype=np.float32)
            img.pixels.foreach_get(buf)
            lum = buf.reshape(h, w, img.channels)[:, :, :3].sum(axis=2)
            iy, ix = np.unravel_index(int(lum.argmax()), lum.shape)
            phi_hdri = (0.5 - (ix + 0.5) / w) * 2 * math.pi
        except Exception as exc:
            print("hdri sun not located, leaving unrotated:", exc)
            phi_hdri = None
        mp = nt.nodes.new("ShaderNodeMapping")
        tc = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], env.inputs["Vector"])
        if phi_hdri is not None:
            to_sun = sun.rotation_euler.to_matrix() @ Vector((0.0, 0.0, 1.0))
            phi_lamp = math.atan2(to_sun.y, to_sun.x)
            mp.inputs["Rotation"].default_value = (0.0, 0.0, phi_hdri - phi_lamp)
            print(f"hdri rotation about z: {phi_hdri - phi_lamp:.4f} rad (sun azimuth {phi_lamp:.4f} rad from +x, "
                  f"elevation {math.asin(max(-1.0, min(1.0, to_sun.normalized().z))):.4f} rad)")
        clamp = nt.nodes.new("ShaderNodeVectorMath")
        clamp.operation = "MINIMUM"
        clamp.inputs[1].default_value = (12.0, 12.0, 12.0)
        nt.links.new(env.outputs["Color"], clamp.inputs[0])
        out = next((n for n in nt.nodes if n.type == "OUTPUT_WORLD"), None)
        if sky_out is not None and out is not None:
            # Camera rays see the physical sky (deep blue, clean horizon); everything else is lit by the HDRI.
            light_bg = nt.nodes.new("ShaderNodeBackground")
            nt.links.new(clamp.outputs[0], light_bg.inputs[0])
            light_bg.inputs[1].default_value = 1.0
            lp = nt.nodes.new("ShaderNodeLightPath")
            mix = nt.nodes.new("ShaderNodeMixShader")
            nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs[0])
            nt.links.new(light_bg.outputs[0], mix.inputs[1])
            nt.links.new(bg.outputs[0], mix.inputs[2])
            nt.links.new(mix.outputs[0], out.inputs["Surface"])
        else:
            nt.links.new(clamp.outputs[0], bg.inputs[0])
            bg.inputs[1].default_value = 1.0
        print("hdri sky:", path.name)

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

    def build_walk_panel(self):
        """Register the HAVEN sidebar panels and store them in the .blend: haven_walk.py (walk spots,
        cutaway, cameras) and haven_live.py (the live link to the backend world state)."""
        here = Path(__file__).resolve().parent if "__file__" in globals() else ROOT / "blender"
        for fname in ("haven_walk.py", "haven_live.py"):
            try:
                code = (here / fname).read_text(encoding="utf-8")
            except OSError as exc:
                print(f"{fname} skipped:", exc)
                continue
            text = bpy.data.texts.get(fname) or bpy.data.texts.new(fname)
            text.clear()
            text.write(code)
            text.use_module = True          # re-registers on file load when Auto Run Python Scripts is on
            try:
                exec(compile(code, fname, "exec"), {"__name__": fname[:-3]})
            except Exception as exc:
                print(f"{fname} failed:", exc)

    def build(self):
        if BAKE_ON:
            bake_materials(self.mats)
        self.build_shell()
        self.build_facade()
        if self.with_interior:
            self.build_interiors()
        if self.with_site:
            self.build_site()
        self.build_people()
        self.build_scene()
        self.build_walk_panel()


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


def export_glb(path, collections=("Shell", "Windows"), include=None, objects=None, image_max=2048):
    """Export the named collections (or an explicit object list); `include(name) -> bool` narrows it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    bevels = []
    if objects is None:
        objects = [ob for name in collections for ob in bpy.data.collections[name].all_objects]
    for ob in objects:
        if include is not None and not include(ob.name):
            continue
        try:
            ob.select_set(True)
        except RuntimeError:        # not in the view layer (excluded collection)
            continue
        for mod in ob.modifiers:
            if mod.type == "BEVEL" and mod.show_viewport:
                mod.show_viewport = False        # render-only polish; keeps the GLB small
                bevels.append(mod)
    # Scanned albedo + roughness ride along as 1k JPEGs; normal maps stay in Blender (JPEG normals look
    # worse than none in three.js) so the files stay small.
    swapped = []
    if BAKED:
        for ob in objects:
            me = ob.data if ob.type == "MESH" else None
            if me is None:
                continue
            for i, m in enumerate(me.materials):
                if m in BAKED:
                    me.materials[i] = BAKED[m]
                    swapped.append((me, i, m))
    muted = []
    for mat in bpy.data.materials:
        if not mat.use_nodes or mat.name.endswith(" baked"):
            continue
        for link in list(mat.node_tree.links):
            if link.from_node.type == "NORMAL_MAP":
                muted.append((mat.node_tree, link.from_socket, link.to_socket))
                mat.node_tree.links.remove(link)
    shrunk = []
    for img in bpy.data.images:
        if img.source == "FILE" and max(img.size) > image_max and not img.filepath.lower().endswith(".hdr"):
            img.scale(image_max, image_max)
            shrunk.append(img)
    try:
        kwargs = dict(filepath=str(path), export_format="GLB", use_selection=True, export_apply=True,
                      export_yup=True, export_extras=True, export_materials="EXPORT")
        try:
            bpy.ops.export_scene.gltf(**kwargs, export_image_format="JPEG", export_jpeg_quality=72)
        except TypeError:
            bpy.ops.export_scene.gltf(**kwargs)
    finally:
        for mod in bevels:
            mod.show_viewport = True
        for nt, a, b in muted:
            nt.links.new(a, b)
        for img in shrunk:
            img.reload()
        for me, i, m in swapped:
            me.materials[i] = m
    print(f"wrote {path}")


def export_site_glb(path, target_tris=40000):
    """The surroundings for the dashboard twin: Site collection (streets, sidewalks, neighbours, far city,
    cars, signals) plus every Props instance (trees, shrubs, hydrant, covered cars, people) realised as plain
    objects that share one mesh per model, with the heavy tree scans thinned once more. Everything is tagged
    level_index = 1 and named site_* so a floor focus below grade can hide it."""
    scene = bpy.context.scene
    site = bpy.data.collections.get("Site")
    props = bpy.data.collections.get("Props")
    if site is None:
        print("no Site collection; site GLB skipped")
        return
    lib_lc = bpy.context.view_layer.layer_collection.children.get("Library")
    was_excluded = lib_lc.exclude if lib_lc else None
    if lib_lc:
        lib_lc.exclude = False                       # sources must be in the view layer to evaluate
        bpy.context.view_layer.update()
    lod_cache, temp_obs, temp_meshes, retyped = {}, [], [], []

    def lod_mesh(src):
        me = src.data
        n = len(me.polygons)
        if n < 12000:
            return me
        if me not in lod_cache:
            mod = src.modifiers.new("export_lod", "DECIMATE")
            mod.ratio = 0.4 if n < 40000 else max(0.12, target_tris / n)
            mod.use_collapse_triangulate = True
            dg = bpy.context.evaluated_depsgraph_get()
            thin = bpy.data.meshes.new_from_object(src.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
            thin.name = me.name + "_glb"
            src.modifiers.remove(mod)
            lod_cache[me] = thin
            temp_meshes.append(thin)
        return lod_cache[me]

    objects = []
    for ob in site.all_objects:
        if "level_index" not in ob:
            ob["level_index"], ob["level"] = 1, "L1"
        objects.append(ob)
    if props is not None:
        for e in list(props.all_objects):
            col = e.instance_collection if e.instance_type == "COLLECTION" else None
            if col is None:
                if e.type == "MESH":
                    if "level_index" not in e:
                        e["level_index"], e["level"] = 1, "L1"
                    objects.append(e)
                continue
            off = Matrix.Translation(-Vector(col.instance_offset))
            for src in col.all_objects:
                if src.type != "MESH":
                    continue
                dup = bpy.data.objects.new(f"site_{e.name}_{src.name}"[:63], lod_mesh(src))
                dup.matrix_world = e.matrix_world @ off @ src.matrix_world
                props.objects.link(dup)
                dup["level_index"] = e.get("level_index", 1)
                dup["level"] = e.get("level", "L1")
                temp_obs.append(dup)
                objects.append(dup)
            e.instance_type = "NONE"                 # the exporter must not expand it a second time
            retyped.append((e, col))
    bpy.context.view_layer.update()
    try:
        export_glb(path, objects=objects, image_max=512)      # seen from the street, never up close
    finally:
        for e, col in retyped:
            e.instance_type = "COLLECTION"
            e.instance_collection = col
        for ob in temp_obs:
            bpy.data.objects.remove(ob, do_unlink=True)
        for me in temp_meshes:
            bpy.data.meshes.remove(me)
        if lib_lc and was_excluded is not None:
            lib_lc.exclude = was_excluded
    print(f"site GLB: {len(objects)} objects, {len(lod_cache)} thinned scans")


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
    opts = {"glb": None, "glb-interior": None, "glb-furniture": None, "glb-site": None, "render": None, "site": True, "interior": True,
            "blend": None, "cutaway": [], "engine": "eevee", "samples": 128}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--cutaway":
            opts["cutaway"].append(argv[i + 1])
            i += 2
        elif a in ("--glb", "--glb-interior", "--glb-furniture", "--glb-site", "--render", "--blend", "--engine"):
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
        elif a in ("--bake", "--rebake"):
            global BAKE_ON, REBAKE
            BAKE_ON = True
            REBAKE = REBAKE or a == "--rebake"
            i += 1
        elif a == "--no-textures":
            global TEXTURES_ON
            TEXTURES_ON = False
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
        export_glb(resolve(opts["glb-interior"]), collections=("Interior", "Plant"),
                   include=lambda n: not n.startswith("furniture_"))
    if opts["glb-furniture"]:
        export_glb(resolve(opts["glb-furniture"]), collections=("Interior",), include=lambda n: n.startswith("furniture_"))
    if opts["glb-site"]:
        export_site_glb(resolve(opts["glb-site"]))
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            for space in area.spaces:
                if space.type == "VIEW_3D":
                    space.shading.type = "MATERIAL"
                    space.shading.use_scene_world = True
                    space.shading.use_scene_lights = True
                    space.clip_end = 5000.0
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
