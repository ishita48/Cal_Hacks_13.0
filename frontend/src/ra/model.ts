import type { IncidentTask, Snapshot } from '../portal/types'
import type { Rect } from '../state/types'

/**
 * Everything the RA dashboard shows, as a pure function of the RA's own projection (GET /api/portal/snapshot,
 * pushed again on /ws/portal). The server already decided who on these floors needs a hand and in what
 * situation (never a medical detail); this file only ranks them, words the situation codes, and lays the
 * floor out from the spaces the RA may see.
 */

/** escalated: needs you and no approved plan covers them (or the plan left them out) · assisted: an approved
 * plan covers them · checkin: affected, check on them · safe: nothing flagged. */
export type RaStatus = 'escalated' | 'assisted' | 'checkin' | 'safe'

export const STATUS_LABEL: Record<RaStatus, string> = { escalated: 'Escalated', assisted: 'Assisted', checkin: 'Check-in due', safe: 'Safe' }

// The planner's situation codes (backend/haven/world/cascade.py `_resident_impacts`), said plainly.
const SITUATION: Record<string, string> = {
  stranded: 'no step-free way out',
  medication_at_risk: 'medication needs a powered fridge',
  device_power_lost: 'a powered device has lost power',
  stairs_only_slow: 'slow on stairs with the lifts down',
  needs_escort: 'needs an escort in the dark',
  needs_visual_alert: 'needs a light, not a knock',
  power_lost: 'no power in their room',
  away: 'away from the building',
}
export const situationLabel = (code: string) => SITUATION[code] ?? code.replaceAll('_', ' ')
// Most serious first: who cannot get out, then a body that depends on power, then medicine, then the rest.
const WEIGHT = ['stranded', 'device_power_lost', 'medication_at_risk', 'needs_escort', 'stairs_only_slow', 'needs_visual_alert', 'power_lost']
const gravity = (codes: string[]) => Math.min(9, ...codes.map((c) => (WEIGHT.includes(c) ? WEIGHT.indexOf(c) : 8)))

export interface ResidentRow {
  id: string
  name: string
  room: string | null
  level: string
  status: RaStatus
  situation: string[]
  now: boolean
  leftBehind: boolean
}

export interface Hero {
  person: ResidentRow
  badge: string
  text: string
  /** This RA's step of the plan that names the resident, if there is one. */
  task: IncidentTask | null
  /** Why "Confirm" cannot be pressed, or '' when it can. */
  confirmBlocked: string
}

export interface Update {
  id: string
  kind: 'escalation' | 'step' | 'request' | 'notice' | 'done'
  title: string
  text: string
  at: string
}

export interface MapSpace {
  id: string
  name: string
  kind: string
  rect: Rect
  mark: 'hero' | 'flag' | 'lift' | 'lift-down' | null
}

export interface FloorMap {
  level: string
  label: string
  box: Rect
  spaces: MapSpace[]
  /** Dotted path from the hero's room to the nearest working lift, along the corridor. */
  route: { x: number; y: number }[] | null
  note: string
}

export interface RaView {
  name: string
  first: string
  building: string
  floors: string
  levels: string[]
  residentCount: number
  attention: number
  incident: boolean
  hero: Hero | null
  residents: ResidentRow[]
  updates: Update[]
  map: FloorMap | null
}

const RANK: Record<RaStatus, number> = { escalated: 0, assisted: 1, checkin: 2, safe: 3 }
const by = <T,>(f: (t: T) => number | string) => (a: T, b: T) => {
  const x = f(a)
  const y = f(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function floorsLabel(snap: Snapshot, levels: string[]) {
  const named = snap.building.levels.filter((l) => levels.includes(l.id))
  if (named.length <= 1) return named[0]?.name ?? 'Your floors'
  return `Floors ${named.map((l) => l.short).join(' and ')}`
}

export function raView(snap: Snapshot, mapLevel?: string): RaView {
  const { viewer, incident, building } = snap
  const levels = viewer.levels
  const approved = incident.approved

  const flagged = new Map(
    incident.people.map((p) => {
      // priority covers the forecast too: someone the water will strand needs the RA before it arrives.
      const status: RaStatus = p.left_behind || (p.priority && !approved) ? 'escalated' : p.priority ? 'assisted' : 'checkin'
      return [p.id, { id: p.id, name: p.name, room: p.room, level: p.level, status, situation: p.situation, now: p.now, leftBehind: p.left_behind } as ResidentRow]
    }),
  )
  // Everyone who lives on these floors (the team list carries residents without rooms; flagged ones have theirs).
  const roster = snap.team.filter((t) => t.role === 'resident' && levels.includes(t.level))
  const residents: ResidentRow[] = [
    ...flagged.values(),
    ...roster.filter((t) => !flagged.has(t.id)).map((t) => ({ id: t.id, name: t.name, room: null, level: t.level, status: 'safe' as const, situation: [], now: false, leftBehind: false })),
  ].sort(by((r) => `${RANK[r.status]}${gravity(r.situation)}${r.now ? 0 : 1}${r.name}`))

  const top = residents.find((r) => r.status !== 'safe') ?? null
  let hero: Hero | null = null
  if (top) {
    const task = incident.tasks.find((t) => t.title.includes(top.name)) ?? null
    const first = top.name.split(' ')[0]
    const said = top.situation.filter((c) => c !== 'power_lost').map(situationLabel)
    const why = said.length ? said : top.situation.map(situationLabel)
    const coverage = top.leftBehind
      ? `The plan assigns nobody to ${first} yet.`
      : top.status === 'escalated'
        ? `No plan is approved yet. Check in with ${first}.`
        : top.status === 'assisted'
          ? `The approved plan covers ${first}. Check in and confirm.`
          : `Check in with ${first}.`
    hero = {
      person: top,
      badge: `${STATUS_LABEL[top.status]}${why[0] ? ` · ${why[0]}` : ''}`,
      text: [task?.reason, `${first} ${why.length ? `has ${why.length > 1 ? 'these needs' : 'this need'} tonight: ${why.join('; ')}.` : 'is affected tonight.'}`, coverage]
        .filter(Boolean)
        .join(' '),
      task,
      confirmBlocked: !task
        ? `No step of the plan names you for ${first}.`
        : !approved
          ? 'The plan is waiting for approval.'
          : task.status === 'done'
            ? 'Already confirmed.'
            : '',
    }
  }

  const updates: Update[] = [
    ...residents
      .filter((r) => r.status === 'escalated')
      .map((r) => ({ id: `esc:${r.id}`, kind: 'escalation' as const, title: `Escalation · ${r.name}`, text: [r.room, ...r.situation.map(situationLabel)].filter(Boolean).join(' · '), at: '' })),
    ...incident.tasks.map((t) => ({
      id: `task:${t.id}`,
      kind: t.status === 'done' ? ('done' as const) : ('step' as const),
      title: t.status === 'done' ? 'Step confirmed' : t.status === 'assigned' ? 'Your step' : 'Proposed step',
      text: t.title,
      at: '',
    })),
    ...snap.requests.map((r) => {
      const last = r.history[r.history.length - 1]
      return { id: `req:${r.id}`, kind: 'request' as const, title: r.title, text: last ? `${last.action.replaceAll('_', ' ')}${last.text ? ` · ${last.text}` : ''}` : r.status.replaceAll('_', ' '), at: r.updated_at }
    }),
    ...snap.inbox.filter((n) => !n.id.startsWith('incident:')).map((n) => ({ id: n.id, kind: 'notice' as const, title: n.title, text: n.text, at: n.created_at })),
  ].sort((a, b) => (a.at ? 1 : 0) - (b.at ? 1 : 0) || b.at.localeCompare(a.at))

  return {
    name: viewer.name,
    first: viewer.name.split(' ')[0],
    building: building.name,
    floors: floorsLabel(snap, levels),
    levels,
    residentCount: roster.length,
    attention: residents.filter((r) => r.status === 'escalated' || r.status === 'assisted').length,
    incident: incident.active,
    hero,
    residents,
    updates,
    map: floorMap(snap, mapLevel ?? hero?.person.level ?? levels[0], hero?.person ?? null, residents),
  }
}

const centre = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 })
const area = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0)

export function floorMap(snap: Snapshot, level: string | undefined, hero: ResidentRow | null, residents: ResidentRow[]): FloorMap | null {
  if (!level) return null
  const here = snap.building.spaces.filter((s) => s.level === level && ['room', 'corridor', 'lift', 'stair', 'lounge', 'study', 'kitchen', 'laundry', 'bathroom'].includes(s.kind))
  if (!here.length) return null
  const flaggedRooms = new Set(residents.filter((r) => r.status !== 'safe' && r.level === level && r.room).map((r) => r.room))
  // Lift cars on this level are named after their shaft; the live status is on the shaft's equipment.
  const liftStatus = new Map(snap.building.equipment.map((e) => [e.name, e.status]))
  const spaces: MapSpace[] = here.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    rect: s.rect,
    mark:
      hero && s.kind === 'room' && s.name === hero.room
        ? 'hero'
        : s.kind === 'room' && flaggedRooms.has(s.name)
          ? 'flag'
          : s.kind === 'lift'
            ? liftStatus.get(s.name) === 'online'
              ? 'lift'
              : 'lift-down'
            : null,
  }))
  const box = here.reduce((b, s) => ({ x0: Math.min(b.x0, s.rect.x0), y0: Math.min(b.y0, s.rect.y0), x1: Math.max(b.x1, s.rect.x1), y1: Math.max(b.y1, s.rect.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
  const label = snap.building.levels.find((l) => l.id === level)?.name ?? level

  const heroSpace = spaces.find((s) => s.mark === 'hero')
  let route: FloorMap['route'] = null
  let note = hero ? '' : 'Nobody on this floor needs you right now.'
  if (heroSpace) {
    const lifts = spaces.filter((s) => s.mark === 'lift')
    const corridors = spaces.filter((s) => s.kind === 'corridor')
    const from = centre(heroSpace.rect)
    const lift = lifts.sort((a, b) => Math.hypot(centre(a.rect).x - from.x, centre(a.rect).y - from.y) - Math.hypot(centre(b.rect).x - from.x, centre(b.rect).y - from.y))[0]
    if (lift) {
      const to = centre(lift.rect)
      // Along the corridor nearest the room: out of the door, down the corridor, into the lobby.
      const hall = corridors.sort((a, b) => Math.abs(centre(a.rect).y - from.y) + Math.abs(centre(a.rect).x - from.x) - (Math.abs(centre(b.rect).y - from.y) + Math.abs(centre(b.rect).x - from.x)))[0]
      const wide = hall && hall.rect.x1 - hall.rect.x0 >= hall.rect.y1 - hall.rect.y0
      const c = hall ? centre(hall.rect) : null
      route = !c ? [from, to] : wide ? [from, { x: from.x, y: c.y }, { x: to.x, y: c.y }, to] : [from, { x: c.x, y: from.y }, { x: c.x, y: to.y }, to]
      note = `${hero!.room} → ${lift.name}`
    } else {
      note = `Every lift is out of service: ${hero!.name.split(' ')[0]} shelters in ${hero!.room}.`
    }
  }
  // Big shared spaces first so rooms and lifts draw on top.
  spaces.sort(by((s) => -area(s.rect)))
  return { level, label, box, spaces, route, note }
}
