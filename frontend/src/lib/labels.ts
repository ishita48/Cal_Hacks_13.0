import type { EquipmentStatus, Severity } from '../state/types'

export const IMPACT_LABEL: Record<string, string> = {
  stranded: 'No step-free route',
  medication_at_risk: 'Medication in dead fridge',
  device_power_lost: 'Medical device unpowered',
  stairs_only_slow: 'Stairs only, slowly',
  needs_escort: 'Needs escort',
  needs_visual_alert: 'Visual alert only',
  power_lost: 'Room dark',
  away: 'Away',
}

export const NEED_LABEL: Record<string, string> = {
  step_free_route: 'wheelchair',
  stairs_slow: 'limited mobility',
  visual_alerts: 'Deaf',
  guide_dog: 'blind · guide dog',
  refrigerated_medication: 'refrigerated meds',
  medical_device_power: 'powered device',
}

export const PRESENCE_LABEL: Record<string, string> = {
  in_room: 'in room',
  asleep: 'asleep',
  away: 'away',
  elsewhere: 'elsewhere in building',
}

export const SEVERITY_TEXT: Record<Severity, string> = {
  critical: 'text-haven-danger',
  warning: 'text-amber-400',
  info: 'text-slate-300',
}

export const SEVERITY_DOT: Record<Severity, string> = {
  critical: 'bg-haven-danger',
  warning: 'bg-amber-400',
  info: 'bg-slate-500',
}

export const STATUS_COLOR: Record<EquipmentStatus, string> = {
  online: '#2ecc8f',
  offline: '#ffb020',
  flooded: '#3ba7ff',
  isolated: '#94a3b8',
  closing: '#c084fc',
  closed: '#a78bfa',
}

export const KIND_FILL: Record<string, string> = {
  room: '#1a2330',
  corridor: '#263141',
  lobby: '#2a3647',
  lounge: '#22303d',
  study: '#22303d',
  kitchen: '#22303d',
  bathroom: '#1d2733',
  laundry: '#1d2733',
  office: '#1f2a37',
  retail: '#1b2431',
  amenity: '#22303d',
  storage: '#182028',
  stair: '#30405a',
  lift: '#3a4a66',
  service: '#182028',
  mechanical: '#1f2a2a',
  electrical: '#2b2a1f',
  generator: '#2b2a1f',
  riser: '#101418',
  courtyard: '#13201a',
}
