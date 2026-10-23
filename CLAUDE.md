# HAVEN

Multi-agent emergency response for buildings. A sensor detects an incident in **David Blackwell Hall**
(UC Berkeley, 2401 Durant Ave); HAVEN traces the cascade through one shared dependency graph, specialist
agents + a personal agent per resident negotiate a plan under hard safety/accessibility constraints, a human
governs by voice and approves, then the system acts. PRDs: `HAVEN_PRD (1).docx` (v3, primary), `SYNAPSE_PRD.docx` (extras).

## Non-negotiables
1. **One shared world state.** The backend `WorldEngine` owns the only `WorldState`. Every surface (3D view,
   dashboard, agents) is a view of it or submits input events to it. Never keep a second copy of truth in the client.
2. **The Maya moment.** Toggling Maya's resident agent off must visibly change the computed plan. Protect it.
3. **Logic first, beauty last.** Deterministic logic (graph traversal, constraint checks) does the work; the LLM
   parses, proposes, critiques, explains. Safety and accessibility are hard filters, never weights.

## Architecture
- `backend/` — Python 3.12, FastAPI, NetworkX, uv. Event-sourced:
  - `haven/world/events.py` input events (the only way to change the world), persisted with the step they applied at.
  - `haven/world/state.py` `WorldState` + pure reducer (`apply_input`, `advance`). Fixed step `DT`; deterministic.
    Both take the static `WorldContext` (`haven/world/context.py`: spec, graph, roster, pre-indexed).
  - `haven/world/physics.py` hydraulics: volume per space, weir flow through openings, drains/sump,
    equipment floods at its `flood_height`. One `step()` drives the live world and the forecast.
  - `haven/world/cascade.py` consequences: `assess` (per-resident impact; needs are hard facts, not
    weights), `describe` (chain events with causes), `forecast` (runs the water forward ~60 min).
  - `haven/world/narrative.py` the story so far in plain words: `state.narrative` (stage, headline, detail, next,
    ask, the people named, `contact_at_s`, affected-if-nothing-done vs affected-by-plan). A pure function of
    (context, state, clock) recomputed on every rederive and once a simulated minute; the dashboard's story
    strip, the phone and the story page read it, nobody re-derives those sentences.
  - `haven/world/operations.py` the everyday view (`GET /api/ops`): energy per floor and plant from who is home
    and awake (a dormitory load shape scaled to tonight), cost and carbon from the utility feed's props, the
    standby generator's load and runtime from its props, plant health from each item's `installed` /
    `last_service` / `service_days` / `task` props, and the resilience audit (every electrical item failed alone
    in the graph, every plant room flooded to 15 cm, ranked by who is stranded) whose findings become
    `WorkOrder` input events (`POST /api/ops/work-order`, Linear when keyed). Facility records are spec props.
  - Incidents are not only water: `Situation.kind` is `flood` or `power` (a dead utility feed or generator,
    via `EquipmentCommand off`); `_first_call` picks the plumber, the utility or the generator contractor; the
    planner escorts wheelchair users by lift while the lifts run on standby and shelters them when they do not.
  - `haven/agents/registry.py` who the agents are: `agent_label` / `agent_info` (label, kind, description, named,
    fixed) from the roster; `GET /api/agents` serves it and the frontend never names an agent.
  - Performance: `physics._spill` only visits openings that touch a space holding water (`ctx.links_by_space`),
    in spec order so every replay stays bit-identical; a rederive (forecast + plan) costs ~0.5 s, not 6 s.
  - `haven/world/engine.py` the single mutator: clock loop, persistence, broadcast, replay.
  - `haven/world/store.py` append-only event log (SQLite locally).
  - `haven/api/app.py` HTTP + `/ws` (every client receives identical state frames: `engine.frame()` encodes each one
    once for all subscribers and leaves out `FRAME_EXCLUDE`, i.e. `spoken`, which only the planner reads; `GET /api/state`
    is complete). HTTP responses are gzipped (`GZipMiddleware`): the spec and roster go from ~200 KB to ~15 KB.
    Inputs: `POST /api/sensor` (reading) and `POST /api/command` (valve close/open, breaker off/on).
  - `haven/agents/models.py` + `planner.py` the negotiation (Phase 3): a `Plan` is a derived view, a pure function of
    (impact, forecast, `state.agents`, `state.rules`). Round 1 is the naive proposal, every enabled agent evaluates
    it (propose/support/critique/veto), round 2 folds in the enabled objections. An agent that is off does not
    speak, and anyone with a critical need nobody spoke for lands in `plan.left_behind`: that is the Maya moment.
    Inputs: `POST /api/agent` (toggle), `/api/rule` (manager constraint code), `/api/plan/decision` (approve).
    No LLM decides anything here; an LLM may only paraphrase stances later.
  - `haven/agents/rules.py` voice governance (Phase 5): a spoken sentence -> one constraint code
    (`no_off_campus`, `no_wake`, `shelter_in_place`, `no_moves_after:HH:MM`, `lifts_first`); regex first,
    `haven/agents/llm.py` (Anthropic SDK, key-gated) only as the fallback parser / narrator. The planner
    honours codes, never prose. `POST /api/rule/parse` parses and submits a `ManagerRule` event.
  - Messages: `plan.messages` is derived with the plan (one per person with a need, grouped per step and
    language for everyone else, plus RA / facilities / plumber / dean / manager briefs; es + zh templates).
  - Execution: approving freezes `state.approved_plan`; `WorldEngine.due_actions()` turns its steps into
    input events at their time (`EquipmentCommand` with `step_id`, `ActionEvent` assigned/done). People moved
    by a done step live in `state.moved`, and `assess` judges them where they are. Replay reproduces it all.
    `state.actors` (derived, `derive_actors`) says where each responder with a body is (RA per floor, facilities,
    desk staff, plumber): `at`, `heading`, `step_id`, `status` idle/moving/done/offsite, from the approved plan +
    action reports. The 3D twin, the floor plan and Blender draw responders from it; nobody re-derives it.
  - `haven/integrations/` optional, key-gated sponsors: `cartesia.py` (`POST /api/speak`, CARTESIA_API_KEY),
    `tiger.py` (sensor readings hypertable, TIGER_DATABASE_URL; `GET /api/sensor/{id}/history` falls back to the
    event log). `GET /api/integrations` says what is on. See `backend/.env.example`.
    `fetch.py` (Phase 7): the residents' agents as Fetch.ai uAgents in a Bureau inside the backend (port
    HAVEN_FETCH_PORT, local dispatch; AGENTVERSE_API_KEY adds the mailbox). The planner stays the authority:
    `Society.offer` is an `engine.plan_listeners` callback that puts each round's steps + facts in front of the
    hosted agents; each computes its stance with the same `_resident` function and sends a signed
    `StanceMessage` to the table agent, whose ledger (`GET /api/fetch`) records address, stance, `verified`
    (sender == expected address) and `agrees` (== planner's stance). An agent that is off does not reply.
    `actions.py` performs a step's outward effect once, inside `WorldEngine._execute_due`, and returns the
    detail that goes into the ActionEvent: `twilio.py` (plumber call, demo SMS), `linear.py` (ticket);
    simulated text otherwise. `GET /api/memory` + `POST /api/memory/apply`: manager rules from earlier runs
    (`EventStore.rule_history`), the cross-incident memory.
    `elevenlabs.py` (Phase 8): first voice for `POST /api/speak` (then Cartesia, then the browser; the response
    carries `X-Voice-Provider`), plus `GET /api/voice/agent` for a Conversational AI session grounded in the world.
    `sponsors.py`: `GET /api/sponsors` round-trip proof per sponsor (memoised 30 s, `?fresh=true`).
  - `haven/api/auth.py` roles (MVP step 1, plan in `docs/MVP.md`): `resident` / `ra` / `maintenance` / `admin`,
    decided by the server. With CLERK_SECRET_KEY the `viewer` dependency verifies the Bearer session token against
    Clerk's JWKS and reads `public_metadata.role` (none = resident) and `person_id` (roster link); without it the
    demo is open and `X-Haven-Role` declares the role (default admin, `source: "demo"`). `GET /api/me`.
    With Clerk, those headers mean something only to a verified admin: `auth.preview` gives that role's viewer
    (`preview_by` set), the portal's `read_only_preview` refuses every write but `/api/portal/ask`, and the frontend
    sends them on portal calls only (`getPreview`/`setPreview`, localStorage `haven.preview`), so `/api/me` and
    `/command` always see the real admin.
    `integrations/resend.py` email (RESEND_API_KEY, RESEND_FROM), `POST /api/notify/test` (admin).
    Frontend: `src/state/me.ts` (`useMe`), `api.ts` sends the token (`setTokenGetter`, set by `auth.tsx`) or the
    demo role (localStorage `haven.role`); `src/lib/theme.ts` follows the device unless the viewer picks
    light/dark (`haven.theme`), applied before first paint by `index.html`.
  - `haven/api/portal.py` the multi-role workspace (`docs/MVP.md`): housing records are `HousingEvent` inputs
    (requests, profiles, contacts, duties, inbox, assignments) that survive resets; `snapshot(engine, viewer)` is the
    only thing a non-admin receives (`GET /api/portal/snapshot`, `/ws/portal`, credentials in the first frame), built
    from scratch per role, never a redacted `WorldState`. `incident_for` cuts a live incident per role (residents get
    their own plan message and no step titles, which name others; RAs get people on their floors by situation; maintenance
    gets down plant and facilities steps). Every legacy `/api/*` route and `/ws` is admin-only (middleware in `app.py`).
    `tests/test_portal.py` checks no other resident's name reaches a resident's snapshot.
  - `haven/agents/negotiation.py` (Phase 9): the negotiation for real. `AgentStance` is an input event
    (agent, situation key, round, stance, reason, constraint code, step ids, source); `state.spoken` keeps them
    per `situation#round`; `planner._evaluate` uses a spoken stance over the rule function, so a model's answer
    shapes round 2 (`_revised_proposal` builds escorts only for agents that objected) and replay re-derives the
    plan with no model. `planner.situation_key(sit)` hashes every fact agents reason from. `Negotiator` is a
    plan listener: when the key changes it asks each enabled agent per round (Claude, `stance_llm`, validated by
    `validate` against the codes its role may use, `AGENT_TIMEOUT_S`), residents through `Society.ask_resident`
    (the uAgent calls the model and signs a `StanceMessage`, source `fetch:claude`), specialists in-process; the
    checker is never asked. Without a key (`configured()` false) nothing is asked and `source == "rules"`.
    `GET /api/negotiation` reports mode, pending and spoken. `POST /api/action` is a responder's acknowledgement
    (actor must be on the step); `due_actions` auto-confirms at the deadline with an honest label.
  - `haven/agents/redteam.py` (Phase 11): the attacker. `attack(ctx, sit, steps)` runs five deterministic attacks
    on the revised plan and returns the plan after fixes plus `Attack` records; `compute_plan` re-plans with a
    tighter `eta_cut_s` when the surge attack lands and appends the `redteam` stance (always on, never a model).
    `GET /api/memory/incidents` + `EventStore.outcomes` / `WorldEngine.outcome()`: how incidents ended, compared.
    `POST /api/twilio/answer/{step_id}` is the Gather webhook (yes = done, no/silence = next vendor, end = failed).
    `GET /api/graph` serves the dependency graph for the Connections overlay and the Inspector.
  - No building facts in code: `WorldContext` derives `story_order` (residents with a story, role resident),
    `assembly_point` (space tagged `main_entrance`), `sensor_ids`, `fridges`, `egress_stairs`, `ground`,
    `below_ground`, `top_level`, `main_switchboard` (kind), `ras` (level -> RA resident id), `short_name`,
    `links_by_space`, and `is_electrical` / `powers_lifts` / `hops_to_lift` / `valve_for` / `is_upstairs` /
    `level_short` from the graph and the spec; `Level.short` is how a floor is said ("3 and 4"); a space tagged
    `no_overflow` is never a destination; `BuildingSpec.external_destinations` carries the off-site options; the
    planner's isolate steps come from `sit.at_risk` (electrical equipment the forecast floods before the valve
    closes) and `sit.lift_feeder`. The frontend reads `storyIds`, `heroId`/`heroLevel`, `ground`, `topLevel`,
    `sensorId` and the agent registry from the building store. `tests/test_no_hardcoding.py` greps the backend
    for this building's ids. Keep it that way: a new building must need no code change.
  - `haven/agents/buds.py` (Phase 8): the on-screen companion. `answer()` is a deterministic intent router over
    the state (where is X, why the hold, forecast, left behind, counts, messages, plumber, agents) returning
    `Reply{speech, focus[], actions[]}`; `answer_llm()` is the Claude fallback that may only point at `pointable`
    ids; `POST /api/buds/ask` / `POST /api/buds/act` (the human approved an action: it becomes the same input
    event a button sends). Buds never mutates anything on its own.
- Scenario timing (Phase 2 tuned): riser burst 150 L/s → MSB-B + ATS-EQ flood ≈ 12.5 min (lifts dead,
  floors 3–4 dark) → original switchgear on its pad ≈ 34 min (whole building dark) → ATS-EM ≈ 50 min.
- `frontend/` — React 19 + Vite + TS + Tailwind v4 + Zustand. Routes: `/app` the workspace picker after sign-in (`src/roles/`:
  `workspaces.ts` Student / RA / Maintenance / Security / Admin, `canOpen` = the server's role, the open demo opens all;
  the remembered choice lives only in `readChoice`/`writeChoice`), `/app/student` the student dashboard (`src/student/`:
  `model.ts` `studentView(snapshot, spec)` is pure and tested in `__tests__/student.test.ts`: `outcome.status` ok/assisted/
  escalated from the resident's own `/api/portal/snapshot`, `reachable_refuge` = a step-free way out via the spec's
  `verticals` and live lift status; in an incident the hero shows the server's message verbatim), `/app/ra` the RA
  dashboard (`src/ra/`: `model.ts` `raView(snapshot)` ranks `incident.people` escalated (left behind, or priority before
  approval) > assisted > check-in due > safe, then by situation gravity (stranded first); the floor roster is `team`;
  Confirm = `POST /api/portal/tasks/{id}/done` on the RA's own approved step naming the resident; no resident phone
  numbers exist, so Call stays disabled and says so; tested in `__tests__/ra.test.ts`), `/app/maintenance` the
  facilities dashboard (`src/maintenance/`: `maintenanceView(snapshot, spec)` ranks `incident.equipment` flooded = hazard >
  isolated / valve closed > offline; the hero's safety note is its facilities step's own reason; `routeTo` draws a side
  elevation from the facilities office down the nearest stair; work orders = one per fault + maintenance requests;
  S4: a shutdown reads Verified only when `task.verified`, i.e. a person confirmed it (`ActionState.actor` not `haven*`):
  done by HAVEN or auto-confirmed at a deadline still asks for an on-site Confirm, which `tasks/{id}/done` now accepts
  once; tested in `__tests__/maintenance.test.ts`), `/app/security` dispatch (`src/security/`, admin only: it reads the live
  world over `/ws`; `securityView(world, spec)` takes critical residents now + forecast, escalated (left behind or not
  covered by an approved escort/shelter/relocate step) before assisted, then stranded; `exitsOf` names each street
  door by side + the space behind it and the hero gets the nearest step-free one; the info line (`brief`) names the real
  responder on the hero's step; the Responder units card and the en-route strip are simulated placeholders (no CAD feed),
  labelled "simulated" on screen; "Dispatch responders" is `decidePlan(approve)`, the same human gate; Acknowledge is
  per-viewer localStorage; tested in `__tests__/security.test.ts`), shared rail `roles/Shell.tsx`,
  `/app/<staff>` stubs,
  `/app/workspace` the multi-role workspace (`src/portal/`: `Portal.tsx`
  shell, `data.ts` snapshot + socket, `Home` per-role overview + incident card, `Requests`, `Comms` inbox + Contact
  Corner, `Ask`, `Settings` preferences + team, `Building` the privacy-scoped 3D from the snapshot only, `RolePicker`
  demo-only; liquid-glass `portal.css`), `/command` the admin command centre (`App.tsx`, described below). `src/state/world.ts` is a read-only mirror of `/ws`;
  `src/state/building.ts` caches the static spec + roster + agent registry (not world state). Components:
  `StoryStrip` (the narrative, the stage rail, the facts, Approve and the hero agent switch), `FloorPlan`
  (SVG from the spec, view fitted to the level, coloured only by world state, labels laid out apart),
  `ImpactLedger`, `CascadePanel` (forecast + timeline), `Controls`, `AgentConsole` (hero card, specialists,
  residents with a need, the rest folded, always-on agents; `Negotiation.tsx` holds the transcript and the hard
  rules), `PlanPanel`, `VoiceRule`, `MessagesPanel`, and `Building3D` (R3F twin, lazy-loaded; loads the
  meshopt GLBs from `frontend/public/models/`, keys tints off `userData.space_id` / `equipment_id` /
  `level_index` and `win_<space_id>` names per `blender/README.md`, a night rig when the world clock says
  night, DOM labels projected over the canvas, and reads nothing but the world store). 3D is the default view;
  the 2D plan opens on the hero's floor. The app is barebones by design (the user asked for it to be
  understandable and demo-ready): a pill nav with only the status chip and a ⋯ menu (demo replay, start over,
  Operations, flat plan, connections, Buds, phones, story); Overview is two windows: "What's happening" (30%,
  `src/workstation/Panel.tsx`, facts from the pure `workstation/logic.ts`, tested in `__tests__/workstation.test.tsx`,
  minimal by request: a greeting, the status (Healthy / Attention needed from `GET /api/ops` / Emergency) and a
  wing picker (`wingsOf`: the spec has no wings, so each footprint rectangle is named by the side it stands on;
  it filters the people and the checklist by room position); three widgets (active incidents, steps to approve,
  people needing help) with Gmail-style red badges for urgent counts, details only on a click; HAVEN response
  (incident command: a verdict, "Plan is safe to approve" only when `logic.outcomes` says feasible = steps and no failing
  hard check; Safe / Assisted / Unresolved counts from step head counts and the plan's `left_behind`; every failing check;
  recommendation, 2-4 phases, Review = phases + checks + the Maya switch + a rule; "Approve & dispatch" through
  `lib/approve.ts` `approveOnce`, idempotent on run + plan version; an inline preference that reports Parsed (a rule
  code) or Advisory (nothing changes); while an incident runs, the After-action ledger = `state.timeline`, newest last).
  `/app/admin` redirects here: the admin's workspace is the command centre; a routine check
  read from sensors, power, lifts, leaks and the audit (`routineCheck`, cleared when the situation changes);
  today's checklist = the audit's findings (tick = `POST /api/ops/work-order` done, Schedule = open); three
  emergency actions pinned to the bottom: Call 911 and emergency services confirm, then open the dialer
  (`tel:`; the services number is `VITE_HAVEN_EMERGENCY_NUMBER`/`_LABEL`, absent by default and said so), and
  never claim a call was made; Contact an RA lists live RA availability (no RA phone numbers exist in HAVEN).
  "people left behind" after approval is the plan's own `left_behind`, never inferred from step lists (they hold
  only a sample of names). An "All details" toggle (D) keeps the collapsible `Widget` cards from
  `components/Workstation.tsx`: plan, agents, people, messages, timeline, say a rule, controls, glance, system);
  and "The building" (70%, two tabs in a pill over the view, `haven.render`: "Live animation" and "Photoreal",
  the latter lazy-loading `components/Building3D.tsx` (the Blender GLBs, owned by the peer session) with the same
  props; the live animation is `src/twin/` (realistic but generated, no model files: stone-and-glass facade
  textures with a roughness map, sun or moon with shadows, a procedural `Environment` of Lightformers, fog,
  streets, plaza, courtyard lawn, trees; night is a readable blue hour; storeys extruded from the spec's outline in `geometry.ts`,
  every fact derived in `model.ts` and tested in `__tests__/twin.test.tsx`; two tabs, Building and People;
  the Building tab follows the story by itself (`sceneMode`: at rest when quiet, live status in an incident
  with whoever the plan leaves behind labelled, the response once approved) with a colour key from `Cards.tsx`; `frameloop="demand"` plus a 30 fps heartbeat only while
  something moves; labels are plain DOM placed by the scene's `Projector`, not drei `Html`; it selects records
  and points at the workstation's plan card, it never approves) or the 2D plan, the floor pill and the Key) and Operations (`OpsView` in one window). The overview comes back
  by itself, plan card open, when the narrative stage leaves `quiet`; `haven:focus` opens the card that holds a
  target; T / N hide either window; card open state is a per-viewer localStorage convenience (`haven.cards`).
  `Buds` (the companion: `src/lib/companion.ts` is a DOM cursor that rides next to the mouse, bobs, wears a mood
  ring, carries the speech bubble and flies to `[data-buds="kind:id"]` elements on `buds:point`; off by default
  (`useBudsOn`, localStorage `haven.buds.enabled`): off, it renders nothing and hears no key but Alt+B; the
  Buds switch in the top pill and in System health turn it on; hold Ctrl+Alt to talk, Alt+B on/off, Alt+C chat, Alt+Shift+V hands-free; App listens for `haven:focus` to switch tab/floor).
  Theme: `index.css` is the Sentinel app language (tokens on `:root`, `.dark` overrides, `@theme inline` so the
  `text-t1` / `bg-haven-*` utilities repaint); `App.tsx` is the shell, styled by `src/workstation.css` (scoped `.mac-*`,
  pastel periwinkle/lavender tokens with `.dark` overrides, loaded with the app chunk only). The floor plan reads `--fp-*` variables from `.floorplan`, `src/story/Story.tsx` (+ `story.css`, scoped `.argus`: the editorial page at
  `/story`, live event log + sponsor proofs), `src/lib/speak.ts` (ElevenLabs → Cartesia → browser, interruptible),
  `src/lib/voice.ts` (Web Speech push-to-talk / hands-free with echo guard). Routes in `main.tsx` (each page a lazy chunk): `/` the landing page, `/app` the
  command centre, `/phone`, `/story`. `src/landing/` (scoped `.lp`, `landing.css`) is the public landing: one night in six
  chapters (calm, leak, ripple, people, plan, together) told by one number, `progress.ts` `storyT` (-1 hero … 5 last chapter),
  that drives both the horizontal-scroll chapter cards (motion + lenis) and `Scene3D` (a fixed R3F canvas that dresses the same
  GLBs as pastel clay: lit windows, an x-ray shell, water in the glass basement, coral runs to the plant, Maya's window, the mint
  route). It reads no world state and needs no backend; the bento below it is illustrative micro-demos (the Maya switch, approve).
- `firmware/haven_sensor/haven_sensor.ino` — ESP32 + resistive probe → `POST /api/sensor` with
  `X-Haven-Token`; posts on every wet/dry crossing and a 15 s heartbeat. Calibrate DRY_RAW / WET_RAW from Serial.
- `blender/` — scripted exterior built from the same building spec (Phase 3). `haven_live.py` is the live link:
  a sidebar panel that polls `/api/state` (stdlib only), draws the frame into a `Live` collection (water sheets,
  floor/equipment tints via object-linked material overrides, `person_<id>` / `agent_<actor>` figures, routes,
  labels, HUD) and POSTs inputs back. `snapshot()` does the same once, headless, for a render.

## Commands
- Both servers: `scripts/dev.sh` (macOS/Linux) or `powershell -ExecutionPolicy Bypass -File scripts\dev.ps1` (Windows; it
  stops a stale backend first: a leftover uvicorn keeps :8000 and :8010 and a new one dies with exit 3).
- Backend: `cd backend && uv run --env-file .env uvicorn haven.api.app:create_app --factory --port 8000 --reload --reload-dir haven`
  (`uv run` does not read `.env` on its own; the keys only reach the process through `--env-file`, which the dev scripts add).
- Backend tests: `cd backend && uv run pytest -q`
- Floor-plan PNG: `cd backend && PYTHONPATH=. uv run python tools/plot_plans.py out.png [LEVEL]`
- Export spec for Blender: `cd backend && PYTHONPATH=. uv run python tools/export_building.py` → `shared/`
- Windows note: uvicorn `--reload` can hang on reload; restart the server if endpoints look stale.
  Also check for a stale server already holding :8000 (`Get-NetTCPConnection -LocalPort 8000`).
- Blender exterior (from `shared/`): `blender-launcher.exe -b -P blender/build_blackwell.py -- --glb frontend/public/models/blackwell.glb --render blender/renders/hero.png`
  (or exec the script in a live Blender with `HAVEN_ROOT` set; see `blender/README.md`). Window meshes are `win_<space_id>`.
- Frontend: `cd frontend && npm run dev` (proxies `/api` and `/ws` to :8000) · typecheck `npx tsc -b`

## Conventions
- Derived happenings (lift offline, room dark) are computed by the reducer and recorded on the timeline, never
  logged as inputs — replay re-derives them. `state.impact` is what is true now; `state.forecast` is what the
  same physics says will happen if nobody acts. Both are views, recomputed on every physical change.
- State frames must stay small (≈45 KB at the worst point): flagged residents are objects, everyone else is an
  id resolved against the cached roster on the client. A field no client reads goes in `FRAME_EXCLUDE`.
- Heavy public files (`public/models`, `public/landing`, `public/env`) are fetched through `heavy(path)`
  (`src/lib/assets.ts`): `vite.assets.ts` versions them by content (`?v=<hash>`) so the host caches them for a year
  (`vercel.json`, `vite preview`), and a build writes `.glb.gz` beside each GLB, served with `Content-Encoding: gzip`
  (CDNs do not compress `model/gltf-binary`; meshopt GLBs shrink to 30-70 %). The landing loads its own cuts
  (`blender/glb/landing.mjs`: no textures or UVs, interior equipment only), 1.4 MB instead of 7.7 MB. Pages and
  Clerk are lazy chunks. In three.js, a transparent `DoubleSide` material re-selects its program on every draw
  (two passes, `needsUpdate` each): give it `forceSinglePass = true`.
- Building geometry lives in one spec (`backend/haven/building/`); graph, nav grids, 3D and Blender all derive from it.
  Coordinates are metres: x east, y north, z up; origin at the SW corner (Dana St × Durant Ave).
- Work phase by phase; test before moving on; commit after each checkpoint.
