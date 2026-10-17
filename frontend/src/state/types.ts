// Mirrors backend/haven/world/state.py. The backend is the only source of truth;
// these types describe what it broadcasts.

export interface SensorState {
  value: number
  wet: boolean
  last_step: number | null
  source: string | null
}

export interface TimelineEntry {
  step: number
  kind: string
  severity: 'info' | 'warning' | 'critical'
  message: string
  data: Record<string, unknown>
}

export interface WorldState {
  run_id: string
  scenario: string
  mode: 'live' | 'replay'
  step: number
  version: number
  sensors: Record<string, SensorState>
  timeline: TimelineEntry[]
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
