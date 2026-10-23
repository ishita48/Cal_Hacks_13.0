import { IMPACT_LABEL, NEED_LABEL } from '../lib/labels'
import type { ActorState, Check, Equipment, Level, OpsFinding, OpsSnapshot, Plan, PlanStep, Rect, Resident, ResidentImpact, Space, StepKind, TimelineEntry, WorldState } from '../state/types'

/**
 * The workstation's reading of the world: pure functions over the frame, the spec and the ops snapshot, so
 * the panel and the tests see the same facts. Nothing here is invented: a count is a count of something the
 * world carries, a step is a plan step, an acknowledgement is an action the backend recorded.
 */

// ---- the one status line --------------------------------------------------------------------------

export type Health = 'healthy' | 'attention' | 'emergency' | 'checking'

export interface Status {
  health: Health
  label: string
  /** One sentence: why the status is what it is. */
  why: string
}

/** Healthy, Attention needed or Emergency: an incident decides it; on a quiet night the maintenance log does. */
export function buildingStatus(world: WorldState, ops: OpsSnapshot | null): Status {
  const stage = world.narrative.stage
  const approved = world.approved_plan
  if (stage !== 'quiet') {
    if (approved?.status === 'done') return { health: 'attention', label: 'Attention needed', why: 'The incident is resolved; close it when the building is back to normal.' }
    const severe = isEmergency(world)
    return {
      health: severe ? 'emergency' : 'attention',
      label: severe ? 'Emergency' : 'Attention needed',
      why: approved ? 'HAVEN is carrying out the plan you approved.' : world.plan.status === 'draft' ? 'A response plan is waiting for your approval.' : 'HAVEN is working out what fails next.',
    }
  }
  if (!ops) return { health: 'checking', label: 'Checking', why: 'Reading the maintenance log.' }
  const s = ops.summary
  if (s.critical_findings > 0 || s.overdue > 0) {
    const parts = [s.overdue ? `${s.overdue} plant item${s.overdue === 1 ? '' : 's'} overdue for service` : null, s.critical_findings ? `${s.critical_findings} critical finding${s.critical_findings === 1 ? '' : 's'} from the resilience audit` : null].filter(Boolean)
    return { health: 'attention', label: 'Attention needed', why: `No incident. ${parts.join(' and ')}.` }
  }
  return { health: 'healthy', label: 'Healthy', why: 'No incident, and no maintenance is overdue.' }
}

/** An emergency is an incident that hurts someone or takes out the lifts; anything less needs attention. */
export function isEmergency(world: WorldState): boolean {
  const critical = (rs: ResidentImpact[]) => rs.some((r) => r.severity === 'critical')
  return critical(world.impact.residents) || critical(world.forecast.impact.residents) || world.impact.lifts_down.length > 0 || world.forecast.impact.lifts_down.length > 0 || world.forecast.events.some((e) => e.severity === 'critical')
}

export function greeting(timeOfDay: number): string {
  const h = Math.floor((timeOfDay % 86400) / 3600)
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

// ---- the incident --------------------------------------------------------------------------------

export interface Incident {
  type: string
  location: string
  severity: 'Emergency' | 'Minor'
}

/** What kind of incident, and where: an active leak and its room, or the power source that failed. */
export function incidentInfo(world: WorldState, spaces: Record<string, Space>, equipment: Record<string, Equipment>, levels: Record<string, Level>): Incident | null {
  if (world.narrative.stage === 'quiet') return null
  const severity = isEmergency(world) ? 'Emergency' : 'Minor'
  const where = (sid: string | undefined) => {
    const s = sid ? spaces[sid] : undefined
    return s ? `${s.name}, ${levels[s.level]?.name ?? s.level}` : 'the building'
  }
  const leak = Object.entries(world.leaks).find(([, l]) => l.active) ?? Object.entries(world.leaks)[0]
  if (leak) return { type: 'Water leak', location: where(leak[1].space), severity }
  const failed = (kind: string) => Object.values(equipment).find((e) => e.kind === kind && ['offline', 'flooded', 'isolated'].includes(world.equipment[e.id]?.status ?? 'online'))
  const grid = failed('utility_feed')
  if (grid) return { type: 'Power cut from the grid', location: where(grid.space), severity }
  const gen = failed('generator')
  if (gen) return { type: 'Standby generator failure', location: where(gen.space), severity }
  return { type: 'Incident', location: 'the building', severity }
}

// ---- the response, in a few steps ------------------------------------------------------------------

export interface Phase {
  id: string
  title: string
  steps: PlanStep[]
  done: number
}

const PHASES: { id: string; title: string; kinds: StepKind[] }[] = [
  { id: 'safe', title: 'Make the building safe', kinds: ['call', 'valve', 'isolate', 'hold'] },
  { id: 'help', title: 'Help the people who need it first', kinds: ['escort', 'shelter', 'move_item'] },
  { id: 'move', title: 'Move and tell everyone else', kinds: ['relocate', 'notify'] },
  { id: 'report', title: 'Report it', kinds: ['ticket'] },
]

/** The plan's steps grouped into the 2-4 things a manager needs to know are happening; every step lands in one. */
export function phases(plan: Plan, actions: WorldState['actions']): Phase[] {
  const out = PHASES.map((p) => ({ id: p.id, title: p.title, steps: plan.steps.filter((s) => p.kinds.includes(s.kind)), done: 0 }))
  const placed = new Set(out.flatMap((p) => p.steps.map((s) => s.id)))
  const rest = plan.steps.filter((s) => !placed.has(s.id))
  if (rest.length) out[out.length - 1].steps.push(...rest)
  for (const p of out) {
    p.steps.sort((a, b) => a.order - b.order)
    p.done = p.steps.filter((s) => actions[s.id]?.status === 'done').length
  }
  return out.filter((p) => p.steps.length > 0)
}

export function actorName(actor: string, actors: WorldState['actors']): string {
  if (actor === 'haven') return 'HAVEN'
  if (actor === 'housing') return 'Housing'
  return actor
    .split(',')
    .map((a) => actors[a]?.label.replace(/\s*\(.*\)/, '') ?? a)
    .join(', ')
}

/** Who on the maintenance side is asked to do what: the plumber's and facilities' steps. */
export function maintenance(plan: Plan, actors: WorldState['actors']): { id: string; who: string; what: string }[] {
  return plan.steps
    .filter((s) => s.actor === 'plumber' || s.actor === 'facilities' || s.kind === 'valve' || s.kind === 'isolate')
    .map((s) => ({ id: s.id, who: actorName(s.actor, actors), what: s.title }))
}

/** The RAs and where each stands: free at their post, on a step, done, or off site. */
export function raAvailability(actors: WorldState['actors']): { id: string; label: string; status: ActorState['status'] }[] {
  return Object.values(actors)
    .filter((a) => a.label.startsWith('RA'))
    .map((a) => ({ id: a.actor, label: a.label, status: a.status }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// ---- who needs help ---------------------------------------------------------------------------------

export interface NeedsHelp {
  id: string
  name: string
  level: string
  room: string
  severity: 'critical' | 'warning'
  needs: string
  why: string
  contact: string
  /** left behind and moved are the world's facts; covered = named in a step; affected = flagged, not named in a step (steps that reach hundreds list only a sample, so this is not 'unhelped'). */
  state: 'left' | 'moved' | 'covered' | 'affected'
  named: boolean
}

let languageNames: Intl.DisplayNames | null = null
function language(code: string): string {
  try {
    languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' })
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}

/**
 * The people who need help now (or, before the water reaches anything, the ones the forecast says will),
 * the hardest first, with their needs, how they want to be reached, and whether the plan covers them.
 */
export function needingHelp(world: WorldState, storyIds: string[]): { people: NeedsHelp[]; predicted: boolean } {
  const now = world.impact.residents.filter((r) => r.severity !== 'info')
  const predicted = now.length === 0
  const src = predicted ? world.forecast.impact.residents.filter((r) => r.severity !== 'info') : now
  const plan = world.approved_plan ?? world.plan
  const covered = new Set(plan.steps.flatMap((s) => s.people))
  const left = new Set(world.plan.left_behind)
  const story = new Set(storyIds)
  const people = src.map<NeedsHelp>((r) => ({
    id: r.id,
    name: r.name,
    level: r.level,
    room: r.room,
    severity: r.severity === 'critical' ? 'critical' : 'warning',
    needs: r.needs.map((n) => NEED_LABEL[n] ?? n.replace(/_/g, ' ')).join(', '),
    why: r.impacts.filter((i) => i !== 'power_lost').map((i) => IMPACT_LABEL[i] ?? i.replace(/_/g, ' ')).join(' · ') || IMPACT_LABEL.power_lost,
    contact: `${r.channel === 'call' ? 'call' : r.channel === 'sms' ? 'text' : r.channel}, ${language(r.lang)}`,
    state: left.has(r.id) ? 'left' : world.moved[r.id] ? 'moved' : covered.has(r.id) ? 'covered' : 'affected',
    named: story.has(r.id),
  }))
  const rank = (p: NeedsHelp) => (p.state === 'left' ? 0 : p.severity === 'critical' ? 1 : 2) * 2 + (p.named ? 0 : 1)
  people.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  return { people, predicted }
}

// ---- progress once approved ---------------------------------------------------------------------------

export interface Progress {
  done: PlanStep[]
  assigned: PlanStep[]
  waiting: PlanStep[]
  failed: PlanStep[]
  /** Recorded acknowledgements: what the backend says happened, newest first. */
  acks: { id: string; title: string; detail: string; step: number }[]
}

export function progress(world: WorldState): Progress | null {
  const plan = world.approved_plan
  if (!plan) return null
  const by = (st: string) => plan.steps.filter((s) => world.actions[s.id]?.status === st)
  const acks = plan.steps
    .map((s) => ({ s, a: world.actions[s.id] }))
    .filter(({ a }) => a && a.status !== 'assigned' && a.detail)
    .map(({ s, a }) => ({ id: s.id, title: s.title, detail: a!.detail, step: a!.step }))
    .sort((x, y) => y.step - x.step)
  return { done: by('done'), assigned: by('assigned'), failed: by('failed'), waiting: plan.steps.filter((s) => !world.actions[s.id]), acks }
}

// ---- incident command: what the plan does for people, and whether it may be approved ---------------------

export interface Outcomes {
  /** At home and needing nothing from the plan. */
  safe: number
  /** Escorted, relocated or sheltered by a step (the step's own head count, not its sample of names). */
  assisted: number
  /** The plan's own left-behind list: someone with a critical need nobody covered. */
  unresolved: number
  /** Hard checks the plan fails: safety, access, the manager's rules, capacity. */
  violations: Check[]
  /** The backend approves only a plan with steps and no failing check; so does this. */
  feasible: boolean
}

const ASSISTS = new Set<StepKind>(['escort', 'relocate', 'shelter'])

export function outcomes(plan: Plan, home: number): Outcomes {
  const assisted = plan.steps.filter((s) => ASSISTS.has(s.kind)).reduce((n, s) => n + Math.max(s.count, s.people.length), 0)
  const unresolved = plan.left_behind.length
  const violations = plan.checks.filter((c) => !c.ok)
  return { safe: Math.max(0, home - assisted - unresolved), assisted, unresolved, violations, feasible: plan.steps.length > 0 && violations.length === 0 }
}

export interface LedgerRow {
  step: number
  at: number
  kind: string
  severity: TimelineEntry['severity']
  message: string
}

/** The after-action ledger: the world's own timeline, oldest first so the newest reads last. */
export function ledger(world: WorldState, clock: { step: number; time_of_day: number; dt: number }, limit = 40): LedgerRow[] {
  return world.timeline.slice(-limit).map((t) => ({ step: t.step, at: clock.time_of_day - (clock.step - t.step) * clock.dt, kind: t.kind, severity: t.severity, message: t.message }))
}

export function residentsHere(residents: Record<string, Resident>): number {
  return Object.values(residents).filter((r) => r.role === 'resident' && r.presence !== 'away').length
}

// ---- wings: read off the footprint's shape, not typed in ------------------------------------------------

export type WingId = 'north' | 'south' | 'east' | 'west'
export interface Wing {
  id: WingId
  name: string
  rects: Rect[]
}

const WING_NAME: Record<WingId, string> = { north: 'North wing', south: 'South wing', east: 'East wing', west: 'West wing' }

/**
 * The spec has no wing names, so a wing is each footprint rectangle named by the side of the building it
 * stands on (its centre's offset from the building's centre, scaled by the building's half-extent; the larger
 * axis wins). Rectangles on the same side form one wing. A one-rectangle building has no wings.
 */
export function wingsOf(footprint: Rect[]): Wing[] {
  if (footprint.length < 2) return []
  const x0 = Math.min(...footprint.map((r) => r.x0)), x1 = Math.max(...footprint.map((r) => r.x1))
  const y0 = Math.min(...footprint.map((r) => r.y0)), y1 = Math.max(...footprint.map((r) => r.y1))
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 || 1, hy = (y1 - y0) / 2 || 1
  const by = new Map<WingId, Rect[]>()
  for (const r of footprint) {
    const dx = ((r.x0 + r.x1) / 2 - cx) / hx
    const dy = ((r.y0 + r.y1) / 2 - cy) / hy
    const id: WingId = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'east' : 'west') : dy >= 0 ? 'north' : 'south'
    by.set(id, [...(by.get(id) ?? []), r])
  }
  const order: WingId[] = ['east', 'west', 'north', 'south']
  return order.filter((id) => by.has(id)).map((id) => ({ id, name: WING_NAME[id], rects: by.get(id)! }))
}

/** Which wing a point stands in: the first footprint rectangle that holds it (corners belong to the first). */
export function wingAt(x: number, y: number, footprint: Rect[], wings: Wing[]): WingId | null {
  const r = footprint.find((f) => x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1)
  if (!r) return null
  return wings.find((w) => w.rects.includes(r))?.id ?? null
}

export function wingOfSpace(space: Space | undefined, footprint: Rect[], wings: Wing[]): WingId | null {
  if (!space) return null
  return wingAt((space.rect.x0 + space.rect.x1) / 2, (space.rect.y0 + space.rect.y1) / 2, footprint, wings)
}

// ---- the routine check: what the building's own instruments say right now ---------------------------------

export interface CheckLine {
  id: string
  label: string
  value: string
  ok: boolean
}

/** A routine inspection read from the world and the maintenance log: sensors, power, lifts, leaks, plant, audit. */
export function routineCheck(world: WorldState, ops: OpsSnapshot, sensorIds: string[] = Object.keys(world.sensors)): CheckLine[] {
  // A probe reports on every wet/dry crossing: one that has not reported yet has never been wet.
  const ids = [...new Set([...sensorIds, ...Object.keys(world.sensors)])]
  const wet = ids.filter((id) => world.sensors[id]?.wet).length
  const floors = Object.values(world.power.levels)
  const powered = floors.filter(Boolean).length
  const lifts = Object.values(world.power.lifts)
  const running = lifts.filter(Boolean).length
  const leaks = Object.values(world.leaks).filter((l) => l.active).length
  const s = ops.summary
  return [
    { id: 'sensors', label: 'Water sensors', value: ids.length === 0 ? 'none installed' : wet ? `${wet} of ${ids.length} wet` : `${ids.length} of ${ids.length} dry`, ok: wet === 0 },
    { id: 'power', label: 'Power', value: `${powered} of ${floors.length} floors on`, ok: powered === floors.length },
    { id: 'lifts', label: 'Lifts', value: `${running} of ${lifts.length} running`, ok: running === lifts.length },
    { id: 'leaks', label: 'Pipes', value: leaks ? `${leaks} active leak${leaks === 1 ? '' : 's'}` : 'no leaks', ok: leaks === 0 },
    { id: 'plant', label: 'Plant service', value: s.overdue ? `${s.overdue} of ${s.plant} items overdue` : `all ${s.plant} items in date`, ok: s.overdue === 0 },
    { id: 'audit', label: 'Resilience audit', value: s.critical_findings ? `${s.critical_findings} critical finding${s.critical_findings === 1 ? '' : 's'}` : 'no critical findings', ok: s.critical_findings === 0 },
  ]
}

/** Today's checklist from the audit: every finding not yet closed, critical first. */
export function checklist(ops: OpsSnapshot): OpsFinding[] {
  const rank = { critical: 0, serious: 1, warning: 2 } as const
  return [...ops.findings].sort((a, b) => Number(a.work_order?.status === 'done') - Number(b.work_order?.status === 'done') || rank[a.severity] - rank[b.severity])
}
