import { NEED_LABEL } from '../lib/labels'
import type { ActorState, Clock, Equipment, Level, PlanStep, Resident, Space, WorldState } from '../state/types'

/**
 * What the stylized twin draws, derived from the one world state and the static spec. Pure functions,
 * so the cards and the scene read the same facts and the tests can check them without WebGL. Nothing
 * here invents a value: a fact the world does not carry is not shown.
 */

/** What the scene draws: the building at rest, its live status, its people, the response under way. */
export type Tab = 'building' | 'status' | 'people' | 'response'
/** What the person picks: the building (which shows status or the response by itself), or everyone in it. */
export type ViewTab = 'building' | 'people'

/** The Building tab follows the story: at rest when quiet, the live status in an incident, the response once approved. */
export function sceneMode(tab: ViewTab, world: WorldState): Tab {
  if (tab === 'people') return 'people'
  if (world.narrative.stage === 'quiet') return 'building'
  return world.approved_plan ? 'response' : 'status'
}

export type Tone = 'critical' | 'warning' | 'calm' | 'moved' | 'left' | 'safe'

export const TONE: Record<Tone, string> = {
  critical: '#ff7a6b',
  warning: '#ffb84d',
  calm: '#b9b4f0',
  moved: '#5fd4a0',
  left: '#9b6bff',
  safe: '#5fd4a0',
}

export const PALETTE = {
  wall: '#f1eee8',
  plate: '#cfc9be',
  room: '#c9a77f',
  corridor: '#b9bdc1',
  lift: '#9ea6ae',
  stair: '#a9aeb4',
  amenity: '#c8b593',
  service: '#bdb6aa',
  plant: '#a7abb0',
  lawn: '#6f9a57',
  water: '#2f7fc0',
  dark: '#e0574a',
  soon: '#f0a33a',
  glow: '#ffd9a0',
  route: '#38c98a',
  responder: '#5aa8ff',
}

// Floors as they are: timber in the rooms and lounges, stone in the lobby, tile in the wet rooms, grey plant.
const KIND_TINT: Record<string, string> = {
  room: PALETTE.room,
  corridor: PALETTE.corridor,
  lobby: '#d8d2c6',
  lounge: '#c4a27e',
  study: '#c9ae8a',
  kitchen: '#d9d5cc',
  bathroom: '#cfdde0',
  laundry: '#d0d6da',
  office: '#c7a986',
  retail: '#d3cbbd',
  amenity: PALETTE.amenity,
  storage: PALETTE.service,
  service: PALETTE.service,
  stair: PALETTE.stair,
  lift: PALETTE.lift,
  riser: PALETTE.plant,
  mechanical: PALETTE.plant,
  electrical: PALETTE.plant,
  generator: PALETTE.plant,
  courtyard: PALETTE.lawn,
}
export const kindTint = (kind: string) => KIND_TINT[kind] ?? PALETTE.room

export const centre = (s: Space): [number, number] => [(s.rect.x0 + s.rect.x1) / 2, (s.rect.y0 + s.rect.y1) / 2]

// ---- levels ------------------------------------------------------------------------------------

export interface LevelStatus {
  id: string
  dark: boolean
  soon: boolean
  water: number
  wetSpaces: number
}

/** Per level: dark now, dark if nothing is done, the deepest water and how many spaces are wet. */
export function levelStatus(world: WorldState, levels: Level[], spaces: Record<string, Space>): Record<string, LevelStatus> {
  const out: Record<string, LevelStatus> = {}
  const darkNow = new Set(world.impact.dark_levels)
  const darkSoon = new Set(world.forecast.impact.dark_levels)
  for (const lv of levels) out[lv.id] = { id: lv.id, dark: darkNow.has(lv.id), soon: !darkNow.has(lv.id) && darkSoon.has(lv.id), water: 0, wetSpaces: 0 }
  for (const [sid, w] of Object.entries(world.water)) {
    const s = spaces[sid]
    if (!s || !out[s.level] || w.depth < 0.005) continue
    out[s.level].water = Math.max(out[s.level].water, w.depth)
    out[s.level].wetSpaces++
  }
  return out
}

// ---- people ------------------------------------------------------------------------------------

export interface PersonMark {
  id: string
  name: string
  level: string
  x: number
  y: number
  tone: Tone
  named: boolean
  needs: string[]
  /** Plain words: what is true for this person right now. */
  status: string
  space: string
}

const NEED_ORDER = ['step_free_route', 'guide_dog', 'visual_alerts', 'stairs_slow', 'medical_device_power', 'refrigerated_medication']

export function needWords(needs: string[]): string {
  return [...needs].sort((a, b) => NEED_ORDER.indexOf(a) - NEED_ORDER.indexOf(b)).map((n) => NEED_LABEL[n] ?? n.replace(/_/g, ' ')).join(' · ')
}

/**
 * Everyone who is in the building, where they are now: their room, or where an executed step moved them.
 * The tone is the world's: flagged residents by severity, the plan's left-behind in violet, moved in mint,
 * everyone else a quiet lavender. People who are away are not drawn.
 */
export function peopleMarks(world: WorldState, residents: Record<string, Resident>, spaces: Record<string, Space>, storyIds: string[]): PersonMark[] {
  const flagged = new Map(world.impact.residents.map((r) => [r.id, r]))
  const left = new Set(world.plan.left_behind)
  const story = new Set(storyIds)
  const perSpace: Record<string, number> = {}
  const out: PersonMark[] = []
  for (const r of Object.values(residents)) {
    if (r.role !== 'resident' && !story.has(r.id)) continue
    const movedTo = world.moved[r.id]
    if (!movedTo && r.presence === 'away') continue
    const sid = movedTo ?? (r.presence === 'elsewhere' && r.location && spaces[r.location] ? r.location : r.room)
    const s = spaces[sid]
    if (!s) continue
    const k = perSpace[sid] ?? 0
    perSpace[sid] = k + 1
    const w = s.rect.x1 - s.rect.x0
    const h = s.rect.y1 - s.rect.y0
    const cols = Math.max(1, Math.floor((w - 0.6) / 0.9))
    const col = k % cols
    const row = Math.floor(k / cols)
    const x = cols === 1 ? s.rect.x0 + w / 2 : Math.min(s.rect.x1 - 0.45, s.rect.x0 + 0.75 + col * 0.9)
    const y = Math.min(s.rect.y1 - 0.45, s.rect.y0 + Math.min(h / 2, 0.9) + row * 0.9)
    const f = flagged.get(r.id)
    const tone: Tone = movedTo ? 'moved' : left.has(r.id) ? 'left' : f ? (f.severity === 'critical' ? 'critical' : f.severity === 'warning' ? 'warning' : 'calm') : 'calm'
    const status = movedTo
      ? `moved to ${s.name}`
      : left.has(r.id)
        ? 'left behind by this plan'
        : f
          ? f.impacts.includes('stranded')
            ? world.impact.routes[r.id]
              ? 'step-free route found'
              : 'no step-free way out'
            : f.impacts.includes('medication_at_risk')
              ? 'medication in a dead fridge'
              : f.impacts.includes('device_power_lost')
                ? 'medical device unpowered'
                : f.impacts.includes('needs_escort')
                  ? 'needs an escort'
                  : f.impacts.includes('stairs_only_slow')
                    ? 'stairs only, slowly'
                    : f.impacts.includes('needs_visual_alert')
                      ? 'needs a visual alert'
                      : f.impacts.includes('power_lost')
                        ? 'room is dark'
                        : 'fine'
          : 'fine'
    out.push({ id: r.id, name: r.name, level: s.level, x, y, tone, named: story.has(r.id), needs: r.needs, status, space: s.id })
  }
  return out
}

export interface RouteLine {
  id: string
  name: string
  points: { x: number; y: number; level: string }[]
}

/** The step-free routes the world found, as space centres in order (a change of level is a lift or stair ride). */
export function routeLines(world: WorldState, spaces: Record<string, Space>, residents: Record<string, Resident>): RouteLine[] {
  const out: RouteLine[] = []
  for (const [rid, path] of Object.entries(world.impact.routes)) {
    if (!path || world.moved[rid]) continue
    const points = path.map((sid) => spaces[sid]).filter((s): s is Space => !!s).map((s) => ({ x: centre(s)[0], y: centre(s)[1], level: s.level }))
    if (points.length > 1) out.push({ id: rid, name: residents[rid]?.name ?? rid, points })
  }
  return out
}

// ---- responders and the plan -----------------------------------------------------------------------

export interface ActorMark {
  id: string
  label: string
  status: ActorState['status']
  from: { x: number; y: number; level: string } | null
  to: { x: number; y: number; level: string } | null
  step: string | null
}

export function actorMarks(world: WorldState, spaces: Record<string, Space>): ActorMark[] {
  const out: ActorMark[] = []
  for (const a of Object.values(world.actors ?? {})) {
    const here = a.at ? spaces[a.at] : undefined
    const there = a.heading ? spaces[a.heading] : undefined
    if (!here && !there) continue
    const at = (s: Space | undefined) => (s ? { x: centre(s)[0], y: centre(s)[1], level: s.level } : null)
    out.push({ id: a.actor, label: a.label.replace(/\s*\(.*\)/, ''), status: a.status, from: at(here), to: at(there), step: a.step_id })
  }
  return out
}

export type StepState = 'done' | 'assigned' | 'failed' | 'proposed' | 'pending'

export interface StepBeacon {
  id: string
  order: number
  title: string
  kind: PlanStep['kind']
  state: StepState
  where: { x: number; y: number; level: string; name: string } | null
}

/** The plan on the map: each step with somewhere to stand gets a numbered beacon, coloured by its state. */
export function stepBeacons(world: WorldState, spaces: Record<string, Space>, equipment: Record<string, Equipment>, residents: Record<string, Resident>): StepBeacon[] {
  const plan = world.approved_plan ?? world.plan
  if (plan.status === 'none') return []
  const approved = world.approved_plan != null
  return plan.steps.map((st) => {
    const action = world.actions[st.id]
    const state: StepState = !approved ? 'proposed' : action ? action.status : 'pending'
    let where: StepBeacon['where'] = null
    const eq = st.target ? equipment[st.target] : undefined
    const sp = st.target ? spaces[st.target] : undefined
    if (eq) where = { x: eq.x, y: eq.y, level: eq.level, name: eq.name }
    else if (sp) where = { x: centre(sp)[0], y: centre(sp)[1], level: sp.level, name: sp.name }
    else {
      const person = st.people.map((p) => residents[p]).find((r) => r && spaces[r.room])
      if (person && (st.kind === 'escort' || st.kind === 'move_item' || st.kind === 'shelter' || st.kind === 'relocate')) {
        const s = spaces[person.room]
        where = { x: centre(s)[0], y: centre(s)[1], level: s.level, name: s.name }
      }
    }
    return { id: st.id, order: st.order, title: st.title, kind: st.kind, state, where }
  })
}

// ---- what happens next ---------------------------------------------------------------------------

export interface Upcoming {
  id: string
  message: string
  remaining: number
  equipment: string | null
}

/** The forecast's next failures, with the seconds left until each (the same arithmetic as the cascade panel). */
export function upcoming(world: WorldState, clock: Clock): Upcoming[] {
  const computedAt = world.forecast.computed_step * clock.dt
  return world.forecast.events
    .filter((e) => e.severity !== 'info')
    .map((e) => ({ id: `${e.kind}:${e.id}`, message: e.message, remaining: computedAt + e.eta_s - clock.sim_time, equipment: e.id }))
    .filter((e) => e.remaining > -1)
    .sort((a, b) => a.remaining - b.remaining)
}

/** Night between 19:00 and 06:30 (seconds after midnight), as the world's clock says. */
export function isNight(timeOfDay: number | undefined): boolean {
  if (timeOfDay == null) return true
  const t = timeOfDay % 86400
  return t < 6.5 * 3600 || t >= 19 * 3600
}

/** Plant the forecast says the water will reach (the ids of its non-info events). */
export function atRiskIds(world: WorldState, equipment: Record<string, Equipment>): Set<string> {
  return new Set(world.forecast.events.filter((e) => e.severity !== 'info' && equipment[e.id]).map((e) => e.id))
}

export interface LiftShaft {
  id: string
  name: string
  running: boolean
  rect: Space['rect']
  from: number
  to: number
}

/** Each lift as a shaft: the lift spaces stacked under it in the spec, running when the world says it has power. */
export function liftShafts(world: WorldState, equipment: Record<string, Equipment>, spaces: Record<string, Space>, levels: Record<string, Level>): LiftShaft[] {
  const out: LiftShaft[] = []
  for (const e of Object.values(equipment)) {
    if (e.kind !== 'lift') continue
    const stack = Object.values(spaces).filter((s) => s.kind === 'lift' && e.x >= s.rect.x0 && e.x <= s.rect.x1 && e.y >= s.rect.y0 && e.y <= s.rect.y1 && levels[s.level])
    if (stack.length === 0) continue
    const from = Math.min(...stack.map((s) => levels[s.level].elevation))
    const to = Math.max(...stack.map((s) => levels[s.level].elevation + levels[s.level].height))
    const running = world.power.lifts[e.id] ?? world.equipment[e.id]?.status === 'online'
    out.push({ id: e.id, name: e.name.replace(/\s*\(.*\)/, ''), running, rect: stack[0].rect, from, to })
  }
  return out
}

export function levelWords(ids: string[], levels: Record<string, Level>): string {
  const names = [...ids].sort((a, b) => (levels[a]?.index ?? 0) - (levels[b]?.index ?? 0)).map((id) => levels[id]?.short ?? id)
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
