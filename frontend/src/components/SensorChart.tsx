import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useWorld } from '../state/world'
import type { SensorHistory } from '../state/types'

interface Props {
  sensorId: string
  limit?: number
}

const W = 240
const H = 44
const PAD = 2
const THRESHOLD = 0.5

/** A sparkline of the probe's readings over time: Tiger Data when configured, the event log otherwise. */
export function SensorChart({ sensorId, limit = 120 }: Props) {
  const [history, setHistory] = useState<SensorHistory | null>(null)
  const lastStep = useWorld((s) => s.world?.sensors[sensorId]?.last_step ?? null)
  const runId = useWorld((s) => s.world?.run_id ?? null)

  useEffect(() => {
    let alive = true
    const load = () => {
      api
        .sensorHistory(sensorId, limit)
        .then((h) => {
          if (alive) setHistory(h)
        })
        .catch(() => {})
    }
    load()
    const id = window.setInterval(load, 2000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [sensorId, limit, lastStep, runId])

  const readings = history?.readings ?? []
  const n = readings.length
  const x = (i: number) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD))
  const y = (v: number) => PAD + (1 - Math.min(1, Math.max(0, v))) * (H - 2 * PAD)
  const line = n > 0 ? readings.map((r, i) => `${x(i).toFixed(1)},${y(r.value).toFixed(1)}`).join(' ') : ''
  const area = n > 1 ? `${x(0).toFixed(1)},${H - PAD} ${line} ${x(n - 1).toFixed(1)},${H - PAD}` : ''
  const source = history?.source === 'tiger' ? 'tiger data' : 'event log'

  return (
    <div className="mt-2.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-11 w-full" preserveAspectRatio="none" aria-label="sensor readings over time">
        <defs>
          <linearGradient id={`spark-${sensorId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#64d2ff" stopOpacity="0.28" />
            <stop offset="1" stopColor="#64d2ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={PAD} x2={W - PAD} y1={y(THRESHOLD)} y2={y(THRESHOLD)} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="3 3" />
        {n === 0 && <line x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth="1" />}
        {n > 1 && <polygon points={area} fill={`url(#spark-${sensorId})`} />}
        {n > 1 && <polyline points={line} fill="none" stroke="#64d2ff" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />}
        {readings.map((r, i) => (
          <circle key={`${r.step}-${i}`} cx={x(i)} cy={y(r.value)} r={r.wet ? 2.2 : 1.4} fill={r.wet ? '#0284c7' : 'var(--ink-4)'} />
        ))}
      </svg>
      <div className="mt-1 flex items-center justify-between">
        <span className="label mono">{n === 0 ? 'no readings yet' : `${n} reading${n === 1 ? '' : 's'}`}</span>
        <span className="label mono">source: {source}</span>
      </div>
    </div>
  )
}
