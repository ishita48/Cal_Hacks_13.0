import { useEffect, useState } from 'react'
import { CascadePanel } from './components/CascadePanel'
import { Controls } from './components/Controls'
import { FloorPlan } from './components/FloorPlan'
import { ImpactLedger } from './components/ImpactLedger'
import { api, formatTimeOfDay } from './lib/api'
import { useBuilding } from './state/building'
import { connectWorld, useWorld } from './state/world'

export default function App() {
  useEffect(() => connectWorld(), [])
  const loadBuilding = useBuilding((b) => b.load)
  const levels = useBuilding((b) => b.spec?.levels ?? [])
  useEffect(() => {
    loadBuilding().catch(() => {})
  }, [loadBuilding])

  const { connection, clock, world } = useWorld()
  const [level, setLevel] = useState('L4')

  if (!world || !clock) {
    return <div className="flex h-full items-center justify-center text-slate-500">connecting to the world…</div>
  }

  const darkNow = new Set(world.impact.dark_levels)
  const darkSoon = new Set(world.forecast.impact.dark_levels)
  const wetLevels = new Set(world.wet_spaces.map((s) => s.split('-')[0]))

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-6 border-b border-ink-700 bg-ink-900 px-5 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-[0.2em] text-white">HAVEN</span>
          <span className="text-xs text-slate-500">David Blackwell Hall · cascade engine</span>
        </div>
        <div className="font-mono text-2xl tabular-nums text-white">{formatTimeOfDay(clock.time_of_day)}</div>
        <div className="flex gap-1">
          <button className="rounded bg-ink-700 px-3 py-1 text-sm hover:bg-ink-600" onClick={() => api.clock({ playing: !clock.playing })}>
            {clock.playing ? 'Pause' : 'Play'}
          </button>
          {[1, 5, 20, 60].map((s) => (
            <button
              key={s}
              className={`rounded px-2 py-1 text-sm ${clock.speed === s ? 'bg-slate-200 text-ink-900' : 'bg-ink-700 hover:bg-ink-600'}`}
              onClick={() => api.clock({ speed: s })}
            >
              {s}×
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {world.mode === 'replay' && (
            <span className="rounded border border-amber-500/50 px-2 py-0.5 text-amber-400">REPLAY · {clock.replay_remaining} events left</span>
          )}
          <span className="flex items-center gap-1.5 text-slate-400">
            <span className={`h-2 w-2 rounded-full ${connection === 'open' ? 'bg-haven-safe' : connection === 'connecting' ? 'bg-amber-400' : 'bg-haven-danger'}`} />
            {connection}
          </span>
          <span className="font-mono text-slate-500">
            run {world.run_id} · v{world.version}
          </span>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[340px_1fr_380px] gap-px overflow-hidden bg-ink-700">
        <section className="flex min-h-0 flex-col gap-4 overflow-hidden bg-ink-900 p-4">
          <Controls world={world} />
          <div className="min-h-0 flex-1 border-t border-ink-700 pt-3">
            <ImpactLedger world={world} />
          </div>
        </section>

        <section className="flex min-h-0 flex-col bg-ink-950">
          <div className="flex items-center gap-1 border-b border-ink-700 px-3 py-2">
            {[...levels]
              .sort((a, b) => b.index - a.index)
              .map((lv) => {
                const now = darkNow.has(lv.id)
                const soon = !now && darkSoon.has(lv.id)
                const wet = wetLevels.has(lv.id)
                return (
                  <button
                    key={lv.id}
                    onClick={() => setLevel(lv.id)}
                    className={`relative rounded px-2.5 py-1 text-xs ${level === lv.id ? 'bg-slate-200 text-ink-900' : 'bg-ink-800 text-slate-400 hover:bg-ink-700'}`}
                    title={lv.name}
                  >
                    {lv.id}
                    {(now || soon || wet) && (
                      <span className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ${now ? 'bg-haven-danger' : wet ? 'bg-haven-water' : 'bg-amber-400 haven-pulse'}`} />
                    )}
                  </button>
                )
              })}
            <span className="ml-3 text-xs text-slate-500">{levels.find((l) => l.id === level)?.name}</span>
            <Legend />
          </div>
          <div className="min-h-0 flex-1 p-3">
            <FloorPlan world={world} level={level} />
          </div>
        </section>

        <section className="min-h-0 overflow-hidden bg-ink-900 p-4">
          <CascadePanel world={world} clock={clock} />
        </section>
      </main>
    </div>
  )
}

function Legend() {
  const item = (color: string, label: string, extra = '') => (
    <span className="flex items-center gap-1">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${extra}`} style={{ background: color }} />
      {label}
    </span>
  )
  return (
    <div className="ml-auto flex gap-3 text-[10px] text-slate-500">
      {item('#3ba7ff', 'water')}
      {item('rgba(255,77,79,0.5)', 'dark now')}
      {item('rgba(255,176,32,0.6)', 'dark if nothing is done')}
      {item('#2ecc8f', 'step-free route')}
      {item('#ff4d4f', 'person at risk', 'rounded-full')}
    </div>
  )
}
