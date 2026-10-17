"""Who lives in Blackwell Hall on a Tuesday at 23:41, and who is on duty.

Deterministic (seeded). Named residents carry the demo's story; everyone else is generated
with realistic proportions so the cascade affects a real crowd (~750 people), not 20 dots.
Each resident profile is also the seed for that person's agent.
"""

import random
from typing import Literal

from pydantic import BaseModel, Field

from ..building.model import BuildingSpec

Presence = Literal["in_room", "asleep", "away", "elsewhere"]
Need = Literal[
    "step_free_route",        # cannot use stairs at all (wheelchair) -> hard constraint
    "stairs_slow",            # can use stairs slowly / with help (crutches, chronic pain)
    "visual_alerts",          # Deaf / hard of hearing: no calls, flashing + text
    "guide_dog",              # blind / low vision with a guide dog: escort preferred
    "refrigerated_medication",  # e.g. insulin kept in the floor fridge
    "medical_device_power",   # CPAP / powered device that needs an outlet overnight
]


class Contact(BaseModel):
    channel: Literal["sms", "call", "app", "text_only"] = "app"
    lang: str = "en"


class Resident(BaseModel):
    id: str
    name: str
    room: str
    level: str
    year: str
    needs: list[Need] = Field(default_factory=list)
    presence: Presence = "in_room"
    location: str | None = None      # space id when presence == "elsewhere"
    away_until: str | None = None    # "07:30"
    contact: Contact = Field(default_factory=Contact)
    medication_location: str | None = None   # equipment id (fridge) holding their meds
    role: Literal["resident", "ra"] = "resident"
    story: str | None = None         # one line the agent uses to speak for them


class Staff(BaseModel):
    id: str
    name: str
    role: str
    location: str                    # space id, or "off_site"
    on_call: bool = False
    contact: Contact = Field(default_factory=Contact)


class Roster(BaseModel):
    residents: list[Resident]
    staff: list[Staff]

    def by_id(self) -> dict[str, Resident]:
        return {r.id: r for r in self.residents}


# Named residents: (id, name, level, room or None, year, needs, presence, extra)
_NAMED: list[dict] = [
    dict(id="maya", name="Maya Reyes", room="room_412", year="Junior", needs=["step_free_route"],
         presence="in_room", contact=Contact(channel="call"),
         story="Uses a power wheelchair; cannot descend without a working lift. Awake, studying."),
    dict(id="dana", name="Dana Okafor", level="L3", year="Sophomore", needs=["refrigerated_medication"],
         presence="asleep", medication_location="fridge_L3", contact=Contact(channel="sms"),
         story="Type 1 diabetic; tonight's and tomorrow's insulin are in the floor 3 lounge fridge."),
    dict(id="jordan", name="Jordan Ellis", level="L3", year="Senior", presence="away", away_until="07:30",
         contact=Contact(channel="sms"),
         story="Works overnight shifts as an EMT; out until 07:30. Do not relocate or wake."),
    dict(id="sam", name="Sam Whitfield", level="L4", year="Freshman", needs=["visual_alerts"],
         presence="asleep", contact=Contact(channel="text_only"),
         story="Deaf. Will not hear alarms or calls; needs strobe, text, or a knock with a light."),
    dict(id="lucia", name="Lucía Morales", level="L3", year="Freshman", presence="in_room",
         contact=Contact(channel="sms", lang="es"),
         story="Prefers Spanish for anything urgent; first semester in the US."),
    dict(id="theo", name="Theo Park", level="L4", year="Sophomore", needs=["stairs_slow"], presence="in_room",
         contact=Contact(channel="sms"),
         story="Broken ankle, on crutches for 4 more weeks. Can do stairs slowly with someone beside him."),
    dict(id="nora", name="Nora Lindqvist", level="L4", year="Grad", needs=["guide_dog"], presence="asleep",
         contact=Contact(channel="call"),
         story="Blind, with a guide dog (Juniper). Moves independently but an escort helps in a crowd."),
    dict(id="ahmed", name="Ahmed Siddiqui", level="L6", year="Junior", needs=["step_free_route"],
         presence="asleep", contact=Contact(channel="call"),
         story="Manual wheelchair user on floor 6 (not on the affected riser)."),
    dict(id="grace", name="Grace Liu", level="L3", year="Senior", needs=["medical_device_power"],
         presence="asleep", contact=Contact(channel="sms", lang="zh"),
         story="Sleeps with a CPAP machine; needs a powered outlet overnight."),
]
_RAS = {
    "L2": ("ra_2", "Ben Adeyemi"), "L3": ("ra_3", "Priya Nair"), "L4": ("ra_4", "Marcus Bell"),
    "L5": ("ra_5", "Hana Sato"), "L6": ("ra_6", "Diego Ramirez"), "L7": ("ra_7", "Chloe Martin"),
}

_FIRST = (
    "Aaliyah Aarav Abigail Adrian Aisha Alex Alejandro Amara Amir Ana Andre Anika Aria Arjun Ava "
    "Bianca Brandon Bryce Caleb Camila Carlos Carmen Cecilia Chen Chloe Daniel David Destiny Elena "
    "Eli Emily Emma Ethan Fatima Felix Gabriel Hannah Harper Hassan Ian Imani Isaac Isabella Jada "
    "Jamal Jasmine Javier Jin Joel Jonah Julia Kaito Keanu Kenji Kiara Layla Leah Leo Liam Lily Luca "
    "Luis Maddie Malik Mateo Maya Mei Mia Miguel Mina Nadia Naomi Nathan Nia Noah Olivia Omar Oscar "
    "Parker Quinn Rafael Riya Rohan Ruby Ryan Sara Sebastian Simone Sofia Tariq Tessa Tomas Uma "
    "Valentina Vikram Wen Will Xavier Yara Yusuf Zara Zoe"
).split()
_LAST = (
    "Adams Agarwal Ahmed Alvarez Anderson Bae Baker Banerjee Brown Castillo Chang Chen Choi Cohen "
    "Cruz Davis Diaz Dubois Edwards Evans Fernandez Flores Garcia Gonzalez Gupta Hall Hernandez Hoang "
    "Huang Ibrahim Iyer Jackson Johnson Jones Kang Kaur Khan Kim Kumar Lee Lewis Li Lin Lopez Martin "
    "Martinez Mehta Miller Mitchell Moore Murphy Nakamura Nguyen Novak Okoye Olsen Ortiz Patel Perez "
    "Phillips Rahman Ramos Reddy Rivera Robinson Rodriguez Ross Russo Sanchez Santos Shah Silva Singh "
    "Smith Suzuki Tan Taylor Thomas Thompson Tran Turner Vargas Walker Wang Williams Wilson Wong Wu "
    "Xu Yamamoto Yang Young Zhang Zhao"
).split()
_YEARS = ["Freshman"] * 6 + ["Sophomore"] * 3 + ["Junior", "Senior"]
_LANGS = ["es"] * 4 + ["zh"] * 3 + ["ko", "vi", "hi"]


def build_roster(spec: BuildingSpec, seed: int = 2401, vacancies: int = 22) -> Roster:
    rng = random.Random(seed)
    rooms = sorted((s for s in spec.spaces if s.kind == "room"), key=lambda s: s.id)
    beds: list[tuple[str, str]] = [(r.id, r.level) for r in rooms for _ in range(r.capacity)]
    taken: dict[str, int] = {}
    residents: list[Resident] = []

    def free_room(level: str, accessible: bool | None = None, exclude_tags=("ra",)) -> str:
        options = [
            r for r in rooms
            if r.level == level and taken.get(r.id, 0) < r.capacity
            and not any(t in r.tags for t in exclude_tags)
            and (accessible is None or r.accessible == accessible)
        ]
        return rng.choice(options).id

    def occupy(room_id: str) -> None:
        taken[room_id] = taken.get(room_id, 0) + 1

    space = spec.space
    for lv, (rid, name) in _RAS.items():
        ra_room = next(r for r in rooms if r.level == lv and "ra" in r.tags)
        residents.append(Resident(id=rid, name=name, room=ra_room.id, level=lv, year="Senior", role="ra",
                                  presence="in_room", contact=Contact(channel="call"),
                                  story=f"Resident Assistant for floor {lv[1:]}."))
        occupy(ra_room.id)

    for spec_ in _NAMED:
        d = dict(spec_)
        if "room" not in d:
            needs_access = "step_free_route" in d.get("needs", []) or "guide_dog" in d.get("needs", [])
            d["room"] = free_room(d["level"], accessible=True if needs_access else False)
        d["level"] = space(d["room"]).level
        residents.append(Resident(**d))
        occupy(d["room"])

    # Everyone else fills the remaining beds, minus a few vacancies.
    open_beds = [b for b in beds if taken.get(b[0], 0) < space(b[0]).capacity]
    remaining: list[tuple[str, str]] = []
    counts: dict[str, int] = dict(taken)
    for room_id, level in open_beds:
        if counts.get(room_id, 0) < space(room_id).capacity:
            counts[room_id] = counts.get(room_id, 0) + 1
            remaining.append((room_id, level))
    rng.shuffle(remaining)
    remaining = sorted(remaining[vacancies:])

    used_names = {r.name for r in residents}
    commons = {lv.id: [s.id for s in spec.spaces if s.level == lv.id and s.kind in ("study", "kitchen", "lounge", "laundry")]
               for lv in spec.levels}
    ground = ["L1-study", "L1-laundry", "L1-academic", "L1-community_kitchen", "L1-rec", "L1-fitness"]

    for n, (room_id, level) in enumerate(remaining, start=1):
        name = _unique_name(rng, used_names)
        roll = rng.random()
        if roll < 0.40:
            presence, location = "in_room", None
        elif roll < 0.73:
            presence, location = "asleep", None
        elif roll < 0.90:
            presence, location = "away", None
        else:
            presence = "elsewhere"
            location = rng.choice(commons[level] if rng.random() < 0.6 else ground)
        needs: list[str] = []
        if rng.random() < 0.02:
            needs.append("stairs_slow")
        if rng.random() < 0.01:
            needs.append("visual_alerts")
        if rng.random() < 0.006:
            needs.append("refrigerated_medication")
        if rng.random() < 0.01:
            needs.append("medical_device_power")
        lang = rng.choice(_LANGS) if rng.random() < 0.09 else "en"
        channel = "text_only" if "visual_alerts" in needs else rng.choice(["app", "app", "sms", "sms", "call"])
        residents.append(Resident(
            id=f"r_{n:04d}", name=name, room=room_id, level=level, year=rng.choice(_YEARS),
            needs=needs, presence=presence, location=location,
            away_until=rng.choice(["01:00", "02:30", "08:00", "tomorrow"]) if presence == "away" else None,
            contact=Contact(channel=channel, lang=lang),
            medication_location=f"fridge_{level}" if "refrigerated_medication" in needs else None,
        ))

    staff = [
        Staff(id="rosa", name="Rosa Alvarez", role="Residential Life Coordinator (on-call manager)",
              location="off_site", on_call=True, contact=Contact(channel="call")),
        Staff(id="devon", name="Devon Brooks", role="Night desk attendant", location="L1-lobby",
              contact=Contact(channel="app")),
        Staff(id="kim_cso", name="Alex Kim", role="Community Service Officer (night patrol)", location="L1-lobby",
              contact=Contact(channel="app")),
        Staff(id="luis", name="Luis Ortega", role="Facilities night technician", location="L1-facilities",
              contact=Contact(channel="call")),
        Staff(id="dean", name="Dean of Students", role="Dean of Students", location="off_site",
              contact=Contact(channel="sms")),
    ]
    return Roster(residents=residents, staff=staff)


def _unique_name(rng: random.Random, used: set[str]) -> str:
    while True:
        name = f"{rng.choice(_FIRST)} {rng.choice(_LAST)}"
        if name not in used:
            used.add(name)
            return name
