# HAVEN

**Connected failure, connected response — and nobody left behind.**

A $4 water sensor in the basement of David Blackwell Hall (UC Berkeley) detects a leak. HAVEN traces the
chain through one shared dependency graph, forecasts what fails and when, lets specialist agents and one
personal agent per resident negotiate a plan under hard safety and accessibility constraints, takes a rule
from the manager by voice, and acts on approval. Everything is a view of one event-sourced world state and
replays exactly.

## Run it

```bash
cd backend  && uv run uvicorn haven.api.app:create_app --factory --port 8000
cd frontend && npm install && npm run dev        # http://localhost:5173 (proxies /api and /ws)
cd backend  && uv run pytest -q                  # 43 tests
```

Nothing needs a key. Optional integrations are read from `backend/.env.example`: Claude (rule parsing
fallback), Cartesia (voice), Tiger Data (sensor time-series), `HAVEN_SENSOR_TOKEN` (ESP32 auth).

## The two-minute demo

| Beat | What to do | What happens |
|---|---|---|
| 0:00 "This is a $4 water sensor." | Drip on the ESP32 probe, or press **Simulate leak** | The reading lands as an input event; the riser burst starts |
| 0:15 The cascade | Watch the **Cascade** tab and the B1 floor plan | Forecast: water reaches the switchgear in ~12.5 min, lifts die, floors 3–4 go dark, 250 residents affected; whole building dark at ~34 min if nobody acts |
| 0:35 **The Maya moment** | **Agents** tab, toggle *Maya's agent* off, then on | Off: "Cut the power now… Maya is left behind." On: lifts held 6 min, two staff bring her down by lift first, then the cut |
| 1:00 The manager speaks | Mic button: *"Fine, but nobody gets moved off campus."* | Parsed to `no_off_campus`; every agent re-plans under it. Try *"No one moves after midnight"* |
| 1:20 HAVEN acts | **Approve** | Plumber called, section B and ATS-EQ cut at the safe moment, insulin moved, RAs knocking, 222 people placed by capacity, every person messaged in their language (**Messages** tab) |
| 1:40 The ledger | Set the clock to 60× | Maya in the lobby before the cut, valve closed at +27 min, 0 left behind, outcome strip in the Impact ledger |
| 2:00 Close | **Replay** any recorded run | The whole thing re-derives from the event log |

If the hardware flakes: **runs → Replay** re-emits a recorded run deterministically. The canonical run is
`backend/demo/blackwell_leak.json` (leak → Maya off → Maya on → spoken rule → approve → HAVEN acts, done at
+28 min); load it on any machine with
`curl -X POST localhost:8000/api/runs/import -H 'Content-Type: application/json' --data-binary @backend/demo/blackwell_leak.json`
and re-record it after planner or physics changes with `cd backend && PYTHONPATH=. uv run python tools/record_demo.py`.

## Layout

- `backend/` FastAPI world-state service: `haven/world` (events, reducer, physics, cascade, engine),
  `haven/agents` (planner, rules, llm), `haven/building` (the spec and graph), `haven/people` (roster),
  `haven/integrations` (Cartesia, Tiger Data). `Dockerfile` + `railway.json` for Railway.
- `frontend/` React + Vite + Tailwind + Zustand; `src/state/world.ts` mirrors `/ws`. `vercel.json` for Vercel
  (set `VITE_HAVEN_WS=wss://<railway-app>/ws` at build time; HTTP goes through the rewrite).
- `blender/` the building built in Blender from the same spec; GLBs in `frontend/public/models/`.
  `blender/haven_live.py` makes Blender a live client of the same world: open `blackwell.blend`, press N,
  HAVEN tab, **Connect**. Water, dark floors, equipment, flagged residents, responders, routes and the
  headline are drawn from `/api/state`; the panel's buttons (leak, Maya's agent, approve, speed, a spoken
  rule) submit the same input events the dashboard does. Headless still of the live world:
  `blender-launcher.exe -b blender/blackwell.blend -P blender/haven_live.py -- --snapshot blender/renders/live_check.png --camera CutawayCam --cutaway L4`.
- `firmware/haven_sensor/` the ESP32 sketch.
- `CLAUDE.md` the architecture notes and non-negotiables.
