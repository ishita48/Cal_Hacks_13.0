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
  - `haven/world/engine.py` the single mutator: clock loop, persistence, broadcast, replay.
  - `haven/world/store.py` append-only event log (SQLite locally).
  - `haven/api/app.py` HTTP + `/ws` (every client receives identical state frames).
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
- Scenario timing (Phase 2 tuned): riser burst 150 L/s → MSB-B + ATS-EQ flood ≈ 12.5 min (lifts dead,
  floors 3–4 dark) → original switchgear on its pad ≈ 34 min (whole building dark) → ATS-EM ≈ 50 min.
- `frontend/` — React 19 + Vite + TS + Tailwind v4 + Zustand. `src/state/world.ts` is a read-only mirror of `/ws`;
  `src/state/building.ts` caches the static spec + roster (not world state). Components: `FloorPlan`
  (SVG from the spec, coloured only by world state), `ImpactLedger`, `CascadePanel` (forecast + timeline), `Controls`,
  `AgentConsole`, `PlanPanel`, `VoiceRule`, `MessagesPanel`, and `Building3D` (R3F twin, lazy-loaded; loads the GLBs
  from `frontend/public/models/`, keys tints off `userData.space_id` / `equipment_id` / `level_index` per
  `blender/README.md`, and reads nothing but the world store). 2D plan is the default; the toggle is in the centre panel.
- `firmware/haven_sensor/haven_sensor.ino` — ESP32 + resistive probe → `POST /api/sensor` with
  `X-Haven-Token`; posts on every wet/dry crossing and a 15 s heartbeat. Calibrate DRY_RAW / WET_RAW from Serial.
- `blender/` — scripted exterior built from the same building spec (Phase 3). `haven_live.py` is the live link:
  a sidebar panel that polls `/api/state` (stdlib only), draws the frame into a `Live` collection (water sheets,
  floor/equipment tints via object-linked material overrides, `person_<id>` / `agent_<actor>` figures, routes,
  labels, HUD) and POSTs inputs back. `snapshot()` does the same once, headless, for a render.

## Commands
- Backend: `cd backend && uv run uvicorn haven.api.app:create_app --factory --port 8000 --reload --reload-dir haven`
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
  id resolved against the cached roster on the client.
- Building geometry lives in one spec (`backend/haven/building/`); graph, nav grids, 3D and Blender all derive from it.
  Coordinates are metres: x east, y north, z up; origin at the SW corner (Dana St × Durant Ave).
- Work phase by phase; test before moving on; commit after each checkpoint.
