"""What the agents produce: stances, plan steps, negotiation rounds, and the plan itself.

A Plan is a derived view on the WorldState: a pure function of (impact, forecast, which agents
are enabled, the manager's rules). Toggling an agent is an input event; the plan recomputes.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

StanceKind = Literal["propose", "support", "critique", "veto"]
PlanStatus = Literal["none", "draft", "approved", "executing", "done"]
StepKind = Literal["isolate", "valve", "hold", "escort", "relocate", "move_item", "shelter", "notify", "call", "ticket"]


class Constraint(BaseModel):
    type: Literal["hard", "soft"] = "hard"
    rule: str                       # human-readable, e.g. "Maya keeps a feasible step-free route"
    code: str = ""                  # machine code, e.g. "step_free:maya", "no_off_campus"
    source: str = ""                # agent id or "manager"


class Stance(BaseModel):
    agent: str                      # "safety" | "housing" | "capacity" | "resident:maya" | ...
    label: str                      # "Maya's agent"
    stance: StanceKind
    reason: str
    constraint: Constraint | None = None
    step_ids: list[str] = Field(default_factory=list)   # steps this stance is about
    resident: str | None = None     # resident id for resident agents
    source: str = "rules"           # rules | claude | fetch:claude (a logged AgentStance event)


class PlanStep(BaseModel):
    id: str
    order: int
    kind: StepKind
    actor: str                      # "facilities" | "plumber" | "ra_4" | "staff" | "haven" | "manager"
    title: str
    reason: str
    at_s: float = 0.0               # start, sim-seconds after the plan's computed_step
    deadline_s: float | None = None  # must be done by (sim-seconds after computed_step)
    people: list[str] = Field(default_factory=list)     # resident ids involved
    target: str | None = None       # space / equipment id
    command: dict[str, Any] | None = None   # EquipmentCommand payload issued on approval
    satisfies: list[str] = Field(default_factory=list)   # agent ids whose constraint this step honours
    count: int = 0                  # people covered (for relocate/notify)


class Message(BaseModel):
    """One tailored message the plan implies: who, how, in what language, saying what."""

    id: str
    to: str                         # resident id, staff id, or "plumber" / "dean"
    name: str
    role: Literal["resident", "staff", "external"]
    channel: str                    # sms | call | app | text_only | email
    lang: str = "en"
    priority: Literal["critical", "normal"] = "normal"
    text: str
    step_ids: list[str] = Field(default_factory=list)
    count: int = 1                  # people this message goes to (grouped messages)


class Check(BaseModel):
    """One hard-constraint verification the checker runs on the final plan, agents or no agents."""

    code: str
    label: str
    ok: bool
    detail: str = ""
    severity: Literal["safety", "access", "rule", "capacity"] = "safety"


class Attack(BaseModel):
    """One red-team attack on the final plan: did it survive, and what fix the planner applied."""

    code: str
    label: str
    ok: bool
    detail: str = ""
    fixed: bool = False
    fix: str = ""


class Round(BaseModel):
    n: int
    title: str
    summary: str
    steps: list[PlanStep]
    stances: list[Stance]
    feasible: bool                  # no enabled hard constraint vetoes this proposal


class Plan(BaseModel):
    version: int = 0
    computed_step: int = 0
    status: PlanStatus = "none"
    rounds: list[Round] = Field(default_factory=list)
    steps: list[PlanStep] = Field(default_factory=list)      # the final proposal
    stances: list[Stance] = Field(default_factory=list)      # stances on the final proposal
    left_behind: list[str] = Field(default_factory=list)     # residents with a hard need nobody spoke for
    metrics: dict[str, float | int] = Field(default_factory=dict)
    enabled_agents: list[str] = Field(default_factory=list)
    rules: list[Constraint] = Field(default_factory=list)     # manager-imposed (voice) constraints
    headline: str = ""
    messages: list[Message] = Field(default_factory=list)
    checks: list[Check] = Field(default_factory=list)       # the adversarial checker's verdicts
    signature: int = 0              # content hash; version bumps only when this changes
    situation: str = ""             # key of the facts the stances were given for (planner.situation_key)
    attacks: list[Attack] = Field(default_factory=list)     # the red team's attacks on the final plan
