import { describe, expect, it } from 'vitest'
import type { IncidentTask, Snapshot } from '../portal/types'
import type { BuildingSpec } from '../state/types'
import { maintenanceView } from '../maintenance/model'

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 })
const levels = [
  { id: 'B1', index: -1, name: 'Basement', elevation: -4, height: 4, short: 'basement' },
  { id: 'L1', index: 1, name: 'Ground', elevation: 0, height: 4, short: 'ground' },
  { id: 'L4', index: 4, name: 'Floor 4', elevation: 12, height: 3, short: '4' },
]
const space = (id: string, name: string, kind: string, level: string, r = rect(0, 0, 4, 4), tags: string[] = []) => ({
  id, name, kind, level, rect: r, capacity: 0, accessible: false, outdoor: false, tags,
})
const eq = (id: string, kind: string, name: string, level: string, x: number, sp: string) => ({ id, kind, name, level, x, y: 2, space: sp, flood_height: null, props: {} })

const spec: BuildingSpec = {
  id: 'b', name: 'Test Hall', address: '', footprint: [rect(0, 0, 50, 80)], levels, openings: [],
  spaces: [
    space('L1-facilities', 'Facilities office', 'office', 'L1', rect(40, 48, 46, 70)),
    space('L1-lobby', 'Main lobby', 'lobby', 'L1', rect(0, 0, 14, 14), ['main_entrance']),
    space('B1-elec', 'Main electrical room', 'electrical', 'B1', rect(14, 22, 30, 34)),
    space('L1-stair_se', 'Stair SE', 'stair', 'L1', rect(36, 0, 40, 4)),
    space('B1-stair_se', 'Stair SE', 'stair', 'B1', rect(36, 0, 40, 4)),
    space('B1-riser', 'Electrical riser', 'riser', 'B1', rect(20, 40, 22, 42)),
    space('L1-riser', 'Electrical riser', 'riser', 'L1', rect(20, 40, 22, 42)),
  ],
  verticals: [{ id: 'stair_se', kind: 'stair', name: 'Stair SE', spaces: { B1: 'B1-stair_se', L1: 'L1-stair_se' }, step_free: false, equipment: null, seconds_per_level: 15 }],
  equipment: [
    eq('msb_b', 'switchboard_section', 'MSB section B', 'B1', 22, 'B1-elec'),
    eq('riser_b', 'panel', 'Riser B distribution', 'B1', 21, 'B1-riser'),
    eq('lift_1', 'lift', 'Lift 1', 'L1', 20, 'L1-lift_1'),
    eq('fridge_L4', 'fridge', 'L4 lounge fridge', 'L4', 10, 'L4-lounge'),
  ],
}

const task = (over: Partial<IncidentTask>): IncidentTask => ({ id: 'isolate_msb_b', title: 'Cut MSB section B now', reason: 'Energised switchgear must not be under water.', target: 'msb_b', target_name: 'MSB section B', status: 'assigned', verified: false, ...over })

function snap(equipment: Snapshot['incident']['equipment'], tasks: IncidentTask[] = [], approved = true): Snapshot {
  return {
    type: 'portal', revision: 1,
    viewer: { role: 'maintenance', source: 'demo', name: 'Facilities team', id: 'demo:maintenance', person_id: null, levels: [], linked: false },
    building: {
      name: 'Test Hall', levels, footprint: [], photoreal: false, scope: '', spaces: [],
      equipment: spec.equipment.map((e) => ({ id: e.id, name: e.name, level: e.level, x: e.x, y: e.y, status: equipment.find((x) => x.id === e.id)?.status ?? 'online' })),
    },
    requests: [], inbox: [], team: [], duty: {}, assignments: {}, email_configured: false, contacts: [],
    profile: { agent_name: 'Buds', avatar: 'spark', quiet_hours: '', entry_permission: 'ask_first', email_updates: true, accessibility: '', emergency_contact: '' },
    incident: { active: equipment.length > 0, stage: 'act', id: 'r', approved, affected: true, message: '', tasks, people: [], equipment },
  }
}

const down = [
  { id: 'fridge_L4', name: 'L4 lounge fridge', status: 'offline', place: 'Floor lounge & kitchen' },
  { id: 'lift_1', name: 'Lift 1', status: 'isolated', place: 'Lift 1' },
  { id: 'msb_b', name: 'MSB section B', status: 'flooded', place: 'Main electrical room' },
]

describe('maintenance view', () => {
  it('is quiet when all plant runs', () => {
    const v = maintenanceView(snap([]), spec)
    expect(v.hero).toBeNull()
    expect(v.urgent).toBe(0)
    expect(v.orders).toEqual([])
  })

  it('puts the hazard first, with its step’s own reason as the safety note', () => {
    const v = maintenanceView(snap(down, [task({})]), spec)
    expect(v.urgent).toBe(2)
    expect(v.hero?.fault).toMatchObject({ id: 'msb_b', severity: 'hazard', where: 'Main electrical room · Basement' })
    expect(v.hero?.note).toBe('Energised switchgear must not be under water.')
    expect(v.hero?.confirmBlocked).toBe('')
  })

  it('routes from the facilities office down the stair to the asset', () => {
    const route = maintenanceView(snap(down, [task({})]), spec).hero!.route!
    expect(route.from.label).toBe('Facilities office')
    expect(route.steps).toEqual(['Leave Facilities office (Ground)', 'Take Stair SE down to Basement', 'Go to Main electrical room: MSB section B'])
    expect(route.path.map((p) => p.z)).toEqual([0, 0, -4, -4])
    expect(route.floors.find((f) => f.hot)?.id).toBe('B1')
  })

  it('highlights the riser when the asset sits in it', () => {
    const v = maintenanceView(snap([{ id: 'riser_b', name: 'Riser B distribution', status: 'isolated', place: 'Electrical riser' }]), spec)
    expect(v.hero?.route?.risers).toEqual([{ x: 21, z0: -4, z1: 4, hot: true }])
  })

  it('lists one work order per fault, urgent first', () => {
    const orders = maintenanceView(snap(down), spec).orders
    expect(orders.map((o) => [o.title, o.status])).toEqual([
      ['MSB section B — isolate & inspect', 'urgent'],
      ['Lift 1 — locked out', 'open'],
      ['L4 lounge fridge — power loss', 'open'],
    ])
  })

  it('reads Verified only when a person confirmed the shutdown (S4)', () => {
    const states = (t: IncidentTask, approved = true) => maintenanceView(snap(down, [t], approved), spec).shutdowns[0]
    expect(states(task({ status: 'proposed' }), false)).toMatchObject({ state: 'waiting' })
    expect(states(task({ status: 'assigned' }))).toMatchObject({ state: 'confirm', text: 'Isolate, then confirm on site' })
    expect(states(task({ status: 'done', verified: false }))).toMatchObject({ state: 'confirm', text: 'Isolated by HAVEN — confirm on site' })
    expect(states(task({ status: 'done', verified: true }))).toMatchObject({ state: 'verified', text: 'Confirmed on site' })
    const verified = maintenanceView(snap(down, [task({ status: 'done', verified: true })]), spec)
    expect(verified.hero?.confirmBlocked).toBe('Verified on site.')
    expect(verified.orders.at(-1)).toMatchObject({ status: 'done', title: 'Cut MSB section B now' })
  })
})
