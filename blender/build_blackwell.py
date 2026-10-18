"""Build the exterior of David Blackwell Hall in Blender from the shared building spec.

Everything here derives from ``shared/blackwell_hall.json`` (written by
``backend/tools/export_building.py``): level massing comes from the footprint plus each level's
spaces, windows come from which space sits behind each stretch of exterior wall, street doors
come from the spec's ``outside`` openings, the courtyard and podium garden are the holes the
spaces leave. Nothing about the building is typed in here twice.

Facade language (from photos of the real building): white panels, paired tall windows with a
staggered ochre accent panel, a recessed dark-glass ground floor under a wood soffit, a glass
corner bay at Dana St x Durant Ave, flat roof with a parapet.

Run headless (Store install exposes ``blender-launcher.exe``; a zip install exposes ``blender``):

    blender -b -P blender/build_blackwell.py -- --glb frontend/public/models/blackwell.glb \
        --render blender/renders/hero.png

Run inside a live Blender (e.g. through the Blender MCP):

    exec(open(r"C:/.../blender/build_blackwell.py").read(), {"HAVEN_ROOT": r"C:/.../Cal_Hacks_13.0"})

Every window mesh is named ``win_<space_id>`` and carries a ``space_id`` custom property, so a
glTF consumer (the React Three Fiber view) can light or darken rooms from world state.
Coordinates are the spec's: metres, x east, y north, z up, origin at the SW corner.
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

GROUND_RECESS = 0.9        # upper floors overhang the glazed ground floor by this much
PARAPET_H = 1.0
PARAPET_T = 0.3
SLAB_LINE = 0.0            # no visible floor bands; the real facade reads as one white skin
WIN_SILL, WIN_HEAD = 0.55, 2.75
WIN_W, PANEL_W, WIN_GAP = 0.95, 0.95, 0.12
GLASS_OUT, GLASS_IN = 0.02, 0.25   # glass box sits 2 cm proud and 25 cm into the wall
FRAME_OUT, FRAME_T = 0.06, 0.08
PANEL_OUT = 0.05
SITE_PAD = 36.0

# Facade treatment by the kind of space behind the wall (upper floors).
CURTAIN_KINDS = {"lounge", "study", "kitchen", "amenity", "lobby", "retail", "office"}
BLANK_KINDS = {"corridor", "lift", "riser", "service", "storage", "mechanical", "electrical",
               "generator", "courtyard"}

COLORS = {
    "panel_white": (0.86, 0.86, 0.83),
    "panel_ochre": (0.95, 0.58, 0.07),
    "glass": (0.06, 0.10, 0.15),
    "glass_frosted": (0.55, 0.65, 0.70),
    "frame": (0.11, 0.11, 0.12),
    "wood": (0.48, 0.30, 0.15),
    "concrete": (0.50, 0.48, 0.45),
    "podium": (0.55, 0.54, 0.52),
    "roof": (0.42, 0.42, 0.44),
    "lawn": (0.32, 0.52, 0.22),
    "paving": (0.74, 0.72, 0.68),
    "asphalt": (0.10, 0.10, 0.11),
    "sidewalk": (0.62, 0.61, 0.58),
    "trunk": (0.30, 0.22, 0.14),
    "canopy": (0.24, 0.45, 0.20),
    "metal": (0.55, 0.57, 0.60),
    "neighbour": (0.40, 0.38, 0.36),
    "ground": (0.30, 0.31, 0.28),
}


# ---- small geometry helpers -----------------------------------------------------------------


class R:
    __slots__ = ("x0", "y0", "x1", "y1")

    def __init__(self, x0, y0, x1, y1):
        self.x0, self.y0, self.x1, self.y1 = float(x0), float(y0), float(x1), float(y1)

    @classmethod
    def of(cls, d):
        return cls(d["x0"], d["y0"], d["x1"], d["y1"])

    def contains(self, x, y, eps=1e-6):
        return self.x0 - eps <= x <= self.x1 + eps and self.y0 - eps <= y <= self.y1 + eps

    def grow(self, d):
        return R(self.x0 - d, self.y0 - d, self.x1 + d, self.y1 + d)


class Cells:
    """A rectilinear region as a set of cells on a grid of all the rect edges."""

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
        """True if every cell inside rect belongs to the region (rect edges on grid lines)."""
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
        out = Cells.__new__(Cells)
        out.xs, out.ys = self.xs, self.ys
        out.cells = set()
        for (i, j) in self.cells:
            r = R(self.xs[i], self.ys[j], self.xs[i + 1], self.ys[j + 1]).grow(d)
            if self.covered(r):
                out.cells.add((i, j))
        return out

    def minus(self, other):
        out = Cells.__new__(Cells)
        out.xs, out.ys = self.xs, self.ys
        out.cells = self.cells - other.cells
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
    vs = [bm.verts.new((x, y, z)) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
    for f in ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)):
        face = bm.faces.new([vs[i] for i in f])
        face.material_index = mi


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
        f.material_index = mi
        faces.append(f)
    res = bmesh.ops.extrude_face_region(bm, geom=faces)
    moved = [g for g in res["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=moved, vec=(0, 0, z0 - z1))
    for g in res["geom"]:
        if isinstance(g, bmesh.types.BMFace):
            g.material_index = mi
    for f in bm.faces:
        if f.material_index != mi and any(vv in vcache.values() for vv in f.verts):
            f.material_index = mi
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1.0), verts=bm.verts[:], edges=bm.edges[:])


def mesh_object(name, bm, materials, collection, props=None):
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


# ---- materials ------------------------------------------------------------------------------


def material(name, rgb, roughness=0.6, metallic=0.0, emission=None, alpha=1.0):
    key = f"BW {name}"
    mat = bpy.data.materials.get(key)
    if mat:
        return mat
    mat = bpy.data.materials.new(key)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 0.0
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        try:
            mat.surface_render_method = "BLENDED"
        except AttributeError:  # older Blender
            mat.blend_method = "BLEND"
    mat.diffuse_color = (*rgb, 1.0)
    return mat


def make_materials():
    c = COLORS
    return {
        "white": material("panel white", c["panel_white"], roughness=0.55),
        "ochre": material("panel ochre", c["panel_ochre"], roughness=0.5),
        "glass": material("glass", c["glass"], roughness=0.12, metallic=0.2, emission=(1.0, 0.85, 0.55)),
        "frosted": material("glass frosted", c["glass_frosted"], roughness=0.35),
        "frame": material("frame", c["frame"], roughness=0.4, metallic=0.3),
        "wood": material("wood soffit", c["wood"], roughness=0.7),
        "concrete": material("concrete", c["concrete"], roughness=0.9),
        "podium": material("podium", c["podium"], roughness=0.85),
        "roof": material("roof", c["roof"], roughness=0.95),
        "lawn": material("lawn", c["lawn"], roughness=1.0),
        "paving": material("paving", c["paving"], roughness=0.9),
        "asphalt": material("asphalt", c["asphalt"], roughness=0.95),
        "sidewalk": material("sidewalk", c["sidewalk"], roughness=0.9),
        "trunk": material("trunk", c["trunk"], roughness=0.9),
        "canopy": material("canopy", c["canopy"], roughness=0.9),
        "metal": material("metal", c["metal"], roughness=0.4, metallic=0.6),
        "neighbour": material("neighbour", c["neighbour"], roughness=0.9),
        "ground": material("ground", c["ground"], roughness=1.0),
    }


# ---- the build ------------------------------------------------------------------------------


class Builder:
    def __init__(self, spec, with_site=True):
        self.spec = spec
        self.with_site = with_site
        self.levels = {lv["id"]: lv for lv in spec["levels"]}
        self.above = [lv for lv in spec["levels"] if lv["index"] > 0]
        self.above.sort(key=lambda lv: lv["index"])
        self.top_level = self.above[-1]
        self.roof_z = self.top_level["elevation"] + self.top_level["height"]
        self.footprint = [R.of(r) for r in spec["footprint"]]
        self.spaces_by_level = {}
        for s in spec["spaces"]:
            self.spaces_by_level.setdefault(s["level"], []).append(s)
        self.mats = make_materials()
        self.col_building = self._collection("Blackwell Hall")
        self.col_windows = self._collection("Windows", parent=self.col_building)
        self.col_site = self._collection("Site")
        self.massing = {}      # level id -> Cells (solid region for that level)

    @staticmethod
    def _collection(name, parent=None):
        col = bpy.data.collections.get(name)
        if col is None:
            col = bpy.data.collections.new(name)
            (parent or bpy.context.scene.collection).children.link(col)
        return col

    # -- massing --

    def level_region(self, lv):
        rects = list(self.footprint)
        rects += [R.of(s["rect"]) for s in self.spaces_by_level.get(lv["id"], []) if not s["outdoor"]]
        extra = (GROUND_RECESS, PARAPET_T) if lv["index"] == 1 else (PARAPET_T,)
        return Cells(rects, extra_lines=extra)

    def build_massing(self):
        m = self.mats
        for lv in self.above:
            region = self.level_region(lv)
            z0, z1 = lv["elevation"], lv["elevation"] + lv["height"]
            if lv["index"] == 1:
                # Glazed ground floor: the solid is set back; the storefront glass sits on its face.
                solid = region.eroded(GROUND_RECESS)
                self.massing[lv["id"]] = solid
                bm = bmesh.new()
                add_prism(bm, solid, z0, z1, mi=0)
                mesh_object(f"level_{lv['id']}", bm, [m["podium"]], self.col_building)
                # Wood soffit fills the overhang under L2.
                bm = bmesh.new()
                add_prism(bm, region, z1 - 0.32, z1 - 0.02, mi=0)
                mesh_object("soffit", bm, [m["wood"]], self.col_building)
                # The overhang edge: a slim dark fascia hides the soffit/skin joint.
                self.ground_region = region
            else:
                self.massing[lv["id"]] = region
                bm = bmesh.new()
                add_prism(bm, region, z0, z1, mi=0)
                mesh_object(f"level_{lv['id']}", bm, [m["white"]], self.col_building)
        self.build_roof()
        self.build_podium_garden()

    def build_roof(self):
        m = self.mats
        top = self.massing[self.top_level["id"]]
        bm = bmesh.new()
        add_prism(bm, top, self.roof_z - 0.05, self.roof_z + 0.05, mi=0)
        mesh_object("roof_deck", bm, [m["roof"]], self.col_building)
        parapet = top.minus(top.eroded(PARAPET_T))
        bm = bmesh.new()
        add_prism(bm, parapet, self.roof_z, self.roof_z + PARAPET_H, mi=0)
        mesh_object("parapet", bm, [m["white"]], self.col_building)
        # Lift overrun + mechanical penthouse above the lift core, rooftop units along the spine.
        lifts = [s for s in self.spaces_by_level[self.top_level["id"]] if s["kind"] == "lift"]
        if lifts:
            x0 = min(R.of(s["rect"]).x0 for s in lifts) - 0.8
            x1 = max(R.of(s["rect"]).x1 for s in lifts) + 3.0
            y0 = min(R.of(s["rect"]).y0 for s in lifts) - 1.0
            y1 = max(R.of(s["rect"]).y1 for s in lifts) + 1.0
            bm = bmesh.new()
            add_box(bm, x0, x1, y0, y1, self.roof_z, self.roof_z + 3.2, 0)
            mesh_object("penthouse", bm, [m["concrete"]], self.col_building)
        bm = bmesh.new()
        for i, y in enumerate((30, 45, 60)):
            add_box(bm, 2.5, 6.5, y, y + 3.0, self.roof_z + 0.05, self.roof_z + 1.4, 0)
        add_box(bm, 20, 26, 78.5, 82.5, self.roof_z + 0.05, self.roof_z + 1.6, 0)
        mesh_object("rooftop_units", bm, [m["metal"]], self.col_building)

    def build_podium_garden(self):
        """The L2 garden is the part of the ground-floor roof that the upper floors leave open."""
        m = self.mats
        l1 = self.levels["L1"]
        l2 = next(lv for lv in self.above if lv["index"] == 2)
        garden = Cells(list(self.footprint) +
                       [R.of(s["rect"]) for s in self.spaces_by_level["L1"] if not s["outdoor"]],
                       extra_lines=(0.6, 0.12))
        garden = garden.minus(self._as_cells(garden, self.massing[l2["id"]]))
        if not garden.cells:
            return
        z = l1["elevation"] + l1["height"]
        bm = bmesh.new()
        add_prism(bm, garden.eroded(0.6), z + 0.0, z + 0.18, mi=0)
        mesh_object("podium_lawn", bm, [m["lawn"]], self.col_building)
        # Glass balustrade along the garden's street edges.
        rail = garden.minus(garden.eroded(0.12))
        bm = bmesh.new()
        add_prism(bm, rail, z, z + 1.1, mi=0)
        mesh_object("podium_rail", bm, [m["frosted"]], self.col_building)
        b = garden.bounds()
        bm = bmesh.new()
        for (x, y) in ((b.x0 + 5, b.y0 + 5), (b.x1 - 6, b.y0 + 6), (b.x0 + 9, b.y1 - 5), (b.x1 - 5, b.y1 - 6)):
            self._tree(bm, x, y, z + 0.18, height=4.5, radius=2.2)
        mesh_object("podium_trees", bm, [m["trunk"], m["canopy"]], self.col_building)

    def _as_cells(self, grid_like, region):
        """Re-express `region` on `grid_like`'s grid (both grids share the spec's edges)."""
        out = Cells.__new__(Cells)
        out.xs, out.ys = grid_like.xs, grid_like.ys
        out.cells = set()
        for i in range(len(out.xs) - 1):
            cx = (out.xs[i] + out.xs[i + 1]) / 2
            for j in range(len(out.ys) - 1):
                cy = (out.ys[j] + out.ys[j + 1]) / 2
                if region.inside(cx, cy):
                    out.cells.add((i, j))
        return out

    # -- facade --

    def exterior_edges(self, space, region):
        """Yield (axis, fixed, lo, hi, outward_sign) for each edge of a space facing open air."""
        r = R.of(space["rect"])
        probe = 0.15
        edges = [
            ("x", r.y0, r.x0, r.x1, -1),   # south face, wall runs along x
            ("x", r.y1, r.x0, r.x1, +1),   # north face
            ("y", r.x0, r.y0, r.y1, -1),   # west face, wall runs along y
            ("y", r.x1, r.y0, r.y1, +1),   # east face
        ]
        for axis, fixed, lo, hi, sign in edges:
            mid = (lo + hi) / 2
            px, py = (mid, fixed + sign * probe) if axis == "x" else (fixed + sign * probe, mid)
            if not region.inside(px, py):
                yield axis, fixed, lo, hi, sign

    def build_facade(self):
        for lv in self.above:
            region = self.massing[lv["id"]] if lv["index"] > 1 else self.ground_region
            z_floor = lv["elevation"]
            for idx, space in enumerate(sorted(self.spaces_by_level.get(lv["id"], []), key=lambda s: s["id"])):
                if space["outdoor"] or space["kind"] in BLANK_KINDS:
                    continue
                bm = bmesh.new()
                n_before = len(bm.faces)
                for axis, fixed, lo, hi, sign in self.exterior_edges(space, region):
                    if lv["index"] == 1:
                        self.storefront(bm, space, axis, fixed, lo, hi, sign, z_floor, lv["height"])
                    else:
                        self.upper_window(bm, space, idx, lv, axis, fixed, lo, hi, sign, z_floor)
                if len(bm.faces) == n_before:
                    bm.free()
                    continue
                bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
                m = self.mats
                mesh_object(f"win_{space['id']}", bm, [m["glass"], m["frame"], m["ochre"], m["frosted"]],
                            self.col_windows, props={"space_id": space["id"], "level": lv["id"],
                                                     "kind": space["kind"]})
        self.build_doors()

    # a window/panel box on a wall: `fixed` is the wall plane, `sign` points outward
    def _wall_box(self, bm, axis, fixed, sign, a0, a1, z0, z1, out, inward, mi):
        n0, n1 = sorted((fixed + sign * out, fixed - sign * inward))
        if axis == "x":
            add_box(bm, a0, a1, n0, n1, z0, z1, mi)
        else:
            add_box(bm, n0, n1, a0, a1, z0, z1, mi)

    def upper_window(self, bm, space, idx, lv, axis, fixed, lo, hi, sign, z):
        kind = space["kind"]
        length = hi - lo
        z0, z1 = z + WIN_SILL, z + WIN_HEAD
        if kind in CURTAIN_KINDS:
            self.curtain(bm, axis, fixed, lo + 0.3, hi - 0.3, sign, z + 0.25, z + lv["height"] - 0.25)
            return
        if kind == "bathroom":
            c = (lo + hi) / 2
            self._wall_box(bm, axis, fixed, sign, c - 0.45, c + 0.45, z + 1.5, z + 2.5, GLASS_OUT, GLASS_IN, 3)
            self._frame(bm, axis, fixed, sign, c - 0.45, c + 0.45, z + 1.5, z + 2.5)
            return
        if kind == "stair":
            c = (lo + hi) / 2
            self._wall_box(bm, axis, fixed, sign, c - 0.3, c + 0.3, z + 0.4, z + lv["height"] - 0.3,
                           GLASS_OUT, GLASS_IN, 3)
            self._frame(bm, axis, fixed, sign, c - 0.3, c + 0.3, z + 0.4, z + lv["height"] - 0.3)
            return
        # Resident rooms + laundry: paired windows with one ochre accent panel, staggered so the
        # accent flips side floor by floor and room by room (the real facade's checker rhythm).
        n_win = 2 if length >= 2 * WIN_W + PANEL_W + 2 * WIN_GAP + 0.8 else 1
        group_w = n_win * WIN_W + PANEL_W + n_win * WIN_GAP
        start = (lo + hi) / 2 - group_w / 2
        panel_first = (lv["index"] + idx) % 2 == 0
        pos = start
        items = (["panel"] + ["win"] * n_win) if panel_first else (["win"] * n_win + ["panel"])
        for item in items:
            if item == "panel":
                self._wall_box(bm, axis, fixed, sign, pos, pos + PANEL_W, z0 - 0.1, z1 + 0.1, PANEL_OUT, 0.02, 2)
                pos += PANEL_W + WIN_GAP
            else:
                self._wall_box(bm, axis, fixed, sign, pos, pos + WIN_W, z0, z1, GLASS_OUT, GLASS_IN, 0)
                self._frame(bm, axis, fixed, sign, pos, pos + WIN_W, z0, z1)
                pos += WIN_W + WIN_GAP

    def _frame(self, bm, axis, fixed, sign, a0, a1, z0, z1):
        t = FRAME_T
        self._wall_box(bm, axis, fixed, sign, a0 - t, a0, z0 - t, z1 + t, FRAME_OUT, 0.02, 1)
        self._wall_box(bm, axis, fixed, sign, a1, a1 + t, z0 - t, z1 + t, FRAME_OUT, 0.02, 1)
        self._wall_box(bm, axis, fixed, sign, a0, a1, z0 - t, z0, FRAME_OUT, 0.02, 1)
        self._wall_box(bm, axis, fixed, sign, a0, a1, z1, z1 + t, FRAME_OUT, 0.02, 1)

    def curtain(self, bm, axis, fixed, lo, hi, sign, z0, z1, bay=1.5, mi_glass=0):
        if hi - lo < 0.6:
            return
        self._wall_box(bm, axis, fixed, sign, lo, hi, z0, z1, GLASS_OUT, GLASS_IN, mi_glass)
        self._frame(bm, axis, fixed, sign, lo, hi, z0, z1)
        n = max(1, int(round((hi - lo) / bay)))
        for k in range(1, n):
            a = lo + (hi - lo) * k / n
            self._wall_box(bm, axis, fixed, sign, a - 0.04, a + 0.04, z0, z1, FRAME_OUT, 0.02, 1)

    def storefront(self, bm, space, axis, fixed, lo, hi, sign, z, height):
        """Ground floor: the solid is recessed, so the glass line sits on the outer footprint."""
        kind = space["kind"]
        if kind in {"stair", "storage", "service", "bathroom"}:
            # Back of house reads as a dark panel wall on the outer line.
            self._wall_box(bm, axis, fixed, sign, lo, hi, z + 0.0, z + height - 0.35, 0.0, 0.1, 1)
            return
        self.curtain(bm, axis, fixed, lo + 0.1, hi - 0.1, sign, z + 0.1, z + height - 0.4, bay=2.0)
        # Plinth under the glass.
        self._wall_box(bm, axis, fixed, sign, lo, hi, z, z + 0.1, 0.02, 0.1, 1)

    def build_doors(self):
        """Street doors from the spec's `outside` openings."""
        m = self.mats
        bm = bmesh.new()
        for o in self.spec["openings"]:
            if o["b"] != "outside":
                continue
            lv = self.levels[o["level"]]
            z = lv["elevation"]
            w = max(o["width"], 1.2)
            if o["axis"] == "x":
                sign = -1 if o["y"] <= 1e-6 else +1
                add_box(bm, o["x"] - w / 2, o["x"] + w / 2, o["y"] - 0.2, o["y"] + 0.2, z, z + 2.6, 0)
                add_box(bm, o["x"] - w / 2 - 0.12, o["x"] + w / 2 + 0.12, o["y"] - 0.22 + (0.02 if sign > 0 else 0),
                        o["y"] + 0.22, z + 2.6, z + 2.75, 1)
            else:
                add_box(bm, o["x"] - 0.2, o["x"] + 0.2, o["y"] - w / 2, o["y"] + w / 2, z, z + 2.6, 0)
                add_box(bm, o["x"] - 0.22, o["x"] + 0.22, o["y"] - w / 2 - 0.12, o["y"] + w / 2 + 0.12,
                        z + 2.6, z + 2.75, 1)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        mesh_object("street_doors", bm, [m["glass"], m["frame"]], self.col_building)

    # -- courtyard + site --

    def build_courtyard(self):
        m = self.mats
        for s in self.spaces_by_level.get("L1", []):
            if not s["outdoor"]:
                continue
            r = R.of(s["rect"])
            z = self.levels["L1"]["elevation"]
            bm = bmesh.new()
            add_box(bm, r.x0, r.x1, r.y0, r.y1, z - 0.05, z + 0.02, 0)
            add_box(bm, r.x0 + 2, r.x1 - 2, r.y0 + 2, r.y1 - 2, z + 0.02, z + 0.12, 1)
            mesh_object(f"court_{s['id']}", bm, [m["paving"], m["lawn"]], self.col_building)
            bm = bmesh.new()
            for (x, y) in ((r.x0 + 4.5, r.y0 + 5), (r.x1 - 4.5, r.y0 + 8), (r.x0 + 6, r.y1 - 5), (r.x1 - 5, r.y1 - 6)):
                self._tree(bm, x, y, z + 0.1, height=6.0, radius=2.6)
            mesh_object(f"court_trees_{s['id']}", bm, [m["trunk"], m["canopy"]], self.col_building)

    def _tree(self, bm, x, y, z, height, radius):
        trunk = bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.22, radius2=0.16,
                                      depth=height * 0.45)
        for v in trunk["verts"]:
            v.co += Vector((x, y, z + height * 0.225))
        for f in bm.faces:
            if any(v in trunk["verts"] for v in f.verts):
                f.material_index = 0
        before = set(bm.faces)
        ball = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius)
        for v in ball["verts"]:
            v.co = Vector((x, y, z + height * 0.45 + radius * 0.75)) + Vector((v.co.x, v.co.y, v.co.z * 0.8))
        for f in bm.faces:
            if f not in before:
                f.material_index = 1

    def build_site(self):
        m = self.mats
        all_rects = list(self.footprint)
        b = R(min(r.x0 for r in all_rects), min(r.y0 for r in all_rects),
              max(r.x1 for r in all_rects), max(r.y1 for r in all_rects))
        z = 0.0
        # Streets (asphalt) and sidewalks (lighter), 4 m wide walks around the block.
        bm = bmesh.new()
        add_box(bm, b.x0 - SITE_PAD, b.x1 + SITE_PAD, b.y0 - SITE_PAD, b.y1 + SITE_PAD, z - 0.6, z - 0.2, 0)
        mesh_object("site_streets", bm, [m["asphalt"]], self.col_site)
        # Ground out to the horizon so the sky never shows below the site.
        bm = bmesh.new()
        add_box(bm, b.x0 - 900, b.x1 + 900, b.y0 - 900, b.y1 + 900, z - 1.0, z - 0.62, 0)
        mesh_object("site_ground", bm, [m["ground"]], self.col_site)
        bm = bmesh.new()
        walk = 4.0
        add_box(bm, b.x0 - walk, b.x1 + walk, b.y0 - walk, b.y1 + walk, z - 0.2, z, 0)
        mesh_object("site_sidewalk", bm, [m["sidewalk"]], self.col_site)
        # Neighbouring block masses, so the hero shot has context without claiming detail.
        bm = bmesh.new()
        for (x0, y0, x1, y1, h) in ((b.x1 + 14, 4, b.x1 + 34, 30, 9), (b.x1 + 14, 38, b.x1 + 30, 80, 12),
                                    (-30, 6, -14, 40, 7), (-30, 48, -14, 80, 10)):
            add_box(bm, x0, x1, y0, y1, z, z + h, 0)
        mesh_object("site_neighbours", bm, [m["neighbour"]], self.col_site)
        # Street trees along Dana St (west) and the two cross streets.
        bm = bmesh.new()
        for y in range(8, int(b.y1) - 4, 12):
            self._tree(bm, b.x0 - 2.0, y, z, height=7.0, radius=2.4)
        for x in range(10, int(b.x1) - 4, 12):
            self._tree(bm, x, b.y0 - 2.0, z, height=7.0, radius=2.4)
            self._tree(bm, x, b.y1 + 2.0, z, height=7.0, radius=2.4)
        mesh_object("site_trees", bm, [m["trunk"], m["canopy"]], self.col_site)
        # PG&E pad transformer vault on Durant (from the spec's equipment list).
        for e in self.spec["equipment"]:
            if e["kind"] == "utility_feed":
                bm = bmesh.new()
                add_box(bm, e["x"] - 1.2, e["x"] + 1.2, e["y"] - 0.9, e["y"] + 0.9, z, z + 1.3, 0)
                mesh_object("site_transformer", bm, [m["metal"]], self.col_site)

    # -- scene --

    def build_scene(self):
        scene = bpy.context.scene
        b = R(min(r.x0 for r in self.footprint), min(r.y0 for r in self.footprint),
              max(r.x1 for r in self.footprint), max(r.y1 for r in self.footprint))
        # Camera: three-quarter from Dana St x Durant Ave (the SW corner), like the reference photo.
        cam_data = bpy.data.cameras.new("HeroCam")
        cam_data.lens = 32
        cam = bpy.data.objects.new("HeroCam", cam_data)
        scene.collection.objects.link(cam)
        cam.location = Vector((b.x0 - 52, b.y0 - 58, 34))
        target = Vector(((b.x0 + b.x1) / 2 - 4, (b.y0 + b.y1) / 2 - 10, self.roof_z * 0.45))
        cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.camera = cam
        # Sun from the south-west, warm afternoon light.
        sun_data = bpy.data.lights.new("Sun", "SUN")
        sun_data.energy = 5.5
        sun_data.angle = math.radians(2.0)
        sun_data.color = (1.0, 0.96, 0.9)
        sun = bpy.data.objects.new("Sun", sun_data)
        scene.collection.objects.link(sun)
        sun.rotation_euler = (math.radians(42), 0, math.radians(-40))
        world = scene.world or bpy.data.worlds.new("World")
        scene.world = world
        world.use_nodes = True
        bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
        if bg:
            bg.inputs[0].default_value = (0.55, 0.72, 0.95, 1.0)
            bg.inputs[1].default_value = 0.35
            # A physical sky (sun disc off; the Sun lamp is the only hard light) gives the horizon
            # gradient and a cool fill. Sky model names differ between Blender versions.
            sky = world.node_tree.nodes.new("ShaderNodeTexSky")
            models = [i.identifier for i in sky.bl_rna.properties["sky_type"].enum_items]
            sky.sky_type = next((m for m in ("MULTIPLE_SCATTERING", "NISHITA") if m in models), models[0])
            if hasattr(sky, "sun_intensity"):
                sky.sun_intensity = 0.0
                sky.sun_elevation = math.radians(48)
                sky.sun_rotation = math.radians(230)
            world.node_tree.links.new(sky.outputs[0], bg.inputs[0])
            bg.inputs[1].default_value = 0.015
        scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
        # Colour management: AgX with a touch of contrast keeps the white skin from clipping.
        try:
            scene.view_settings.view_transform = "AgX"
            scene.view_settings.look = "AgX - Medium High Contrast"
        except TypeError:
            pass
        scene.view_settings.exposure = 0.0
        for attr, val in (("use_raytracing", True), ("use_shadows", True), ("use_gtao", True),
                          ("taa_render_samples", 64)):
            if hasattr(scene.eevee, attr):
                setattr(scene.eevee, attr, val)
        scene.render.film_transparent = False
        try:
            scene.render.engine = "BLENDER_EEVEE_NEXT"
        except TypeError:
            try:
                scene.render.engine = "BLENDER_EEVEE"
            except TypeError:
                pass

    def build(self):
        self.build_massing()
        self.build_facade()
        self.build_courtyard()
        if self.with_site:
            self.build_site()
        self.build_scene()


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


def export_glb(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    col = bpy.data.collections["Blackwell Hall"]
    for ob in col.all_objects:
        ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True, export_extras=True,
                              export_materials="EXPORT")
    print(f"wrote {path}")


def render(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.render.filepath = str(path)
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    print(f"rendered {path}")


def main(argv=None):
    argv = list(argv) if argv is not None else (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    opts = {"glb": None, "render": None, "site": True, "blend": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--glb":
            opts["glb"] = argv[i + 1]; i += 2
        elif a == "--render":
            opts["render"] = argv[i + 1]; i += 2
        elif a == "--blend":
            opts["blend"] = argv[i + 1]; i += 2
        elif a == "--no-site":
            opts["site"] = False; i += 1
        else:
            i += 1
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    clear_scene()
    builder = Builder(spec, with_site=opts["site"])
    builder.build()
    n_win = len(bpy.data.collections["Windows"].objects)
    print(f"built {spec['name']}: {len(bpy.data.objects)} objects, {n_win} window groups, roof at {builder.roof_z} m")
    if opts["glb"]:
        export_glb(ROOT / opts["glb"] if not Path(opts["glb"]).is_absolute() else opts["glb"])
    if opts["blend"]:
        p = ROOT / opts["blend"] if not Path(opts["blend"]).is_absolute() else Path(opts["blend"])
        p.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(p))
    if opts["render"]:
        render(ROOT / opts["render"] if not Path(opts["render"]).is_absolute() else opts["render"])
    return builder


if __name__ == "__main__" or "HAVEN_ROOT" in globals():
    main(globals().get("HAVEN_ARGS"))
