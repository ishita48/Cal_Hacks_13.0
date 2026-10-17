import { useEffect, useState } from 'react'
import { api, formatTimeOfDay, type RunSummary } from './lib/api'
import { connectWorld, useWorld } from './state/world'

export default function App() {
  useEffect(() => connectWorld(), [])
  const { connection, clock, world } = useWorld()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [error, setError] = useState<string | null>(null)

  const act = (fn: () => Promise<unknown>) => () => {
    setError(null)
    fn().catch((e: Error) => setError(e.message))
  }

  useEffect(() => {
    api.runs().then(setRuns).catch(() => {})
  }, [world?.run_id])

  const sensor = world?.sensors['basement_mech_1']

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-6 border-b border-ink-700 bg-ink-900 px-5 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-[0.2em] text-white">HAVEN</span>
          <span className="text-xs text-slate-500">David Blackwell Hall · world-state spine</span>
        </div>
        <div className="font-mono text-2xl tabular-nums text-white">
          {clock ? formatTimeOfDay(clock.time_of_day) : '--:--:--'}
        </div>
        <div className="flex gap-1">
          <button
            className="rounded bg-ink-700 px-3 py-1 text-sm hover:bg-ink-600"
            onClick={act(() => api.clock({ playing: !clock?.playing }))}
          >
            {clock?.playing ? 'Pause' : 'Play'}
          </button>
          {[1, 5, 20, 60].map((s) => (
            <button
              key={s}
              className={`rounded px-2 py-1 text-sm ${clock?.speed === s ? 'bg-slate-200 text-ink-900' : 'bg-ink-700 hover:bg-ink-600'}`}
              onClick={act(() => api.clock({ speed: s }))}
            >
              {s}×
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {clock?.mode === 'replay' && (
            <span className="rounded border border-amber-500/50 px-2 py-0.5 text-amber-400">
              REPLAY · {clock.replay_remaining} events left
            </span>
          )}
          <span className="flex items-center gap-1.5 text-slate-400">
            <span
              className={`h-2 w-2 rounded-full ${connection === 'open' ? 'bg-haven-safe' : connection === 'connecting' ? 'bg-amber-400' : 'bg-haven-danger'}`}
            />
            {connection}
          </span>
          <span className="font-mono text-slate-500">run {world?.run_id ?? '—'} · v{world?.version ?? 0}</span>
        </div>
      </header>

      <main className="grid flex-1 grid-cols-[320px_1fr_320px] gap-px overflow-hidden bg-ink-700">
        <section className="flex flex-col gap-4 bg-ink-900 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Sensor · basement_mech_1</h2>
          <div className={`rounded-lg border p-4 ${sensor?.wet ? 'border-haven-water bg-haven-water/10' : 'border-ink-600'}`}>
            <div className="text-3xl font-semibold tabular-nums">{((sensor?.value ?? 0) * 100).toFixed(0)}%</div>
            <div className="text-sm text-slate-400">{sensor?.wet ? 'WATER DETECTED' : 'dry'} · source {sensor?.source ?? '—'}</div>
          </div>
          <div className="flex gap-2">
            <button
              className="flex-1 rounded bg-haven-water/90 px-3 py-2 text-sm font-medium text-ink-950 hover:bg-haven-water"
              onClick={act(() => api.sensor('basement_mech_1', 0.85))}
            >
              Simulate leak
            </button>
            <button
              className="flex-1 rounded bg-ink-700 px-3 py-2 text-sm hover:bg-ink-600"
              onClick={act(() => api.sensor('basement_mech_1', 0.02))}
            >
              Dry
            </button>
          </div>
          <button className="rounded bg-ink-700 px-3 py-2 text-sm hover:bg-ink-600" onClick={act(api.reset)}>
            New run (reset world)
          </button>
          {error && <p className="text-xs text-haven-danger">{error}</p>}
        </section>

        <section className="overflow-y-auto bg-ink-950 p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Timeline</h2>
          <ol className="space-y-2">
            {[...(world?.timeline ?? [])].reverse().map((t, i) => (
              <li key={`${t.step}-${i}`} className="flex gap-3 rounded border border-ink-700 bg-ink-900 px-3 py-2 text-sm">
                <span className="font-mono text-slate-500">
                  {clock ? formatTimeOfDay(clock.time_of_day - (clock.step - t.step) * clock.dt) : t.step}
                </span>
                <span className={t.severity === 'critical' ? 'text-haven-danger' : t.severity === 'warning' ? 'text-amber-400' : ''}>
                  {t.message}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="overflow-y-auto bg-ink-900 p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Recorded runs</h2>
          <ul className="space-y-2">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center justify-between rounded border border-ink-700 px-3 py-2 text-xs">
                <span className="font-mono">
                  {r.id}
                  <span className="ml-2 text-slate-500">{r.event_count} ev</span>
                </span>
                <button
                  disabled={r.event_count === 0}
                  className="rounded bg-ink-700 px-2 py-1 hover:bg-ink-600 disabled:opacity-30"
                  onClick={act(() => api.replay(r.id, 5))}
                >
                  Replay
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  )
}
