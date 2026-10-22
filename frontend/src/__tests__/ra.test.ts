import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../portal/types'
import { raView } from '../ra/model'

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 })
const sp = (id: string, name: string, kind: string, r = rect(0, 0, 4, 4)) => ({ id, name, kind, level: 'L4', rect: r, wet: false, authorized: true })
type Person = Snapshot['incident']['people'][number]
const person = (id: string, name: string, room: string, over: Partial<Person> = {}): Person => ({
  id, name, room, level: 'L4', priority: false, situation: ['power_lost'], now: true, left_behind: false, ...over,
})

function snap(over: { people?: Person[]; approved?: boolean; lift?: string; tasks?: Snapshot['incident']['tasks'] } = {}): Snapshot {
  const people = over.people ?? []
  return {
    type: 'portal', revision: 1,
    viewer: { role: 'ra', source: 'clerk', name: 'Marcus Bell', id: 'ra_4', person_id: 'ra_4', levels: ['L4'], linked: true },
    building: {
      name: 'Test Hall', footprint: [], photoreal: false, scope: '',
      levels: [{ id: 'L4', index: 4, name: 'Floor 4', elevation: 12, height: 3, short: '4' }],
      spaces: [
        sp('L4-hall', 'Corridor', 'corridor', rect(0, 10, 40, 12)),
        sp('room_412', 'Room 412', 'room', rect(2, 12, 6, 16)),
        sp('room_429', 'Room 429', 'room', rect(30, 12, 34, 16)),
        sp('room_430', 'Room 430', 'room', rect(34, 12, 38, 16)),
        sp('L4-lift_1', 'Lift 1', 'lift', rect(18, 6, 20, 10)),
      ],
      equipment: [{ id: 'lift_1', name: 'Lift 1', level: 'L1', x: 19, y: 8, status: over.lift ?? 'online' }],
    },
    requests: [], inbox: [], duty: {}, assignments: {}, email_configured: false, contacts: [],
    profile: { agent_name: 'Buds', avatar: 'spark', quiet_hours: '', entry_permission: 'ask_first', email_updates: true, accessibility: '', emergency_contact: '' },
    team: [
      { id: 'ra_4', name: 'Marcus Bell', role: 'ra', level: 'L4', duty: {} },
      ...['maya:Maya Reyes', 'malik:Malik Rahman', 'carmen:Carmen Martinez', 'priya:Priya Shah'].map((s) => ({ id: s.split(':')[0], name: s.split(':')[1], role: 'resident', level: 'L4', duty: {} })),
      { id: 'ben', name: 'Ben Other', role: 'resident', level: 'L2', duty: {} },
    ],
    incident: {
      active: people.length > 0, stage: people.length ? 'negotiate' : 'quiet', id: 'r', approved: over.approved ?? false, affected: people.length > 0,
      message: '', tasks: over.tasks ?? [], people, equipment: [],
    },
  }
}

const maya = (over: Partial<Person> = {}) => person('maya', 'Maya Reyes', 'Room 412', { priority: true, situation: ['stranded', 'power_lost'], ...over })
const malik = (over: Partial<Person> = {}) => person('malik', 'Malik Rahman', 'Room 429', { priority: true, situation: ['medication_at_risk', 'power_lost'], ...over })
const carmen = person('carmen', 'Carmen Martinez', 'Room 430', { situation: ['stairs_only_slow', 'power_lost'] })

describe('RA view', () => {
  it('is clear on a quiet night: everyone on the floor is safe, nobody else is listed', () => {
    const v = raView(snap())
    expect(v.hero).toBeNull()
    expect(v.attention).toBe(0)
    expect(v.floors).toBe('Floor 4')
    expect(v.residentCount).toBe(4)
    expect(v.residents.map((r) => r.status)).toEqual(['safe', 'safe', 'safe', 'safe'])
    expect(v.map?.note).toMatch(/Nobody/)
  })

  it('puts the most serious first: who cannot get out before medicine, before a check-in', () => {
    const v = raView(snap({ people: [carmen, malik(), maya({ now: false })] }))
    expect(v.residents.slice(0, 3).map((r) => [r.name, r.status])).toEqual([
      ['Maya Reyes', 'escalated'],
      ['Malik Rahman', 'escalated'],
      ['Carmen Martinez', 'checkin'],
    ])
    expect(v.attention).toBe(2)
    expect(v.hero?.person.name).toBe('Maya Reyes')
    expect(v.hero?.badge).toBe('Escalated · no step-free way out')
    expect(v.hero?.confirmBlocked).toMatch(/names you/)
  })

  it('turns escalated into assisted once a plan is approved, unless the plan left them out', () => {
    expect(raView(snap({ approved: true, people: [maya()] })).residents[0].status).toBe('assisted')
    expect(raView(snap({ approved: true, people: [maya({ left_behind: true })] })).residents[0].status).toBe('escalated')
  })

  it("lets the RA confirm only their own approved step for the resident", () => {
    const task = { id: 'move_meds_L4', title: 'Move the medication of Malik Rahman to a powered fridge', reason: 'Medication must stay cold.', target: '', target_name: '', status: 'assigned' as const }
    const pending = raView(snap({ people: [malik()], tasks: [{ ...task, status: 'proposed' }] }))
    expect(pending.hero?.task?.id).toBe('move_meds_L4')
    expect(pending.hero?.confirmBlocked).toMatch(/approval/)
    const ready = raView(snap({ approved: true, people: [malik()], tasks: [task] }))
    expect(ready.hero?.confirmBlocked).toBe('')
    expect(ready.hero?.text.startsWith('Medication must stay cold.')).toBe(true)
  })

  it('maps the hero, the flagged rooms and the way to a working lift', () => {
    const v = raView(snap({ people: [maya(), carmen] }))
    const marks = Object.fromEntries(v.map!.spaces.map((s) => [s.id, s.mark]))
    expect(marks).toMatchObject({ room_412: 'hero', room_430: 'flag', 'L4-lift_1': 'lift', 'L4-hall': null })
    expect(v.map!.route?.length).toBe(4)
    expect(v.map!.note).toBe('Room 412 → Lift 1')
    const dark = raView(snap({ people: [maya()], lift: 'flooded' }))
    expect(dark.map!.route).toBeNull()
    expect(dark.map!.note).toMatch(/shelters in Room 412/)
  })

  it('lists escalations first in the updates, then dated records newest first', () => {
    const s = snap({ people: [maya()] })
    s.inbox = [
      { id: 'a', title: 'Older', text: '', request_id: '', created_at: '2026-10-22T08:00:00Z', read: false, email_status: '' },
      { id: 'b', title: 'Newer', text: '', request_id: '', created_at: '2026-10-22T09:00:00Z', read: false, email_status: '' },
    ]
    expect(raView(s).updates.map((u) => u.title)).toEqual(['Escalation · Maya Reyes', 'Newer', 'Older'])
  })
})
