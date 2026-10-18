import { useEffect, useState } from 'react'
import { api, type RunSummary } from '../lib/api'
import { STATUS_COLOR } from '../lib/labels'
import type { WorldState } from '../state/types'

interface Props {
  world: WorldState
}

const SENSOR = 'basement_mech_1'

/** Inputs to the world: the sensor, and the two levers a human (or later an agent) can pull. */
export function Controls({ world }: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showRuns, setShowRuns] = useState(false)

  const act = (fn: () => Promise<unknown>) => () => {
    setError(null)
    fn().catch((e: Error) => setError(e.message))
  }

  useEffect(() => {
    api.runs().then(setRuns).catch(() => {})
  }, [world.run_id])

  const sensor = world.sensors[SENSOR]
  const leak = world.leaks['water_riser']
  const valve = world.equipment['main_valve']?.status ?? 'online'
  const msbB = world.equipment['msb_b']?.status ?? 'online'
  const replay = world.mode === 'replay'

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Sensor · {SENSOR}</h2>
      <div className={`rounded-lg border p-3 ${sensor?.wet ? 'border-haven-water bg-haven-water/10' : 'border-ink-600'}`}>
        <div className="flex items-baseline justify-between">
          <div className="text-2xl font-semibold tabular-nums">{((sensor?.value ?? 0) * 100).toFixed(0)}%</div>
          <div className="text-xs text-slate-400">{sensor?.wet ? 'WATER DETECTED' : 'dry'} · {sensor?.source ?? '—'}</div>
        </div>
        {leak && (
          <div className="mt-1 text-xs text-haven-water">
            riser burst · {leak.flow_lps.toFixed(0)} L/s {leak.active ? '' : '· stopped (valve closed)'}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button
          disabled={replay}
          className="flex-1 rounded bg-haven-water/90 px-3 py-2 text-sm font-medium text-ink-950 hover:bg-haven-water disabled:opacity-30"
          onClick={act(() => api.sensor(SENSOR, 0.85))}
        >
          Simulate leak
        </button>
        <button disabled={replay} className="flex-1 rounded bg-ink-700 px-3 py-2 text-sm hover:bg-ink-600 disabled:opacity-30" onClick={act(() => api.sensor(SENSOR, 0.02))}>
          Dry
        </button>
      </div>

      <h2 className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Levers</h2>
      <div className="grid grid-cols-2 gap-2">
        <Lever
          label="Close main valve"
          hint="plumber · ~7 min"
          status={valve}
          disabled={replay || valve !== 'online'}
          onClick={act(() => api.command('main_valve', 'close', 'plumber'))}
        />
        <Lever
          label={msbB === 'isolated' ? 'Restore MSB-B' : 'Cut MSB-B'}
          hint="floors 3–4 dark, lifts on generator"
          status={msbB}
          disabled={replay || msbB === 'flooded'}
          onClick={act(() => api.command('msb_b', msbB === 'isolated' ? 'on' : 'off', 'manager'))}
        />
      </div>

      <div className="flex gap-2">
        <button className="flex-1 rounded bg-ink-700 px-3 py-2 text-sm hover:bg-ink-600" onClick={act(api.reset)}>
          New run (reset world)
        </button>
        <button className="rounded bg-ink-800 px-3 py-2 text-xs text-slate-400 hover:bg-ink-700" onClick={() => setShowRuns((v) => !v)}>
          runs ({runs.length})
        </button>
      </div>
      {showRuns && (
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {runs.slice(0, 12).map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded border border-ink-700 px-2 py-1 text-[11px]">
              <span className="font-mono">
                {r.id}
                <span className="ml-2 text-slate-500">{r.event_count} ev</span>
              </span>
              <button disabled={r.event_count === 0} className="rounded bg-ink-700 px-2 py-0.5 hover:bg-ink-600 disabled:opacity-30" onClick={act(() => api.replay(r.id, 5))}>
                Replay
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-haven-danger">{error}</p>}
    </div>
  )
}

function Lever({ label, hint, status, disabled, onClick }: { label: string; hint: string; status: string; disabled: boolean; onClick: () => void }) {
  return (
    <button disabled={disabled} onClick={onClick} className="rounded border border-ink-600 bg-ink-800 px-3 py-2 text-left hover:bg-ink-700 disabled:opacity-40">
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[status as keyof typeof STATUS_COLOR] ?? '#64748b' }} />
        {label}
      </div>
      <div className="text-[10px] text-slate-500">
        {hint} · {status}
      </div>
    </button>
  )
}
