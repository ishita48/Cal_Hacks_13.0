import type { AgentInfo, BuildingSpec, Roster, RuleParse } from '../state/types'

const base = import.meta.env.VITE_HAVEN_API ?? ''

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export interface RunSummary {
  id: string
  scenario: string
  created_at: number
  event_count: number
}

export type Command = 'close' | 'open' | 'off' | 'on'

export const api = {
  sensor: (sensor_id: string, value: number) =>
    request('POST', '/api/sensor', { sensor_id, value, source: 'manual' }),
  command: (equipment_id: string, command: Command, actor = 'operator') =>
    request('POST', '/api/command', { equipment_id, command, actor }),
  clock: (body: { playing?: boolean; speed?: number }) => request('POST', '/api/clock', body),
  reset: () => request<{ run_id: string }>('POST', '/api/scenario/reset'),
  runs: () => request<RunSummary[]>('GET', '/api/runs'),
  replay: (run_id: string, speed?: number) => request('POST', '/api/replay', { run_id, speed }),
  building: () => request<BuildingSpec>('GET', '/api/building'),
  people: () => request<Roster>('GET', '/api/people'),
  agents: () => request<AgentInfo[]>('GET', '/api/agents'),
  toggleAgent: (agent: string, enabled: boolean) => request('POST', '/api/agent', { agent, enabled }),
  decidePlan: (plan_version: number, decision: 'approve' | 'reject', actor = 'manager') =>
    request('POST', '/api/plan/decision', { plan_version, decision, actor }),
  rule: (text: string, code: string, actor = 'manager') => request('POST', '/api/rule', { text, code, actor }),
  parseRule: (text: string, actor = 'manager', submit = true) =>
    request<RuleParse>('POST', '/api/rule/parse', { text, actor, submit }),
}

export function formatTimeOfDay(seconds: number): string {
  const s = Math.floor(seconds) % 86400
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

export function formatClockHM(seconds: number): string {
  const s = Math.floor(seconds) % 86400
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`
}

/** "in 12 min 30 s" style countdown; negative = already due. */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'now'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m >= 60) return `${Math.floor(m / 60)} h ${m % 60} min`
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`
  return `${s} s`
}
