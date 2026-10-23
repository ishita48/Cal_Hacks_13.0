import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Check, Plan, PlanStep, WorldState } from '../state/types'
import { ledger, outcomes } from '../workstation/logic'

const decidePlan = vi.fn()
vi.mock('../lib/api', () => ({ api: { decidePlan: (...a: unknown[]) => decidePlan(...a) } }))
const { approveOnce } = await import('../lib/approve')

const step = (id: string, kind: PlanStep['kind'], count: number, people: string[] = []): PlanStep =>
  ({ id, order: 0, kind, actor: 'ra_4', title: id, reason: '', at_s: 0, deadline_s: null, people, target: null, command: null, satisfies: [], count }) as PlanStep
const check = (code: string, ok: boolean): Check => ({ code, label: code, ok, detail: ok ? '' : `${code} broken`, severity: 'safety' })
const plan = (over: Partial<Plan>): Plan => ({ version: 3, steps: [], left_behind: [], checks: [check('lifts_first', true)], ...over }) as Plan

describe('incident command outcomes', () => {
  it('counts the people each step helps by its head count, not its sample of names', () => {
    const o = outcomes(plan({ steps: [step('escort', 'escort', 2, ['maya']), step('relocate', 'relocate', 14, ['a', 'b']), step('notify', 'notify', 200)] }), 250)
    expect(o).toMatchObject({ assisted: 16, unresolved: 0, safe: 234, feasible: true, violations: [] })
  })

  it('is unresolved for whoever the plan leaves behind, and blocked by any failing hard check', () => {
    const o = outcomes(plan({ steps: [step('relocate', 'relocate', 3)], left_behind: ['maya'], checks: [check('lifts_first', true), check('no_wheelchair_on_stairs', false)] }), 20)
    expect(o.unresolved).toBe(1)
    expect(o.safe).toBe(16)
    expect(o.feasible).toBe(false)
    expect(o.violations.map((c) => c.code)).toEqual(['no_wheelchair_on_stairs'])
  })

  it('is not approvable without steps', () => {
    expect(outcomes(plan({}), 10).feasible).toBe(false)
  })
})

describe('after-action ledger', () => {
  it('keeps the world’s order, newest last, with the building clock’s time', () => {
    const world = { timeline: [1, 2, 3].map((n) => ({ step: n * 100, kind: 'k', severity: 'info', message: `m${n}`, data: {} })) } as unknown as WorldState
    const rows = ledger(world, { step: 300, time_of_day: 1000, dt: 0.2 }, 2)
    expect(rows.map((r) => r.message)).toEqual(['m2', 'm3'])
    expect(rows.map((r) => r.at)).toEqual([980, 1000])
  })
})

describe('approve & dispatch', () => {
  beforeEach(() => {
    decidePlan.mockReset()
    sessionStorage.clear()
  })

  it('sends a plan version once, however many times it is pressed', async () => {
    let release!: () => void
    decidePlan.mockImplementation(() => new Promise<void>((r) => (release = r)))
    const a = approveOnce('run1', 3, null)
    const b = approveOnce('run1', 3, null)
    release()
    expect(await a).toBe('sent')
    expect(await b).toBe('sent')
    expect(await approveOnce('run1', 3, null)).toBe('already')
    expect(decidePlan).toHaveBeenCalledTimes(1)
    expect(decidePlan).toHaveBeenCalledWith(3, 'approve', 'manager')
  })

  it('never sends a version that is already approved, and lets a refused one try again', async () => {
    expect(await approveOnce('run1', 4, 4)).toBe('already')
    decidePlan.mockRejectedValueOnce(new Error('The plan changed while you looked'))
    await expect(approveOnce('run1', 5, null)).rejects.toThrow('changed')
    decidePlan.mockResolvedValueOnce({})
    expect(await approveOnce('run1', 5, null)).toBe('sent')
    decidePlan.mockResolvedValueOnce({})
    expect(await approveOnce('run1', 6, 5)).toBe('sent')
    expect(decidePlan).toHaveBeenCalledTimes(3)
  })
})
