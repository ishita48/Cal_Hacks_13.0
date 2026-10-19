# HAVEN, simplified: one app, three tabs, four roles

The full multi-role brief (personal agents, appointments, duty rosters, per-role 3D) is the destination.
The MVP gets there by building three things everyone uses, then letting the **role decide what you see**:

| Tab | What it is |
|---|---|
| **Alerts** | The tracking system: anything that needs attention (a leak, a broken AC, an emergency) is an alert that moves `open → acknowledged → resolved`, with who did what and when. Email (Resend) is a copy; the in-app list is the record. |
| **Contacts** | The Contact Corner: your RA, the front desk, housing, maintenance, and emergency services kept apart from ordinary support. Real numbers only when configured, otherwise "not set". |
| **Ask HAVEN** | The AI: ask about what is going on ("is my floor safe?", "who fixes this?"), answered from the live world, scoped to your role. It explains and suggests; people decide. |

Housing Admin also keeps today's command centre (3D twin, plan, approve) as a fourth tab, **Building**.

## Roles (server-decided, from Clerk `public_metadata.role`)

| Role | Alerts they see | Can do |
|---|---|---|
| Resident | their own reports + building-wide emergencies | report an issue, see status, contact |
| RA | their floors | acknowledge, resolve welfare items, contact residents' support |
| Maintenance | maintenance + equipment alerts, work orders | acknowledge, resolve, add notes |
| Housing Admin | everything | assign, resolve, approve plans, edit contacts |

Privacy is enforced by the backend (filtered API responses and, later, filtered `/ws` frames), never by hiding things in the UI.

## Build order

1. **Foundation** ✅ theme follows the device (system / light / dark); Clerk roles verified server-side (`GET /api/me`, demo role header without Clerk); Resend email (`POST /api/notify/test`).
2. **Alerts backend**: `AlertEvent` input events (raise / acknowledge / resolve / note) in the event log, `state.alerts`, the live incident raises its alert by itself, routing per role, `GET /api/alerts` filtered by viewer, email on raise.
3. **New shell**: `/app` opens on the role's home: Alerts tab (list, report form, acknowledge / resolve) in the pastel glass style; demo role picker when Clerk is off.
4. **Contacts**: Contact Corner from the roster + building spec, admin-editable, emergency vs support kept apart.
5. **Ask HAVEN**: the existing Buds router answering from a role-filtered view of the world, Claude as fallback.
6. **Privacy on the live view**: `/ws` frames filtered per role; residents and RAs see only shared spaces and their floors in the 3D twin.
7. **Polish**: maintenance appointments, RA availability and welfare checks, per-role agents.
