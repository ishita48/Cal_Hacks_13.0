"""David Blackwell Hall, UC Berkeley (2401 Durant Ave) as a buildable spec.

Massing follows the real building (aerial imagery + public project data): a long spine on
Dana St spanning the block from Durant Ave (south) to Bancroft Way (north), a C-shaped south
block wrapping a podium garden, and a north block wrapping a closed courtyard. ~84 m x 46 m,
ground floor + six residential floors, ~750 beds in double rooms with gender-inclusive
bathroom pods and a lounge + study room on every floor.

Interior layout and building services are invented but architecturally conventional (real
interior plans are not public): double-loaded 2 m corridors, three egress stairs, two
passenger lifts at the main lobby, a partial basement holding the main electrical room next
to the domestic-water mechanical room.

The failure mode the demo exercises is real and well documented (cf. Hurricane Sandy
hospital outages): normal AND standby power for the lifts both pass through switchgear in
one basement electrical room, so water reaching that room takes out every step-free route.
"""

from dataclasses import dataclass, field

from .model import (ExternalDestination, 
    BuildingSpec,
    Dependency,
    Equipment,
    Level,
    Opening,
    Rect,
    Space,
    VerticalLink,
)

RESIDENTIAL_LEVELS = ["L2", "L3", "L4", "L5", "L6", "L7"]
ROOM_TARGET_WIDTH = 4.8   # m along the corridor; a typical premium double is ~4.5 x 6 m
FLOOR_TO_FLOOR = 3.1
GROUND_HEIGHT = 5.0
BASEMENT_DEPTH = 4.5

# ---- plan skeleton (shared by every residential floor) ---------------------------------
# Corridors, 2 m wide. Rectangles touch end-to-end; openings join them.
CORRIDORS = {
    "spine": Rect(x0=6, y0=6, x1=8, y1=78),     # along Dana St
    "south": Rect(x0=8, y0=6, x1=40, y1=8),     # along Durant Ave
    "middle": Rect(x0=8, y0=40, x1=46, y1=42),  # between the garden and the courtyard
    "east": Rect(x0=38, y0=42, x1=40, y1=76),   # east side of the courtyard
    "north": Rect(x0=8, y0=76, x1=44, y1=78),   # along Bancroft Way
}

STAIRS = {
    "stair_se": ("South-east stair", Rect(x0=35.6, y0=0, x1=40, y1=6)),
    "stair_nw": ("North-west stair", Rect(x0=6, y0=78, x1=10.4, y1=84)),
    "stair_ne": ("North-east stair", Rect(x0=41.6, y0=78, x1=46, y1=84)),
}
LIFTS = {
    "lift_1": ("Lift 1", Rect(x0=8, y0=14, x1=10.6, y1=16.4)),
    "lift_2": ("Lift 2", Rect(x0=8, y0=16.4, x1=10.6, y1=18.8)),
}
RISER_SHAFT = Rect(x0=10.6, y0=14, x1=14, y1=18.8)   # electrical riser, B1 -> roof
TRASH_ROOM = Rect(x0=8, y0=18.8, x1=14, y1=22)

FOOTPRINT = [
    Rect(x0=0, y0=0, x1=14, y1=84),     # spine
    Rect(x0=14, y0=0, x1=40, y1=14),    # south wing
    Rect(x0=14, y0=34, x1=46, y1=48),   # middle wing
    Rect(x0=32, y0=48, x1=46, y1=70),   # east wing
    Rect(x0=14, y0=70, x1=46, y1=84),   # north wing
]
GROUND_EXTRA = [Rect(x0=14, y0=14, x1=40, y1=34)]   # podium under the L2 garden


@dataclass
class _Builder:
    levels: list[Level] = field(default_factory=list)
    spaces: list[Space] = field(default_factory=list)
    openings: list[Opening] = field(default_factory=list)
    equipment: list[Equipment] = field(default_factory=list)
    deps: list[Dependency] = field(default_factory=list)
    _room_counter: dict[str, int] = field(default_factory=dict)

    # ---- spaces ------------------------------------------------------------------------

    def add(self, level: str, kind: str, name: str, rect: Rect, sid: str | None = None, **kw) -> Space:
        sid = sid or f"{level}-{_slug(name)}"
        sp = Space(id=sid, level=level, kind=kind, name=name, rect=rect, **kw)
        self.spaces.append(sp)
        return sp

    def room(self, level: str, rect: Rect, beds: int = 2) -> Space:
        floor = level[1:]
        n = self._room_counter.get(level, 0) + 1
        self._room_counter[level] = n
        number = f"{floor}{n:02d}"
        return self.add(
            level, "room", f"Room {number}", rect, sid=f"room_{number}", capacity=beds,
            tags=["double" if beds == 2 else "single"],
        )

    def row(
        self,
        level: str,
        along: str,
        start: float,
        end: float,
        band: tuple[float, float],
        modules: list[tuple[str, str, float | None]],
        reverse: bool = False,
    ) -> None:
        """Lay modules side by side along one side of a corridor.

        modules: (kind, name, width). width=None means 'resident rooms that share the
        leftover length equally' and name is then the room count, or "auto".
        """
        fixed = sum(w for _, _, w in modules if w is not None)
        fill_slots = [m for m in modules if m[2] is None]
        counts = []
        leftover = (end - start) - fixed
        if fill_slots:
            autos = [m for m in fill_slots if m[1] == "auto"]
            explicit = sum(int(m[1]) for m in fill_slots if m[1] != "auto")
            if autos:
                total = max(explicit + len(autos), round(leftover / ROOM_TARGET_WIDTH))
                per_auto = (total - explicit) / len(autos)
                counts = [int(m[1]) if m[1] != "auto" else round(per_auto) for m in fill_slots]
            else:
                counts = [int(m[1]) for m in fill_slots]
        room_w = leftover / sum(counts) if counts else 0.0
        seq = list(reversed(modules)) if reverse else modules
        fill_iter = iter(reversed(counts) if reverse else counts)

        pos = end if reverse else start
        for kind, name, width in seq:
            n_rooms = next(fill_iter) if width is None else 0
            pieces = [(kind, name, width)] if width is not None else [("room", "", room_w)] * n_rooms
            for p_kind, p_name, p_w in pieces:
                a, b = (pos - p_w, pos) if reverse else (pos, pos + p_w)
                pos = a if reverse else b
                rect = (
                    Rect(x0=a, y0=band[0], x1=b, y1=band[1])
                    if along == "x"
                    else Rect(x0=band[0], y0=a, x1=band[1], y1=b)
                )
                if p_kind == "room":
                    self.room(level, rect)
                elif p_kind == "stair":
                    pass  # stairs are placed from STAIRS so every level shares one footprint
                else:
                    self.add(level, p_kind, p_name, rect, sid=f"{level}-{_slug(p_name)}",
                             capacity=_default_capacity(p_kind, rect))

    # ---- openings ----------------------------------------------------------------------

    def opening(self, level: str, a: str, b: str, x: float, y: float, width: float, axis: str,
                kind: str = "door", step_free: bool = True, oid: str | None = None) -> None:
        oid = oid or f"{level}:{a}~{b}"
        self.openings.append(
            Opening(id=oid, level=level, a=a, b=b, x=x, y=y, width=width, axis=axis, kind=kind,
                    step_free=step_free)
        )

    def auto_doors(self, level: str) -> None:
        """Give every enclosed space a door onto the circulation it touches.

        Circulation = corridors and lobbies. Corridors that touch each other get a full-width
        opening. Rooms get one 0.9 m door on their longest shared edge with circulation.
        """
        here = [s for s in self.spaces if s.level == level]
        circ = [s for s in here if s.kind in ("corridor", "lobby")]
        existing = {(o.a, o.b) for o in self.openings} | {(o.b, o.a) for o in self.openings}

        for i, c1 in enumerate(circ):
            for c2 in circ[i + 1:]:
                seg = _shared_edge(c1.rect, c2.rect)
                if seg and (c1.id, c2.id) not in existing:
                    x, y, length, axis = seg
                    self.opening(level, c1.id, c2.id, x, y, length, axis, kind="opening")

        for sp in here:
            if sp.kind in ("corridor", "lobby", "courtyard", "riser", "retail"):
                continue
            best = None
            for c in circ:
                seg = _shared_edge(sp.rect, c.rect)
                if seg and seg[2] >= 0.9 and (best is None or seg[2] > best[1][2]):
                    best = (c, seg)
            if best is None or (sp.id, best[0].id) in existing:
                continue
            c, (x, y, length, axis) = best
            if sp.kind == "lift":
                self.opening(level, sp.id, c.id, x, y, 1.1, axis, kind="lift_door")
            elif sp.kind == "stair":
                self.opening(level, sp.id, c.id, x, y, 1.1, axis, kind="fire_door")
            else:
                width = 1.8 if sp.kind in ("lounge", "amenity", "laundry", "study", "kitchen") else 0.9
                self.opening(level, sp.id, c.id, x, y, min(width, length - 0.2), axis)


def build_blackwell_hall() -> BuildingSpec:
    b = _Builder()

    # ---- levels ------------------------------------------------------------------------
    b.levels.append(Level(id="B1", index=-1, name="Basement", short="basement", elevation=-BASEMENT_DEPTH,
                          height=BASEMENT_DEPTH))
    b.levels.append(Level(id="L1", index=1, name="Ground", short="ground", elevation=0.0, height=GROUND_HEIGHT))
    for i, lv in enumerate(RESIDENTIAL_LEVELS):
        b.levels.append(
            Level(id=lv, index=i + 2, name=f"Floor {i + 2}", short=str(i + 2),
                  elevation=GROUND_HEIGHT + i * FLOOR_TO_FLOOR, height=FLOOR_TO_FLOOR)
        )

    _basement(b)
    _ground(b)
    for lv in RESIDENTIAL_LEVELS:
        _residential(b, lv)

    # Shared vertical elements on every level they serve.
    served_by_lifts = ["B1", "L1", *RESIDENTIAL_LEVELS]
    for lv in served_by_lifts:
        for lid, (name, rect) in LIFTS.items():
            b.add(lv, "lift", name, rect, sid=f"{lv}-{lid}")
        b.add(lv, "riser", "Electrical riser", RISER_SHAFT, sid=f"{lv}-riser_e")
    for lv in ["L1", *RESIDENTIAL_LEVELS]:
        for sid, (name, rect) in STAIRS.items():
            b.add(lv, "stair", name, rect, sid=f"{lv}-{sid}")
    b.add("B1", "stair", "Service stair", Rect(x0=0, y0=18, x1=6, y1=22), sid="B1-stair_svc")
    b.add("L1", "stair", "Service stair", Rect(x0=0, y0=18, x1=6, y1=22), sid="L1-stair_svc")

    for lv in [lv.id for lv in b.levels]:
        b.auto_doors(lv)
    _explicit_openings(b)

    verticals = [
        VerticalLink(id=lid, kind="lift", name=name, spaces={lv: f"{lv}-{lid}" for lv in served_by_lifts},
                     step_free=True, equipment=lid, seconds_per_level=4.0)
        for lid, (name, _) in LIFTS.items()
    ]
    verticals += [
        VerticalLink(id=sid, kind="stair", name=name,
                     spaces={lv: f"{lv}-{sid}" for lv in ["L1", *RESIDENTIAL_LEVELS]},
                     step_free=False, seconds_per_level=14.0)
        for sid, (name, _) in STAIRS.items()
    ]
    verticals.append(
        VerticalLink(id="stair_svc", kind="stair", name="Service stair",
                     spaces={"B1": "B1-stair_svc", "L1": "L1-stair_svc"}, step_free=False,
                     seconds_per_level=18.0)
    )

    _services(b)
    _designate_singles(b)

    return BuildingSpec(
        id="blackwell_hall",
        name="David Blackwell Hall",
        address="2401 Durant Ave, Berkeley, CA 94704",
        footprint=FOOTPRINT,
        levels=b.levels,
        spaces=b.spaces,
        openings=b.openings,
        verticals=verticals,
        equipment=b.equipment,
        dependencies=b.deps,
        external_destinations=[
            ExternalDestination(id="unit2_lounges", name="Unit 2 lounges (next building, on campus)", capacity=60),
            ExternalDestination(id="hotel_rooms", name="Hotel rooms (arranged by housing, off campus)", capacity=10**6, off_campus=True),
        ],
        notes=[
            "Massing from aerial imagery and public project data; interior and services are a "
            "plausible reconstruction, not facilities drawings.",
            "Lifts are on standby power via ATS-EQ, but ATS-EQ sits in the same basement "
            "electrical room as the normal-power switchboard.",
            "A full-bore break of the 4-inch riser at ~60 psi releases on the order of 100+ L/s "
            "(orifice flow, Cd ~0.6); the mechanical room floor drain and sump cannot keep up.",
        ],
    )


# ---- level layouts -----------------------------------------------------------------------


def _residential(b: _Builder, lv: str) -> None:
    for name, rect in CORRIDORS.items():
        b.add(lv, "corridor", f"{name.title()} corridor", rect, sid=f"{lv}-cor_{name}")
    b.add(lv, "service", "Trash room", TRASH_ROOM, sid=f"{lv}-trash")

    # South row along Durant (y 0..6): corner glass-bay lounge, rooms, SE stair.
    b.row(lv, "x", 0, 40, (0, 6), [
        ("lounge", "Corner lounge", 8.0),
        ("room", "auto", None),
        ("stair", "", 4.4),
    ])
    # South wing, garden side (y 8..14).
    b.row(lv, "x", 8, 40, (8, 14), [
        ("room", "3", None),
        ("bathroom", "South bathrooms", 4.8),
        ("room", "auto", None),
    ])
    # Spine, Dana St side (x 0..6), y 6..84.
    b.row(lv, "y", 6, 84, (0, 6), [
        ("room", "auto", None),
        ("bathroom", "West bathrooms", 4.8),
        ("room", "auto", None),
        ("study", "North-west study", 8.0),
    ])
    # Spine, garden side, between the lift core and the middle wing (x 8..14, y 22..34).
    b.row(lv, "y", 22, 34, (8, 14), [("room", "auto", None)])
    # Spine, courtyard side (x 8..14, y 48..70).
    b.row(lv, "y", 48, 70, (8, 14), [
        ("room", "auto", None),
        ("bathroom", "Courtyard bathrooms", 4.8),
    ])
    # Middle wing, garden side (y 34..40): rooms then the floor lounge + kitchen (has the fridge).
    b.row(lv, "x", 8, 46, (34, 40), [
        ("room", "auto", None),
        ("kitchen", "Floor lounge & kitchen", 7.0),
    ])
    # Middle wing, courtyard side (y 42..48), west of the east corridor, plus an east study.
    b.row(lv, "x", 8, 38, (42, 48), [("room", "auto", None)])
    b.add(lv, "study", "East study", Rect(x0=40, y0=42, x1=46, y1=48), sid=f"{lv}-east_study")
    # East wing (x 32..38 courtyard side; x 40..46 outer side), y 48..70.
    b.row(lv, "y", 48, 70, (32, 38), [("room", "auto", None)])
    b.row(lv, "y", 48, 70, (40, 46), [("bathroom", "East bathrooms", 4.4), ("room", "auto", None)])
    # North wing, courtyard side (y 70..76): rooms west of the east corridor; laundry east of it.
    b.row(lv, "x", 8, 38, (70, 76), [("room", "auto", None)])
    b.add(lv, "laundry", "Laundry", Rect(x0=40, y0=70, x1=46, y1=76), sid=f"{lv}-laundry")
    # North row along Bancroft (y 78..84): between the two north stairs.
    b.row(lv, "x", 10.4, 41.6, (78, 84), [("room", "auto", None)])


def _ground(b: _Builder) -> None:
    lv = "L1"
    b.add(lv, "lobby", "Main lobby", Rect(x0=0, y0=0, x1=14, y1=14), sid="L1-lobby",
          capacity=60, tags=["front_desk", "main_entrance"])
    for name in ("spine", "north", "east"):
        rect = CORRIDORS[name]
        if name == "spine":
            rect = Rect(x0=6, y0=14, x1=8, y1=78)
        if name == "east":
            rect = Rect(x0=38, y0=48, x1=40, y1=76)
        b.add(lv, "corridor", f"{name.title()} corridor", rect, sid=f"L1-cor_{name}")
    b.add(lv, "service", "Trash room", TRASH_ROOM, sid="L1-trash")

    b.add(lv, "retail", "Durant Ave retail", Rect(x0=14, y0=0, x1=35.6, y1=12), sid="L1-retail_durant")
    b.add(lv, "amenity", "Fitness center", Rect(x0=14, y0=12, x1=40, y1=34), sid="L1-fitness", capacity=40)
    b.add(lv, "service", "Mail & packages", Rect(x0=0, y0=14, x1=6, y1=18), sid="L1-mail")
    b.add(lv, "office", "Residential Life office", Rect(x0=0, y0=22, x1=6, y1=30), sid="L1-rl_office", capacity=8)
    b.add(lv, "bathroom", "Ground restrooms", Rect(x0=0, y0=30, x1=6, y1=36), sid="L1-restrooms")
    b.add(lv, "study", "Group study rooms", Rect(x0=0, y0=36, x1=6, y1=50), sid="L1-study", capacity=24)
    # A practice room with instruments is not somewhere to sleep: never an overflow destination.
    b.add(lv, "amenity", "Music practice", Rect(x0=0, y0=50, x1=6, y1=58), sid="L1-music", capacity=8,
          tags=["no_overflow"])
    b.add(lv, "laundry", "Main laundry", Rect(x0=0, y0=58, x1=6, y1=66), sid="L1-laundry", capacity=12)
    b.add(lv, "storage", "Bike storage", Rect(x0=0, y0=66, x1=6, y1=76), sid="L1-bikes")
    b.add(lv, "retail", "Bancroft & Dana retail", Rect(x0=0, y0=76, x1=6, y1=84), sid="L1-retail_bancroft")
    b.add(lv, "service", "Package room", Rect(x0=8, y0=22, x1=14, y1=34), sid="L1-packages")
    b.add(lv, "amenity", "Academic Success Center", Rect(x0=8, y0=34, x1=46, y1=48), sid="L1-academic",
          capacity=120, tags=["overflow_candidate"])
    b.add(lv, "kitchen", "Community kitchen", Rect(x0=8, y0=48, x1=14, y1=70), sid="L1-community_kitchen",
          capacity=30)
    b.add(lv, "amenity", "Recreation room", Rect(x0=32, y0=48, x1=38, y1=70), sid="L1-rec", capacity=40,
          tags=["overflow_candidate"])
    b.add(lv, "office", "Facilities office", Rect(x0=40, y0=48, x1=46, y1=70), sid="L1-facilities")
    b.add(lv, "amenity", "Courtyard lounge", Rect(x0=8, y0=70, x1=38, y1=76), sid="L1-courtyard_lounge",
          capacity=50, tags=["overflow_candidate"])
    b.add(lv, "storage", "Building storage", Rect(x0=40, y0=70, x1=46, y1=76), sid="L1-storage")
    b.add(lv, "amenity", "Stiles Hall", Rect(x0=10.4, y0=78, x1=41.6, y1=84), sid="L1-stiles", capacity=80)
    b.add(lv, "courtyard", "North courtyard", Rect(x0=14, y0=48, x1=32, y1=70), sid="L1-courtyard",
          outdoor=True)


def _basement(b: _Builder) -> None:
    lv = "B1"
    b.add(lv, "corridor", "Basement corridor", Rect(x0=6, y0=4, x1=8, y1=40), sid="B1-cor_spine")
    b.add(lv, "corridor", "Plant corridor", Rect(x0=8, y0=22, x1=30, y1=24), sid="B1-cor_plant")
    b.add(lv, "mechanical", "Fire pump room", Rect(x0=0, y0=4, x1=6, y1=18), sid="B1-fire_pump")
    b.add(lv, "generator", "Generator room", Rect(x0=0, y0=24, x1=6, y1=40), sid="B1-generator")
    b.add(lv, "storage", "Basement storage", Rect(x0=8, y0=4, x1=14, y1=14), sid="B1-storage")
    b.add(lv, "service", "Lift machine & trash", TRASH_ROOM, sid="B1-trash")
    b.add(lv, "mechanical", "Mechanical room (domestic water)", Rect(x0=14, y0=4, x1=30, y1=22),
          sid="B1-mech", tags=["floor_drain", "sump"])
    b.add(lv, "electrical", "Main electrical room", Rect(x0=14, y0=24, x1=30, y1=36), sid="B1-elec")
    b.add(lv, "storage", "Housekeeping storage", Rect(x0=8, y0=24, x1=14, y1=40), sid="B1-housekeeping")


def _explicit_openings(b: _Builder) -> None:
    # Street doors and exits (all step-free at grade).
    b.opening("L1", "L1-lobby", "outside", 7.0, 0.0, 2.4, "x", kind="exit", oid="exit_main_durant")
    b.opening("L1", "L1-lobby", "outside", 0.0, 7.0, 1.8, "y", kind="exit", oid="exit_dana")
    b.opening("L1", "L1-stair_se", "outside", 37.8, 0.0, 1.1, "x", kind="exit", oid="exit_stair_se")
    b.opening("L1", "L1-stair_nw", "outside", 8.2, 84.0, 1.1, "x", kind="exit", oid="exit_stair_nw")
    b.opening("L1", "L1-stair_ne", "outside", 43.8, 84.0, 1.1, "x", kind="exit", oid="exit_stair_ne")
    b.opening("L1", "L1-stiles", "outside", 26.0, 84.0, 1.8, "x", kind="exit", oid="exit_stiles")
    # Ground-floor rooms that open onto the street or the courtyard rather than a corridor.
    b.opening("L1", "L1-retail_durant", "outside", 24.0, 0.0, 2.0, "x", kind="door", oid="retail_durant_street")
    b.opening("L1", "L1-retail_bancroft", "outside", 3.0, 84.0, 1.8, "x", kind="door", oid="retail_bancroft_street")
    b.opening("L1", "L1-courtyard", "L1-courtyard_lounge", 23.0, 70.0, 2.4, "x", kind="door")
    b.opening("L1", "L1-courtyard", "L1-community_kitchen", 14.0, 59.0, 1.8, "y", kind="door")
    b.opening("L1", "L1-courtyard", "L1-rec", 32.0, 59.0, 1.8, "y", kind="door")
    b.opening("L1", "L1-academic", "L1-cor_east", 39.0, 48.0, 2.0, "x", kind="opening")
    # The ground-floor north corridor (x 8..44) reaches the NE stair only through its top edge.
    # Basement plant rooms open onto the plant corridor (auto_doors covers them); the electrical
    # room gets a second, double door so switchgear can be swapped.
    b.opening("B1", "B1-elec", "B1-cor_plant", 26.0, 24.0, 1.8, "x", oid="B1:elec_double_door")
    b.opening("B1", "B1-mech", "B1-cor_plant", 18.0, 22.0, 1.8, "x", oid="B1:mech_double_door")


def _services(b: _Builder) -> None:
    eq, dep = b.equipment.append, b.deps.append

    def E(id, kind, name, level, x, y, space, flood_height=None, **props):
        eq(Equipment(id=id, kind=kind, name=name, level=level, x=x, y=y, space=space,
                     flood_height=flood_height, props=props))

    def D(src, dst, rel="powers"):
        dep(Dependency(src=src, dst=dst, rel=rel))

    # ---- electrical: utility -> main switchboard sections -> risers -> floor panels ---------
    # The original switchgear sits on a 300 mm housekeeping pad; section B and ATS-EQ were added in
    # a later retrofit at floor level (100 mm channel base), so they are the first to go under.
    E("pge_service", "utility_feed", "PG&E 12 kV service + pad transformer", "L1", 20.0, -3.0, "L1-retail_durant",
      note="Transformer is outdoors in a vault on Durant Ave")
    E("msb", "switchboard", "Main switchboard MSB (4000 A)", "B1", 18.0, 34.5, "B1-elec", flood_height=0.30)
    E("msb_a", "switchboard_section", "MSB section A", "B1", 16.5, 34.5, "B1-elec", flood_height=0.30)
    E("msb_b", "switchboard_section", "MSB section B", "B1", 19.5, 34.5, "B1-elec", flood_height=0.10)
    E("msb_c", "switchboard_section", "MSB section C", "B1", 22.5, 34.5, "B1-elec", flood_height=0.30)
    E("msb_m", "switchboard_section", "MSB section M (mechanical)", "B1", 25.5, 34.5, "B1-elec", flood_height=0.30)
    D("pge_service", "msb")
    for s in ("msb_a", "msb_b", "msb_c", "msb_m"):
        D("msb", s)

    E("generator", "generator", "Standby generator 500 kW (diesel)", "B1", 3.0, 32.0, "B1-generator",
      flood_height=0.30)
    E("ats_em", "transfer_switch", "ATS-EM (life safety)", "B1", 15.5, 25.2, "B1-elec", flood_height=0.45)
    E("ats_eq", "transfer_switch", "ATS-EQ (lifts + sump)", "B1", 17.5, 25.2, "B1-elec", flood_height=0.10)
    D("generator", "ats_em", "backs_up")
    D("generator", "ats_eq", "backs_up")
    D("msb_a", "ats_em")
    D("msb_b", "ats_eq")

    E("fire_alarm", "fire_alarm", "Fire alarm control panel", "L1", 1.0, 1.0, "L1-lobby")
    E("emergency_lighting", "emergency_lighting", "Egress lighting + exit signs", "B1", 15.5, 25.6, "B1-elec")
    D("ats_em", "fire_alarm")
    D("ats_em", "emergency_lighting")

    # Lifts: elevator controllers fed from ATS-EQ (normal via MSB-B, standby via generator).
    for lid, (name, rect) in LIFTS.items():
        E(f"{lid}_ctrl", "elevator_controller", f"{name} controller", "B1", rect.cx, rect.cy + 0.3, f"B1-{lid}",
          flood_height=0.6)
        E(lid, "lift", name, "L1", rect.cx, rect.cy, f"L1-{lid}", capacity_persons=13, wheelchair=True)
        D("ats_eq", f"{lid}_ctrl")
        D(f"{lid}_ctrl", lid, "controls")

    riser_map = {"msb_a": ["B1", "L1", "L2"], "msb_b": ["L3", "L4"], "msb_c": ["L5", "L6", "L7"]}
    for section, levels in riser_map.items():
        rp = f"riser_{section[-1]}"
        E(rp, "panel", f"Riser {section[-1].upper()} distribution", "B1", 12.3, 15.0, "B1-riser_e")
        D(section, rp)
        for lv in levels:
            pid = f"panel_{lv}"
            E(pid, "panel", f"Floor panel {lv}", lv, 12.3, 16.4, f"{lv}-riser_e", serves_level=lv)
            D(rp, pid)

    # ---- domestic water --------------------------------------------------------------------
    E("water_main", "water_main", "6\" domestic water service (EBMUD)", "B1", 20.0, 4.6, "B1-mech")
    E("main_valve", "valve", "Main shut-off (gate valve)", "B1", 20.0, 5.4, "B1-mech",
      note="Old-style gate valve; needs a plumber with a valve key to close fully", seconds_to_close=420)
    E("booster_pump", "pump", "Domestic water booster pumps", "B1", 22.0, 10.0, "B1-mech", flood_height=0.25)
    E("water_heater", "water_heater", "Domestic water heaters", "B1", 26.0, 8.0, "B1-mech", flood_height=0.3)
    E("water_riser", "water_riser", "Domestic water riser (4\")", "B1", 27.5, 21.0, "B1-mech",
      burst_flow_lps=150.0)
    E("sump_pump", "sump_pump", "Sump pump (duplex)", "B1", 15.0, 5.0, "B1-mech", flood_height=0.5,
      capacity_lps=3.0)
    D("water_main", "main_valve", "feeds_water")
    D("main_valve", "booster_pump", "feeds_water")
    D("booster_pump", "water_riser", "feeds_water")
    D("water_riser", "water_heater", "feeds_water")
    D("msb_m", "booster_pump")
    D("msb_m", "water_heater")
    D("ats_eq", "sump_pump")

    # ---- per-floor loads that matter to residents ------------------------------------------
    for lv in RESIDENTIAL_LEVELS:
        fid = f"fridge_{lv}"
        E(fid, "fridge", f"{lv} lounge fridge", lv, 44.0, 39.0, f"{lv}-floor_lounge_kitchen")
        D(f"panel_{lv}", fid)

    # ---- the sensor (ESP32 + water probe on the mechanical room floor by the riser) ---------
    E("basement_mech_1", "sensor", "Water sensor (ESP32)", "B1", 27.0, 20.0, "B1-mech", hardware="ESP32")
    D("basement_mech_1", "water_riser", "monitors")


def _designate_singles(b: _Builder) -> None:
    """19 singles, matching the real building: per floor the RA's room and two accessible
    singles closest to the lifts, plus room 412 (accessible single, far end of the south wing)."""
    lift_lobby = (9.0, 17.0)

    def make_single(sp: Space, tag: str, accessible: bool) -> None:
        sp.capacity = 1
        sp.tags = ["single", tag]
        sp.accessible = accessible

    for lv in RESIDENTIAL_LEVELS:
        rooms = sorted(
            (s for s in b.spaces if s.kind == "room" and s.level == lv and s.id != "room_412"),
            key=lambda s: (s.rect.cx - lift_lobby[0]) ** 2 + (s.rect.cy - lift_lobby[1]) ** 2,
        )
        make_single(rooms[0], "ra", accessible=False)
        for sp in rooms[1:3]:
            make_single(sp, "accessible", accessible=True)
    make_single(next(s for s in b.spaces if s.id == "room_412"), "accessible", accessible=True)


# ---- helpers ---------------------------------------------------------------------------------


def _slug(name: str) -> str:
    out = "".join(ch.lower() if ch.isalnum() else "_" for ch in name)
    while "__" in out:
        out = out.replace("__", "_")
    return out.strip("_")


def _default_capacity(kind: str, rect: Rect) -> int:
    if kind in ("lounge", "kitchen", "study"):
        return max(6, int(rect.area / 2.5))
    return 0


def _shared_edge(a: Rect, b: Rect, eps: float = 1e-6):
    """Shared wall segment between two touching rects -> (cx, cy, length, axis) or None."""
    if abs(a.x1 - b.x0) < eps or abs(b.x1 - a.x0) < eps:
        x = a.x1 if abs(a.x1 - b.x0) < eps else a.x0
        lo, hi = max(a.y0, b.y0), min(a.y1, b.y1)
        if hi - lo > eps:
            return (x, (lo + hi) / 2, hi - lo, "y")
    if abs(a.y1 - b.y0) < eps or abs(b.y1 - a.y0) < eps:
        y = a.y1 if abs(a.y1 - b.y0) < eps else a.y0
        lo, hi = max(a.x0, b.x0), min(a.x1, b.x1)
        if hi - lo > eps:
            return ((lo + hi) / 2, y, hi - lo, "x")
    return None
