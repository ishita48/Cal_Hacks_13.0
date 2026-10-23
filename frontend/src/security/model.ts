import type { ActorState, BuildingSpec, PlanStep, Rect, ResidentImpact, WorldState } from '../state/types'

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
  stepFree: boolean
}

export interface SiteMap {
  box: Rect
  footprint: Rect[]
  exits: Exit[]
  entrance: Exit | null
  refuge: { x: number; y: number; label: string } | null
  route: { x: number; y: number }[] | null
  lifts: { x: number; y: number; down: boolean }[]
}

export interface QueueRow {
  id: string
  kind: 'person' | 'hazard' | 'entrance'
  title: string
  sub: string
  tag: 'critical' | 'assisted' | 'monitor' | 'clear'
}

export interface Unit {
  id: string
  label: string
  status: string
  tone: 'moving' | 'done' | 'idle' | 'offsite'
  sub: string
}

export interface SecurityView {
  incident: boolean
  approved: boolean
  planVersion: number
  /** Why the plan cannot be approved from here, or '' when it can. */
  dispatchBlocked: string
  active: number
  hero: Escalation | null
  info: string[]
  responders: string[]
  map: SiteMap | null
  queue: QueueRow[]
  units: Unit[]
}

const MOVES = new Set(['escort', 'relocate', 'shelter'])
const KIND_TITLE: Record<string, string> = { escort: 'Assisted evacuation', relocate: 'Relocation', shelter: 'Shelter in place' }

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
      const side = (Object.entries(d).sort((a, b) => a[1] - b[1])[0]?.[0] ?? '') as string
      const inner = names.get(o.a === 'outside' ? o.b : o.a)
      return { id: o.id, x: o.x, y: o.y, label: `${side} entrance · ${inner?.name ?? o.id}`, stepFree: o.step_free, inner: inner?.kind }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ inner: _inner, ...e }) => e)
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

  const info: string[] = hero
    ? [
        liftsDown ? 'Elevators offline' : 'Elevators running',
        hero.stepFree ? (liftsDown ? 'needs step-free assisted evacuation' : 'needs a step-free route') : hero.stranded ? 'cannot get out alone' : 'needs a responder',
        entrance ? `nearest accessible entrance: ${entrance.label}` : '',
      ].filter(Boolean)
    : []

  const actorsOn = (step: PlanStep | null) => Object.values(world.actors).filter((a) => step && a.step_id === step.id)
  const responders = hero
    ? (() => {
        const on = actorsOn(hero.step)
        if (on.length) return on.map((a) => `${a.label} · ${statusWord(a)}${a.heading ? ` · to ${place(a.heading)}` : a.at ? ` · at ${place(a.at)}` : ''}`)
        if (!hero.step) return ['The plan names nobody for this person yet']
        if (!approved) return [`Planned: ${hero.step.title}. Nobody moves until the plan is approved.`]
        return [`Assigned: ${hero.step.actor.split(',').join(', ')}`]
      })()
    : []

  const lifts = (spec?.equipment ?? [])
    .filter((e) => e.kind === 'lift')
    .map((e) => ({ x: e.x, y: e.y, down: world.equipment[e.id]?.status !== 'online' }))
  const map: SiteMap | null = spec
    ? {
        box: spec.footprint.reduce((b, r) => ({ x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }),
        footprint: spec.footprint,
        exits,
        entrance,
        refuge: from && hero ? { ...from, label: `${hero.room} · ${hero.levelName}` } : null,
        route: from && entrance ? [{ x: entrance.x, y: entrance.y }, { x: entrance.x, y: from.y }, from] : null,
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
      title: `${e.name} · ${e.title.split(' · ')[0].toLowerCase()}`,
      sub: `${e.room} · ${e.levelName}${e.leftBehind ? ' · nobody assigned' : ''}`,
      tag: (e.status === 'assisted' ? 'assisted' : 'critical') as QueueRow['tag'],
    })),
    ...flooded.map(([id]) => {
      const eq = spec?.equipment.find((x) => x.id === id)
      const s = facilitiesStep(id)
      return { id: `h:${id}`, kind: 'hazard' as const, title: `${eq?.name ?? id} · water hazard`, sub: `${place(eq?.space)} · ${s ? 'facilities step in the plan' : 'no facilities step yet'}`, tag: 'monitor' as const }
    }),
    ...(wetExits.length
      ? wetExits.map((e) => ({ id: `x:${e.id}`, kind: 'entrance' as const, title: `${e.label} · water at the door`, sub: 'Send responders another way', tag: 'monitor' as const }))
      : [{ id: 'x:all', kind: 'entrance' as const, title: 'Entrances clear of water', sub: `${exits.filter((e) => e.stepFree).length} step-free entrances`, tag: 'clear' as const }]),
  ]

  const units: Unit[] = Object.values(world.actors)
    .map((a) => {
      const step = plan.steps.find((s) => s.id === a.step_id)
      return { id: a.actor, label: a.label, status: statusWord(a), tone: a.status, sub: [step?.title, a.heading ? `to ${place(a.heading)}` : a.at ? `at ${place(a.at)}` : ''].filter(Boolean).join(' · ') || 'No step assigned' }
    })
    .sort((a, b) => ['moving', 'done', 'idle', 'offsite'].indexOf(a.tone) - ['moving', 'done', 'idle', 'offsite'].indexOf(b.tone) || a.label.localeCompare(b.label))

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
    info,
    responders,
    map,
    queue,
    units,
  }
}

function statusWord(a: ActorState) {
  return { moving: 'En route', done: 'Done', idle: 'Available', offsite: 'Off site' }[a.status]
}
