# HAVEN

HAVEN supports **Haven Hall**, **Salesforce Park**, and **Palace of Fine Arts** through the same platform. Use the building selector on `/admin`, or open `/admin?building=salesforce-park` or `/admin?building=palace-of-fine-arts`. Each deployment has its own 3D environment, equipment, sensor registry, accessible routes, incidents, and role context. See [multi-property deployments](docs/multi-property.md) for the architecture, scenario runbook and Blender replacement contract.

HAVEN is a building nervous system for residential buildings and dorms.

It ingests building signals such as water, fire, elevator, power, HVAC, and occupancy data, maintains one live building state, reasons about system dependencies and accessibility, and gives each role a clear next action.

## Current expanded demo

One authoritative FastAPI world state now supports water and fire workflows, eleven sensor input types, deterministic severity 0–4, accessible route exclusions, resident requests, role coordination, and a persistent grounded text/browser-voice assistant. The existing water approval flow and WebSockets remain intact. The code-generated 3D twin is preserved; no Blender work is included.

**Water Leak** (`Simulate water leak`) → Riser R-3 → E1 unavailable → blocked normal route → Maintenance investigation → Admin approval → Resident same-floor refuge instruction.

Every role has **Agent Review** directly below the building selector, ahead of Home and the existing navigation. It is a link that opens the team's HAVEN agents on [Agentverse](https://agentverse.ai/) in a new browser tab. The agents themselves are described in [agents/README.md](agents/README.md).

**Heat Warning** → Advisory. **Confirmed Fire** stages rising heat → smoke → fire alarm, with severity escalation, excluded unsafe routes, immediate role hazard notices, a reviewed step-free plan, and an automatic **simulated** emergency call at Level 4. Admin also has **CALL EMERGENCY SERVICES**, which starts the same local simulation. Its status, scripted voice conversation, transcript, and report are shared state; Read simulated conversation optionally uses browser speech. No real number is dialed. `ProductionDispatchAdapter` is disabled and always rejects use; a verified provider is future work.

Resident can submit maintenance requests, contact RA, use AI help, acknowledge reviewed guidance, and press **I NEED HELP** during incidents. RA and Maintenance handle their request queues. Campus Security records entrance access readiness and emergency responder arrival separately from its existing Campus Security-team response status. These are human reports, not physical lock controls or evidence of resident safety.

Use [the expanded contract and rules](docs/expanded-contract.md), [implementation plan](docs/expanded-plan.md), and [presenter runbook](docs/demo-runbook.md).

## Hackathon Demo

Primary demo flow:

1. Water leak / pressure event is triggered
2. HAVEN updates the live building state
3. Dependency logic determines the affected systems
4. Elevator E1 becomes unavailable
5. A resident who requires step-free egress loses their normal route
6. HAVEN generates a safer response plan
7. Admin reviews and approves the plan
8. Resident, RA, Maintenance, and Campus Security views update live

For the first build, the water event can be simulated. ESP32 integration comes later.

## Tech Stack

Frontend:

* Next.js
* TypeScript
* React
* Tailwind
* React Three Fiber for 3D

Backend:

* FastAPI
* Python
* WebSockets

Hardware:

* ESP32 water sensor later
* Possible fire/smoke sensor later

## Core Architecture

Sensors / Events
→ Event Ingestion
→ Building World State
→ Dependency + Accessibility Engine
→ Incident / Response Plan
→ Human Approval
→ Role Views + Agents

There must be one authoritative building state shared by all dashboards and agents.

## Water vertical slice (preserved)

The original completed vertical slice remains covered by regression tests:

* fake water leak event
* central building state
* incident object
* elevator marked affected
* admin dashboard
* simple 3D building visualization
* generated response plan
* Approve Plan button
* simple resident view that updates after approval
* WebSocket updates between backend and frontend

## Role Views

The top building selector offers exactly **Haven Hall**, **Salesforce Park**, and **Hospital X**. Selection updates that label and the header breadcrumb, and remains selected across client-side role navigation. It is UI-only prospect context: demo data, assets, incidents and routes still use the existing Haven Hall backend. Refresh defaults to Haven Hall. No role switching or backend logic changes are involved.

Role navigation is in the circular profile button at the top-right. Open it to switch between **Admin, Resident, RA, Maintenance, and Campus Security** using their existing routes. The menu shows the current view. Every sidebar begins with **Agent Review**, a link out to Agentverse, followed by Home and its role-specific destinations. Contextual request handoffs and the presenter's expandable role links remain available.

This is temporary demo navigation, with no authentication, identity session or permissions. The route supplies the active view. `src/components/profile-menu.tsx` and the separate `src/lib/role-navigation.ts` registry form the replacement boundary for a future Flow/auth account UI. See [profile navigation and verification](docs/profile-navigation.md).

Admin now has five sidebar destinations: **Home**, **Incident & Operations Log**, **Resident Requests**, **Contact Log**, and **Equipment & System Health**. The four detailed workspaces live off Home; Home retains overall status, the digital twin, incident/plan review and response coordination. **Check Overall Status** returns to and focuses Home’s status; while an incident remains active (including after approval), it becomes the red **Check Emergency Status** action. **Call Campus Security** opens simulated staff contact review in Contact Log and never sends a contact automatically. Emergency-services calling remains separate on Home. See [Admin navigation](docs/admin-navigation.md).

Maintenance’s sidebar is **Home**, **Resident Requests**, **Sensor Health**, **Campus Security**. Campus Security’s sidebar is **Home**, **Resident Requests**. Requests and Maintenance telemetry now live off Home in their own tabs; Home keeps each role’s existing work/incident dashboard. Maintenance’s Campus Security shortcut opens the existing role view. Conversations retain drafts across tab changes, and all workspaces share live state. See [staff navigation](docs/staff-navigation.md).

Every role also has a shared bottom sidebar action area: a role-specific status button above its human contact/review button. Active incidents or reported critical severity turn the status button red and use the emergency label. Actions focus existing status, request and review workflows without automatically sending anything. The footer remains separate from Home content; profile navigation and building selection are preserved. See [sidebar actions and destinations](docs/sidebar-actions.md).

RA now has **Home, Resident Requests, Check-Ins, Escalations, Floor / Resident Overview, Announcements**. Resident has **Home, My Requests, Maintenance, Contact RA, Building Map, Alerts & Updates**. Home stays focused on current status; detailed conversations, follow-up and maps live in their tabs. RA can post building/floor notices that reach the applicable Resident view through the same shared state. Notices never replace reviewed safety guidance. Request and announcement drafts survive tab changes; demo reset clears them. See [community navigation and notice behavior](docs/community-navigation.md).

Admin:

* building overview
* daily health, one routine maintenance ticket, and everyday step-free access
* active incident
* affected systems
* response plan
* approve plan
* review and approve simulated Maintenance/Campus Security contact
* compact HAVEN assistant for live explanations and UI/3D focus

Resident:

* current status
* one clear instruction
* safe route

Campus Security / Dispatch (lightweight follow-up):

* active incident, escalation location, and affected resident
* responder status
* manual acknowledgement, dispatch, and arrival records

RA (lightweight follow-up):

* residents needing a check-in
* incident escalations and escalation to Admin
* acknowledgement of approved instructions
* simple floor and registered-room view

Maintenance (lightweight follow-up to the first MVP):

* one routine laundry-room light ticket in daily mode
* current affected asset: Riser R-3 fault and Elevator E1 impact
* service location and illustrative route
* three-step investigation checklist
* shared investigation status

## HAVEN agent and dispatch boundaries

The persistent assistant explains incident triggers, severity reasons, affected people/systems, plans, staff work, and emergency-call status from the current snapshot. Text and optional browser voice use the same deterministic answer function. It uses allowlisted backend navigation tools to focus the twin/cards or open the Resident route; tools validate the incident and revision. It never directly changes severity, plans, routing, equipment, or dispatch. Admin uses Ask HAVEN; the other roles use AI help.

Level 4 automatically starts only `DemoDispatchAdapter`. Manual emergency controls and the separate Admin-approved Maintenance/Campus Security contact simulator are local demonstrations. Future real outbound service integration requires a verified provider; production emergency dispatch remains disabled. Human approval still publishes consequential Resident route instructions; immediate fire hazard warnings do not wait for plan approval.

## Design Principles

* one job per screen
* calm by default
* plain language
* 2–3 important cards maximum
* accessibility is a hard constraint
* humans approve consequential actions
* do not overbuild the UI before the vertical slice works

## Visual Design Reference

Use the HAVEN UI board as the visual design reference: calm card-based layouts, clear status indicators, plain language, and one primary action per screen.

![HAVEN UI board showing Resident, RA, Maintenance, Admin, and Campus Security dashboard concepts](docs/haven-ui-board.jpg)

The board remains the visual reference for all five calm role views. Sensor requests accept ESP32-shaped JSON without hardware; firmware, provisioning, real emergency calling, authentication, and advanced 3D remain outside this local demo.

## Current Priority

Maintain both end-to-end demos: shared sensor ingestion → authoritative state → dependency/severity rules → incident and route exclusions → reviewed plan → live role apps → reported actions → timeline. Fire additionally runs simulated emergency dispatch through its transcript/report. Never route a step-free resident through stairs or a reported unsafe corridor.

## Run the local demo

The first vertical slice is implemented. Requirements: Node.js 20.9+ (Node 24 tested), pnpm 11+, Python 3.10+ (Python 3.12 tested) and, for live Convex state, `cloudflared`. Sign-in uses a Clerk development instance and live state a Convex development deployment; both are configured in `.env.local` (below).

First-time setup from the project root, in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-lock.txt
pnpm install --frozen-lockfile
```

### Settings (`.env.local`)

All settings live in one file, `.env.local`, in the project root. It is gitignored, so share it privately rather than committing it. Next.js, the Convex CLI and `scripts/dev.mjs` all read it; restart them after changing it. Create it with:

```dotenv
# Clerk sign-in: keys from Clerk Dashboard → API keys.
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…
CLERK_SECRET_KEY=sk_test_…
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FORCE_REDIRECT_URL=/workspace
NEXT_PUBLIC_CLERK_SIGN_UP_FORCE_REDIRECT_URL=/workspace

# Convex live state. `npx convex dev` writes these two when it links the project.
CONVEX_DEPLOYMENT=dev:<your-deployment>
NEXT_PUBLIC_CONVEX_URL=https://<your-deployment>.convex.cloud

# Shared secrets, 32+ characters each:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# HAVEN_ENGINE_KEY guards the engine gateway Convex calls through the tunnel.
# HAVEN_SENSOR_KEY is the X-Haven-Sensor-Key header the ESP32 sends to https://<your-deployment>.convex.site/sensor.
HAVEN_ENGINE_KEY=
HAVEN_SENSOR_KEY=

# Optional.
# NEXT_PUBLIC_HAVEN_AUTH_DISABLED=1   # run without Clerk or Convex (pnpm verify sets this)
# NEXT_PUBLIC_API_URL=http://127.0.0.1:8000   # browser address of FastAPI, if its port changes
# HAVEN_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000   # FastAPI CORS/WebSocket origins; scripts/dev.mjs passes it to the backend
```

### Landing page

`/` is the public landing page, ported from the Cal Hacks 13.0 build (`src/components/landing/`, styles in `src/app/landing.css`, models and images in `public/landing/`). It renders on the client only because of its WebGL scene and smooth scrolling, and it falls back to a still image when WebGL is unavailable. **Open HAVEN** goes through sign-in to `/workspace`; the Admin command centre is now at `/admin`.

### Live state (Convex)

FastAPI stays the compute engine: cascades, severity and plans. Convex is the live state store every dashboard subscribes to. With `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` in `.env.local`, `node scripts/dev.mjs` also:

1. starts `scripts/engine-gateway.mjs` on `127.0.0.1:8787`. It forwards only the engine routes Convex uses, and only with `X-Haven-Engine-Key`;
2. opens a Cloudflare quick tunnel to that gateway (`cloudflared` must be installed);
3. sets `FASTAPI_URL`, `HAVEN_ENGINE_KEY`, `HAVEN_SENSOR_KEY` and `CLERK_JWT_ISSUER_DOMAIN` on the deployment, then runs `npx convex dev`.

How it flows:

- **Writes.** Each dashboard button calls a typed Convex mutation (`approvePlan`, `acknowledgeAction`, `createRequest`, `updateRequest`, `startScenario`, `resetDemo`). The mutation records a command and schedules `engine.dispatch`, which calls FastAPI and mirrors the returned snapshot.
- **Reads.** `useBuildingState` subscribes to `building.snapshot`, so all five role views update live without socket code. Escalated systems are revealed one step at a time through the scheduler, so the 3D twin lights up along the cascade.
- **Idempotent approval.** `approvePlan` is idempotent on `incidentId:planId`.
- **Sensor trigger.** The ESP32 posts readings in the engine's sensor format to `https://<deployment>.convex.site/sensor` with header `X-Haven-Sensor-Key`. The reading is recorded at once, and `engine.runCascade` sends it to FastAPI.
- **One-time setup.** In Clerk Dashboard → JWT templates, create the **Convex** template named `convex`.

Normalised tables (`nodes`, `sensors`, `incidents`, `events`, `plans`, `residents`, `requests`, `approvals`) and their indexed queries live in `convex/`. Without Convex settings, and in `pnpm verify`, the dashboards fall back to the engine's WebSocket.

### Hardware (ESP32 riser node)

One ESP32 NodeMCU per riser, flashed with `hardware/arduino/haven_device/haven_device.ino`:

| Part | Role | Wiring (GPIO) |
| --- | --- | --- |
| Water probe (resistive) | Leak input, raw 12-bit ADC | S → 34, + → 3V3, − → GND |
| SG90 micro servo | Shut-off valve | signal → 13, red → VIN (5 V), brown → GND |
| 16-pin HD44780 LCD (16×2, 4-bit) | Status text | RS → 19, E → 23, D4–D7 → 18/17/16/4, RW → GND, V0 → 10k pot, A → 5 V via 220 Ω |
| Buzzer | Alarm | + → 27, − → GND (set `BUZZER_IS_PASSIVE` for a passive one) |

Install **ArduinoJson 7**, **ESP32Servo 3** and **LiquidCrystal** in the Arduino IDE (board "ESP32 Dev Module"). Then fill `hardware/arduino/haven_device/secrets.h`; it is gitignored:

```cpp
#pragma once
#define WIFI_SSID "…"
#define WIFI_PASS "…"
#define DEVICE_ID "esp32-r3-l4"
#define HAVEN_SYNC_URL "https://<deployment>.convex.site/device/sync"
#define HAVEN_DEVICE_KEY "<HAVEN_SENSOR_KEY from .env.local>"
```

Every second the board posts `{ id, raw, applied, … }` to `/device/sync`. Convex replies with `{ v, poll, servo, lcd: [l1, l2], buzzer, wet }`:

- **Probe.** The probe is wet at or above `wetAbove` and dry at or below `dryBelow`, which defaults to raw 1500 and 800 with hysteresis in between. Only wet/dry changes go to the engine, as sensor `<id>-water` at `riser-r3-l4`. Telemetry goes to `deviceReadings` and is kept for 24 h; events go to `deviceEvents` and are kept for 7 days.
- **Valve.** It closes (90°) only when a water incident's plan has been approved, or when staff hold it closed. It reopens when the incident ends.
- **LCD.** It shows `HAVEN all clear` or `LEAK L4 SEV 2`, then `Needs approval`, then `Valve closed`.
- **Buzzer.** It plays `alert` (severity 2–3) or `alarm` (severity 4) until someone approves or silences it, then `chirp` once.
- **Offline.** A device that stops syncing is marked offline within about 10 s (`crons.ts`). The board itself shows `HAVEN offline` and sounds locally if the probe is wet, but never moves the valve on its own.

Staff functions (signed in) live in `convex/devices.ts`:

- `setValve({ deviceId, mode: "auto" | "open" | "closed" })`, `silenceBuzzer`, `identifyDevice`;
- `calibrateWater({ deviceId, dryBelow, wetAbove })`: read the live `water.raw` from `devices:list` with the probe dry, then in water;
- `configureDevice`: label, node, poll interval and servo angles;
- queries `list`, `readings` and `events`.

### Sign-in and workspaces (Clerk)

Fill the Clerk lines in `.env.local` (see Settings above). Every page except the landing page, `/sign-in` and `/sign-up` requires a signed-in account (`src/proxy.ts`). After signing in, `/workspace` lets each person pick Student, RA, Maintenance / Facilities, Security / Dispatch or Admin. The choice is saved to their Clerk profile (`unsafeMetadata.havenRole`) and shown in the profile menu, which also offers **Change workspace** and **Sign out**.

During development the saved workspace is a preference only: every signed-in account can open every role from the profile menu. Before enforcing roles, move the value to admin-set `publicMetadata` and check it server-side. The FastAPI backend is still unauthenticated. `pnpm verify` sets `NEXT_PUBLIC_HAVEN_AUTH_DISABLED=1`, so browser tests run without an account. To run `pnpm test:e2e` against a dev server, start that server with the same variable.

With Clerk on, open the app at `http://localhost:3000`, not `127.0.0.1`. Clerk rewrites each request to its own `localhost` URL, and Next.js treats that as an internal rewrite only when the server is bound to `localhost`. `pnpm dev`, `pnpm start` and `scripts/dev.mjs` bind there; the backend stays on `127.0.0.1:8000`.

Start both services with one command (dependencies are already installed in the current workspace):

```powershell
node scripts/dev.mjs
```

The launcher checks dependencies and both ports before starting anything. It waits for backend health, then prepares the dashboards and prints **HAVEN READY** only after the frontend responds. An occupied port stops startup with an explanation; it does not kill or attach to another service. If either owned service exits, its companion is stopped too. The local launcher connects the frontend to its backend on port 8000.

Optional: run the Fetch.ai agent team (Sentinel, Analyst, Guardian with 10 Resident Agents, Operator, Dispatcher, Recovery, and a Chat Protocol coordinator) in a second terminal. See [agents/README.md](agents/README.md).

Sign in at [localhost:3000/sign-in](http://localhost:3000/sign-in), choose a workspace, then open [Admin](http://localhost:3000/admin), [Resident](http://localhost:3000/resident), [Maintenance](http://localhost:3000/maintenance), [RA](http://localhost:3000/ra), and [Campus Security / Dispatch](http://localhost:3000/security) in separate tabs. Press Ctrl+C in the terminal to stop both services. Restart the demo after backend source changes to load the new state model and endpoints.

1. In Admin, expand **Live Demo Guide**, then click **Water Leak**.
2. Observe the incident, affected Riser R-3, unavailable Elevator E1, blocked normal route, and generated response plan.
3. Resident shows that E1 is offline and the alternative is awaiting approval.
4. In Admin, click **Approve Plan**.
5. The open Resident tab updates live with the instruction and same-floor route to the west refuge. E1 remains unavailable.
6. Optionally review the staff messages and approve a simulated Maintenance or Campus Security contact. Open the Contact log for recipient, time, approver, message, and incident details.
7. Click **Reset demo** in Admin to repeat. This resets the fictional incident and role work; it is not real incident resolution. The contact audit log is retained until backend restart.

### Presenting the hackathon sequence

The guide starts collapsed behind a compact **Live Demo Guide** header and chevron. Expand it to use the existing tools; click again to hide them. Hiding it never cancels a scenario or resets its progress. The short transition respects reduced motion, and hidden controls are excluded from keyboard/assistive navigation. Refresh or returning to Admin starts collapsed again. See [disclosure behavior and verification](docs/demo-disclosure.md).

When expanded, the guide keeps **Water Leak / Heat Warning / Confirmed Fire / Reset demo** visible together. Backend severity is prominent, Heat Warning remains distinct from an emergency, and new incidents focus the affected floor once. Blocked, proposed and reviewed paths have distinct treatments. Approval updates all four role notices live; the incident and its severity remain active. Reset confirms Normal in each open view and restores the full building. Request progress and delayed WebSocket confirmation are shown separately; neither can fabricate a successful action. See the [current presenter runbook](docs/demo-runbook.md) and [polish scope](docs/demo-polish-plan.md).

Admin includes a collapsible **Live Demo Guide**: **Normal → Trigger leak → Cascade → Access issue → Plan → Approve → Role updates → Explain**. Open the four role-view links before presenting, then follow the current cue. **Review proposed plan** scrolls/focuses the real plan; approval still uses the existing **Approve Plan** button. Once the live snapshot confirms publication, **Explain response** opens the existing read-only HAVEN assistant with the plan question. It does not start microphone capture or audio automatically.

The finite cascade uses five 900 ms highlights (4.5 seconds). All backend incident/system/access/plan facts arrive immediately; these highlights pace the explanation, not processing. **Replay cascade** and **Skip animation** change only presentation. Early approval stops the pending animation. Reduced-motion users see the ordered static explanation immediately. Offline guide controls disable, and the guide resumes from current live state after reconnection.

**Reset demo** remains available inside the expanded guide while connected, including Normal. On desktop the guide stays accessible while scrolling; the approved plan also has **Explain this plan** beside its confirmation. A confirmed reset returns each view to the top, restores the normal camera without reloading WebGL, and clears stale focus/review/explanation and unsent assistant draft state. Pressing the presenter Reset stops active speech/capture. An external reset still lets an already-captured voice question finish against the latest state, preserving the existing voice behavior. If the assistant is open, it keeps its selected question and refreshes its answer. Historical simulated contacts remain in Contact log. Loading placeholders never claim healthy/live state before a snapshot; the optional 3D view has its own preparation/fallback state.

See [the 90-second presenter runbook](docs/demo-runbook.md) for the exact clicks, narration, repeat flow, and offline/voice fallbacks.

To run the services in separate terminals instead:

```powershell
# Terminal 1, project root
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --workers 1

# Terminal 2, project root
pnpm dev
```

On macOS/Linux, use `python3 -m venv .venv` and `.venv/bin/python` in place of the Windows Python commands. The Node launcher works on both platforms.

## Implementation

* `backend/app/models.py`: typed building state, systems, places, events, incidents, plans, resident, and activity, with stable entity IDs.
* `src/components/daily-care.tsx`: calm daily ticket summary, Maintenance start/complete controls, and everyday accessible route. `src/lib/daily.ts` checks the existing route/elevator/live-state dependencies before displaying everyday routing.
* `backend/app/engine.py`: deterministic water → riser → elevator → accessible-route dependency rules and response-plan generation.
* `backend/app/store.py`: the single authoritative store, serialized mutations, idempotency, versioned snapshots, and bounded live subscriptions.
* `backend/app/main.py`: FastAPI transport and WebSocket lifecycle.
* `backend/app/sensors.py`: shared validated sensor payload contract.
* `backend/app/ingestion.py`: server-owned sensor location mapping, simulator payload construction, and normalization into the existing water-leak event.
* `backend/app/contacting.py`: fixed incident contact requests, strict approval payload, and a local-only simulated receipt generator. It has no numbers, network I/O, or external integration configuration.
* `src/lib/use-building-state.ts`: live snapshots, reconnection, command errors, and connection state.
* `src/components/demo-guide.tsx`: snapshot-derived presenter cues, role links, review/explanation handoffs, and reset/replay/skip controls.
* `src/components/dashboard-loading.tsx`: initial snapshot placeholders; the 3D model handles its separate optional loading/fallback state.
* `src/components/role-response-status.tsx`: live publication feedback in Maintenance/Campus Security without changing their work/dispatch state.
* `src/components/`: Admin/Resident views, lightweight Maintenance, RA, and Campus Security views, interactive React Three Fiber building model, and illustrative Resident route map.
* `src/components/maintenance-dashboard.tsx`: two cards answering what needs fixing, using incident work details and system status from the same live snapshot.
* `src/components/ra-dashboard.tsx`: check-ins, escalations, acknowledgement state, and a simple floor/location schematic, using the shared snapshot and command hook.
* `src/components/security-dashboard.tsx`: two cards for incident/response location and manually reported responder/dispatch status, using the same live hook.
* `src/components/contact-approvals.tsx`: Admin message review/approval, expandable audit log, and live simulated receipt notices in Maintenance/Campus Security.
* `src/lib/assistant.ts`: pure deterministic answers from the supplied snapshot, with explicit missing-data/offline fallbacks and focus targets.
* `src/components/haven-assistant.tsx`: compact shared floating question panel (Ask HAVEN / AI help); one live answer, suggested questions, voice, and validated navigation buttons.
* `src/lib/use-assistant-voice.ts`: browser speech input/output lifecycle only; it receives transcripts and speaks the same on-screen answer without owning building state.
* `src/lib/browser-speech.ts`: typed recognition interface and plain-language browser speech errors.
* `src/components/building-scene.tsx`: six low-poly floors with Elevator E1, Riser R-3, Room 412, and the Level 4 west refuge, generated from code primitives. Drag to orbit; scroll/pinch or use the view buttons to zoom. The reset-view button restores the camera without changing building state.
* `src/lib/building-visualization.ts`: pure adapter from the authoritative WebSocket snapshot to entity colors, labels, incident associations, affected floors, and the approved destination highlight. The scene consumes this view model and does not process events or infer dependencies.
* `src/lib/use-incident-presentation.ts`: one shared finite presentation clock for the Admin guide and building, with 900 ms cues and read-only replay/skip. It directs visual attention without delaying or changing authoritative statuses. Approval/reset/skip cancel timers; reduced-motion users receive the static explanation immediately.
* `src/components/approval-status.tsx`: pending/confirmed Admin feedback derived only from the backend snapshot. It shows unpublished guidance before approval and the backend approval timestamp plus publication confirmation afterward.

### Backend IDs → 3D elements

| Backend entity ID | 3D element | Authoritative fields used |
| --- | --- | --- |
| `R3` | Riser R-3 and affected floor tint | Matching system's `status` and `floors` |
| `E1` | Elevator shaft and doors | Matching system's `status` |
| `room-412` | Room 412 | `places` and incident `affected_place_ids` |
| `west-refuge-l4` | Level 4 west refuge | `places` and approved plan `destination_id` |
| `accessible_route` | Normal route, proposed alternative, and approved refuge path | Resident `normal_route_available`, system status, and matching plan destination/status |

The backend publishes `places`, resident `room_id`, incident `affected_place_ids`, and plan `destination_id`. These are explicit references, so visual associations do not depend on parsing resident instructions or route text. Adding these references preserves the existing leak and approval transitions. Missing mapped entities render as neutral unknowns. Healthy entities stay calm; an incident's existence alone does not turn every mesh red. The mesh groups retain the backend ID as their Three.js name and expose the visual/incident association in `userData`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Service health |
| `GET /api/state` | Current authoritative snapshot |
| `POST /api/demo/water-leak` | Simulate the Level 4 water event |
| `POST /api/sensor-events` | Accept a validated sensor reading through the same incident pipeline |
| `POST /api/incidents/{id}/approve` | Approve the current incident's plan |
| `POST /api/incidents/{id}/maintenance/start` | Start investigating the current incident's maintenance work |
| `POST /api/incidents/{id}/maintenance/complete` | Report the investigation complete for Admin review |
| `POST /api/incidents/{id}/ra/{resident_id}/check-in` | Record RA contact with an affected resident |
| `POST /api/incidents/{id}/ra/{resident_id}/escalate` | Escalate resident support to Admin |
| `POST /api/incidents/{id}/resident/acknowledge` | Resident acknowledges the approved instruction |
| `POST /api/incidents/{id}/security/acknowledge` | Record Campus Security acknowledgement of the incident |
| `POST /api/incidents/{id}/security/dispatch` | Record a manually coordinated responder dispatch |
| `POST /api/incidents/{id}/security/on-scene` | Record reported responder arrival |
| `POST /api/incidents/{id}/contacts/{recipient}/approve` | Explicitly approve one simulated contact to `maintenance` or `security`; requires `{ "approved": true }` |
| `POST /api/daily/tickets/{id}/start` | Start the single routine ticket while no incident is active |
| `POST /api/daily/tickets/{id}/complete` | Report the started routine repair complete |
| `POST /api/demo/reset` | Reset the demo, including all connected views |
| `WS /ws` | Initial and subsequent `{ "type": "state", "state": ... }` snapshots |

The frontend uses WebSocket snapshots as its displayed state. HTTP commands mutate the backend; all connected dashboards receive the resulting snapshot. Reconnecting clients get the latest complete state. Repeated leak/approval requests do not create duplicate events. Stale incident approvals return HTTP 409.

State is in memory and resets when FastAPI restarts. The contact audit log survives the **Reset demo** command but not backend restart. Run **one backend worker**; a shared persistent store is needed before multiple workers or deployment. The backend binds to loopback and has no authentication, as scoped for this demo. The browser API URL and allowed origins can be changed in `.env.local` if ports change (see Settings).

The response plan is generated from explicit rules, without an LLM. The building and routes are fictional demo geometry. Admin uses a basic interactive React Three Fiber cutaway. A water incident receives subtle, finite spotlights in this order: R-3 affected → E1 unavailable → normal route blocked → Room 412 impacted → west-refuge alternative proposed. All reported statuses remain visible immediately. The normal elevator route is marked with a red blocked path and cross. The proposed alternative is dashed amber and explicitly awaits Admin approval; it becomes solid green only after approval. The normal elevator route remains blocked afterward.

The scene renders on demand between camera movements and presentation updates. There are no continuous incident effects, auto-rotation, or Blender assets. If WebGL is unavailable, the incident and affected-system cards remain usable. Approval publishes guidance; it does not dispatch staff or control physical equipment.

Before approval, Admin shows an amber proposed/pending panel and explicitly states that Resident guidance is unpublished. Once the approved WebSocket snapshot arrives, the panel and response banner turn green, display the backend approval timestamp, and confirm instruction publication. The 3D route gains a white-edged solid green path, a direction marker, and a destination checkmark. The incident remains active and E1 stays unavailable. Button clicks, request progress, and HTTP response bodies cannot independently activate these states. Resident instruction handling, stale-incident protection, and idempotent approvals retain their existing behavior.

## One daily-mode workflow

Outside an incident, Admin shows normal monitored-system health, one routine ticket, and the resident's everyday step-free route. The example is a resident-reported flickering light inside the Level 4 laundry room. It requires routine upkeep but does not close the corridor or Elevator E1. This is separate from the monitored water/elevator/access health; the ticket is not an emergency or a new sensor signal.

Select **Open Maintenance** to see the ticket details. Maintenance presses **Start routine repair**, then **Mark routine repair complete** after doing the work in the demo. Admin's ticket status and activity update live over the same WebSocket snapshots. Resident keeps the normal route **Room 412 → Elevator E1 → Ground floor exit**, with an existing illustrative floor map. The Admin/Maintenance route summary explicitly says no stairs and that E1 is used.

`BuildingState.daily_ticket` is one typed ticket, not a ticket-management collection: ID, title, laundry location, description, route impact, routine priority, status (`open` → `in_progress` → `completed`), creation/update times, and optional completion time. The existing store serializes both actions and logs reported progress. Repeated commands are idempotent; a delayed start cannot reopen completed work. Completion before start, stale ticket IDs, and updates during an active incident return HTTP 409 without mutation; unsupported actions return 422. Neither routine command changes systems, Resident guidance/routes, incident state, contacts, or approval.

Everyday routing is displayed only when the live snapshot reports normal mode, no incident, the normal route available, and both E1 and the accessible-route system operational. Offline views hide live route guidance and disable work actions. When a leak arrives, Admin/Maintenance switch to the existing incident views and Resident's normal route is blocked. The daily ticket remains in state but cannot be updated, even after plan approval while the incident is active. Demo reset creates a fresh open ticket and restores the normal fictional building; retained contact audit history keeps its existing behavior.

To try it: open Admin, Maintenance, and Resident before any leak. Start/complete the light repair in Maintenance and watch Admin update while the everyday route stays available. Then use **Simulate water leak** in Admin's small simulation banner to verify the emergency handoff; **Reset demo** returns to a fresh daily workflow. There is no ticket creation/search, scheduling, staff directory, asset catalogue, or facilities-management platform.

## Admin-approved simulated staff contact

Inside the Admin incident card, **Approve staff contact** shows two fixed recipients and the exact messages proposed for the active incident. Maintenance is asked to investigate Riser R-3; Campus Security is asked to coordinate assistance for the affected resident. Both messages include the incident ID, and Campus Security's message distinguishes the registered room from an unconfirmed current location. Nothing is sent when a leak is detected, the plan is approved, the assistant answers/speaks, RA escalates, or staff update their status.

Only **Approve Maintenance contact** or **Approve Campus Security contact** triggers the local simulator. Each POST requires exactly `{ "approved": true }`. Missing/false/string/numeric approvals or additional fields return HTTP 422; callers cannot supply a phone number, message, or approver. The only recipient values are `maintenance` and `security`. Arbitrary destinations, including emergency numbers, are not supported. **No real calls, emails, messages, or 911 calls are made.** There is no outbound integration or environment setting that changes this simulator into a real dialer.

After approval, the store atomically marks the request `simulated_contacted`, associates its receipt ID, appends a structured `contact_log` record, adds shared activity, and broadcasts the full snapshot. A record contains recipient/name, incident ID, exact message, request/receipt IDs, `approved_by`, `approved_at`, `contacted_at`, and `mode: simulated`. The server uses the fixed actor **Admin (demo)**; this is an Admin-view demo control, not server-enforced Admin authorization or authenticated identity verification. The existing authless local architecture is preserved.

Admin's expandable **Contact log** shows who was contacted, when, for which incident, and who approved it. Maintenance/Campus Security receive a live **Admin-approved contact · Simulated** notice for their matching current incident. This does not start investigation, acknowledge/dispatch Campus Security, approve Resident guidance, or restore equipment. The assistant has no contact-command capability.

Repeated/concurrent approvals produce one receipt per recipient per incident, with no duplicate timestamp, activity, revision, or simulated delivery. Missing/stale incident IDs return HTTP 409 before the simulator runs. Failed simulation does not fabricate a receipt or partially update approval state. Contact buttons disable offline or while busy; HTTP response bodies alone cannot mark contact as sent. Reset clears the incident's requests but retains historical receipts; a new incident requires new approval even for the same team. Restarting the backend clears the in-memory audit log.

To try it: open Admin, Maintenance, and Campus Security; simulate a leak; review and approve one team's message; watch only that team's contact notice update live; approve the second team if desired. Expand Contact log, refresh, and reset the incident to verify history. Staff actions and Resident-plan approval remain separate.

## Compact Admin HAVEN assistant

Open **Ask HAVEN** at the lower-right corner of Admin. Choose **What happened?**, **Why is E1 offline?**, **Who is affected?**, **Is the resident safe?**, or **What is the proposed plan?**, or type/speak a question about those topics. This is a small panel with one current answer, not a separate chatbot page or conversation history.

Answers are deterministic and use the Admin dashboard's current authoritative WebSocket snapshot. The assistant reads linked event/source information, actual system statuses, affected IDs, registered resident/room details, and proposed or approved plan steps/rationale. It distinguishes proposed guidance from approved guidance and never treats approval as elevator restoration or confirmed resident arrival. Unknown questions get a bounded explanation of the supported topics; missing data is not guessed. The current answer updates on approval/reset and is replaced with an unavailable-context message while disconnected.

**Show** buttons close the panel, scroll to the matching incident, system, room/building, or plan card, and move keyboard focus there. For known mapped entities, the existing 3D camera centres on the element and a separate blue marker/ring appears for 4.5 seconds. Plan focus highlights the mapped refuge without approving it or changing route visibility. Original system colours, cascade timing, and approval state remain authoritative. Reset/incident changes and disconnects hide old focus; **Reset building view** restores the camera. Text/card focus still works without WebGL, and scrolling respects reduced-motion preferences.

Opening the panel focuses its input; Escape closes it and returns focus to the launcher. The panel fits desktop/mobile screens and stays absent from Resident, RA, Maintenance, and Campus Security. It has no LLM/API key, new backend state, incident-command capability, or external calling. Questions, answers, and focus actions do not mutate world state. Existing dashboard controls remain responsible for incident actions.

### Voice input and output

Press **Speak question** and allow microphone access in your browser. HAVEN listens for one English question, shows the recognized question in the same answer panel, and passes it to the existing `answerBuildingQuestion` function with the latest WebSocket snapshot. Spoken “E one” and “E 1” map to E1. Ask about the current incident, affected systems, resident safety, or the plan. The same suggested/typed questions and focus actions remain available.

**Speak voice replies** is initially enabled: final voice questions receive the same on-screen answer aloud. Uncheck it for silent replies. **Read answer aloud** reads any current answer, including typed/suggested questions; **Stop speaking** cancels playback. Starting capture stops playback to avoid hearing the assistant through the microphone. **Cancel listening** discards that capture. Capture ends after a final result, an error, or a 20-second timeout; it never restarts automatically.

Closing/focusing away through a Show action, disconnecting, hiding the tab, or leaving Admin stops active capture/output and ignores late recognition results. Question or building-revision changes cancel stale playback; use Read answer aloud to hear the refreshed answer. A question already being captured can finish against the latest state, rather than a separate voice snapshot. There are no voice sessions, audio files, transcripts, or world-state copies stored on the backend.

Resident-safety answers read the existing normal-route, published-guidance, Resident acknowledgement, RA contact, and Campus Security response fields. They explicitly leave safety/current location/refuge arrival unconfirmed. Reading an instruction, recording RA contact, or reporting Campus Security on scene is not treated as proof of safety or equipment restoration. These rules apply identically to text and voice.

With `CARTESIA_API_KEY` set, listening uses Cartesia Ink and HAVEN's own answers are spoken by Cartesia Sonic, through `/api/voice`, which only speaks text the server produced. Resident guidance, approved PA announcements, team briefs and the Admin-approved phone calls use the same path; see [docs/cartesia-voice.md](docs/cartesia-voice.md). Without a key, voice uses the browser's [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) (including its prefixed form) and [SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/speak) APIs. Input support varies and needs a secure context (localhost is suitable for the demo), microphone permission, and an available browser speech service. Some browsers send audio to their speech service, so this is **not guaranteed offline recognition**. The panel discloses that before capture. No emergency call is ever placed automatically.

Unsupported input/output has disabled controls and a visible explanation; denied microphone access, missing audio devices, network/no-speech errors, timeouts, and playback errors leave typing and on-screen answers usable. Automated tests exercise these boundaries with deterministic browser speech doubles. See the verification report for native browser probe results and any microphone/provider limitations.

## Hey Haven: the on-screen assistant that acts

Every signed-in dashboard (Admin, RA, Maintenance, Security, Resident and the `/app` phone view) has the **Hey Haven** orb above Ask HAVEN. It is built on StudyO's Buds (inspired by Clicky), rebuilt for HAVEN. Turn it on with the orb, **Alt+H**, or by saying **"Hey Haven"** (switch the wake word on in its panel); a small cursor then follows yours.

- **Talk:** hold **Ctrl+Alt** (⌘+⌥ on Mac) and speak, or tap the mic. Conversation mode listens again after each answer. Cartesia Ink transcribes and Cartesia Sonic answers through `/api/voice` with a server-issued token, so the page never sends words to be spoken; the browser's voice is the fallback. "Bye Haven" switches it off.
- **Evacuation plans:** "Draw my evacuation plan", the map button, or by itself when an incident starts or a plan is approved. The plan is drawn stroke by stroke from the live state and the twin's floor plan (`src/lib/hey-haven/evacuation.ts`), never by the model: walls, rooms, stairwells, E1 (crossed out when closed), hazard zones, closed routes, the person's room and the verified route, amber while proposed and green once Admin approves. No verified route means "shelter in place". Configured properties are drawn from their registry geometry, seen from above.
- **Explains and teaches:** answers from the page's building snapshot, points and circles things on screen, sketches flowcharts and graphs, and teaches step by step ("teach me my way out step by step"): one leg per answer, moving on by itself, with Pause / Next / End or "continue", "next", "wait" out loud.
- **Does the work:** files and works requests, records staff steps (acknowledge, dispatch, on scene, check-in, maintenance start/complete), approves contacts, approves the plan, starts the simulated emergency call or a demo scenario. Each task runs through the page's own `act` (the Convex commands the buttons use) and **always waits for Allow** (or a spoken "yes"); approvals, resets, scenarios and calls ask twice. Read-only tasks (open a page, show something in the twin, ask the Fetch.ai agent team) run at once. A task tray chimes when work finishes.
- **Do it for me:** multi-step work on screen ("open My Requests, then Maintenance, and tell me what the form asks"), one step at a time, re-reading the page after each; anything that approves, dispatches, sends or resolves needs Allow. **Stop**, Esc or "stop" ends it.
- **Reports:** "write an incident report / shift handoff" returns a sectioned report, saved to Convex for the team, with Copy and Download.
- **Memory:** one conversation per person across pages and devices (Convex `heyHavenTurns`, kept a week; **Forget** clears it), plus a log of what Hey Haven did (`heyHavenTasks`).

Pieces: [src/components/hey-haven](src/components/hey-haven) (UI), [src/lib/hey-haven](src/lib/hey-haven) (engine, whiteboard, evacuation, voice, tasks, schema, prompt, agent), [src/app/api/hey-haven](src/app/api/hey-haven) (one Claude turn, streamed so speech starts early; `log` for the task log) and [convex/heyHaven.ts](convex/heyHaven.ts). It needs `ANTHROPIC_API_KEY` (model `HEY_HAVEN_MODEL`, default the agents' `claude-opus-5-5`); Cartesia is optional. The model returns JSON commands that are validated against what is actually on screen before anything is drawn or done. Tests: `pnpm test:hey-haven`.

## Lightweight Maintenance dashboard

In daily mode, `/maintenance` shows the single routine laundry-light ticket and everyday route described above. During an incident, it answers “What needs fixing?” with two cards: Riser R-3's fault, Elevator E1's current impact, and service location/route; then a short investigation checklist and one status action. It has no building overview, approval controls, or 3D scene.

Each water incident contains `maintenance`: referenced `asset_id` (`R3`), `impact_system_id` (`E1`), location, illustrative service route, checklist, status, and server update time. The backend owns these details. **Start investigation** moves `open` → `in_progress`; **Mark investigation complete** moves `in_progress` → `investigated`. Admin sees the status and activity updates live. Reporting completion leaves the incident active and E1 unavailable; it does not claim equipment is repaired or approve Resident guidance.

These commands need no request body and return the full state. The displayed status changes only from WebSocket snapshots. Repeated commands are idempotent; delayed start requests cannot reopen completed work. Completing before starting, or using a missing/stale incident ID, returns HTTP 409 without mutation. Demo reset clears the work with its incident; reconnecting dashboards receive the current work status. During a disconnect, the view warns that its data may be stale and disables status actions.

To try it, open Maintenance before triggering the Admin leak simulation. Observe the fault arrive without a refresh, start and complete the investigation, and watch Admin's maintenance status update. Approve the response plan separately to publish Resident guidance.

## Lightweight RA dashboard

The `/ra` page answers “Who needs me?” with three small cards: residents needing a check-in, incident escalations, and a floor/location view. It uses the existing demo resident, Alex Morgan in Room 412; it does not add a resident directory, chat, or calling.

The dependency engine creates `incident.ra_check_ins` when the water event blocks the resident's normal step-free route. Each task references the stable `resident.id` (`resident-412`) and contains a reason, `pending`/`checked_in` status, `checked_in_at`, and optional `escalated_at`. **Mark checked in** records contact; **Escalate to Admin** flags follow-up in the RA incident card, Admin summary, and shared activity. Either action can happen first. A check-in does not clear an escalation or resolve the incident.

Acknowledgement is separate from contact: after Admin approval, Resident can press **I’ve read the instruction**. The backend records `resident.acknowledged_plan_id` and `acknowledged_at`; RA updates live from “awaiting approval” to “awaiting resident acknowledgement” to “acknowledged.” RA cannot acknowledge on behalf of the resident through its controls. Reading the instruction does not mark a check-in complete, confirm arrival, or restore Elevator E1.

All three commands need no body and return the authoritative snapshot. Displayed status comes only from WebSockets. Repeated commands are idempotent, with no duplicate activity or revision. Missing/stale incident IDs and unknown check-in residents return HTTP 409; acknowledgement before approval also returns 409. Unsupported RA actions return 422. The store serializes updates under its existing lock. Reset clears RA tasks and acknowledgement state, and reconnecting clients receive the latest snapshot. Offline actions are disabled and the shared warning identifies potentially stale data.

The floor view shows the resident's registered room and the plan's refuge destination on the same floor. It is an illustrative layout, not live resident tracking. Before approval, the refuge is not presented as an approved destination. After approval, its label changes without claiming the resident is there.

To try it: open RA before triggering the Admin leak. Record a check-in or escalate support; watch Admin update live. Approve the plan in Admin, then acknowledge the instruction in Resident and watch RA's acknowledgement state change. These actions preserve the existing Maintenance work, sensor-ingestion flow, equipment restrictions, and approval boundary.

## Lightweight Campus Security / Dispatch dashboard

The `/security` page answers “Where is response required?” with two cards: the active incident, escalation location, and affected resident; then the responder and acknowledgement/dispatch state. It has no Admin approval controls, cameras, autonomous calling, or external dispatch integration.

The dependency engine creates `incident.security` with a stable affected `resident_id`, registered-room `location_id`, reason, demo `responder_id`/`responder_name`, status, and three initially null timestamps. For the current incident, response is associated with Alex Morgan's Room 412 on Level 4. This is a registered response location, not a claim about the resident's current position. Plan approval does not move this location to the refuge. RA escalations to Admin are also shown from the existing check-in state for coordination, without changing their destination or automatically dispatching anyone.

The only progression is manual: **Acknowledge incident** (`pending` → `acknowledged`), **Record dispatch** (`acknowledged` → `dispatched`), and **Mark on scene** (`dispatched` → `on_scene`). The responder remains on standby until dispatch is recorded. Server-set `acknowledged_at`, `dispatched_at`, and `on_scene_at` are visible in the view. Admin receives the current Campus Security status and activity live. On-scene status does not confirm resident safety or resolve the incident.

All three POST commands need no body and return the complete world snapshot. WebSockets alone drive displayed status. Commands are serialized in the existing store; repeats and delayed earlier commands are no-ops without duplicate timestamps, activity, or revisions. Dispatch before acknowledgement, arrival before dispatch, and stale/missing incident IDs return HTTP 409 without mutation. Unsupported actions return 422. Reset clears response details with the incident, and reconnecting clients get the current snapshot. Offline actions are disabled with the shared stale-data warning.

These controls record human coordination in the fictional demo. They do not contact responders, call emergency services, or control physical equipment. Campus Security acknowledgement is separate from Resident acknowledgement, RA check-ins, Maintenance work, and Admin plan approval. None of those actions automatically dispatches a responder, and dispatch never publishes Resident guidance or re-enables Elevator E1.

To try it, open Campus Security before triggering Admin's water leak. Optionally escalate support from RA to see the shared escalation. Acknowledge the incident, record dispatch, and report arrival manually; watch Admin update without refreshing. Approve Resident guidance separately. Reset from Admin to repeat.

## Sensor request contract — no hardware required

Send JSON to **`POST /api/sensor-events`**, with **`Content-Type: application/json`**. The current local URL is `http://127.0.0.1:8000/api/sensor-events`.

```json
{
  "sensor_id": "esp32-water-01",
  "sensor_type": "water",
  "location_id": "riser-r3-l4",
  "value": 1,
  "status": "wet",
  "timestamp": "2026-10-22T15:30:00-04:00"
}
```

| Field | Contract |
| --- | --- |
| `sensor_id` | Non-empty string, at most 80 characters; identifies the sender. |
| `sensor_type` | `water`, `moisture`, `water_pressure`, `heat`, `smoke`, `fire_alarm`, `electrical`, `elevator`, `hvac`, `occupancy`, or `access`. |
| `location_id` | Server-owned allowlist per sensor type; see the expanded contract. Riser readings use `riser-r3-l4`. |
| `value` | Strict finite numeric reading with a type-specific range. Legacy `water` remains integer 0/1; pressure is kPa and heat is °C. Strings and booleans are rejected. |
| `status` | Optional type-specific status. Digital water/moisture use wet/dry; alarms use alarm/clear; faults use fault/normal; access uses blocked/open. Value and status must agree. Analog readings require a value. |
| `timestamp` | Required ISO 8601 observation time with `Z` or a UTC offset. Naive datetimes and numeric epoch values are rejected. |

Extra fields and unsupported types/locations return **HTTP 422** without modifying world state. Senders do not supply affected systems, floors, approval state, or a trusted source label.

Both inputs use one path:

* The existing **Simulate water leak** button calls `POST /api/demo/water-leak`. It constructs a `SensorPayload` internally, then calls `WorldStore.ingest_sensor_event`.
* Future ESP32-shaped JSON enters through `POST /api/sensor-events`, validates as the same `SensorPayload`, and calls the same method.
* The normalizer resolves the location and converts wet input into the existing `BuildingEvent`. The existing dependency/accessibility engine, incident generation, approval gate, and WebSocket broadcast then run unchanged.

The endpoint returns **HTTP 200** with the current `BuildingState`, using the same snapshot shape as the demo endpoint plus sensor metadata. `sensor_readings` holds the most recently accepted reading per sensor ID, with its payload, server-set `source_kind`, and server `received_at`. A leak event retains the original payload under `event.sensor`; `event.created_at` is the observation time normalized to UTC, while `event.received_at` records server receipt time. Inputs use source kind `sensor`; the demo uses `simulated`.

Dry input is recorded as telemetry and broadcast, but never resolves an active incident, re-enables E1, or bypasses Admin approval. Repeating identical accepted input is a no-op. Legacy water wet readings while an incident is active retain the existing coalescing behavior. Expanded sensors retain the latest reading per sensor and a bounded 100-reading/event history for trends. Non-water observations at or before that sensor's latest timestamp are ignored. An observed sensor ID cannot change type or location. Demo reset clears telemetry and requests; contact and emergency-call audit histories are retained until backend restart. [Expanded rules, units, locations, and endpoints](docs/expanded-contract.md) document the full contract.

Try the future request format locally, in PowerShell, while the demo services are running:

```powershell
$havenSensorPayload = @{
  sensor_id = 'esp32-water-01'
  sensor_type = 'water'
  location_id = 'riser-r3-l4'
  value = 1
  status = 'wet'
  timestamp = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8000/api/sensor-events' -ContentType 'application/json' -Body $havenSensorPayload
```

Open Admin and Resident in separate tabs to see this request drive the same live incident/approval demo. No ESP32 firmware, Wi-Fi/serial transport, device provisioning, or LAN server configuration is added. The server retains its existing loopback binding. Both hardware-shaped JSON and demo buttons use the same ingestion path and deterministic engine.

## Light building-operations presentation

Admin, Maintenance and Campus Security now use a light facilities-console presentation: equipment hierarchy and IDs, reported-system availability, structured sensor telemetry, incident impact chains, work-order metadata, and response/access coordination. The digital twin emphasizes E1, R-3, electrical/HVAC service equipment, sensor values, stairs and exits. Resident and RA keep their people-focused interface. This is a frontend-only update; backend behavior and workflows are unchanged. See [operational states, data definitions and verification map](docs/operations-ui.md).

## Connected Resident / RA / Maintenance requests

Resident can submit a repair or contact RA, see the assigned team and follow replies/progress on the same request. RA can acknowledge, reply, add a labeled team note, resolve support work or hand a request to Maintenance with context. Maintenance receives direct repairs and RA handoffs with the prior conversation, updates progress and marks work resolved. Resident and RA see the resolution live. Urgent incident assistance stays visible to RA/Admin and does not bypass plan approval or emergency handling.

The shared lifecycle is **New → Acknowledged → In progress → Resolved**, with visible ownership, routine/urgent priority, category, source and history. Desktop uses a compact form/history layout; mobile stacks it. New incoming work opens the team's queue. See [workflow, endpoints and demo visibility boundary](docs/shared-requests.md) and [implementation plan](docs/shared-request-plan.md). Restart the demo after this backend update to load the new request fields/endpoints.

## Building digital twin and Resident map

The six-floor cutaway now includes furnished rooms, continuous corridors, two stair cores, Elevator E1, Riser R-3/service bays, exits, a west refuge, sensor anchors and responder entry. Click a floor or entity to inspect it; isolate floors, toggle layers, reset the camera or smoothly focus the active incident. Keyboard equivalents are available below the model. The Resident map uses the same configured footprints and route points, while the existing backend and approval boundary still decide which route is usable.

Canonical entity IDs and Blender node names are mapped through configuration. The procedural geometry can be replaced with a GLB without rewriting incident or role logic. See [building layout, controls and GLB integration](docs/building-model-integration.md) and [the scoped implementation plan](docs/building-experience-plan.md).

## Verification and screenshots

Run the complete check with one command (no manually started test services needed):

```powershell
pnpm verify
```

This runs workflow tests, backend tests, TypeScript checking, an isolated production build and all browser journeys. It reserves ports 3001/8001, waits for service readiness, and stops only the processes it starts. It never reuses or resets a running demo. Build output goes to `.next-verify`; the usual `.next` output and ports 3000/8000 are preserved. Node restores the generated `next-env.d.ts` declaration on exit. Install Chrome or configure `PLAYWRIGHT_CHANNEL` as described below.

For an occupied test port, set `HAVEN_VERIFY_WEB_PORT` and `HAVEN_VERIFY_API_PORT` to unused ports; they must differ and cannot be 3000/8000. A focused run is `node scripts/verify.mjs tests/request-journey.spec.ts`. Failed browser checks retain Playwright traces/screenshots. Ctrl+C stops owned processes and releases the verification lock. After force-killing a run, confirm its test processes have stopped before removing `.haven-verify/lock` and retrying. Do not run multiple verifiers against the same build directory.

Requests now have a clearer journey: active/urgent-first queues, search and status filters, next-step guidance, and a four-stage progress strip. A confirmed submission opens its own conversation. “Link to this request” and staff links carry the same request into another role view; unavailable/reset links explain what happened. Unsent replies and handoff context survive selection/filter changes within the current view. They are held in memory and clear on reset or leaving/reloading the view. No authentication or new request engine was added. See [the workflow improvement plan](docs/journey-workflow-plan.md) and [verified journey/workflow report](docs/journey-workflow.md).

Individual checks remain available:

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests -q
pnpm typecheck
pnpm build
# With both services running; tests reset the demo state.
pnpm test:e2e
```

Browser tests use installed Chrome by default. To use Playwright Chromium instead, install it with `pnpm exec playwright install chromium` and set `$env:PLAYWRIGHT_CHANNEL = 'chromium'` before running the tests.

Tests can target separate local services with `HAVEN_TEST_BASE_URL` and `HAVEN_TEST_API_URL` (defaults: frontend port 3000, backend port 8000). When testing alternate ports, build/start the frontend with the matching `NEXT_PUBLIC_API_URL` and set the backend's `HAVEN_ALLOWED_ORIGINS` to that frontend origin. This allows isolated validation while another demo is running.

See [the implementation plan](docs/implementation-plan.md) and [verification report with screenshots](docs/verification.md).
