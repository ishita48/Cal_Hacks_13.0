// The stylized twin: its geometry comes from the spec, its facts from the world frame, and its cards
// say only what those two carry. Rendering of the WebGL scene itself is checked in the browser walks.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Equipment, Level, Resident, Space, WorldState } from '../state/types'
import { useBuilding } from '../state/building'
import { outlineLoops, signedArea } from '../twin/geometry'
import { levelStatus, liftShafts, peopleMarks, routeLines, sceneMode, stepBeacons, upcoming } from '../twin/model'
import { PeopleCard, ViewLegend, type Derived } from '../twin/Cards'
import { clock, world } from './fixture'

afterEach(() => cleanup())

const level = (id: string, index: number, elevation: number, height = 3.1): Level => ({ id, index, name: id === 'B1' ? 'Basement' : `Floor ${index}`, elevation, height, short: String(index) })
const space = (id: string, lv: string, kind: string, rect: Space['rect']): Space => ({ id, level: lv, kind, name: id, rect, capacity: 2, accessible: true, outdoor: false, tags: [] })
const resident = (id: string, name: string, room: string, lv: string, extra: Partial<Resident> = {}): Resident => ({ id, name, room, level: lv, year: '', needs: [], presence: 'in_room', location: null, away_until: null, contact: { channel: 'sms', lang: 'en' }, medication_location: null, role: 'resident', story: null, ...extra })

const levels: Record<string, Level> = { B1: level('B1', -1, -4.5, 4.5), L1: level('L1', 1, 0, 5), L4: level('L4', 4, 11.2) }
const spaces: Record<string, Space> = {
  'B1-mech': space('B1-mech', 'B1', 'mechanical', { x0: 0, y0: 0, x1: 10, y1: 8 }),
  'L1-lobby': space('L1-lobby', 'L1', 'lobby', { x0: 0, y0: 0, x1: 10, y1: 6 }),
  'L1-lift_1': space('L1-lift_1', 'L1', 'lift', { x0: 10, y0: 0, x1: 12, y1: 2 }),
  'L4-lift_1': space('L4-lift_1', 'L4', 'lift', { x0: 10, y0: 0, x1: 12, y1: 2 }),
  'L4-cor_spine': space('L4-cor_spine', 'L4', 'corridor', { x0: 6, y0: 6, x1: 8, y1: 78 }),
  room_412: space('room_412', 'L4', 'room', { x0: 0, y0: 20, x1: 4, y1: 26 }),
}
const equipment: Record<string, Equipment> = {
  water_riser: { id: 'water_riser', kind: 'water_riser', name: 'Domestic water riser (4")', level: 'B1', x: 5, y: 4, space: 'B1-mech', flood_height: null, props: {} },
  ats_eq: { id: 'ats_eq', kind: 'transfer_switch', name: 'ATS-EQ', level: 'B1', x: 2, y: 2, space: 'B1-mech', flood_height: 0.3, props: {} },
  msb_b: { id: 'msb_b', kind: 'switchboard_section', name: 'MSB section B', level: 'B1', x: 3, y: 3, space: 'B1-mech', flood_height: 0.1, props: {} },
  lift_1: { id: 'lift_1', kind: 'lift', name: 'Lift 1', level: 'L1', x: 11, y: 1, space: 'L1-lift_1', flood_height: null, props: {} },
}
const residents: Record<string, Resident> = {
  maya: resident('maya', 'Maya Reyes', 'room_412', 'L4', { needs: ['step_free_route'] }),
  dana: resident('dana', 'Dana Okafor', 'room_412', 'L4', { needs: ['refrigerated_medication'] }),
  jordan: resident('jordan', 'Jordan Ellis', 'room_412', 'L4', { presence: 'away' }),
}

beforeAll(() => {
  useBuilding.setState({ levels, spaces, equipment, residents, storyIds: ['maya', 'dana', 'jordan'], byLevel: { L4: Object.values(spaces).filter((s) => s.level === 'L4') } })
})

describe('the twin geometry', () => {
  it('traces an E-shaped footprint with a courtyard into one outer ring and one hole', () => {
    const footprint = [
      { x0: 0, y0: 0, x1: 14, y1: 84 },
      { x0: 14, y0: 0, x1: 40, y1: 14 },
      { x0: 14, y0: 34, x1: 46, y1: 48 },
      { x0: 32, y0: 48, x1: 46, y1: 70 },
      { x0: 14, y0: 70, x1: 46, y1: 84 },
    ]
    const loops = outlineLoops(footprint)
    const areas = loops.map(signedArea).sort((a, b) => a - b)
    expect(loops).toHaveLength(2)
    // the courtyard (14..32 x 48..70) is the hole; the outer ring encloses footprint + courtyard
    expect(areas[0]).toBeCloseTo(-(18 * 22))
    expect(areas[1]).toBeCloseTo(1176 + 364 + 448 + 308 + 448 + 18 * 22)
  })
})

describe('the twin model reads the world, never invents it', () => {
  it('levels: water depth and dark-if-nothing-is-done come from the frame', () => {
    const st = levelStatus(world, Object.values(levels), spaces)
    expect(st.B1.water).toBeCloseTo(0.04)
    expect(st.B1.wetSpaces).toBe(1)
    expect(st.L4.soon).toBe(true) // forecast dark, not dark now
    expect(st.L4.dark).toBe(false)
  })

  it('people: away residents are not drawn; the plan\'s left-behind and moved people carry their tone', () => {
    const left: WorldState = { ...world, plan: { ...world.plan, left_behind: ['maya'] }, moved: { dana: 'L1-lobby' } }
    const marks = peopleMarks(left, residents, spaces, ['maya', 'dana', 'jordan'])
    expect(marks.map((m) => m.id).sort()).toEqual(['dana', 'maya'])
    expect(marks.find((m) => m.id === 'maya')).toMatchObject({ tone: 'left', status: 'left behind by this plan', level: 'L4' })
    expect(marks.find((m) => m.id === 'dana')).toMatchObject({ tone: 'moved', level: 'L1', space: 'L1-lobby' })
  })

  it('routes: the world\'s step-free path as space centres, unknown spaces skipped', () => {
    const r = routeLines(world, spaces, residents)
    expect(r).toHaveLength(1)
    expect(r[0].points.map((p) => p.level)).toEqual(['L4', 'L4', 'L4', 'L1', 'L1'])
  })

  it('steps: proposed until a person approves; then the action state; targets resolve to plant or rooms', () => {
    const draft = stepBeacons(world, spaces, equipment, residents)
    expect(draft.map((b) => b.state)).toEqual(['proposed', 'proposed'])
    expect(draft[0].where?.name).toBe('L1-lobby')
    expect(draft[1].where?.name).toBe('ATS-EQ')
    const approved: WorldState = { ...world, approved_plan: { ...world.plan, status: 'executing' }, actions: { escort_maya: { step_id: 'escort_maya', status: 'done', step: 400, detail: '' } } }
    expect(stepBeacons(approved, spaces, equipment, residents).map((b) => b.state)).toEqual(['done', 'pending'])
  })

  it('lifts and the forecast: shaft from the spec, running from power; countdown from the forecast', () => {
    const shafts = liftShafts(world, equipment, spaces, levels)
    expect(shafts).toHaveLength(1)
    expect(shafts[0]).toMatchObject({ id: 'lift_1', running: true, from: 0, to: 11.2 + 3.1 })
    const next = upcoming(world, clock)
    expect(next[0].message).toBe('MSB section B under water (10 cm)')
    expect(next[0].remaining).toBeCloseTo(25 * 0.2 + 750 - 60)
  })
})

describe('the twin cards', () => {
  const derived = (w: WorldState): Derived => ({
    status: levelStatus(w, Object.values(levels), spaces),
    people: peopleMarks(w, residents, spaces, ['maya', 'dana', 'jordan']),
    routes: routeLines(w, spaces, residents),
    beacons: stepBeacons(w, spaces, equipment, residents),
    lifts: liftShafts(w, equipment, spaces, levels),
    upcoming: upcoming(w, clock),
  })

  it('the Building tab follows the story: at rest, live status, then the response', () => {
    const quiet: WorldState = { ...world, narrative: { ...world.narrative, stage: 'quiet' } }
    expect(sceneMode('building', quiet)).toBe('building')
    expect(sceneMode('building', world)).toBe('status')
    expect(sceneMode('building', { ...world, approved_plan: { ...world.plan, status: 'executing' } })).toBe('response')
    expect(sceneMode('people', world)).toBe('people')
  })

  it('the legend says what the colours mean, and the twin offers nothing to approve', () => {
    const { container, rerender } = render(<ViewLegend mode="status" level="all" />)
    expect(screen.getByText('water')).toBeTruthy()
    expect(screen.getByText('loses power if nobody acts')).toBeTruthy()
    rerender(<ViewLegend mode="response" level="all" />)
    expect(screen.getByText('left behind')).toBeTruthy()
    rerender(<ViewLegend mode="building" level="all" />)
    expect(screen.getByText(/Click a floor to look inside/)).toBeTruthy()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('People lists the named residents with their needs and who is away', () => {
    const w: WorldState = { ...world, plan: { ...world.plan, left_behind: ['maya'] } }
    render(<PeopleCard world={w} d={derived(w)} setLevel={() => {}} onPerson={() => {}} />)
    expect(screen.getByText('Maya Reyes')).toBeTruthy()
    expect(screen.getByText('left behind by this plan')).toBeTruthy()
    expect(screen.getByText(/wheelchair/)).toBeTruthy()
    expect(screen.getByText('Jordan Ellis')).toBeTruthy()
  })
})
