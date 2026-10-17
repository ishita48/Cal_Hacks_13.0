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

export const api = {
  sensor: (sensor_id: string, value: number) =>
    request('POST', '/api/sensor', { sensor_id, value, source: 'manual' }),
  clock: (body: { playing?: boolean; speed?: number }) => request('POST', '/api/clock', body),
  reset: () => request<{ run_id: string }>('POST', '/api/scenario/reset'),
  runs: () => request<RunSummary[]>('GET', '/api/runs'),
  replay: (run_id: string, speed?: number) => request('POST', '/api/replay', { run_id, speed }),
}

export function formatTimeOfDay(seconds: number): string {
  const s = Math.floor(seconds) % 86400
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}
