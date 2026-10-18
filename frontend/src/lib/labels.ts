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
  online: '#22c55e',
  offline: '#f97316',
  flooded: '#0ea5e9',
  isolated: '#94a3b8',
  closing: '#8b5cf6',
  closed: '#7c3aed',
}

// Floor-plan fills: slate ink at low alpha on paper; plant rooms carry a faint warm tint. The .dark
// theme flips the ink to white through the SVG's currentColor-based CSS variables (see .floorplan).
export const KIND_FILL: Record<string, string> = {
  room: 'rgba(15,23,42,0.035)',
  corridor: 'rgba(15,23,42,0.07)',
  lobby: 'rgba(15,98,254,0.07)',
  lounge: 'rgba(15,98,254,0.05)',
  study: 'rgba(15,98,254,0.05)',
  kitchen: 'rgba(15,98,254,0.05)',
  bathroom: 'rgba(15,23,42,0.03)',
  laundry: 'rgba(15,23,42,0.04)',
  office: 'rgba(15,23,42,0.05)',
  retail: 'rgba(15,23,42,0.04)',
  amenity: 'rgba(15,98,254,0.05)',
  storage: 'rgba(15,23,42,0.03)',
  stair: 'rgba(15,23,42,0.12)',
  lift: 'rgba(15,23,42,0.12)',
  service: 'rgba(15,23,42,0.03)',
  mechanical: 'rgba(234,88,12,0.08)',
  electrical: 'rgba(234,88,12,0.10)',
  generator: 'rgba(234,88,12,0.08)',
  riser: 'rgba(15,23,42,0.02)',
  courtyard: 'rgba(22,163,74,0.08)',
}
