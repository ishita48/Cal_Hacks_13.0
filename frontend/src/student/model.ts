import type { Contact, Snapshot } from '../portal/types'
import type { BuildingSpec, Rect } from '../state/types'

type Room = Snapshot['building']['spaces'][number]

/**
 * Everything the student dashboard shows, as a pure function of the resident's own projection (GET
 * /api/portal/snapshot, pushed again on /ws/portal) and the public building spec. Nothing here is a safety
 * decision: the instruction in an incident is the server's message to this resident, word for word. This
 * file only chooses which card says it and lays out the step-free way out from the spec and live lift status.
 */

/** ok: nothing affects you · assisted: it does, and an approved plan covers you · escalated: it does, no plan yet. */
export type Status = 'ok' | 'assisted' | 'escalated'
export type Tone = 'ok' | 'warn' | 'alert'

export interface Stop {
  kind: 'room' | 'lift' | 'exit'
  label: string
  down: boolean
}

export interface Route {
  /** A step-free way from the resident's room to the main entrance exists right now. */
  reachable: boolean
  stops: Stop[]
  /** "Lift 1 → Main lobby", or why there is no step-free way. */
  summary: string
  minutes: number | null
}

export interface InboxRow {
  id: string
  kind: 'alert' | 'visit' | 'notice'
  title: string
  text: string
  at: string
  unread: boolean
  /** A visit someone proposed: the resident accepts or declines it. */
  visit?: { requestId: string; version: number }
}

export interface StudentView {
  name: string
  first: string
  building: string
  linked: boolean
  room: string | null
  floor: string | null
  pill: { tone: Tone; label: string }
  outcome: { status: Status; reachable_refuge: boolean }
  hero: { tone: Tone; title: string; text: string }
  ra: { contact: Contact; role: string } | null
  inbox: InboxRow[]
  route: Route
}

const WALK_M_PER_S = 1.0 // a careful step-free pace, wheelchair or not

const centre = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 })
const walk = (a: Rect, b: Rect) => {
  const p = centre(a)
  const q = centre(b)
  return Math.abs(p.x - q.x) + Math.abs(p.y - q.y)
}

export function stepFreeRoute(snap: Snapshot, spec: BuildingSpec | null, room: Room | null): Route {
  const none = (summary: string): Route => ({ reachable: false, stops: [], summary, minutes: null })
  if (!room) return none('Your account is not linked to a room yet. Ask the housing office to link it.')
  if (!spec) return none('Loading your way out…')
  const exit = spec.spaces.find((s) => s.tags.includes('main_entrance'))
  if (!exit) return none('This building has no main entrance on file.')
  const roomStop: Stop = { kind: 'room', label: room.name, down: false }
  const exitStop: Stop = { kind: 'exit', label: exit.name, down: false }
  if (room.level === exit.level)
    return { reachable: true, stops: [roomStop, exitStop], summary: `Straight to ${exit.name}`, minutes: Math.max(1, Math.ceil(walk(room.rect, exit.rect) / WALK_M_PER_S / 60)) }

  const status = new Map(snap.building.equipment.map((e) => [e.id, e.status]))
  const spaces = new Map(spec.spaces.map((s) => [s.id, s]))
  const levelIndex = new Map(spec.levels.map((l) => [l.id, l.index]))
  const floors = Math.abs((levelIndex.get(room.level) ?? 0) - (levelIndex.get(exit.level) ?? 0))
  const lifts = (spec.verticals ?? [])
    .filter((v) => v.kind === 'lift' && v.step_free && v.spaces[room.level] && v.spaces[exit.level])
    .map((v) => {
      const here = spaces.get(v.spaces[room.level])
      const there = spaces.get(v.spaces[exit.level])
      const seconds = here && there ? (walk(room.rect, here.rect) + walk(there.rect, exit.rect)) / WALK_M_PER_S + floors * v.seconds_per_level : Infinity
      return { v, seconds, up: !v.equipment || status.get(v.equipment) === 'online' }
    })
    .sort((a, b) => a.seconds - b.seconds)
  if (!lifts.length) return none(`No lift reaches ${exit.name} from your floor.`)
  const best = lifts.find((l) => l.up)
  if (!best)
    return {
      reachable: false,
      stops: [roomStop, { kind: 'lift', label: lifts[0].v.name, down: true }, exitStop],
      summary: `${lifts.map((l) => l.v.name).join(' and ')} ${lifts.length > 1 ? 'are' : 'is'} out of service`,
      minutes: null,
    }
  return {
    reachable: true,
    stops: [roomStop, { kind: 'lift', label: best.v.name, down: false }, exitStop],
    summary: `${best.v.name} → ${exit.name}`,
    minutes: Math.max(1, Math.ceil(best.seconds / 60)),
  }
}

export function ago(iso: string, now = Date.now()): string {
  if (!iso) return 'now'
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function studentView(snap: Snapshot, spec: BuildingSpec | null): StudentView {
  const { viewer, incident, building, profile } = snap
  // A resident's projection holds exactly one room: their own (everything else is shared space).
  const room = building.spaces.find((s) => s.kind === 'room') ?? null
  const level = building.levels.find((l) => l.id === (room?.level ?? viewer.levels[0]))
  const affected = incident.active && incident.affected
  const status: Status = !affected ? 'ok' : incident.approved ? 'assisted' : 'escalated'
  const route = stepFreeRoute(snap, spec, room)

  const pill: StudentView['pill'] = !incident.active
    ? { tone: 'ok', label: 'Building normal' }
    : affected
      ? { tone: 'alert', label: 'This affects you' }
      : { tone: 'warn', label: 'Incident in building' }

  const onFile = profile.accessibility ? ' Your access needs are on file.' : ''
  // In any incident the words are the server's: before the water reaches them a resident in the forecast
  // already has their own plan message ("staff are coming to your door"), so never claim it does not concern them.
  const hero: StudentView['hero'] =
    status === 'ok'
      ? incident.active
        ? { tone: 'warn', title: 'Something is happening in the building', text: incident.message }
        : { tone: 'ok', title: "You're all set", text: `${building.name} is operating normally. You'll be alerted the instant anything affects you.${onFile}` }
      : status === 'assisted'
        ? { tone: 'warn', title: 'Help is on the way', text: incident.message }
        : { tone: 'alert', title: 'Follow this instruction', text: incident.message }

  const raContact = level ? snap.contacts.find((c) => !c.emergency && c.levels.includes(level.id)) : undefined
  const ra = raContact && level ? { contact: raContact, role: `${level.name} RA` } : null

  const visits: InboxRow[] = snap.requests
    .filter((r) => r.appointment_status === 'proposed' && r.proposed_by && r.proposed_by !== viewer.id)
    .map((r) => ({ id: `visit:${r.id}`, kind: 'visit', title: 'Visit to review', text: `${r.title} · ${r.appointment}`, at: r.updated_at, unread: true, visit: { requestId: r.id, version: r.version } }))
  const notices: InboxRow[] = snap.inbox.map((n) => ({
    id: n.id,
    kind: n.id.startsWith('incident:') ? 'alert' : 'notice',
    title: n.title,
    text: n.text,
    at: n.created_at,
    unread: !n.read,
  }))
  const rank = { alert: 0, visit: 1, notice: 2 }
  const inbox = [...notices, ...visits].sort((a, b) => rank[a.kind] - rank[b.kind] || Number(b.unread) - Number(a.unread) || b.at.localeCompare(a.at))

  return {
    name: viewer.name,
    first: viewer.name.split(' ')[0],
    building: building.name,
    linked: viewer.linked,
    room: room?.name ?? null,
    floor: level?.name ?? null,
    pill,
    outcome: { status, reachable_refuge: route.reachable },
    hero,
    ra,
    inbox,
    route,
  }
}

export function greeting(hour: number) {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}
