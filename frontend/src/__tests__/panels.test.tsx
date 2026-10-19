// Smoke tests: every panel renders a realistic world frame without throwing and shows the
// facts the demo depends on. Rendering only; the backend owns all logic.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
import { AgentConsole } from '../components/AgentConsole'
import { CascadePanel } from '../components/CascadePanel'
import { ImpactLedger } from '../components/ImpactLedger'
import { MessagesPanel } from '../components/MessagesPanel'
import { PlanPanel } from '../components/PlanPanel'
import { StoryStrip } from '../components/StoryStrip'
import { useBuilding } from '../state/building'
import { clock, world } from './fixture'

beforeAll(() => {
  // The static building store normally loads over HTTP; seed just what the panels read.
  useBuilding.setState({
    residents: {
      maya: { id: 'maya', name: 'Maya Reyes', room: 'room_412', level: 'L4', year: 'Junior', needs: ['step_free_route'], presence: 'in_room', location: null, away_until: null, contact: { channel: 'call', lang: 'en' }, medication_location: null, role: 'resident', story: 'Uses a power wheelchair.' },
    },
    spaces: {
      room_412: { id: 'room_412', level: 'L4', kind: 'room', name: 'Room 412', rect: { x0: 0, y0: 0, x1: 4, y1: 6 }, capacity: 1, accessible: true, outdoor: false, tags: [] },
    },
    storyIds: ['maya'],
    heroId: 'maya',
    heroLevel: 'L4',
    agents: {
      safety: { id: 'safety', label: 'Safety agent', kind: 'specialist', description: 'Hard veto.', enabled: true, resident: null, name: null, level: null, needs: [], named: false, fixed: false },
      'resident:maya': { id: 'resident:maya', label: "Maya's agent", kind: 'resident', description: 'Uses a power wheelchair.', enabled: true, resident: 'maya', name: 'Maya Reyes', level: 'L4', needs: ['step_free_route'], named: true, fixed: false },
    },
  })
})

describe('the story strip and the agents', () => {
  it('story strip says what is happening, offers Approve and the hero switch', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    render(<StoryStrip world={world} clock={clock} />)
    expect(screen.getByText(/Water is pouring into the mechanical room/)).toBeTruthy()
    expect(screen.getByText(/The agents propose/)).toBeTruthy()
    expect(screen.getByText(/Approve plan v3/)).toBeTruthy()
    expect(screen.getByText(/Maya's agent is speaking/)).toBeTruthy()
    expect(screen.getByText(/until water reaches MSB section B/)).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('story strip names who is left behind and asks for the switch', () => {
    const off = { ...world, agents: { ...world.agents, 'resident:maya': false }, narrative: { ...world.narrative, next: 'This plan leaves Maya behind. Maya\'s agent is off: nobody spoke for them.', ask: "Switch Maya's agent back on and watch the plan change." } }
    render(<StoryStrip world={off} clock={clock} />)
    expect(screen.getByText(/leaves Maya behind/)).toBeTruthy()
    expect(screen.getByText(/Maya's agent is off · switch it on/)).toBeTruthy()
  })

  it('agent console puts the hero first with a switch and a stance', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"configured":false,"running":false,"agents":[],"received":0,"agreeing":0}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    render(<AgentConsole world={world} />)
    expect(screen.getAllByText(/Maya's agent/).length).toBeGreaterThan(0)
    expect(screen.getByText(/the Maya moment/)).toBeTruthy()
    expect(screen.getByText(/Lift escort finishes at \+6 min/)).toBeTruthy()
    expect(screen.getByText('Safety agent')).toBeTruthy()
    vi.unstubAllGlobals()
  })
})

describe('panels render the frame', () => {
  it('plan panel shows the headline, steps and checks', () => {
    render(<PlanPanel world={world} clock={clock} />)
    expect(screen.getByText(/Hold the lifts 6 min/)).toBeTruthy()
    expect(screen.getByText(/Two staff bring Maya Reyes down by lift first/)).toBeTruthy()
    expect(screen.getAllByText(/checks pass/).length).toBeGreaterThan(0)
  })

  it('plan panel shouts when someone is left behind', () => {
    const stranded = { ...world, plan: { ...world.plan, left_behind: ['maya'], headline: 'Cut the power now. Maya is left behind.' } }
    render(<PlanPanel world={stranded} clock={clock} />)
    expect(screen.getAllByText(/Left behind/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Maya Reyes/).length).toBeGreaterThan(0)
  })

  it('cascade panel lists forecast events with countdowns', () => {
    render(<CascadePanel world={world} clock={clock} />)
    expect(screen.getByText(/MSB section B under water/)).toBeTruthy()
    expect(screen.getAllByText(/^in /).length).toBeGreaterThan(0)
    expect(screen.getByText(/Water detected by basement_mech_1/)).toBeTruthy()
  })

  it('impact ledger falls back to the forecast when nothing is affected yet', () => {
    render(<ImpactLedger world={world} clock={clock} />)
    expect(screen.getAllByText(/Maya Reyes/).length).toBeGreaterThan(0)
    expect(screen.getByText(/No step-free route/)).toBeTruthy()
  })

  it('messages panel shows the tailored message', () => {
    render(<MessagesPanel world={world} clock={clock} />)
    expect(screen.getByText(/staff are coming to your door/)).toBeTruthy()
  })
})
