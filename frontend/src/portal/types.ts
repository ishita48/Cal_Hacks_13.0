import type { Level, Rect } from '../state/types'
import type { Role } from '../state/me'

/** The role-scoped projection the backend sends (backend/haven/api/portal.py `snapshot`). Nothing else reaches a portal. */

export interface Ticket {
  id: string
  title: string
  description: string
  category: string
  room: string
  level: string
  owner: string
  urgency: 'routine' | 'soon' | 'urgent'
  status: 'open' | 'acknowledged' | 'in_progress' | 'resolved'
  assigned_to: string
  version: number
  appointment: string
  appointment_status: 'none' | 'proposed' | 'accepted' | 'declined'
  created_at: string
  updated_at: string
  history: { actor: string; action: string; text: string; at: string }[]
  proposed_by?: string
  entry_permission?: string
  quiet_hours?: string
}

export interface Contact {
  id: string
  name: string
  phone: string
  email: string
  emergency: boolean
  levels: string[]
  instructions?: string
}

export interface Profile {
  agent_name: string
  avatar: string
  quiet_hours: string
  entry_permission: string
  email_updates: boolean
  accessibility: string
  emergency_contact: string
}

export interface Scene {
  name: string
  levels: Level[]
  footprint: Rect[]
  photoreal: boolean
  scope: string
  spaces: { id: string; name: string; kind: string; level: string; rect: Rect; wet: boolean; authorized: boolean }[]
  equipment: { id: string; name: string; level: string; x: number; y: number; status: string }[]
}

export interface IncidentTask {
  id: string
  title: string
  reason: string
  target: string
  target_name: string
  status: 'proposed' | 'assigned' | 'done' | 'failed'
  /** A person confirmed it on site (done by HAVEN or auto-confirmed at a deadline is not verified). */
  verified?: boolean
}

export interface Incident {
  active: boolean
  stage: string
  id: string
  approved: boolean
  affected: boolean
  message: string
  detail?: string
  next?: string
  tasks: IncidentTask[]
  /** RA only: residents on their floors who need a check-in, by situation (never medical detail). */
  people: { id: string; name: string; room: string; level: string; priority: boolean; situation: string[]; now: boolean; left_behind: boolean }[]
  /** Maintenance only: plant that is down, wet or isolated. */
  equipment: { id: string; name: string; status: string; place: string }[]
}

export interface Notice {
  id: string
  title: string
  text: string
  request_id: string
  created_at: string
  read: boolean
  email_status: string
}

export interface Duty {
  status?: 'available' | 'busy' | 'off_duty'
  schedule?: string
}

export interface Snapshot {
  type: 'portal'
  revision: number
  viewer: { role: Role; source: 'clerk' | 'demo'; name: string; id: string; person_id: string | null; levels: string[]; linked: boolean }
  building: Scene
  requests: Ticket[]
  inbox: Notice[]
  profile: Profile
  contacts: Contact[]
  team: { id: string; name: string; role: string; level: string; duty: Duty }[]
  duty: Duty
  assignments: Record<string, { levels: string[] }>
  incident: Incident
  email_configured: boolean
}

export type Tab = 'home' | 'requests' | 'inbox' | 'contacts' | 'ask' | 'team' | 'settings'
