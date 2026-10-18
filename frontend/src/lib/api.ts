import type { AgentInfo, BudsReply, BuildingSpec, FetchStatus, Graph, IncidentMemory, Integrations, MemoryRule, NegotiationStatus, Roster, RuleParse, SensorHistory, SponsorReport } from '../state/types'

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

export interface LoggedEvent {
  seq: number
  run_id: string
  step: number
  wall_time: number
  event: { type: string } & Record<string, unknown>
}

export const api = {
  sensor: (sensor_id: string, value: number) =>
    request('POST', '/api/sensor', { sensor_id, value, source: 'manual' }),
  command: (equipment_id: string, command: Command, actor = 'operator') =>
    request('POST', '/api/command', { equipment_id, command, actor }),
  clock: (body: { playing?: boolean; speed?: number }) => request('POST', '/api/clock', body),
  reset: () => request<{ run_id: string }>('POST', '/api/scenario/reset'),
  runs: () => request<RunSummary[]>('GET', '/api/runs'),
  replay: (run_id: string, speed?: number) => request('POST', '/api/replay', { run_id, speed }),
  explain: (agent: string, round = 2) =>
    request<{ agent: string; label: string; stance: string; source: string; text: string }>('POST', '/api/agents/explain', { agent, round }),
  brief: () => request<{ text: string; source: string; version?: number }>('GET', '/api/plan/brief'),
  loadDemo: () => request<{ run_id: string; mode: string; event_count: number }>('POST', '/api/demo/load'),
  building: () => request<BuildingSpec>('GET', '/api/building'),
  people: () => request<Roster>('GET', '/api/people'),
  sensorHistory: (sensorId: string, limit = 120) =>
    request<SensorHistory>('GET', `/api/sensor/${encodeURIComponent(sensorId)}/history?limit=${limit}`),
  agents: () => request<AgentInfo[]>('GET', '/api/agents'),
  integrations: () => request<Integrations>('GET', '/api/integrations'),
  fetchStatus: () => request<FetchStatus>('GET', '/api/fetch'),
  negotiation: () => request<NegotiationStatus>('GET', '/api/negotiation'),
  acknowledge: (step_id: string, actor: string, status: 'done' | 'failed' = 'done', detail = '') =>
    request('POST', '/api/action', { step_id, actor, status, detail }),
  memory: () => request<MemoryRule[]>('GET', '/api/memory'),
  incidents: () => request<IncidentMemory>('GET', '/api/memory/incidents'),
  graph: () => request<Graph>('GET', '/api/graph'),
  sponsors: (fresh = false) => request<SponsorReport>('GET', `/api/sponsors${fresh ? '?fresh=true' : ''}`),
  budsAsk: (text: string) => request<BudsReply>('POST', '/api/buds/ask', { text }),
  budsAct: (kind: string, payload: Record<string, unknown>) => request('POST', '/api/buds/act', { kind, payload }),
  runEvents: (runId: string) => request<LoggedEvent[]>('GET', `/api/runs/${encodeURIComponent(runId)}/events`),
  applyMemory: (code: string, actor = 'manager') => request('POST', '/api/memory/apply', { code, actor }),
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
