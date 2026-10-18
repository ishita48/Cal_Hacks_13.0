"""HAVEN sidebar panel for Blender: walk around Blackwell Hall, cut floors away, jump to cameras.

Loaded automatically by ``build_blackwell.py`` (it also stores this file as a text block in the .blend so
the panel comes back when the file is reopened with "Auto Run Python Scripts" enabled). To load it by
hand: Scripting workspace -> open this file -> Run Script. The panel appears in the 3D viewport sidebar
(press N) under the "HAVEN" tab.

Walking uses Blender's own walk navigation: mouse to look, W/A/S/D to move, Q/E up/down, Shift to run,
Tab toggles gravity, Esc or right-click to stop, left-click to keep the new view.
"""

import math

import bpy
from mathutils import Euler, Quaternion, Vector

EYE = 1.65

# name, eye position (metres, spec coordinates), yaw in degrees (0 = looking +Y/north, 90 = east)
WALK_SPOTS = [
    ("Street: Dana x Durant corner", (-7.0, -9.0, EYE), 35.0),
    ("Street: along Durant Ave", (24.0, -6.0, EYE), -20.0),
    ("Lobby (front desk)", (10.0, 2.5, EYE), 0.0),
    ("Courtyard (ground floor)", (23.0, 52.0, EYE + 0.25), 0.0),
    ("Floor 4: lift lobby", (7.0, 17.0, 11.2 + EYE), 0.0),
    ("Floor 4: Maya's wing (south)", (20.0, 7.0, 11.2 + EYE), 90.0),
    ("Floor 4: lounge & kitchen", (40.0, 37.0, 11.2 + EYE), -90.0),
    ("Podium garden (floor 2)", (27.0, 24.0, 5.0 + EYE), 0.0),
    ("Basement: electrical room", (22.0, 30.0, -4.5 + 0.25 + EYE), 0.0),
    ("Basement: mechanical room (riser)", (22.0, 12.0, -4.5 + 0.25 + EYE), 0.0),
    ("Roof", (20.0, 40.0, 23.6 + EYE), 0.0),
]

LEVELS = [("B1", -1), ("L1", 1), ("L2", 2), ("L3", 3), ("L4", 4), ("L5", 5), ("L6", 6), ("L7", 7), ("roof", 99)]


def _view3d(context):
    space = context.space_data
    if space is not None and space.type == "VIEW_3D":
        return space
    for area in context.screen.areas:
        if area.type == "VIEW_3D":
            return area.spaces.active
    return None


class HAVEN_OT_walk(bpy.types.Operator):
    """Put the view at this spot (eye height) and start walk navigation"""
    bl_idname = "haven.walk"
    bl_label = "Walk here"
    bl_options = {"REGISTER"}

    x: bpy.props.FloatProperty()
    y: bpy.props.FloatProperty()
    z: bpy.props.FloatProperty()
    yaw: bpy.props.FloatProperty()
    start_walk: bpy.props.BoolProperty(default=True)

    def invoke(self, context, event):
        space = _view3d(context)
        if space is None:
            self.report({"WARNING"}, "Hover a 3D viewport")
            return {"CANCELLED"}
        r3d = space.region_3d
        space.shading.type = "MATERIAL"
        space.overlay.show_overlays = False
        space.clip_end = 20000
        space.lens = 24
        r3d.view_perspective = "PERSP"
        # Blender's view looks down its local -Z; yaw 0 = +Y, positive = clockwise (east).
        rot = Euler((math.radians(90), 0.0, math.radians(-self.yaw)), "XYZ").to_quaternion()
        forward = rot @ Vector((0, 0, -1))
        r3d.view_distance = 0.05
        r3d.view_rotation = rot
        r3d.view_location = Vector((self.x, self.y, self.z)) + forward * 0.05
        r3d.update()
        if self.start_walk:
            prefs = context.preferences.inputs
            prefs.walk_navigation.use_gravity = False
            prefs.walk_navigation.view_height = EYE
            prefs.walk_navigation.walk_speed = 3.0
            prefs.walk_navigation.mouse_speed = 1.0
            try:
                with context.temp_override(area=context.area, region=context.region):
                    bpy.ops.view3d.walk("INVOKE_DEFAULT")
            except Exception as exc:
                self.report({"WARNING"}, f"Walk mode: {exc}; press Shift+` in the viewport")
        return {"FINISHED"}


class HAVEN_OT_cutaway(bpy.types.Operator):
    """Hide everything above this level in the viewport (and hide the site below grade)"""
    bl_idname = "haven.cutaway"
    bl_label = "Cut away above"

    level_index: bpy.props.IntProperty(default=99)

    def execute(self, context):
        for ob in bpy.data.objects:
            idx = ob.get("level_index")
            if ob.name.startswith("cutter_"):
                continue
            if idx is not None:
                ob.hide_viewport = idx > self.level_index
            elif ob.name.startswith("site_"):
                ob.hide_viewport = self.level_index < 1
        return {"FINISHED"}


class HAVEN_OT_camera(bpy.types.Operator):
    """Look through one of the scene cameras"""
    bl_idname = "haven.camera"
    bl_label = "Camera"

    name: bpy.props.StringProperty()

    def execute(self, context):
        cam = bpy.data.objects.get(self.name)
        space = _view3d(context)
        if cam is None or space is None:
            return {"CANCELLED"}
        context.scene.camera = cam
        space.region_3d.view_perspective = "CAMERA"
        return {"FINISHED"}


class HAVEN_PT_panel(bpy.types.Panel):
    bl_label = "HAVEN: walk & look"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "HAVEN"

    def draw(self, context):
        col = self.layout.column(align=True)
        col.label(text="Walk (WASD + mouse, Esc to stop)")
        for name, (x, y, z), yaw in WALK_SPOTS:
            op = col.operator("haven.walk", text=name)
            op.x, op.y, op.z, op.yaw = x, y, z, yaw
        col.separator()
        col.label(text="Cut away floors above")
        row = col.row(align=True)
        for label, idx in LEVELS:
            op = row.operator("haven.cutaway", text=label)
            op.level_index = idx
        col.separator()
        col.label(text="Cameras")
        row = col.row(align=True)
        for cam in ("HeroCam", "StreetCam", "CutawayCam", "PlantCam"):
            if cam in bpy.data.objects:
                row.operator("haven.camera", text=cam.replace("Cam", "")).name = cam
        col.separator()
        col.label(text="F12 renders the current camera")


CLASSES = (HAVEN_OT_walk, HAVEN_OT_cutaway, HAVEN_OT_camera, HAVEN_PT_panel)


def register():
    for cls in CLASSES:
        try:
            bpy.utils.register_class(cls)
        except ValueError:          # already registered (re-run)
            bpy.utils.unregister_class(cls)
            bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass


if __name__ == "__main__" or __name__.startswith("haven_walk"):
    register()
