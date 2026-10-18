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
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Sensor</span>
        <span className="mono text-[10px] text-t3">{SENSOR}</span>
      </div>

      <div className={`glass-card p-3.5 ${sensor?.wet ? 'tint-cyan' : ''}`}>
        <div className="flex items-end justify-between">
          <div className={`num text-[32px] leading-none ${sensor?.wet ? 'text-haven-water' : 'text-t1'}`}>
            {((sensor?.value ?? 0) * 100).toFixed(0)}
            <span className="ml-0.5 text-[14px] font-medium text-t3">%</span>
          </div>
          <div className="text-right">
            <div className={`text-[12px] font-medium ${sensor?.wet ? 'text-haven-water' : 'text-t2'}`}>{sensor?.wet ? 'Water detected' : 'Dry'}</div>
            <div className="label mono">{sensor?.source ?? '—'}</div>
          </div>
        </div>
        {leak && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-haven-water">
            <span className={`h-1.5 w-1.5 rounded-full bg-haven-water ${leak.active ? 'haven-pulse' : ''}`} />
            riser burst · {leak.flow_lps.toFixed(0)} L/s{leak.active ? '' : ' · stopped, valve closed'}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button disabled={replay} className="btn-primary flex-1" onClick={act(() => api.sensor(SENSOR, 0.85))}>
          Simulate leak
        </button>
        <button disabled={replay} className="btn-secondary flex-1" onClick={act(() => api.sensor(SENSOR, 0.02))}>
          Dry
        </button>
      </div>

      <span className="eyebrow mt-1">Levers</span>
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
          danger={msbB !== 'isolated'}
          disabled={replay || msbB === 'flooded'}
          onClick={act(() => api.command('msb_b', msbB === 'isolated' ? 'on' : 'off', 'manager'))}
        />
      </div>

      <div className="flex gap-2">
        <button className="btn-secondary btn-sm flex-1" onClick={act(api.reset)}>
          New run
        </button>
        <button className="btn-secondary btn-sm" onClick={act(api.loadDemo)} title="Replays the recorded canonical run at 5×: leak, Maya off/on, spoken rule, approve, HAVEN acts">
          Replay demo
        </button>
        <button className="btn-secondary btn-sm mono" onClick={() => setShowRuns((v) => !v)}>
          runs · {runs.length}
        </button>
      </div>

      {showRuns && (
        <ul className="glass-card max-h-40 overflow-y-auto px-3">
          {runs.slice(0, 12).map((r) => (
            <li key={r.id} className="row flex items-center justify-between py-1.5 text-[11px]">
              <span className="mono text-t2">
                {r.id}
                <span className="ml-2 text-t3">{r.event_count} ev</span>
              </span>
              <button disabled={r.event_count === 0} className="btn-secondary btn-sm" onClick={act(() => api.replay(r.id, 5))}>
                Replay
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-[11px] text-haven-danger">{error}</p>}
    </div>
  )
}

function Lever({
  label,
  hint,
  status,
  disabled,
  danger,
  onClick,
}: {
  label: string
  hint: string
  status: string
  disabled: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button disabled={disabled} onClick={onClick} className={`glass-card px-3 py-2.5 text-left transition-transform active:scale-[0.98] disabled:opacity-35 ${danger ? 'hover:tint-red' : ''}`}>
      <div className="flex items-center gap-2 text-[13px] font-medium text-t1">
        <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[status as keyof typeof STATUS_COLOR] ?? '#8e8e93' }} />
        {label}
      </div>
      <div className="label mt-0.5">
        {hint} · <span className="mono">{status}</span>
      </div>
    </button>
  )
}
