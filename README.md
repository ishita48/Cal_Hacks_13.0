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
cd backend  && uv run pytest -q                  # 60 tests
```

Nothing needs a key. Every sponsor integration is optional and key-gated; the header shows which are live
(bright) and which are simulated (dim). Copy `backend/.env.example` to `backend/.env` and fill in what you have.

## What is real, what is simulated

Judges ask. Here is the honest list.

| Part | Real | Simulated / synthetic |
|---|---|---|
| The sensor | ESP32 firmware posts real readings (`firmware/`); the **Simulate leak** button sends the same event | |
| The building and people | | Blackwell Hall's spec and the 250-person roster are synthetic (no facilities data agreement): the rehearsal mode the product ships with |
| Physics and cascade | Deterministic hydraulics and graph traversal (`haven/world`), replayable from the event log | A simplified model: volume per space, weir flow through doors, equipment floods at a height |
| The negotiation | With `ANTHROPIC_API_KEY`, every enabled agent reasons with Claude over the facts and its stance is logged as an `agent_stance` input; the revised plan is built from the objections, so an agent that fails to object leaves its person in `left_behind`. Residents reason inside their own Fetch.ai uAgent and sign the stance. Replay needs no model | Without a key, deterministic rule functions speak (same shape, same codes). The checker is always rule-based and cannot be switched off |
| The human gate | Approve/reject on the phone or dashboard; Buds only proposes | |
| Responders | RAs, desk staff, facilities and the plumber acknowledge their steps from their own phone view (`/phone?as=ra_4`), logged as inputs | A step nobody acknowledges is closed by the clock at its deadline and labelled "auto-confirmed (no acknowledgement)" |
| Outward actions | Plumber call and demo text (Twilio), ticket (Linear) with keys | Labelled "simulated" without keys |
| Voice | ElevenLabs, then Cartesia, with keys | The browser's own speech synthesis otherwise |
| Sponsor status | `GET /api/sponsors` is a live round trip per service | |

## Buds, the story page and the live stack

- **Buds** is the companion on the screen, in the spirit of StudyO's Clicky: a soft cursor rides next to your
  mouse while it is on (Alt+B). **Hold Ctrl+Alt (⌘+⌥ on a Mac) and talk; release to send.** It answers from the
  one world state, says the answer in a bubble by the cursor, flies to the agent card, plan step, floor or panel
  it is talking about, and offers actions (switch an agent, impose a rule, approve, simulate the leak) that only
  run after you tap **Approve**: the same input events the buttons send. Alt+C opens the chat, Alt+Shift+V is
  hands-free (talk over it and it stops), Esc hushes it. Deterministic answers first
  (`backend/haven/agents/buds.py`), Claude only as the fallback.
- **The look** is the Sentinel/Argus app language: a floating frosted sidebar and top bar, slate shell, white
  cards, one blue, colour only where it means something. Light by default; the moon button switches to dark.
- **/story** is the editorial page: the sensor-to-plan cascade, the agents, a "one shared state" room that shows
  the real event log of the current run, and the sponsor proofs. Light paper, one blue; the dashboard stays dark.
- **Live stack**: click the sponsor strip in the header for a round-trip proof per integration (`GET /api/sponsors`):
  a voice name, a model list, a Postgres version, an account, a Linear viewer, the agents' addresses.
- The 3D twin loads `blackwell_site.glb` when present (streets, neighbours, trees, props, people from the Blender
  scene) under a daylight environment with shadows. Hard-refresh after the GLBs change; the browser caches them.

## Keys to make

| Key | Where | What it switches on |
|---|---|---|
| *(none)* | — | Fetch.ai resident agents run as local uAgents inside the backend; the plumber call and ticket are simulated and say so |
| `ANTHROPIC_API_KEY` | console.anthropic.com | Claude parses spoken rules the regex misses, narrates the brief, lets each agent explain itself in its own words |
| `AGENTVERSE_API_KEY` | agentverse.ai → API keys | The nine resident agents register on Agentverse (mailbox) so they are reachable and inspectable there |
| `ELEVENLABS_API_KEY` (+ `ELEVENLABS_VOICE_ID`, `ELEVENLABS_AGENT_ID`) | elevenlabs.io → Profile → API keys; Conversational AI → create an agent for the id | HAVEN's voice, first in line: Buds, the plumber script, the briefs (flash v2.5, multilingual). The agent id enables a live, interruptible voice agent grounded in the world (`GET /api/voice/agent`) |
| `CARTESIA_API_KEY` (+ `CARTESIA_VOICE_ID`) | play.cartesia.ai → API keys | Second voice in line for `POST /api/speak`; the browser's own speech is last |
| `TIGER_DATABASE_URL` | console.cloud.timescale.com (Tiger Data) → service → connection string | Sensor readings land in a hypertable; `GET /api/sensor/{id}/history` reads it (event log otherwise) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` + `HAVEN_PLUMBER_NUMBER`, `HAVEN_SMS_TO` | console.twilio.com (trial works; verify the two numbers) | On approval the plumber is really phoned with the plan's script, and Maya's message is texted to the demo phone |
| `LINEAR_API_KEY`, `LINEAR_TEAM_ID` | linear.app → Settings → API (personal key; team id from the team settings URL or the API) | On approval the facilities ticket is filed in Linear; the step shows its identifier and URL |
| `HAVEN_SENSOR_TOKEN` | make one up | The ESP32 must send it as `X-Haven-Token`; manual and UI readings are unaffected |
| Railway + Vercel accounts | railway.app, vercel.com | Deploy: `backend/railway.json`, `frontend/vercel.json`; set `VITE_HAVEN_WS=wss://<railway-app>/ws` at build |

## The two-minute demo

| Beat | What to do | What happens |
|---|---|---|
| 0:00 "This is a $4 water sensor." | Drip on the ESP32 probe, or press **Simulate leak** | The reading lands as an input event; the riser burst starts |
| 0:15 The cascade | Watch the **Cascade** tab and the B1 floor plan | Forecast: water reaches the switchgear in ~12.5 min, lifts die, floors 3–4 go dark, 250 residents affected; whole building dark at ~34 min if nobody acts |
| 0:35 **The Maya moment** | **Agents** tab, toggle *Maya's agent* off, then on | Off: "Cut the power now… Maya is left behind." On: lifts held 6 min, two staff bring her down by lift first, then the cut. Each card shows the resident's own Fetch.ai agent (address, "said veto on the network") |
| 1:00 The manager speaks | Mic button: *"Fine, but nobody gets moved off campus."* | Parsed to `no_off_campus`; every agent re-plans under it. Try *"No one moves after midnight"*. Next run, the rule is offered back ("last time you said…"): cross-incident memory off the event log |
| 1:20 HAVEN acts | **Approve** | Plumber called (for real with Twilio keys), the ticket filed (for real with Linear keys), section B and ATS-EQ cut at the safe moment, insulin moved, RAs knocking, 222 people placed by capacity, every person messaged in their language (**Messages** tab) |
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
