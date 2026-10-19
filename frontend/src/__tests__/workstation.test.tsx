// The workstation panel: one status, the incident in plain words, the response in a few steps with
// Approve / Modify / View details, then the task list. Every fact comes from the frame or the ops snapshot.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OpsSnapshot, Resident, Space, WorldState } from '../state/types'
import { useBuilding } from '../state/building'
import { useWorld } from '../state/world'
import { buildingStatus, greeting, incidentInfo, needingHelp, phases, progress, routineCheck, wingAt, wingsOf } from '../workstation/logic'
import { Panel } from '../workstation/Panel'
import { clock, plan, world } from './fixture'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const levels = { B1: { id: 'B1', index: -1, name: 'Basement', elevation: -4.5, height: 4.5, short: 'basement' }, L4: { id: 'L4', index: 4, name: 'Floor 4', elevation: 11.2, height: 3.1, short: '4' } }
const space = (id: string, level: string, name: string): Space => ({ id, level, kind: 'room', name, rect: { x0: 0, y0: 0, x1: 4, y1: 4 }, capacity: 2, accessible: true, outdoor: false, tags: [] })
const maya: Resident = { id: 'maya', name: 'Maya Reyes', room: 'room_412', level: 'L4', year: '', needs: ['step_free_route'], presence: 'in_room', location: null, away_until: null, contact: { channel: 'call', lang: 'en' }, medication_location: null, role: 'resident', story: null }

const ops = (overdue: number, critical: number): OpsSnapshot =>
  ({
    date: '2026-10-19',
    energy: {} as OpsSnapshot['energy'],
    health: [],
    audit: { single: [], rooms: [], common_mode: [], flood_probe_m: 0.15 },
    findings: critical ? [{ id: 'raise:msb_b', severity: 'critical', equipment: 'msb_b', kind: 'design', title: 'Raise MSB section B onto a 30 cm pad', why: '', protects: 260, stranded: 2, work_order: null }] : [],
    summary: { plant: 27, overdue, critical_findings: critical, open_findings: critical, single_points: 0, people_exposed: 0 },
  }) as OpsSnapshot

const quiet: WorldState = { ...world, narrative: { ...world.narrative, stage: 'quiet', headline: 'Blackwell Hall is quiet.' }, leaks: {}, plan: { ...plan, status: 'none', steps: [] } }
const flagged: WorldState = {
  ...world,
  impact: { ...world.impact, residents: [{ id: 'maya', name: 'Maya Reyes', room: 'room_412', level: 'L4', presence: 'in_room', needs: ['step_free_route'], impacts: ['stranded', 'power_lost'], severity: 'critical', channel: 'call', lang: 'es', role: 'resident' }] },
}

beforeAll(() => {
  useBuilding.setState({
    levels,
    spaces: { 'B1-mech': space('B1-mech', 'B1', 'Mechanical room'), room_412: space('room_412', 'L4', 'Room 412'), 'L1-lobby': space('L1-lobby', 'L4', 'Lobby') },
    equipment: { water_riser: { id: 'water_riser', kind: 'water_riser', name: 'Domestic water riser', level: 'B1', x: 1, y: 1, space: 'B1-mech', flood_height: null, props: {} } },
    residents: { maya },
    storyIds: ['maya'],
    heroId: 'maya',
  })
})

describe('the workstation reads the world', () => {
  it('status: healthy, attention needed for overdue maintenance, emergency in an incident', () => {
    expect(buildingStatus(quiet, null).health).toBe('checking')
    expect(buildingStatus(quiet, ops(0, 0))).toMatchObject({ health: 'healthy', label: 'Healthy' })
    expect(buildingStatus(quiet, ops(7, 3))).toMatchObject({ health: 'attention', why: 'No incident. 7 plant items overdue for service and 3 critical findings from the resilience audit.' })
    expect(buildingStatus(world, null)).toMatchObject({ health: 'emergency', why: 'A response plan is waiting for your approval.' })
  })

  it('the incident: a leak, where it is, how bad', () => {
    expect(incidentInfo(quiet, {}, {}, levels)).toBeNull()
    const spaces = useBuilding.getState().spaces
    expect(incidentInfo(world, spaces, useBuilding.getState().equipment, levels)).toEqual({ type: 'Water leak', location: 'Mechanical room, Basement', severity: 'Emergency' })
  })

  it('the response: every plan step lands in one of a few plain phases', () => {
    const groups = phases(plan, {})
    expect(groups.map((g) => g.title)).toEqual(['Make the building safe', 'Help the people who need it first'])
    expect(groups.flatMap((g) => g.steps.map((s) => s.id)).sort()).toEqual(plan.steps.map((s) => s.id).sort())
  })

  it('who needs help: the plan coverage and how they want to be reached', () => {
    const { people, predicted } = needingHelp(flagged, ['maya'])
    expect(predicted).toBe(false)
    expect(people[0]).toMatchObject({ name: 'Maya Reyes', needs: 'wheelchair', state: 'covered', contact: 'call, Spanish' })
    const left = needingHelp({ ...flagged, plan: { ...plan, left_behind: ['maya'] } }, ['maya'])
    expect(left.people[0].state).toBe('left')
    // before the water reaches anyone, the forecast says who will need help
    expect(needingHelp(world, ['maya']).predicted).toBe(true)
  })

  it('progress: done, in progress and pending come from recorded actions', () => {
    expect(progress(world)).toBeNull()
    const acting: WorldState = { ...world, approved_plan: { ...plan, status: 'executing' }, actions: { escort_maya: { step_id: 'escort_maya', status: 'done', step: 400, detail: 'confirmed by Ben' } } }
    const p = progress(acting)!
    expect(p.done.map((s) => s.id)).toEqual(['escort_maya'])
    expect(p.waiting.map((s) => s.id)).toEqual(['isolate_ats_eq'])
    expect(p.acks[0]).toMatchObject({ detail: 'confirmed by Ben' })
  })

  it('a greeting from the world clock', () => {
    expect(greeting(23 * 3600)).toBe('Good evening')
    expect(greeting(9 * 3600)).toBe('Good morning')
  })
})

describe('wings, the routine check and the checklist', () => {
  const footprint = [
    { x0: 0, y0: 0, x1: 14, y1: 84 },
    { x0: 14, y0: 0, x1: 40, y1: 14 },
    { x0: 14, y0: 34, x1: 46, y1: 48 },
    { x0: 32, y0: 48, x1: 46, y1: 70 },
    { x0: 14, y0: 70, x1: 46, y1: 84 },
  ]
  it('reads the wings off the footprint, not a list in the code', () => {
    const w = wingsOf(footprint)
    expect(w.map((x) => x.id)).toEqual(['east', 'west', 'north', 'south'])
    expect(wingAt(5, 40, footprint, w)).toBe('west')
    expect(wingAt(40, 60, footprint, w)).toBe('east')
    expect(wingAt(30, 80, footprint, w)).toBe('north')
    expect(wingAt(25, 5, footprint, w)).toBe('south')
    expect(wingsOf([footprint[0]])).toEqual([])
  })

  it('the routine check reports what the instruments say', () => {
    const lines = routineCheck(world, ops(7, 3))
    expect(lines.find((l) => l.id === 'sensors')).toMatchObject({ value: '1 of 1 wet', ok: false })
    expect(lines.find((l) => l.id === 'leaks')).toMatchObject({ value: '1 active leak', ok: false })
    expect(lines.find((l) => l.id === 'plant')).toMatchObject({ value: '7 of 27 items overdue', ok: false })
    const calm = routineCheck(quiet, ops(0, 0))
    expect(calm.find((l) => l.id === 'leaks')?.ok).toBe(true)
  })
})

describe('the workstation panel', () => {
  const props = { onDrill: () => {}, onDemo: () => {}, onOps: () => {}, onPlan: () => {}, details: false, setDetails: () => {}, children: null }
  const stub = (calls: string[], opsBody: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const body = url.startsWith('/api/ops') && !url.includes('work-order') ? opsBody : url.startsWith('/api/memory') ? [] : { ok: true }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

  it('an incident: badges on the widgets, details on a click, Review and Approve', async () => {
    useWorld.setState({ world: flagged, clock, connection: 'open' })
    const calls: string[] = []
    stub(calls, ops(0, 0))
    render(<Panel world={flagged} clock={clock} {...props} />)
    expect(screen.getByText('Good evening')).toBeTruthy()
    // Gmail-style badges: 1 incident, 2 steps to approve, 1 person in critical need
    expect(screen.getAllByText('1', { selector: '.ws2-badge' })).toHaveLength(2)
    expect(screen.getByText('2', { selector: '.ws2-badge' })).toBeTruthy()
    // details stay hidden until asked
    expect(screen.queryByText(world.narrative.headline)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Active incidents/ }))
    expect(screen.getByText(world.narrative.headline)).toBeTruthy()
    expect(screen.getByText('Water leak', { selector: '.ws2-strong' })).toBeTruthy()
    // HAVEN response: review opens the phases; nothing is sent until Approve
    fireEvent.click(screen.getByText('Review'))
    expect(screen.getAllByText('Make the building safe').length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(0)
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(calls).toContain('POST /api/plan/decision'))
  })

  it('a quiet night: the routine check and the checklist use the audit; ticking closes a work order', async () => {
    const calls: string[] = []
    stub(calls, ops(7, 1))
    render(<Panel world={quiet} clock={clock} {...props} />)
    await waitFor(() => expect(screen.getByText('Raise MSB section B onto a 30 cm pad')).toBeTruthy())
    fireEvent.click(screen.getByText('Start routine check'))
    await waitFor(() => expect(screen.getByText(/things? to look at/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Mark done: Raise MSB section B onto a 30 cm pad'))
    await waitFor(() => expect(calls).toContain('POST /api/ops/work-order'))
  })

  it('emergency calls ask first, go through the dialer, and are never reported as made', async () => {
    const calls: string[] = []
    stub(calls, ops(0, 0))
    render(<Panel world={flagged} clock={clock} {...props} />)
    fireEvent.click(screen.getByText('Call 911', { selector: '.ws2-sos-btn span' }))
    expect(screen.getByText('Call 911?')).toBeTruthy()
    const dial = screen.getByText('Call 911', { selector: 'a' }) as HTMLAnchorElement
    expect(dial.getAttribute('href')).toBe('tel:911')
    expect(screen.getByText(/does not place the call/)).toBeTruthy()
    fireEvent.click(dial)
    expect(screen.queryByText(/call (was )?(made|placed|completed)/i)).toBeNull()
    // no number on file: emergency services says so instead of pretending
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.click(screen.getByText('Emergency services'))
    expect(screen.getByText(/No emergency-services number is set up/)).toBeTruthy()
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(0)
  })
})
