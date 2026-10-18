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
- Scenario timing (Phase 2 tuned): riser burst 150 L/s → MSB-B + ATS-EQ flood ≈ 12.5 min (lifts dead,
  floors 3–4 dark) → original switchgear on its pad ≈ 34 min (whole building dark) → ATS-EM ≈ 50 min.
- `frontend/` — React 19 + Vite + TS + Tailwind v4 + Zustand. `src/state/world.ts` is a read-only mirror of `/ws`;
  `src/state/building.ts` caches the static spec + roster (not world state). Components: `FloorPlan`
  (SVG from the spec, coloured only by world state), `ImpactLedger`, `CascadePanel` (forecast + timeline), `Controls`.
- `firmware/` — ESP32 water sensor → `POST /api/sensor` (Phase 7).
- `blender/` — scripted exterior built from the same building spec (Phase 3).

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
