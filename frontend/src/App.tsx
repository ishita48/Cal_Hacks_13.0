import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { AgentConsole } from './components/AgentConsole'
import { CascadePanel } from './components/CascadePanel'
import { Controls } from './components/Controls'
import { FloorPlan } from './components/FloorPlan'
import { ImpactLedger } from './components/ImpactLedger'
import { MessagesPanel } from './components/MessagesPanel'
import { PlanPanel } from './components/PlanPanel'
import { VoiceRule } from './components/VoiceRule'
import { api, formatTimeOfDay } from './lib/api'
import { useBuilding } from './state/building'
import type { Level } from './state/types'
import { connectWorld, useWorld } from './state/world'

// The 3D twin is another view of the same store; it is lazy so the 2D app loads first.
const Building3D = lazy(() => import('./components/Building3D'))

// Selectors must return stable references: a fresh [] per call makes Zustand's getSnapshot loop.
const NO_LEVELS: Level[] = []

export default function App() {
  useEffect(() => connectWorld(), [])
  const loadBuilding = useBuilding((b) => b.load)
  const spec = useBuilding((b) => b.spec)
  const levels = spec?.levels ?? NO_LEVELS
  useEffect(() => {
    loadBuilding().catch(() => {})
  }, [loadBuilding])

  const { connection, clock, world } = useWorld()
  const [level, setLevel] = useState('L4')
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const [rightTab, setRightTab] = useState<'agents' | 'messages' | 'cascade'>('agents')

  if (!world || !clock) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-t3">
        <span className="h-2 w-2 rounded-full bg-haven-blue haven-pulse" />
        <span className="text-xs">connecting to the world…</span>
      </div>
    )
  }

  const darkNow = new Set(world.impact.dark_levels)
  const darkSoon = new Set(world.forecast.impact.dark_levels)
  const wetLevels = new Set(world.wet_spaces.map((s) => s.split('-')[0]))
  const shown = world.approved_plan ?? world.plan
  const criticalMessages = shown.messages?.filter((m) => m.priority === 'critical').length ?? 0
  const vetoes = world.plan.stances.filter((s) => s.stance === 'veto').length

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="glass flex h-14 shrink-0 items-center gap-6 px-5" style={{ borderRadius: 16 }}>
        <div className="flex items-baseline gap-3">
          <span className="text-[15px] font-semibold tracking-[0.18em] text-t1">HAVEN</span>
          <span className="label">David Blackwell Hall · {world.mode === 'replay' ? 'replay' : 'live'}</span>
        </div>

        <div className="ml-6 flex items-center gap-4">
          <span className="mono num text-[34px] leading-none text-t1">{formatTimeOfDay(clock.time_of_day)}</span>
          <button
            className="btn-secondary btn-icon"
            onClick={() => api.clock({ playing: !clock.playing })}
            title={clock.playing ? 'Pause' : 'Play'}
            aria-label={clock.playing ? 'Pause' : 'Play'}
          >
            {clock.playing ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect x="1.5" y="1" width="3" height="10" rx="1" />
                <rect x="7.5" y="1" width="3" height="10" rx="1" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <path d="M2.5 1.5v9l8-4.5z" />
              </svg>
            )}
          </button>
          <div className="seg seg-xs">
            {[1, 5, 20, 60].map((s) => (
              <button key={s} className={`seg-item mono ${clock.speed === s ? 'is-on' : ''}`} onClick={() => api.clock({ speed: s })}>
                {s}×
              </button>
            ))}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {world.mode === 'replay' && <span className="pill pill-amber pill-mono">REPLAY · {clock.replay_remaining} left</span>}
          <span className="flex items-center gap-2 text-[11px] text-t2">
            <span
              className={`h-2 w-2 rounded-full ${connection === 'open' ? 'bg-haven-safe' : connection === 'connecting' ? 'bg-haven-amber' : 'bg-haven-danger'}`}
              style={{ boxShadow: connection === 'open' ? '0 0 8px rgba(48,209,88,0.6)' : undefined }}
            />
            {connection}
          </span>
          <span className="mono text-[11px] text-t3">
            run {world.run_id} · v{world.version}
          </span>
          <a href="/phone" target="_blank" rel="noreferrer" className="pill pill-blue" title="The on-call manager's phone view">
            Phone
          </a>
        </div>
      </header>

      <main className="stagger grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)_420px] gap-3 overflow-hidden">
        <section className="glass flex min-h-0 flex-col gap-4 overflow-hidden p-4">
          <Controls world={world} />
          <div className="hairline pt-4">
            <VoiceRule world={world} />
          </div>
          <div className="hairline min-h-0 flex-1 pt-4">
            <ImpactLedger world={world} clock={clock} />
          </div>
        </section>

        <section className="glass flex min-h-0 flex-col overflow-hidden">
          <div className="hairline-b flex items-center gap-3 px-4 py-2.5">
            <div className="seg">
              {[...levels]
                .sort((a, b) => b.index - a.index)
                .map((lv) => {
                  const now = darkNow.has(lv.id)
                  const soon = !now && darkSoon.has(lv.id)
                  const wet = wetLevels.has(lv.id)
                  return (
                    <button key={lv.id} onClick={() => setLevel(lv.id)} className={`seg-item mono ${level === lv.id ? 'is-on' : ''}`} title={lv.name}>
                      {lv.id}
                      {(now || soon || wet) && (
                        <span className={`absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full ${now ? 'bg-haven-danger' : wet ? 'bg-haven-water' : 'bg-haven-amber haven-pulse'}`} />
                      )}
                    </button>
                  )
                })}
              {view === '3d' && (
                <button onClick={() => setLevel('all')} className={`seg-item ${level === 'all' ? 'is-on' : ''}`} title="Whole building">
                  all
                </button>
              )}
            </div>
            <span className="label">{level === 'all' ? 'Whole building' : levels.find((l) => l.id === level)?.name}</span>
            <div className="seg seg-xs ml-1">
              {(['2d', '3d'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => {
                    setView(v)
                    if (v === '2d' && level === 'all') setLevel('L4')
                  }}
                  className={`seg-item ${view === v ? 'is-on' : ''}`}
                >
                  {v === '2d' ? '2D plan' : '3D twin'}
                </button>
              ))}
            </div>
            <Legend />
          </div>
          <div className="min-h-0 flex-1 p-3">
            {view === '3d' ? (
              <ViewErrorBoundary fallback={<FloorPlan world={world} level={level === 'all' ? 'L4' : level} />}>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-t3">loading the 3D twin…</div>}>
                  <Building3D level={level} />
                </Suspense>
              </ViewErrorBoundary>
            ) : (
              <FloorPlan world={world} level={level} />
            )}
          </div>
        </section>

        <section className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 overflow-hidden">
          <div className="glass min-h-0 overflow-hidden p-4">
            <PlanPanel world={world} clock={clock} />
          </div>
          <div className="glass flex min-h-0 flex-col overflow-hidden">
            <div className="hairline-b flex items-center px-4 py-2.5">
              <div className="seg">
                {(['agents', 'messages', 'cascade'] as const).map((t) => (
                  <button key={t} onClick={() => setRightTab(t)} className={`seg-item ${rightTab === t ? 'is-on' : ''}`}>
                    {t === 'agents' ? 'Agents' : t === 'messages' ? 'Messages' : 'Cascade'}
                    {t === 'agents' && vetoes > 0 && (
                      <span className="ml-1.5 inline-block rounded-full bg-haven-danger px-1.5 text-[10px] font-semibold text-white">{vetoes}</span>
                    )}
                    {t === 'messages' && criticalMessages > 0 && (
                      <span className="ml-1.5 inline-block rounded-full bg-white/10 px-1.5 text-[10px] font-semibold text-t1">{criticalMessages}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-4">
              {rightTab === 'agents' ? (
                <AgentConsole world={world} />
              ) : rightTab === 'messages' ? (
                <MessagesPanel world={world} clock={clock} />
              ) : (
                <CascadePanel world={world} clock={clock} />
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

class ViewErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err: unknown) {
    console.warn('3D view failed; falling back to the 2D plan', err)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function Legend() {
  const item = (color: string, label: string, round = false) => (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 ${round ? 'rounded-full' : 'rounded-[3px]'}`} style={{ background: color }} />
      {label}
    </span>
  )
  return (
    <div className="ml-auto flex gap-3 text-[10px] text-t3">
      {item('#64d2ff', 'water')}
      {item('rgba(255,69,58,0.55)', 'dark now')}
      {item('rgba(255,214,10,0.6)', 'dark if nothing is done')}
      {item('#30d158', 'step-free route')}
      {item('#ff453a', 'person at risk', true)}
      {item('#bf5af2', 'left behind', true)}
      {item('#64d2ff', 'responder')}
    </div>
  )
}
