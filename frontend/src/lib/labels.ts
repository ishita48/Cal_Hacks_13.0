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
  warning: 'text-haven-amber',
  info: 'text-t1',
}

export const SEVERITY_DOT: Record<Severity, string> = {
  critical: 'bg-haven-danger',
  warning: 'bg-haven-amber',
  info: 'bg-t3',
}

export const STATUS_COLOR: Record<EquipmentStatus, string> = {
  online: '#30d158',
  offline: '#ff9f0a',
  flooded: '#64d2ff',
  isolated: '#8e8e93',
  closing: '#bf5af2',
  closed: '#9f6ae8',
}

// Floor-plan fills: neutral white at low alpha; plant rooms carry a faint warm tint.
export const KIND_FILL: Record<string, string> = {
  room: 'rgba(255,255,255,0.05)',
  corridor: 'rgba(255,255,255,0.09)',
  lobby: 'rgba(255,255,255,0.11)',
  lounge: 'rgba(255,255,255,0.07)',
  study: 'rgba(255,255,255,0.07)',
  kitchen: 'rgba(255,255,255,0.07)',
  bathroom: 'rgba(255,255,255,0.04)',
  laundry: 'rgba(255,255,255,0.05)',
  office: 'rgba(255,255,255,0.06)',
  retail: 'rgba(255,255,255,0.05)',
  amenity: 'rgba(255,255,255,0.07)',
  storage: 'rgba(255,255,255,0.035)',
  stair: 'rgba(255,255,255,0.14)',
  lift: 'rgba(255,255,255,0.14)',
  service: 'rgba(255,255,255,0.035)',
  mechanical: 'rgba(255,200,150,0.07)',
  electrical: 'rgba(255,200,150,0.08)',
  generator: 'rgba(255,200,150,0.07)',
  riser: 'rgba(255,255,255,0.02)',
  courtyard: 'rgba(120,200,140,0.06)',
}
