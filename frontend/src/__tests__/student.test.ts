import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../portal/types'
import type { BuildingSpec } from '../state/types'
import { ago, studentView } from '../student/model'
import { canOpen, workspace, workspaceFromPath } from '../roles/workspaces'

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 })
const levels = [
  { id: 'L1', index: 1, name: 'Ground', elevation: 0, height: 4, short: 'ground' },
  { id: 'L4', index: 4, name: 'Floor 4', elevation: 12, height: 3, short: '4' },
]
const space = (id: string, name: string, kind: string, level: string, r = rect(0, 0, 4, 4), tags: string[] = []) => ({
  id, name, kind, level, rect: r, capacity: 0, accessible: false, outdoor: false, tags,
})

const spec: BuildingSpec = {
  id: 'b', name: 'Test Hall', address: '', footprint: [], levels, openings: [], equipment: [],
  spaces: [
    space('lobby', 'Main lobby', 'lobby', 'L1', rect(0, 0, 10, 10), ['main_entrance']),
    space('L1-lift_1', 'Lift 1', 'lift', 'L1', rect(20, 0, 22, 2)),
    space('L4-lift_1', 'Lift 1', 'lift', 'L4', rect(20, 0, 22, 2)),
    space('L1-lift_2', 'Lift 2', 'lift', 'L1', rect(50, 0, 52, 2)),
    space('L4-lift_2', 'Lift 2', 'lift', 'L4', rect(50, 0, 52, 2)),
    space('room_412', 'Room 412', 'room', 'L4', rect(24, 0, 28, 4)),
  ],
  verticals: [
    { id: 'lift_1', kind: 'lift', name: 'Lift 1', spaces: { L1: 'L1-lift_1', L4: 'L4-lift_1' }, step_free: true, equipment: 'lift_1', seconds_per_level: 4 },
    { id: 'lift_2', kind: 'lift', name: 'Lift 2', spaces: { L1: 'L1-lift_2', L4: 'L4-lift_2' }, step_free: true, equipment: 'lift_2', seconds_per_level: 4 },
  ],
}

function snap(over: { incident?: Partial<Snapshot['incident']>; lifts?: [string, string]; linked?: boolean } = {}): Snapshot {
  const [s1, s2] = over.lifts ?? ['online', 'online']
  const linked = over.linked ?? true
  return {
    type: 'portal', revision: 1,
    viewer: { role: 'resident', source: 'clerk', name: 'Maya Reyes', id: 'maya', person_id: linked ? 'maya' : null, levels: linked ? ['L4'] : [], linked },
    building: {
      name: 'Test Hall', levels, footprint: [], photoreal: false, scope: '',
      spaces: [
        { id: 'lobby', name: 'Main lobby', kind: 'lobby', level: 'L1', rect: rect(0, 0, 10, 10), wet: false, authorized: false },
        ...(linked ? [{ id: 'room_412', name: 'Room 412', kind: 'room', level: 'L4', rect: rect(24, 0, 28, 4), wet: false, authorized: true }] : []),
      ],
      equipment: [
        { id: 'lift_1', name: 'Lift 1', level: 'L1', x: 21, y: 1, status: s1 },
        { id: 'lift_2', name: 'Lift 2', level: 'L1', x: 51, y: 1, status: s2 },
      ],
    },
    requests: [], inbox: [], team: [], duty: {}, assignments: {}, email_configured: false,
    profile: { agent_name: 'Buds', avatar: 'spark', quiet_hours: '', entry_permission: 'ask_first', email_updates: true, accessibility: '', emergency_contact: '' },
    contacts: [
      { id: 'frontdesk', name: 'Front desk', phone: '', email: '', emergency: false, levels: [] },
      { id: 'jordan', name: 'Jordan Lee', phone: '', email: '', emergency: false, levels: ['L4'] },
    ],
    incident: { active: false, stage: 'quiet', id: 'r', approved: false, affected: false, message: 'No active building incident.', tasks: [], people: [], equipment: [], ...over.incident },
  }
}

describe('student view', () => {
  it('is all set on a quiet night, with the RA for their floor and the nearest working lift', () => {
    const v = studentView(snap(), spec)
    expect(v.outcome).toEqual({ status: 'ok', reachable_refuge: true })
    expect(v.pill).toEqual({ tone: 'ok', label: 'Building normal' })
    expect(v.hero.title).toBe("You're all set")
    expect(v.room).toBe('Room 412')
    expect(v.floor).toBe('Floor 4')
    expect(v.ra?.contact.id).toBe('jordan')
    expect(v.ra?.role).toBe('Floor 4 RA')
    expect(v.route.stops.map((s) => s.label)).toEqual(['Room 412', 'Lift 1', 'Main lobby'])
    expect(v.route.summary).toBe('Lift 1 → Main lobby')
    expect(v.route.minutes).toBeGreaterThan(0)
  })

  it('passes on the server’s words before the incident reaches them, without claiming it will not', () => {
    const message = 'Water in the basement means the lifts will stop at 23:48. Two staff are coming to your door.'
    const v = studentView(snap({ incident: { active: true, stage: 'leak', message } }), spec)
    expect(v.outcome.status).toBe('ok')
    expect(v.pill.tone).toBe('warn')
    expect(v.hero).toEqual({ tone: 'warn', title: 'Something is happening in the building', text: message })
  })

  it("flips to the server's own instruction when the incident affects them", () => {
    const message = 'Stay in Room 412. Jordan is coming to take you down in Lift 2.'
    const escalated = studentView(snap({ incident: { active: true, affected: true, message } }), spec)
    expect(escalated.outcome.status).toBe('escalated')
    expect(escalated.hero).toEqual({ tone: 'alert', title: 'Follow this instruction', text: message })
    const assisted = studentView(snap({ incident: { active: true, affected: true, approved: true, message } }), spec)
    expect(assisted.outcome.status).toBe('assisted')
    expect(assisted.hero.text).toBe(message)
  })

  it('routes around a dead lift, and says so when none is left', () => {
    expect(studentView(snap({ lifts: ['flooded', 'online'] }), spec).route.summary).toBe('Lift 2 → Main lobby')
    const v = studentView(snap({ lifts: ['offline', 'isolated'] }), spec)
    expect(v.outcome.reachable_refuge).toBe(false)
    expect(v.route.stops[1]).toMatchObject({ kind: 'lift', down: true })
    expect(v.route.summary).toBe('Lift 1 and Lift 2 are out of service')
  })

  it('asks for a room link instead of guessing one', () => {
    const v = studentView(snap({ linked: false }), spec)
    expect(v.room).toBeNull()
    expect(v.ra).toBeNull()
    expect(v.route.reachable).toBe(false)
    expect(v.route.summary).toMatch(/not linked/)
  })

  it('puts the incident alert first, then visits to review, then notices', () => {
    const s = snap({ incident: { active: true, affected: true } })
    s.inbox = [
      { id: 'n1', title: 'Request updated', text: 'Fixed', request_id: 'r1', created_at: '2026-10-22T10:00:00Z', read: true, email_status: '' },
      { id: 'incident:r:maya', title: 'Building response in progress', text: '…', request_id: '', created_at: '', read: false, email_status: '' },
    ]
    s.requests = [{
      id: 'q1', title: 'Leaky tap', description: '', category: 'plumbing', room: 'room_412', level: 'L4', owner: 'maya', urgency: 'routine',
      status: 'acknowledged', assigned_to: 'facilities', version: 3, appointment: 'Fri 10:00', appointment_status: 'proposed',
      created_at: '', updated_at: '2026-10-22T09:00:00Z', history: [], proposed_by: 'facilities',
    }]
    const rows = studentView(s, spec).inbox
    expect(rows.map((r) => r.kind)).toEqual(['alert', 'visit', 'notice'])
    expect(rows[1].visit).toEqual({ requestId: 'q1', version: 3 })
  })

  it('says how long ago, briefly', () => {
    const now = Date.parse('2026-10-22T12:00:00Z')
    expect(ago('2026-10-22T10:00:00Z', now)).toBe('2h')
    expect(ago('2026-10-21T11:00:00Z', now)).toBe('1d')
    expect(ago('', now)).toBe('now')
  })
})

describe('workspaces', () => {
  it('reads the workspace from the path', () => {
    expect(workspaceFromPath('/app/student')?.role).toBe('resident')
    expect(workspaceFromPath('/app')).toBeNull()
    expect(workspaceFromPath('/app/nope')).toBeNull()
  })

  it('opens the server role’s own door when signed in, every door to an admin and in the demo', () => {
    const student = workspace('student')!
    const security = workspace('security')!
    expect(canOpen(student, { role: 'resident', source: 'clerk' })).toBe(true)
    expect(canOpen(student, { role: 'ra', source: 'clerk' })).toBe(false)
    expect(canOpen(student, { role: 'admin', source: 'clerk' })).toBe(true)
    expect(canOpen(security, { role: 'admin', source: 'clerk' })).toBe(true)
    expect(canOpen(security, { role: 'ra', source: 'clerk' })).toBe(false)
    expect(canOpen(student, { role: 'admin', source: 'demo' })).toBe(true)
  })
})
