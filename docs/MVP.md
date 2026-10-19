# HAVEN multi-role MVP

The stack remains **React + Vite + TypeScript**, backed by the existing FastAPI simulation. No Next.js or Turbopack.

## Where it stands (2026-10-19)

All eight steps below are built. Routes: `/app` the role workspace (`frontend/src/portal/`), `/command` the admin's
command centre (the live simulation, the agents, approval), `/phone` the responder's phone, `/` and `/story` public.
Live incidents reach each role through `portal.incident_for`: a resident gets only their own tailored message, an RA
the people on their floors who need a check-in (by situation, sorted by urgency), maintenance the plant that is down
and the facilities steps (confirmable with `POST /api/portal/tasks/{step}/done`), the admin the full narrative.
Maintenance sees its own jobs plus the unclaimed maintenance queue and claims a job before working it.

Not done yet: per-role AI agents beyond Ask HAVEN, calendar-backed duty schedules, Resend delivery webhooks.

## Build order

1. **Identity and theme:** Clerk sessions verified by the backend; system/light/dark preference; demo role selection separated from account permissions.
2. **Privacy boundary:** legacy command-centre API is admin-only. `/api/portal/snapshot` and `/ws/portal` project authorized records. WebSocket credentials travel in the first frame, never URLs. Clerk tokens are revalidated while streaming.
3. **Housing events:** requests, profiles, contacts, assignments, availability and inbox records use `HousingEvent` in the existing SQLite log. They survive incident resets and restarts. Incident replay is read-only.
4. **Requests and visits:** report, acknowledge, start, resolve, assign, message, propose appointments, accept or decline. Versions reject stale updates. Private-room maintenance requires an accepted visit; when-home preferences require staff to confirm presence.
5. **Communication:** inbox records persist before Resend is attempted. Email uses session-verified addresses. Status distinguishes provider acceptance, failure, missing address/configuration and disabled notifications.
6. **Dashboards:** overview, requests, inbox, Contact Corner, Ask HAVEN and preferences; staff availability and team tools; admin command centre with the existing simulation.
7. **Scoped building:** lightweight Three.js reuses existing footprint geometry, with server-filtered rooms/equipment. Admin can load the existing Blender exterior on demand. No duplicate simulation.
8. **Validation:** permission/IDOR, WebSocket, appointment, persistence and role-spoofing tests; incident regressions; TypeScript, frontend tests, Vite build and local UI checks.

## Role contract

| Role | Workspace | Private data | Actions |
|---|---|---|---|
| Resident | Own requests, appointments, inbox and shared updates | Own room and profile | Report, message, negotiate visits, configure companion and preferences |
| RA | Welfare/assistance on assigned floors and duty schedule | Assigned room locations and minimal directory; no medical profiles | Acknowledge/resolve support requests, welfare checks, visits, availability |
| Maintenance | Explicitly assigned jobs | Job rooms, plant, shared access; relevant entry preferences | Start/complete work, message owner, propose visits, availability |
| Housing Admin | All housing requests, teams and command centre | Full authorized simulation and housing records | Assign staff/floors, edit contacts/procedures, approve feasible plans |

Demo selection is not a production role grant. Clerk `public_metadata.role` is authoritative; missing role means resident. `public_metadata.person_id` links a roster resident, RA or staff identity. Configure metadata in Clerk, never browser storage. Unlinked residents receive shared spaces, not a guessed room assignment.

## Clerk and Resend

Copy the existing environment templates, then configure these values locally. Never commit secrets.

```dotenv
# frontend/.env
VITE_CLERK_PUBLISHABLE_KEY=your_publishable_key

# backend/.env
CLERK_SECRET_KEY=your_secret_key
CLERK_AUTHORIZED_PARTIES=http://localhost:5173,http://127.0.0.1:5173
RESEND_API_KEY=your_resend_key
RESEND_FROM=HAVEN <housing@your-verified-domain>
```

Start the backend with its environment file (the dev scripts do this). Save preferences or create a request while signed in to register the verified email destination. No real phone number, email address or emergency procedure is invented; populate Contact Corner as admin.

Resend's shared test sender is limited to the account owner's test address. Use a verified domain for other recipients. `accepted` means Resend accepted the request, not confirmed mailbox delivery. See [Clerk token validation](https://clerk.com/docs/guides/sessions/manual-jwt-verification) and [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email).

## 3D and Blender

Admin can load the existing exported GLB on demand. Other roles use only the scoped stylized scene. Existing files under `frontend/public` are synthetic public demo assets: never replace them with confidential layouts or occupant metadata without authenticated asset delivery.

`blender/haven_live.py` connects Blender to the same backend. Blender MCP is a separate add-on/server connection; installing Blender alone does not expose MCP tools. See [Blender setup](./BLENDER.md).

## Visible limits

- Synthetic building, roster and physics are a rehearsal, not a certified emergency system.
- The companion uses role-scoped facts and optional Claude. It cannot autonomously approve visits, execute commands, or operate equipment.
- Accessibility text is private to its owner and their assistant. Emergency hard constraints still use the authoritative roster; free text does not silently rewrite them.
- Duty schedules are staff-entered descriptions, not calendar integrations. Appointment negotiation records human proposals and acceptance.
- Incident inbox cards derive from the existing run; read acknowledgements persist. Incident-wide email broadcasts are not enabled.
- Email is synchronous with failures recorded. Production scale needs durable retries and signed delivery webhooks.
- Live Clerk/Resend validation needs account credentials. Tests use isolated stores and mocked providers.
