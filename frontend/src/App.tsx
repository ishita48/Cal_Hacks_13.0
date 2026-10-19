import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { BookOpen, CircleHelp, Droplets, Moon, PanelLeft, PanelRight, Pause, Play, Radio, RotateCcw, Share2, Smartphone, Sun } from 'lucide-react'
import { AgentConsole } from './components/AgentConsole'
import { Buds } from './components/Buds'
import { CascadePanel } from './components/CascadePanel'
import { Controls } from './components/Controls'
import { FloorPlan } from './components/FloorPlan'
import { Guide, useGuide } from './components/Guide'
import { ImpactLedger } from './components/ImpactLedger'
import { Inspector, useSelection } from './components/Inspector'
import { MessagesPanel } from './components/MessagesPanel'
import { PlanPanel } from './components/PlanPanel'
import { StoryStrip } from './components/StoryStrip'
import { VoiceRule } from './components/VoiceRule'
import { api, formatTimeOfDay } from './lib/api'
import { useBuilding } from './state/building'
import type { BudsFocus, Integrations, Level, SponsorReport } from './state/types'
import { connectWorld, useWorld } from './state/world'

// The 3D twin is another view of the same store; it is lazy so the 2D app loads first.
const Building3D = lazy(() => import('./components/Building3D'))

// Selectors must return stable references: a fresh [] per call makes Zustand's getSnapshot loop.
const NO_LEVELS: Level[] = []

type RightTab = 'agents' | 'messages' | 'cascade'
type LeftTab = 'inputs' | 'rule' | 'people' | 'selected'
type View = '2d' | '3d'

/**
 * The command centre: a top bar (clock, the three buttons that drive the demo, the other surfaces),
 * the story strip (what is happening, in words, with the Maya switch and Approve), then three
 * columns: inputs on the left, the building in the middle, the plan and the agents on the right.
 * Every word and number on screen is read from the one world store; every control sends an input
 * event to the backend. Nothing about the building is named here: it all comes from the spec.
 */
export default function App() {
  useEffect(() => connectWorld(), [])
  const loadBuilding = useBuilding((b) => b.load)
  const spec = useBuilding((b) => b.spec)
  const sensorId = useBuilding((b) => b.sensorId)
  const heroLevel = useBuilding((b) => b.heroLevel)
  const levels = spec?.levels ?? NO_LEVELS
  useEffect(() => {
    loadBuilding().catch(() => {})
  }, [loadBuilding])

  const { connection, clock, world } = useWorld()
  const guide = useGuide(world)
  const [integrations, setIntegrations] = useState<Integrations | null>(null)
  useEffect(() => {
    api.integrations().then(setIntegrations).catch(() => {})
  }, [])
  const [level, setLevel] = useState('all')
  const [view, setView] = useState<View>('3d')
  const [rightTab, setRightTab] = useState<RightTab>('agents')
  const [leftTab, setLeftTab] = useState<LeftTab>('inputs')
  const [docks, setDocks] = useState({ left: true, right: true })
  const [connections, setConnections] = useState(false)
  const [selection] = useSelection()
  useEffect(() => {
    if (selection) {
      setLeftTab('selected')
      setDocks((d) => ({ ...d, left: true }))
    }
  }, [selection])
  const planLevel = level === 'all' ? (heroLevel ?? levels[levels.length - 1]?.id ?? 'all') : level

  // Blender's habit: T hides the tool dock on the left, N the properties dock on the right.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.altKey || e.ctrlKey || e.metaKey || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return
      if (e.key === 't' || e.key === 'T') setDocks((d) => ({ ...d, left: !d.left }))
      if (e.key === 'n' || e.key === 'N') setDocks((d) => ({ ...d, right: !d.right }))
      if (e.key === '?') guide.setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Buds points at things: switch to the tab or floor that holds them first.
  useEffect(() => {
    const onFocus = (e: Event) => {
      for (const f of (e as CustomEvent<BudsFocus[]>).detail ?? []) {
        if (f.kind === 'tab' && (f.id === 'agents' || f.id === 'messages' || f.id === 'cascade')) {
          setRightTab(f.id)
          setDocks((d) => ({ ...d, right: true }))
        }
        if (f.kind === 'agent' || f.kind === 'message') {
          setRightTab(f.kind === 'agent' ? 'agents' : 'messages')
          setDocks((d) => ({ ...d, right: true }))
        }
        if (f.kind === 'step' || (f.kind === 'panel' && f.id === 'plan')) setDocks((d) => ({ ...d, right: true }))
        if (f.kind === 'panel' && (f.id === 'controls' || f.id === 'voice' || f.id === 'ledger')) {
          setDocks((d) => ({ ...d, left: true }))
          setLeftTab(f.id === 'controls' ? 'inputs' : f.id === 'voice' ? 'rule' : 'people')
        }
        if (f.kind === 'tab' && (f.id === 'inputs' || f.id === 'rule' || f.id === 'people')) {
          setLeftTab(f.id)
          setDocks((d) => ({ ...d, left: true }))
        }
        if (f.kind === 'level') setLevel(f.id)
      }
    }
    window.addEventListener('haven:focus', onFocus)
    return () => window.removeEventListener('haven:focus', onFocus)
  }, [])

  if (!world || !clock) {
    return (
      <div className="app-shell flex h-full flex-col items-center justify-center gap-3 text-t3">
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
  const leftBehind = world.plan.left_behind.length
  const quiet = world.narrative.stage === 'quiet'
  // The responder's phone link: the RA with something to do (a moving or done step), else the first RA.
  const actors = Object.values(world.actors)
  const responderActor = actors.find((a) => a.label.startsWith('RA') && a.status !== 'idle' && a.status !== 'offsite') ?? actors.find((a) => a.label.startsWith('RA')) ?? actors[0]

  return (
    <div className="app-shell grid h-full grid-rows-[auto_auto_minmax(0,1fr)] gap-3 overflow-hidden p-3">
      <TopBar clock={clock} connection={connection} integrations={integrations} buildingName={spec?.name ?? ''} replay={world.mode === 'replay'} sensorId={sensorId} responder={responderActor?.actor ?? 'staff'} responderLabel={responderActor?.label ?? 'A responder'} onGuide={() => guide.setOpen(true)} replayRemaining={clock.replay_remaining} />

      <section className="glass">
        <StoryStrip world={world} clock={clock} />
      </section>

      <main className="grid min-h-0 gap-3 overflow-hidden" style={{ gridTemplateColumns: `${docks.left ? '300px ' : ''}minmax(0,1fr)${docks.right ? ' 440px' : ''}` }}>
        {docks.left && (
          <aside className="glass flex min-h-0 flex-col overflow-hidden enter">
            <div className="hairline-b flex items-center px-3 py-2.5">
              <div className="seg">
                {(['inputs', 'rule', 'people', 'selected'] as const).map((t) => (
                  <button key={t} data-buds={`tab:${t}`} onClick={() => setLeftTab(t)} className={`seg-item ${leftTab === t ? 'is-on' : ''}`} title={t === 'inputs' ? 'The sensor and the levers: what can change the world' : t === 'rule' ? 'A rule from the manager, by voice or typed' : t === 'people' ? 'Who is affected, now or if nothing is done' : 'The record of whatever you clicked on the plan or the twin'}>
                    {t === 'inputs' ? 'Inputs' : t === 'rule' ? 'Say a rule' : t === 'people' ? 'People' : 'Selected'}
                    {t === 'rule' && world.rules.length > 0 && <span className="ml-1.5 inline-block rounded-full bg-haven-blue/15 px-1.5 text-[10px] font-semibold text-haven-blue">{world.rules.length}</span>}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {leftTab === 'inputs' ? <Controls world={world} /> : leftTab === 'rule' ? <VoiceRule world={world} /> : leftTab === 'people' ? <ImpactLedger world={world} clock={clock} /> : <Inspector world={world} selection={selection} />}
            </div>
          </aside>
        )}

        {/* the stage: the simulation, with its own toolbar above the picture */}
        <section className="glass flex min-h-0 flex-col overflow-hidden" data-buds="panel:map">
          <div className="hairline-b flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="eyebrow mr-1">{view === '3d' ? 'Building' : 'Floor'}</span>
            <div className="seg">
              {[...levels]
                .sort((a, b) => b.index - a.index)
                .map((lv) => {
                  const now = darkNow.has(lv.id)
                  const soon = !now && darkSoon.has(lv.id)
                  const wet = wetLevels.has(lv.id)
                  const on = view === '3d' ? level === lv.id : planLevel === lv.id
                  return (
                    <button key={lv.id} data-buds={`level:${lv.id}`} onClick={() => setLevel(lv.id)} className={`seg-item mono ${on ? 'is-on' : ''}`} title={lv.name}>
                      {lv.id}
                      {(now || soon || wet) && <span className={`absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full ${now ? 'bg-haven-danger' : wet ? 'bg-haven-water' : 'bg-haven-amber haven-pulse'}`} />}
                    </button>
                  )
                })}
              {view === '3d' && (
                <button onClick={() => setLevel('all')} className={`seg-item ${level === 'all' ? 'is-on' : ''}`} title="Whole building">
                  all
                </button>
              )}
            </div>
            <span className="label">{view === '3d' && level === 'all' ? 'whole building' : levels.find((l) => l.id === planLevel)?.name}</span>
            <div className="seg seg-xs">
              {(['3d', '2d'] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} className={`seg-item ${view === v ? 'is-on' : ''}`}>
                  {v === '2d' ? '2D plan' : '3D twin'}
                </button>
              ))}
            </div>
            <button className={`seg-item ${connections ? 'is-on' : ''}`} style={{ background: connections ? undefined : 'var(--chip-bg)' }} onClick={() => setConnections((c) => !c)} title="Draw the dependency graph: what powers, controls and feeds what. Dead edges go grey.">
              <Share2 className="mr-1 inline h-3 w-3" />
              Connections
            </button>
            <Legend />
            <div className="ml-auto flex items-center gap-1">
              <button className="btn-secondary btn-icon" onClick={() => setDocks((d) => ({ ...d, left: !d.left }))} title={docks.left ? 'Hide the inputs column (T)' : 'Show the inputs column (T)'} aria-label="Toggle inputs">
                <PanelLeft className="h-3.5 w-3.5" />
              </button>
              <button className="btn-secondary btn-icon" onClick={() => setDocks((d) => ({ ...d, right: !d.right }))} title={docks.right ? 'Hide the plan column (N)' : 'Show the plan column (N)'} aria-label="Toggle plan">
                <PanelRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden" style={{ padding: view === '2d' ? 12 : 0 }}>
            {quiet && (
              <div className="stage-empty glass-card">
                <div className="text-[13px] font-semibold text-t1">A $4 water sensor sits on the basement floor by the riser.</div>
                <div className="mt-0.5 text-[11.5px] text-t2">Press Simulate leak. HAVEN traces what fails, the agents argue a plan, you approve it, and nobody gets left behind.</div>
              </div>
            )}
            {view === '3d' ? (
              <ViewErrorBoundary fallback={<FloorPlan world={world} level={planLevel} />}>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-t3">streaming the building…</div>}>
                  <Building3D level={level} connections={connections} />
                </Suspense>
              </ViewErrorBoundary>
            ) : (
              <FloorPlan world={world} level={planLevel} connections={connections} />
            )}
          </div>
        </section>

        {docks.right && (
          <aside className="grid min-h-0 grid-rows-[minmax(0,1.1fr)_minmax(0,1fr)] gap-3 enter">
            <div className={`glass min-h-0 overflow-hidden p-4 ${leftBehind ? 'tint-red' : ''}`}>
              <PlanPanel world={world} clock={clock} />
            </div>
            <div className="glass flex min-h-0 flex-col overflow-hidden">
              <div className="hairline-b flex items-center px-4 py-2.5">
                <div className="seg">
                  {(['agents', 'messages', 'cascade'] as const).map((t) => (
                    <button key={t} data-buds={`tab:${t}`} onClick={() => setRightTab(t)} className={`seg-item ${rightTab === t ? 'is-on' : ''}`} title={t === 'agents' ? 'Who is in the negotiation and what each one says' : t === 'messages' ? 'Every person gets their own message, in their language' : 'What fails next and when, then what has happened'}>
                      {t === 'agents' ? 'The agents' : t === 'messages' ? 'Messages' : 'Cascade'}
                      {t === 'agents' && vetoes > 0 && <span className="ml-1.5 inline-block rounded-full bg-haven-danger px-1.5 text-[10px] font-semibold text-white">{vetoes}</span>}
                      {t === 'messages' && criticalMessages > 0 && <span className="ml-1.5 inline-block rounded-full bg-haven-blue/15 px-1.5 text-[10px] font-semibold text-haven-blue">{criticalMessages}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden p-4">{rightTab === 'agents' ? <AgentConsole world={world} /> : rightTab === 'messages' ? <MessagesPanel world={world} clock={clock} /> : <CascadePanel world={world} clock={clock} />}</div>
            </div>
          </aside>
        )}
      </main>
      {guide.open && <Guide world={world} onClose={guide.close} />}
      <Buds />
    </div>
  )
}

function TopBar({ clock, connection, integrations, buildingName, replay, sensorId, responder, responderLabel, onGuide, replayRemaining }: { clock: NonNullable<ReturnType<typeof useWorld.getState>['clock']>; connection: string; integrations: Integrations | null; buildingName: string; replay: boolean; sensorId: string | null; responder: string; responderLabel: string; onGuide: () => void; replayRemaining: number }) {
  const [error, setError] = useState<string | null>(null)
  const act = (fn: () => Promise<unknown>) => () => {
    setError(null)
    fn().catch((e: Error) => setError(e.message))
  }
  return (
    <header className="app-topnav flex h-14 items-center gap-3 px-4">
      <a href="/story" className="flex items-center gap-2.5 transition-opacity hover:opacity-80" title="The story: how HAVEN works">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-black/[0.06] bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_24px_-8px_rgba(15,98,254,0.45)] dark:border-white/10 dark:bg-white/[0.06]">
          <span className="h-2.5 w-2.5 rounded-full bg-haven-blue" style={{ boxShadow: '0 0 0 4px rgba(15,98,254,0.18)' }} />
        </span>
        <span className="text-left leading-tight">
          <span className="block text-[14px] font-semibold tracking-[0.14em] text-t1">HAVEN</span>
          <span className="argus-eyebrow block">{buildingName || 'command centre'}</span>
        </span>
      </a>
      <div className="ml-3 flex items-center gap-2.5">
        <span className="mono num text-[24px] leading-none text-t1" title="Simulated time of day">
          {formatTimeOfDay(clock.time_of_day)}
        </span>
        <button className="btn-secondary btn-icon" onClick={act(() => api.clock({ playing: !clock.playing }))} title={clock.playing ? 'Pause the clock' : 'Play'} aria-label={clock.playing ? 'Pause' : 'Play'}>
          {clock.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <div className="seg seg-xs" title="Simulation speed">
          {[1, 5, 20, 60].map((s) => (
            <button key={s} className={`seg-item mono ${clock.speed === s ? 'is-on' : ''}`} onClick={act(() => api.clock({ speed: s }))}>
              {s}×
            </button>
          ))}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {error && <span className="text-[11px] text-haven-danger">{error}</span>}
        {replay && <span className="pill pill-amber pill-mono">REPLAY · {replayRemaining} left</span>}
        <button onClick={act(() => (sensorId ? api.sensor(sensorId, 0.9) : Promise.resolve()))} disabled={replay || !sensorId} className="argus-btn flex items-center gap-2 rounded-full px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40" title="Send the reading the ESP32 would send: the first input event of the incident" data-buds="panel:simulate">
          <Droplets className="h-3.5 w-3.5" /> Simulate leak
        </button>
        <button className="btn-secondary btn-sm" onClick={act(api.reset)} title="A quiet building, a new run in the event log">
          <RotateCcw className="h-3 w-3" /> New run
        </button>
        <button className="btn-secondary btn-sm" onClick={act(api.loadDemo)} title="Replay the recorded run at 5×: leak, the Maya moment, a spoken rule, approval, HAVEN acting">
          Replay demo
        </button>
        <span className="mx-1 h-6 w-px bg-black/10 dark:bg-white/10" />
        <a className="btn-secondary btn-icon" href="/phone" target="_blank" rel="noreferrer" title="The manager's phone: approve from a phone" aria-label="Manager's phone">
          <Smartphone className="h-3.5 w-3.5" />
        </a>
        <a className="btn-secondary btn-icon" href={`/phone?as=${responder}`} target="_blank" rel="noreferrer" title={`A responder's phone: ${responderLabel} confirms steps`} aria-label="Responder's phone">
          <Radio className="h-3.5 w-3.5" />
        </a>
        <a className="btn-secondary btn-icon" href="/story" title="The story: how it works" aria-label="The story">
          <BookOpen className="h-3.5 w-3.5" />
        </a>
        {integrations && <IntegrationStrip flags={integrations} />}
        <span className="flex items-center gap-1.5 text-[11px] text-t2" title={connection}>
          <span className={`h-2 w-2 rounded-full ${connection === 'open' ? 'bg-haven-safe' : connection === 'connecting' ? 'bg-haven-amber' : 'bg-haven-danger'}`} style={{ boxShadow: connection === 'open' ? '0 0 8px rgba(34,197,94,0.6)' : undefined }} />
          {connection === 'open' ? 'live' : connection}
        </span>
        <button className="btn-secondary btn-icon" onClick={onGuide} title="Guide (?)" aria-label="Guide">
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
        <ThemeToggle />
      </div>
    </header>
  )
}

function ThemeToggle() {
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem('haven.theme') === 'dark'
    } catch {
      return false
    }
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      localStorage.setItem('haven.theme', dark ? 'dark' : 'light')
    } catch {
      /* ignore */
    }
  }, [dark])
  return (
    <button className="btn-secondary btn-icon" onClick={() => setDark((d) => !d)} title={dark ? 'Light mode' : 'Dark mode'} aria-label="Toggle theme">
      {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </button>
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
    <div className="hidden items-center gap-3 text-[10px] text-t3 xl:flex">
      {item('#0284c7', 'water')}
      {item('rgba(220,38,38,0.6)', 'dark now')}
      {item('rgba(217,119,6,0.7)', 'dark if nothing is done')}
      {item('#16a34a', 'step-free route')}
      {item('#dc2626', 'person at risk', true)}
      {item('#7c3aed', 'left behind', true)}
      {item('#0284c7', 'responder')}
    </div>
  )
}

/** Which sponsor integrations are live in this backend (key-gated; dim = simulated). Click for the proof. */
function IntegrationStrip({ flags }: { flags: Integrations }) {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<SponsorReport | null>(null)
  const [checking, setChecking] = useState(false)
  const check = (fresh: boolean) => {
    setChecking(true)
    api
      .sponsors(fresh)
      .then(setReport)
      .catch(() => {})
      .finally(() => setChecking(false))
  }
  useEffect(() => {
    if (open && !report) check(false)
  }, [open, report])
  const items: [string, boolean, string][] = [
    ['fetch.ai', flags.fetch, flags.agentverse ? 'resident agents on Agentverse' : flags.fetch ? 'resident agents as local uAgents' : 'HAVEN_FETCH=0'],
    ['claude', flags.llm, flags.negotiation ? 'agents reason with Claude; Buds' : flags.llm ? 'rule parsing fallback + explanations + Buds' : 'set ANTHROPIC_API_KEY'],
    ['elevenlabs', flags.elevenlabs, flags.elevenlabs ? (flags.voice_agent ? 'voice + live voice agent' : "HAVEN's voice") : 'set ELEVENLABS_API_KEY (next: Cartesia, then browser)'],
    ['cartesia', flags.cartesia, flags.cartesia ? 'second voice' : 'set CARTESIA_API_KEY'],
    ['tiger', flags.tiger, flags.tiger ? 'sensor time-series' : 'set TIGER_DATABASE_URL (event log used)'],
    ['twilio', flags.twilio, flags.twilio ? 'real plumber call + demo text' : 'set TWILIO_* (call simulated)'],
    ['linear', flags.linear, flags.linear ? 'real facilities ticket' : 'set LINEAR_API_KEY (ticket simulated)'],
  ]
  const live = items.filter((i) => i[1]).length
  return (
    <span className="relative flex items-center">
      <button className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/70 px-3 py-1.5 text-[11px] font-medium text-t2 hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:bg-white/[0.1]" onClick={() => setOpen((o) => !o)} title="Sponsor integrations: click for live proof">
        <span className={`h-2 w-2 rounded-full ${live ? 'bg-haven-safe' : 'bg-t4'}`} />
        Live stack · {live}/{items.length}
      </button>
      {open && (
        <div className="glass absolute top-10 right-0 z-50 w-[460px] p-3 text-left" style={{ borderRadius: 14 }}>
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Live stack · round-trip proof</span>
            <span className="flex items-center gap-2">
              {report && (
                <span className="mono text-[10px] text-t3">
                  {report.live}/{report.sponsors.length} live
                </span>
              )}
              <button className="btn-secondary btn-sm" disabled={checking} onClick={() => check(true)}>
                {checking ? 'checking…' : 'Re-check'}
              </button>
            </span>
          </div>
          {!report ? (
            <p className="text-[11px] text-t3">checking every sponsor…</p>
          ) : (
            <ul className="space-y-1.5">
              {report.sponsors.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-[11px]">
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${s.state === 'live' ? 'bg-haven-safe' : s.state === 'error' ? 'bg-haven-danger' : 'bg-t4'}`} style={s.state === 'live' ? { boxShadow: `0 0 8px ${s.color}` } : undefined} />
                  <span className="w-24 shrink-0 font-semibold text-t1">{s.name}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-t2">{s.role}</span>
                    <span className={`mono block text-[10px] ${s.state === 'live' ? 'text-haven-safe' : s.state === 'error' ? 'text-haven-danger' : 'text-t3'}`}>
                      {s.proof}
                      {s.latency_ms != null ? ` · ${s.latency_ms} ms` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-t3">A read-only request per service whose answer only the live service could give. Keys: backend/.env (see README).</p>
        </div>
      )}
    </span>
  )
}
