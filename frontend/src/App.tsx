import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import {
  Activity,
  BookOpen,
  Bot,
  Box,
  Droplets,
  LayoutGrid,
  MessagesSquare,
  Moon,
  Pause,
  Play,
  Radio,
  Smartphone,
  Sun,
  Waypoints,
} from 'lucide-react'
import { AgentConsole } from './components/AgentConsole'
import { Buds } from './components/Buds'
import { CascadePanel } from './components/CascadePanel'
import { Controls } from './components/Controls'
import { FloorPlan } from './components/FloorPlan'
import { ImpactLedger } from './components/ImpactLedger'
import { MessagesPanel } from './components/MessagesPanel'
import { PlanPanel } from './components/PlanPanel'
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
type View = '2d' | '3d'

/**
 * The command centre, in the Sentinel app language: a floating frosted sidebar, a floating top bar,
 * stat tiles, then three columns of cards. Every number on screen is read from the one world store;
 * every control sends an input event to the backend.
 */
export default function App() {
  useEffect(() => connectWorld(), [])
  const loadBuilding = useBuilding((b) => b.load)
  const spec = useBuilding((b) => b.spec)
  const levels = spec?.levels ?? NO_LEVELS
  useEffect(() => {
    loadBuilding().catch(() => {})
  }, [loadBuilding])

  const { connection, clock, world } = useWorld()
  const [integrations, setIntegrations] = useState<Integrations | null>(null)
  useEffect(() => {
    api.integrations().then(setIntegrations).catch(() => {})
  }, [])
  const [level, setLevel] = useState('L4')
  const [view, setView] = useState<View>('2d')
  const [rightTab, setRightTab] = useState<RightTab>('agents')

  // Buds points at things: switch to the tab or floor that holds them first.
  useEffect(() => {
    const onFocus = (e: Event) => {
      for (const f of (e as CustomEvent<BudsFocus[]>).detail ?? []) {
        if (f.kind === 'tab' && (f.id === 'agents' || f.id === 'messages' || f.id === 'cascade')) setRightTab(f.id)
        if (f.kind === 'agent') setRightTab('agents')
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
  const incident = shown.status !== 'none'
  const m = shown.metrics
  const deepest = Math.max(0, ...Object.values(world.water).map((w) => w.depth))
  const contact = world.forecast.events.find((e) => e.kind === 'flooded' || e.kind === 'lifts_down')
  const contactIn = contact ? Math.max(0, (world.forecast.computed_step * clock.dt + contact.eta_s - clock.sim_time) / 60) : null
  const leftBehind = world.plan.left_behind.length

  return (
    <div className="app-shell h-full overflow-hidden">
      <Sidebar view={view} setView={setView} rightTab={rightTab} setRightTab={setRightTab} vetoes={vetoes} criticalMessages={criticalMessages} leftBehind={leftBehind} />
      <TopNav title="Command centre" clock={clock} connection={connection} world={world} integrations={integrations} />

      <main className="absolute top-[5.25rem] right-4 bottom-4 left-[17rem] flex min-h-0 flex-col gap-3 overflow-hidden">
        {/* headline numbers, Sentinel's stat row */}
        <div className="stagger grid shrink-0 grid-cols-5 gap-3">
          <Stat k="Affected" v={incident ? Number(m.residents_affected ?? 0) : 0} s={incident ? 'residents on floors that go dark' : 'no incident'} tone={incident ? 'text-haven-power' : undefined} />
          <Stat k="Left behind" v={leftBehind} s={leftBehind ? 'a hard need nobody spoke for' : 'everyone with a need is covered'} tone={leftBehind ? 'text-haven-danger' : incident ? 'text-haven-safe' : undefined} liquid={leftBehind > 0} />
          <Stat k="Violations" v={incident ? Number(m.violations ?? 0) : 0} s={incident ? `${Number(m.checks ?? 0)} checks by the checker` : 'checker idle'} tone={Number(m.violations ?? 0) ? 'text-haven-danger' : incident ? 'text-haven-safe' : undefined} />
          <Stat k="Water" v={`${Math.round(deepest * 100)} cm`} s={deepest > 0 ? `${world.wet_spaces.length} spaces wet` : 'basement dry'} tone={deepest > 0 ? 'text-haven-water' : undefined} />
          <Stat k={contact ? 'Water contact' : 'Plan'} v={contact && contactIn != null ? `${contactIn.toFixed(0)} min` : shown.status === 'none' ? 'quiet' : shown.status} s={contact ? contact.message : incident ? `v${shown.version} · ${shown.enabled_agents.length} agents on` : 'press Simulate leak'} tone={contact && contactIn != null && contactIn < 5 ? 'text-haven-danger' : contact ? 'text-haven-amber' : undefined} />
        </div>

        <div className="stagger grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)_400px] gap-3 overflow-hidden">
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
                      <button key={lv.id} data-buds={`level:${lv.id}`} onClick={() => setLevel(lv.id)} className={`seg-item mono ${level === lv.id ? 'is-on' : ''}`} title={lv.name}>
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
            <div className="min-h-0 flex-1 p-3" data-buds="panel:map">
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
            <div className={`glass min-h-0 overflow-hidden p-4 ${leftBehind ? 'tint-red' : ''}`}>
              <PlanPanel world={world} clock={clock} />
            </div>
            <div className="glass flex min-h-0 flex-col overflow-hidden">
              <div className="hairline-b flex items-center px-4 py-2.5">
                <div className="seg">
                  {(['agents', 'messages', 'cascade'] as const).map((t) => (
                    <button key={t} data-buds={`tab:${t}`} onClick={() => setRightTab(t)} className={`seg-item ${rightTab === t ? 'is-on' : ''}`}>
                      {t === 'agents' ? 'Agents' : t === 'messages' ? 'Messages' : 'Cascade'}
                      {t === 'agents' && vetoes > 0 && <span className="ml-1.5 inline-block rounded-full bg-haven-danger px-1.5 text-[10px] font-semibold text-white">{vetoes}</span>}
                      {t === 'messages' && criticalMessages > 0 && <span className="ml-1.5 inline-block rounded-full bg-haven-blue/15 px-1.5 text-[10px] font-semibold text-haven-blue">{criticalMessages}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden p-4">
                {rightTab === 'agents' ? <AgentConsole world={world} /> : rightTab === 'messages' ? <MessagesPanel world={world} clock={clock} /> : <CascadePanel world={world} clock={clock} />}
              </div>
            </div>
          </section>
        </div>
      </main>
      <Buds />
    </div>
  )
}

// ---- shell ---------------------------------------------------------------------------------------

function Stat({ k, v, s, tone, liquid }: { k: string; v: number | string; s: string; tone?: string; liquid?: boolean }) {
  return (
    <div className={`${liquid ? 'liquid-glass' : 'glass'} stat`}>
      <span className="stat-k">{k}</span>
      <span className={`stat-v ${tone ?? ''}`}>{v}</span>
      <span className="stat-s truncate" title={s}>
        {s}
      </span>
    </div>
  )
}

function Sidebar({
  view,
  setView,
  rightTab,
  setRightTab,
  vetoes,
  criticalMessages,
  leftBehind,
}: {
  view: View
  setView: (v: View) => void
  rightTab: RightTab
  setRightTab: (t: RightTab) => void
  vetoes: number
  criticalMessages: number
  leftBehind: number
}) {
  const item = (on: boolean, Icon: React.ElementType, label: string, desc: string, onClick: () => void, badge = 0, buds?: string) => (
    <button key={label} className={`nav-item ${on ? 'is-on' : ''}`} onClick={onClick} aria-current={on ? 'page' : undefined} data-buds={buds}>
      <Icon />
      <span className="min-w-0 flex-1">
        <span className="nav-label truncate">{label}</span>
        <span className="nav-desc truncate">{desc}</span>
      </span>
      {badge > 0 && <span className="nav-badge">{badge}</span>}
    </button>
  )
  return (
    <aside className="app-sidebar fixed top-4 bottom-4 left-4 z-50 flex w-60 flex-col overflow-hidden">
      <a href="/story" className="flex items-center gap-3 px-5 py-5 transition-opacity hover:opacity-80">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-black/[0.06] bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_24px_-8px_rgba(15,98,254,0.45)] dark:border-white/10 dark:bg-white/[0.06]">
          <span className="h-3 w-3 rounded-full bg-haven-blue" style={{ boxShadow: '0 0 0 4px rgba(15,98,254,0.18)' }} />
        </div>
        <div className="text-left">
          <div className="text-[15px] font-semibold tracking-[0.14em] text-t1">HAVEN</div>
          <div className="argus-eyebrow">Blackwell Hall</div>
        </div>
      </a>
      <div className="px-3 pb-3">
        <button onClick={() => api.sensor('basement_mech_1', 0.9).catch(() => {})} className="argus-btn flex w-full items-center justify-center gap-2 rounded-full px-3 py-2.5 text-sm font-semibold text-white">
          <Droplets className="h-4 w-4" /> Simulate leak
        </button>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-1" aria-label="Main">
        <div>
          <p className="argus-eyebrow px-3 pb-1.5">Command centre</p>
          <div className="space-y-1">
            {item(view === '2d', LayoutGrid, 'Floor plan', 'Rooms, water, routes, people', () => setView('2d'))}
            {item(view === '3d', Box, '3D twin', 'The Blender building, live', () => setView('3d'))}
            {item(rightTab === 'agents', Bot, 'Agents', 'Who speaks in the negotiation', () => setRightTab('agents'), vetoes, 'tab:agents')}
            {item(rightTab === 'messages', MessagesSquare, 'Messages', 'One per person, their language', () => setRightTab('messages'), criticalMessages, 'tab:messages')}
            {item(rightTab === 'cascade', Waypoints, 'Cascade', 'What fails next, and when', () => setRightTab('cascade'), 0, 'tab:cascade')}
          </div>
        </div>
        <div>
          <p className="argus-eyebrow px-3 pb-1.5">Surfaces</p>
          <div className="space-y-1">
            <a className="nav-item" href="/phone" target="_blank" rel="noreferrer">
              <Smartphone />
              <span className="min-w-0 flex-1">
                <span className="nav-label">Manager's phone</span>
                <span className="nav-desc">Approve, say a rule</span>
              </span>
            </a>
            <a className="nav-item" href="/phone?as=ra_4" target="_blank" rel="noreferrer">
              <Radio />
              <span className="min-w-0 flex-1">
                <span className="nav-label">Responder's phone</span>
                <span className="nav-desc">RA floor 4 acknowledges steps</span>
              </span>
            </a>
            <a className="nav-item" href="/story">
              <BookOpen />
              <span className="min-w-0 flex-1">
                <span className="nav-label">The story</span>
                <span className="nav-desc">How it works, live state, stack</span>
              </span>
            </a>
          </div>
        </div>
      </nav>
      <div className={`m-3 rounded-xl border px-3 py-2.5 text-[11px] ${leftBehind ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300' : 'border-black/[0.06] bg-white/60 text-t3 dark:border-white/10 dark:bg-white/[0.04]'}`}>
        <Activity className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
        {leftBehind ? `${leftBehind} left behind: switch their agent on` : 'Nobody left behind'}
      </div>
    </aside>
  )
}

function TopNav({ title, clock, connection, world, integrations }: { title: string; clock: NonNullable<ReturnType<typeof useWorld.getState>['clock']>; connection: string; world: NonNullable<ReturnType<typeof useWorld.getState>['world']>; integrations: Integrations | null }) {
  return (
    <header className="app-topnav fixed top-4 right-4 left-[17rem] z-40 flex h-14 items-center gap-4 px-4">
      <span className="truncate text-[15px] font-semibold tracking-tight text-t1">{title}</span>
      <span className="label hidden lg:inline">David Blackwell Hall · {world.mode === 'replay' ? 'replay' : 'live'}</span>
      <div className="ml-2 flex items-center gap-3">
        <span className="mono num text-[26px] leading-none text-t1">{formatTimeOfDay(clock.time_of_day)}</span>
        <button className="btn-secondary btn-icon" onClick={() => api.clock({ playing: !clock.playing })} title={clock.playing ? 'Pause' : 'Play'} aria-label={clock.playing ? 'Pause' : 'Play'}>
          {clock.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
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
        {integrations && <IntegrationStrip flags={integrations} />}
        {world.mode === 'replay' && <span className="pill pill-amber pill-mono">REPLAY · {clock.replay_remaining} left</span>}
        <span className="flex items-center gap-2 text-[11px] text-t2">
          <span className={`h-2 w-2 rounded-full ${connection === 'open' ? 'bg-haven-safe' : connection === 'connecting' ? 'bg-haven-amber' : 'bg-haven-danger'}`} style={{ boxShadow: connection === 'open' ? '0 0 8px rgba(34,197,94,0.6)' : undefined }} />
          {connection}
        </span>
        <span className="mono hidden text-[11px] text-t3 xl:inline">
          run {world.run_id} · v{world.version}
        </span>
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
    <div className="ml-auto flex gap-3 text-[10px] text-t3">
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
              {report && <span className="mono text-[10px] text-t3">{report.live}/{report.sponsors.length} live</span>}
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
