import type { Me, Role } from '../state/me'
import type { AgentInfo, BudsReply, BuildingSpec, FetchStatus, Graph, IncidentMemory, Integrations, MemoryRule, NegotiationStatus, OpsSnapshot, Roster, RuleParse, SensorHistory, SponsorReport } from '../state/types'

const base = import.meta.env.VITE_HAVEN_API ?? ''

// Who is asking. Signed in with Clerk, every request carries the session token and the server decides the
// role; without Clerk the demo declares one (X-Haven-Role, a per-viewer choice), and the server says so.
let tokenGetter: (() => Promise<string | null>) | null = null
export function setTokenGetter(getter: (() => Promise<string | null>) | null) {
  tokenGetter = getter
}

export function demoRole(): Role | null {
  try {
    return (localStorage.getItem('haven.role') as Role | null) || null
  } catch {
    return null
  }
}

/** An admin looking through another role's eyes (the server honours it for a verified admin only, read-only). */
export interface Preview {
  role: Role
  person: string | null
}
const PREVIEW_KEY = 'haven.preview'
export function getPreview(): Preview | null {
  try {
    const raw = localStorage.getItem(PREVIEW_KEY)
    return raw ? (JSON.parse(raw) as Preview) : null
  } catch {
    return null
  }
}
export function setPreview(p: Preview | null) {
  try {
    if (p) localStorage.setItem(PREVIEW_KEY, JSON.stringify(p))
    else localStorage.removeItem(PREVIEW_KEY)
  } catch {
    /* private window */
  }
}

/** The request's credentials. `portal` adds an admin's preview, which only the role-scoped portal reads. */
export async function identity(portal = false): Promise<Record<string, string>> {
  if (tokenGetter) {
    const token = await tokenGetter()
    const preview = portal ? getPreview() : null
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(preview ? { 'X-Haven-Role': preview.role, ...(preview.person ? { 'X-Haven-Person': preview.person } : {}) } : {}),
    }
  }
  const role = demoRole()
  const person = localStorage.getItem('haven.person')
  return { ...(role ? { 'X-Haven-Role': role } : {}), ...(person ? { 'X-Haven-Person': person } : {}) }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(await identity(path.startsWith('/api/portal/'))), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    // FastAPI puts the reason in {"detail": ...}; surface that sentence, not the envelope.
    const text = await res.text()
    let detail = text
    try {
      const parsed = JSON.parse(text) as { detail?: unknown }
      if (typeof parsed.detail === 'string') detail = parsed.detail
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `${method} ${path} → ${res.status}`)
  }
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
  me: () => request<Me>('GET', '/api/me'),
  notifyTest: (to?: string) => request<{ sent: boolean; to: string; from: string; id: string }>('POST', '/api/notify/test', { to }),
  fetchStatus: () => request<FetchStatus>('GET', '/api/fetch'),
  negotiation: () => request<NegotiationStatus>('GET', '/api/negotiation'),
  acknowledge: (step_id: string, actor: string, status: 'done' | 'failed' = 'done', detail = '') =>
    request('POST', '/api/action', { step_id, actor, status, detail }),
  memory: () => request<MemoryRule[]>('GET', '/api/memory'),
  incidents: () => request<IncidentMemory>('GET', '/api/memory/incidents'),
  graph: () => request<Graph>('GET', '/api/graph'),
  ops: () => request<OpsSnapshot>('GET', '/api/ops'),
  workOrder: (finding_id: string, status: 'open' | 'done' = 'open') => request('POST', '/api/ops/work-order', { finding_id, status }),
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
