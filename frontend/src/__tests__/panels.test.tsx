// Smoke tests: every panel renders a realistic world frame without throwing and shows the
// facts the demo depends on. Rendering only; the backend owns all logic.
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { CascadePanel } from '../components/CascadePanel'
import { ImpactLedger } from '../components/ImpactLedger'
import { MessagesPanel } from '../components/MessagesPanel'
import { PlanPanel } from '../components/PlanPanel'
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
