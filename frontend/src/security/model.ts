import type { ActorStatus, BuildingSpec, PlanStep, Rect, ResidentImpact, WorldState } from '../state/types'

/**
 * Everything the dispatch dashboard shows, as a pure function of the live world (the admin's /ws frames) and
 * the building spec. Nothing here decides who is in danger or what to do: the impact and the forecast say who,
 * the plan says how, the actors say who is moving. This file ranks the escalations, finds the nearest
 * step-free entrance for responders, and lays out the footprint.
 */

export type Status = 'escalated' | 'assisted'

export interface Escalation {
  id: string
  name: string
  room: string
  roomId: string
  level: string
  levelName: string
  status: Status
  leftBehind: boolean
  now: boolean
  title: string
  /** "sheltering at Room 412", "being escorted to Main lobby". */
  where: string
  stepFree: boolean
  stranded: boolean
  step: PlanStep | null
}

export interface Exit {
  id: string
  x: number
  y: number
  label: string
  side: 'North' | 'South' | 'East' | 'West'
  /** The space behind the door, e.g. "Stiles hall". */
  place: string
  stepFree: boolean
}

export interface SiteMap {
  box: Rect
  footprint: Rect[]
  exits: Exit[]
  entrance: Exit | null
  refuge: { x: number; y: number; label: string } | null
  route: { x: number; y: number }[] | null
  /** Where responders arrive from, just outside the chosen door. */
  unit: { x: number; y: number } | null
  lifts: { x: number; y: number; down: boolean }[]
}

/** The hero's facts, in the order the info line says them. */
export interface Brief {
  liftsDown: boolean
  need: string
  entrance: string | null
  responder: string
  noSelfRoute: boolean
}

export interface QueueRow {
  id: string
  kind: 'person' | 'hazard' | 'entrance'
  title: string
  sub: string
  tag: 'critical' | 'assisted' | 'monitor' | 'clear'
}

export interface SecurityView {
  incident: boolean
  approved: boolean
  planVersion: number
  /** Why the plan cannot be approved from here, or '' when it can. */
  dispatchBlocked: string
  active: number
  hero: Escalation | null
  brief: Brief | null
  map: SiteMap | null
  queue: QueueRow[]
}

const MOVES = new Set(['escort', 'relocate', 'shelter'])
const KIND_TITLE: Record<string, string> = { escort: 'Assisted evacuation', relocate: 'Relocation', shelter: 'Shelter in place' }
const KIND_SHORT: Record<string, string> = { escort: 'assisted evac', relocate: 'relocation', shelter: 'shelter in place' }
const DOING: Record<ActorStatus, string> = { moving: 'is on the way', done: 'has finished their step', idle: 'is assigned', offsite: 'is off site' }

const centre = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 })

/** The building's street doors, named by the side they stand on and the space behind them. */
export function exitsOf(spec: BuildingSpec): Exit[] {
  const xs = spec.footprint.flatMap((r) => [r.x0, r.x1])
  const ys = spec.footprint.flatMap((r) => [r.y0, r.y1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const names = new Map(spec.spaces.map((s) => [s.id, s]))
  return spec.openings
    .filter((o) => o.kind === 'exit')
    .map((o) => {
      const d = { South: o.y - y0, North: y1 - o.y, West: o.x - x0, East: x1 - o.x }
      const side = (Object.entries(d).sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'South') as Exit['side']
      const place = names.get(o.a === 'outside' ? o.b : o.a)?.name ?? o.id
      return { id: o.id, x: o.x, y: o.y, label: `${side} entrance · ${place}`, side, place, stepFree: o.step_free }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function securityView(world: WorldState, spec: BuildingSpec | null): SecurityView {
  const plan = world.approved_plan ?? world.plan
  const approved = !!world.approved_plan
  const incident = world.narrative.stage !== 'quiet'
  const spaces = new Map((spec?.spaces ?? []).map((s) => [s.id, s]))
  const levelName = new Map((spec?.levels ?? []).map((l) => [l.id, l.name]))
  const place = (id: string | null | undefined) => (id ? (spaces.get(id)?.name ?? id) : '')

  // Life safety: whoever is critical now, or will be if nobody acts (the forecast).
  const now = new Set(world.impact.residents.filter((r) => r.severity === 'critical').map((r) => r.id))
  const critical = new Map<string, ResidentImpact>()
  for (const r of [...world.impact.residents, ...world.forecast.impact.residents]) if (r.severity === 'critical' && !critical.has(r.id)) critical.set(r.id, r)

  const escalations: Escalation[] = [...critical.values()]
    .map((r) => {
      const step = plan.steps.find((s) => MOVES.has(s.kind) && s.people.includes(r.id)) ?? null
      const leftBehind = plan.left_behind.includes(r.id)
      const status: Status = approved && step && !leftBehind ? 'assisted' : 'escalated'
      const lv = levelName.get(r.level) ?? r.level
      const at = world.moved[r.id]
      const where = at
        ? `now at ${place(at)}`
        : !step
          ? `in ${place(r.room)}`
          : step.kind === 'shelter'
          ? `sheltering at ${place(step.target) || place(r.room)}`
          : `being escorted to ${place(step.target)}`
      return {
        id: r.id,
        name: r.name,
        room: place(r.room),
        roomId: r.room,
        level: r.level,
        levelName: lv,
        status,
        leftBehind,
        now: now.has(r.id),
        title: `${step ? KIND_TITLE[step.kind] : 'Escalation'} · ${lv}`,
        where,
        stepFree: r.needs.includes('step_free_route'),
        stranded: r.impacts.includes('stranded'),
        step,
      }
    })
    // Whoever still needs a dispatch decision first (left out of the plan, then not yet covered), then who cannot get out.
    .sort((a, b) => Number(b.leftBehind) - Number(a.leftBehind) || Number(b.status === 'escalated') - Number(a.status === 'escalated') || Number(b.stranded) - Number(a.stranded) || Number(b.now) - Number(a.now) || a.name.localeCompare(b.name))

  const hero = escalations[0] ?? null
  const exits = spec ? exitsOf(spec) : []
  const liftsDown = world.impact.lifts_down.length > 0
  const room = hero ? spaces.get(hero.roomId) : undefined
  const from = room ? centre(room.rect) : null
  const entrance = from
    ? ([...exits.filter((e) => e.stepFree)].sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0] ?? null)
    : null

  const on = hero ? Object.values(world.actors).filter((a) => hero.step && a.step_id === hero.step.id) : []
  const brief: Brief | null = hero
    ? {
        liftsDown,
        need: hero.stepFree ? (liftsDown ? 'step-free assisted evacuation' : 'step-free route out') : hero.stranded ? 'assisted evacuation' : 'responder check',
        entrance: entrance ? `${entrance.side} entrance (${entrance.place})` : null,
        responder: on.length
          ? on.map((a) => `${a.label} ${DOING[a.status]}`).join('; ')
          : !hero.step
            ? 'The plan names nobody for this person yet'
            : !approved
              ? 'Nobody moves until the plan is approved'
              : `Assigned to ${hero.step.actor.split(',').join(', ')}`,
        noSelfRoute: hero.stranded,
      }
    : null

  const lifts = (spec?.equipment ?? [])
    .filter((e) => e.kind === 'lift')
    .map((e) => ({ x: e.x, y: e.y, down: world.equipment[e.id]?.status !== 'online' }))
  const map: SiteMap | null = spec
    ? {
        box: map0(spec),
        footprint: spec.footprint,
        exits,
        entrance,
        refuge: from && hero ? { ...from, label: `${hero.room} · ${hero.levelName}` } : null,
        unit: entrance ? outside(entrance, map0(spec)) : null,
        route: from && entrance ? [outside(entrance, map0(spec)), { x: entrance.x, y: entrance.y }, { x: entrance.x, y: from.y }, from] : null,
        lifts,
      }
    : null

  const wet = new Set(world.wet_spaces)
  const flooded = Object.entries(world.equipment).filter(([, e]) => e.status === 'flooded')
  const facilitiesStep = (eid: string) => plan.steps.find((s) => s.target === eid && s.actor.includes('facilities'))
  const wetExits = exits.filter((e) => {
    const o = spec?.openings.find((x) => x.id === e.id)
    return o && (wet.has(o.a) || wet.has(o.b))
  })
  const queue: QueueRow[] = [
    ...escalations.map((e) => ({
      id: `p:${e.id}`,
      kind: 'person' as const,
      title: `${e.name} · ${e.step ? KIND_SHORT[e.step.kind] : 'escalation'}`,
      sub: `${e.levelName} · ${e.room}${e.leftBehind ? ' · nobody assigned' : !e.step ? ' · not in the plan' : ''}`,
      tag: (e.status === 'assisted' ? 'assisted' : 'critical') as QueueRow['tag'],
    })),
    ...flooded.map(([id]) => {
      const eq = spec?.equipment.find((x) => x.id === id)
      const s = facilitiesStep(id)
      return { id: `h:${id}`, kind: 'hazard' as const, title: `${eq?.name ?? id} hazard`, sub: `${s ? 'Facilities handling' : 'No facilities step yet'} · monitor`, tag: 'monitor' as const }
    }),
    ...(wetExits.length
      ? wetExits.map((e) => ({ id: `x:${e.id}`, kind: 'entrance' as const, title: `${e.label} · water at the door`, sub: 'Send responders another way', tag: 'monitor' as const }))
      : [{ id: 'x:all', kind: 'entrance' as const, title: 'Entrances clear of water', sub: `${exits.filter((e) => e.stepFree).length} step-free entrances`, tag: 'clear' as const }]),
  ]

  const failing = world.plan.checks.filter((c) => !c.ok)
  return {
    incident,
    approved,
    planVersion: world.plan.version,
    dispatchBlocked: approved
      ? 'Responders are dispatched: the plan is approved.'
      : !incident || !world.plan.steps.length
        ? 'There is no plan to dispatch.'
        : failing.length
          ? `A hard check fails: ${failing[0].label}.`
          : '',
    active: escalations.length,
    hero,
    brief,
    map,
    queue,
  }
}

const map0 = (spec: BuildingSpec) =>
  spec.footprint.reduce((b, r) => ({ x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })

/** A point a few metres out from a door, on the street side. */
function outside(e: Exit, box: Rect, m = 7) {
  return { North: { x: e.x, y: box.y1 + m }, South: { x: e.x, y: box.y0 - m }, East: { x: box.x1 + m, y: e.y }, West: { x: box.x0 - m, y: e.y } }[e.side]
}
