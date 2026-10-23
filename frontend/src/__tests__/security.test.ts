import { describe, expect, it } from 'vitest'
import type { BuildingSpec, Plan, PlanStep, ResidentImpact, WorldState } from '../state/types'
import { exitsOf, securityView } from '../security/model'

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 })
const space = (id: string, name: string, kind: string, level: string, r = rect(0, 0, 4, 4)) => ({ id, name, kind, level, rect: r, capacity: 0, accessible: false, outdoor: false, tags: [] })
const exit = (id: string, a: string, x: number, y: number) => ({ id, level: 'L1', a, b: 'outside', x, y, width: 2, axis: 'x' as const, kind: 'exit', step_free: true })

const spec: BuildingSpec = {
  id: 'b', name: 'Test Hall', address: '',
  footprint: [rect(0, 0, 40, 80)],
  levels: [{ id: 'L1', index: 1, name: 'Ground', elevation: 0, height: 4, short: 'ground' }, { id: 'L4', index: 4, name: 'Floor 4', elevation: 12, height: 3, short: '4' }],
  spaces: [space('L1-lobby', 'Main lobby', 'lobby', 'L1', rect(0, 0, 14, 14)), space('L1-stiles', 'Stiles hall', 'lobby', 'L1', rect(20, 70, 32, 80)), space('room_412', 'Room 412', 'room', 'L4', rect(20, 66, 24, 70)), space('room_429', 'Room 429', 'room', 'L4', rect(2, 2, 6, 6))],
  openings: [exit('exit_main', 'L1-lobby', 7, 0), exit('exit_stiles', 'L1-stiles', 26, 80)],
  equipment: [{ id: 'lift_1', kind: 'lift', name: 'Lift 1', level: 'L1', x: 20, y: 40, space: 'L1-lift_1', flood_height: null, props: {} }, { id: 'msb_b', kind: 'switchboard_section', name: 'MSB section B', level: 'B1', x: 10, y: 30, space: 'B1-elec', flood_height: 0.1, props: {} }],
}

const res = (id: string, name: string, room: string, impacts: string[], needs: string[] = []): ResidentImpact => ({
  id, name, room, level: 'L4', presence: 'home', needs, impacts, severity: 'critical', channel: 'sms', lang: 'en', role: 'resident',
})
const maya = res('maya', 'Maya Reyes', 'room_412', ['stranded', 'power_lost'], ['step_free_route'])
const malik = res('malik', 'Malik Rahman', 'room_429', ['medication_at_risk'])
const shelter: PlanStep = { id: 'shelter_maya', order: 1, kind: 'shelter', actor: 'ra_4', title: 'Marcus stays with Maya in Room 412', reason: '', at_s: 0, deadline_s: null, people: ['maya'], target: 'room_412', command: null, satisfies: [], count: 0 }

function world(over: { residents?: ResidentImpact[]; approved?: boolean; leftBehind?: string[]; liftDown?: boolean; flooded?: boolean; actors?: WorldState['actors'] } = {}): WorldState {
  const residents = over.residents ?? []
  const plan = { version: 6, steps: residents.length ? [shelter] : [], left_behind: over.leftBehind ?? [], checks: [{ code: 'x', label: 'Lifts first', ok: true, detail: '', severity: 'safety' }] } as unknown as Plan
  return {
    run_id: 'r', narrative: { stage: residents.length ? 'negotiate' : 'quiet' },
    impact: { residents, lifts_down: over.liftDown ? ['lift_1'] : [], dark_levels: [], fridges_down: [], wet_spaces: [], others: [], routes: {}, counts: {} },
    forecast: { impact: { residents: [] } },
    plan, approved_plan: over.approved ? plan : null,
    moved: {}, actors: over.actors ?? {}, wet_spaces: [],
    equipment: { lift_1: { status: over.liftDown ? 'offline' : 'online', since_step: 0 }, msb_b: { status: over.flooded ? 'flooded' : 'online', since_step: 0 } },
  } as unknown as WorldState
}

describe('dispatch view', () => {
  it('is all clear on a quiet night, with every entrance named by its side', () => {
    const v = securityView(world(), spec)
    expect(v.active).toBe(0)
    expect(v.hero).toBeNull()
    expect(v.queue).toEqual([{ id: 'x:all', kind: 'entrance', title: 'Entrances clear of water', sub: '2 step-free entrances', tag: 'clear' }])
    expect(exitsOf(spec).map((e) => e.label)).toEqual(['North entrance · Stiles hall', 'South entrance · Main lobby'])
  })

  it('puts the person who cannot get out first, and sends responders in by the nearest step-free door', () => {
    const v = securityView(world({ residents: [malik, maya], liftDown: true, flooded: true }), spec)
    expect(v.active).toBe(2)
    expect(v.hero).toMatchObject({ name: 'Maya Reyes', title: 'Shelter in place · Floor 4', where: 'sheltering at Room 412', status: 'escalated' })
    expect(v.info).toEqual(['Elevators offline', 'needs step-free assisted evacuation', 'nearest accessible entrance: North entrance · Stiles hall'])
    expect(v.map?.entrance?.id).toBe('exit_stiles')
    expect(v.map?.route?.at(-1)).toEqual({ x: 22, y: 68 })
    expect(v.queue.map((q) => q.tag)).toEqual(['critical', 'critical', 'monitor', 'clear'])
    expect(v.responders).toEqual(['Planned: Marcus stays with Maya in Room 412. Nobody moves until the plan is approved.'])
    expect(v.dispatchBlocked).toBe('')
  })

  it('turns assisted once the approved plan covers them, and shows who is moving', () => {
    const actors = { ra_4: { actor: 'ra_4', label: 'RA Marcus', at: null, heading: 'room_412', step_id: 'shelter_maya', status: 'moving', since_step: 0 } } as WorldState['actors']
    const v = securityView(world({ residents: [maya], approved: true, actors }), spec)
    expect(v.hero?.status).toBe('assisted')
    expect(v.responders).toEqual(['RA Marcus · En route · to Room 412'])
    expect(v.units).toEqual([{ id: 'ra_4', label: 'RA Marcus', status: 'En route', tone: 'moving', sub: 'Marcus stays with Maya in Room 412 · to Room 412' }])
    expect(v.dispatchBlocked).toMatch(/already|dispatched/)
  })

  it('puts whoever still needs a dispatch decision above those already covered', () => {
    const v = securityView(world({ residents: [maya, malik], approved: true }), spec)
    expect(v.hero).toMatchObject({ name: 'Malik Rahman', status: 'escalated', title: 'Escalation · Floor 4', where: 'in Room 429', step: null })
    expect(v.queue.slice(0, 2).map((q) => q.tag)).toEqual(['critical', 'assisted'])
  })

  it('keeps someone the plan left out escalated even after approval', () => {
    const v = securityView(world({ residents: [maya], approved: true, leftBehind: ['maya'] }), spec)
    expect(v.hero).toMatchObject({ status: 'escalated', leftBehind: true })
  })
})
