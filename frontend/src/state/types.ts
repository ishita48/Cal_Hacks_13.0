// Mirrors backend/haven/world/state.py and haven/world/cascade.py. The backend is the only
// source of truth; these types describe what it broadcasts.

export type Severity = 'info' | 'warning' | 'critical'

export interface SensorState {
  value: number
  wet: boolean
  last_step: number | null
  source: string | null
}

export interface TimelineEntry {
  step: number
  kind: string
  severity: Severity
  message: string
  data: Record<string, unknown>
}

export interface WaterState {
  depth: number
  volume: number
}

export interface LeakState {
  equipment_id: string
  space: string
  flow_lps: number
  started_step: number
  active: boolean
}

export type EquipmentStatus = 'online' | 'offline' | 'flooded' | 'isolated' | 'closing' | 'closed'

export interface EquipmentState {
  status: EquipmentStatus
  since_step: number
}

export interface PendingCommand {
  equipment_id: string
  command: string
  actor: string
  issued_step: number
  completes_step: number
}

export interface PowerState {
  live: string[]
  levels: Record<string, boolean>
  lifts: Record<string, boolean>
}

export interface ResidentImpact {
  id: string
  name: string
  room: string
  level: string
  presence: string
  needs: string[]
  impacts: string[]
  severity: Severity
  channel: string
  lang: string
  role: string
}

export interface Impact {
  dark_levels: string[]
  lifts_down: string[]
  fridges_down: string[]
  wet_spaces: string[]
  residents: ResidentImpact[]
  others: string[]
  routes: Record<string, string[] | null>
  counts: Record<string, number>
}

export interface ChainEvent {
  eta_s: number
  kind: string
  id: string
  message: string
  severity: Severity
  cause: string | null
  data: Record<string, unknown>
}

export interface Forecast {
  computed_step: number
  horizon_s: number
  events: ChainEvent[]
  impact: Impact
  settled: boolean
}

export interface WorldState {
  run_id: string
  scenario: string
  mode: 'live' | 'replay'
  step: number
  version: number
  sensors: Record<string, SensorState>
  timeline: TimelineEntry[]
  water: Record<string, WaterState>
  wet_spaces: string[]
  leaks: Record<string, LeakState>
  flooded: string[]
  isolated: string[]
  closed_valves: string[]
  pending: PendingCommand[]
  equipment: Record<string, EquipmentState>
  power: PowerState
  impact: Impact
  forecast: Forecast
}

export interface Clock {
  step: number
  sim_time: number
  time_of_day: number
  dt: number
  playing: boolean
  speed: number
  mode: 'live' | 'replay'
  replay_remaining: number
}

export interface StateMessage {
  type: 'state'
  clock: Clock
  state: WorldState
}

// ---- static building spec (backend/haven/building/model.py) ----------------------------

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Level {
  id: string
  index: number
  name: string
  elevation: number
  height: number
}

export interface Space {
  id: string
  level: string
  kind: string
  name: string
  rect: Rect
  capacity: number
  accessible: boolean
  outdoor: boolean
  tags: string[]
}

export interface Opening {
  id: string
  level: string
  a: string
  b: string
  x: number
  y: number
  width: number
  axis: 'x' | 'y'
  kind: string
  step_free: boolean
}

export interface Equipment {
  id: string
  kind: string
  name: string
  level: string
  x: number
  y: number
  space: string
  flood_height: number | null
  props: Record<string, unknown>
}

export interface BuildingSpec {
  id: string
  name: string
  address: string
  footprint: Rect[]
  levels: Level[]
  spaces: Space[]
  openings: Opening[]
  equipment: Equipment[]
}

// ---- static roster (backend/haven/people/roster.py) ------------------------------------

export interface Resident {
  id: string
  name: string
  room: string
  level: string
  year: string
  needs: string[]
  presence: string
  location: string | null
  away_until: string | null
  contact: { channel: string; lang: string }
  medication_location: string | null
  role: string
  story: string | null
}

export interface Staff {
  id: string
  name: string
  role: string
  location: string
  on_call: boolean
  contact: { channel: string; lang: string }
}

export interface Roster {
  residents: Resident[]
  staff: Staff[]
}
