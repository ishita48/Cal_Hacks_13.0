import { useEffect, useState } from 'react'
import { api, type RunSummary } from '../lib/api'
import { STATUS_COLOR } from '../lib/labels'
import { SensorChart } from './SensorChart'
import { useBuilding } from '../state/building'
import type { WorldState } from '../state/types'

interface Props {
  world: WorldState
}


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

  const equipment = useBuilding((b) => b.equipment)
  const SENSOR = useBuilding((b) => b.sensorId) ?? Object.keys(world.sensors)[0] ?? ''
  const sensor = world.sensors[SENSOR]
  // The leak (any active one), the valve on its supply (first valve in the spec), and the switchgear the
  // forecast says floods first: the two levers a human can pull, named from the data.
  const leak = Object.values(world.leaks)[0]
  const valveId = Object.values(equipment).find((e) => e.kind === 'valve')?.id
  // The other things that can fail: the grid feed and the standby set, by kind, never by id.
  const feedId = Object.values(equipment).find((e) => e.kind === 'utility_feed')?.id
  const genId = Object.values(equipment).find((e) => e.kind === 'generator')?.id
  const feedSt = feedId ? (world.equipment[feedId]?.status ?? 'online') : 'online'
  const genSt = genId ? (world.equipment[genId]?.status ?? 'online') : 'online'
  const valve = valveId ? (world.equipment[valveId]?.status ?? 'online') : 'online'
  const riskId = world.forecast.events.find((e) => e.kind === 'flooded')?.id ?? world.flooded[0] ?? Object.values(equipment).find((e) => e.kind === 'switchboard' || e.kind === 'transfer_switch')?.id
  const risk = riskId ? equipment[riskId] : undefined
  const msbB = riskId ? (world.equipment[riskId]?.status ?? 'online') : 'online'
  const darkSoon = world.forecast.impact.dark_levels
  const riskHint = darkSoon.length ? `${darkSoon.join(', ')} go dark${world.forecast.impact.lifts_down.length ? ', lifts stop' : ''}` : 'nothing at risk yet'
  const valveSecs = valveId ? Number(equipment[valveId].props?.seconds_to_close ?? 0) : 0
  const valveHint = valveSecs ? `plumber · closes in ~${Math.max(1, Math.round(valveSecs / 60))} min` : 'plumber'
  const replay = world.mode === 'replay'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow" data-buds="panel:controls">Sensor</span>
        <span className="mono text-[10px] text-t3">{SENSOR || 'no sensor'}</span>
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
        <SensorChart sensorId={SENSOR} />
        {leak && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-haven-water">
            <span className={`h-1.5 w-1.5 rounded-full bg-haven-water ${leak.active ? 'haven-pulse' : ''}`} />
            riser burst · {leak.flow_lps.toFixed(0)} L/s{leak.active ? '' : ' · stopped, valve closed'}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button disabled={replay} className="btn-primary flex-1" onClick={act(() => api.sensor(SENSOR, 0.85))} title="The reading the ESP32 sends when the probe is wet">
          Probe wet
        </button>
        <button disabled={replay} className="btn-secondary flex-1" onClick={act(() => api.sensor(SENSOR, 0.02))} title="The probe reads dry again (the riser stops leaking)">
          Probe dry
        </button>
      </div>

      <span className="eyebrow mt-1">Levers</span>
      <div className="grid grid-cols-2 gap-2">
        <Lever
          label={valveId ? `Close ${equipment[valveId].name.toLowerCase()}` : 'Close valve'}
          hint={valveHint}
          status={valve}
          disabled={replay || valve !== 'online'}
          onClick={act(() => (valveId ? api.command(valveId, 'close', 'plumber') : Promise.resolve()))}
        />
        <Lever
          label={msbB === 'isolated' ? `Restore ${risk?.name ?? 'the switchgear'}` : `Cut ${risk?.name ?? 'the switchgear'}`}
          hint={riskHint}
          status={msbB}
          danger={msbB !== 'isolated'}
          disabled={replay || msbB === 'flooded'}
          onClick={act(() => (riskId ? api.command(riskId, msbB === 'isolated' ? 'on' : 'off', 'manager') : Promise.resolve()))}
        />
        {feedId && (
          <Lever
            label={feedSt === 'isolated' ? 'Grid feed restored' : 'Grid outage'}
            hint={feedSt === 'isolated' ? 'utility feed is dead' : `${equipment[feedId].name} fails; the generator takes the lifts`}
            status={feedSt}
            danger={feedSt !== 'isolated'}
            disabled={replay}
            onClick={act(() => api.command(feedId, feedSt === 'isolated' ? 'on' : 'off', 'grid'))}
          />
        )}
        {genId && (
          <Lever
            label={genSt === 'isolated' ? 'Generator back' : 'Generator trips'}
            hint={genSt === 'isolated' ? 'no standby power' : `${equipment[genId].name} fails under load`}
            status={genSt}
            danger={genSt !== 'isolated'}
            disabled={replay || genSt === 'flooded'}
            onClick={act(() => api.command(genId, genSt === 'isolated' ? 'on' : 'off', 'fault'))}
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="eyebrow flex-1">Event log</span>
        <button className="btn-secondary btn-sm mono" onClick={() => setShowRuns((v) => !v)} title="Every run is an append-only log of input events; replay any of them">
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
