import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Activity, AudioLines, BellRing, BookOpen, Bot, Box, Building2, Camera, CircleHelp, ClipboardList, Gauge, HeartPulse, Map as MapIcon, Mail, Mic, Moon, MoreHorizontal,
  MousePointerClick, Play, Radio, RotateCcw, Share2, SlidersHorizontal, Smartphone, Sun, SunMoon, Users, X,
} from 'lucide-react'
import { AgentConsole } from './components/AgentConsole'
import { Buds, useBudsOn } from './components/Buds'
import { CascadePanel } from './components/CascadePanel'
import { Controls } from './components/Controls'
import { FloorPlan } from './components/FloorPlan'
import { Guide, useGuide } from './components/Guide'
import { ImpactLedger } from './components/ImpactLedger'
import { Inspector, useSelection } from './components/Inspector'
import { MessagesPanel } from './components/MessagesPanel'
import { OpsView } from './components/OpsView'
import { PlanPanel } from './components/PlanPanel'
import { VoiceRule } from './components/VoiceRule'
import { Glance, SystemHealth, Widget, glanceSummary, servicesLive, type CardId } from './components/Workstation'
import { api, formatTimeOfDay } from './lib/api'
import { useBuilding } from './state/building'
import { ROLE_LABEL, useMe } from './state/me'
import { useTheme } from './lib/theme'
import type { BudsFocus, Clock, Integrations, Level, WorldState } from './state/types'
import { connectWorld, useWorld } from './state/world'
import { Panel } from './workstation/Panel'
import './workstation.css'

// Two views of the same store over the building: the live animation (generated from the spec) and the
// photoreal Blender model (GLBs). Both are lazy, so the workstation loads first and the GLBs only on request.
const Twin = lazy(() => import('./twin/Twin'))
const Building3D = lazy(() => import('./components/Building3D'))

type Render = 'live' | 'photo'
const RENDER_KEY = 'haven.render'
function loadRender(): Render {
  try {
    return localStorage.getItem(RENDER_KEY) === 'photo' ? 'photo' : 'live'
  } catch {
    return 'live'
  }
}

// Selectors must return stable references: a fresh [] per call makes Zustand's getSnapshot loop.
const NO_LEVELS: Level[] = []

type View = '2d' | '3d'
type Mode = 'overview' | 'ops'

const CARDS_KEY = 'haven.cards'
const DEFAULT_CARDS: Record<CardId, boolean> = { plan: true, glance: false, cascade: false, agents: false, people: false, messages: false, inputs: false, rule: false, system: false, selected: true }

function loadCards(): Record<CardId, boolean> {
  try {
    const raw = localStorage.getItem(CARDS_KEY)
    return raw ? { ...DEFAULT_CARDS, ...(JSON.parse(raw) as Partial<Record<CardId, boolean>>) } : DEFAULT_CARDS
  } catch {
    return DEFAULT_CARDS
  }
}

/**
 * The command centre, barebones: one story card on the left (what is happening, who is at risk, what HAVEN
 * recommends, one button) and the building on the right, coloured only where something is wrong. Everything
 * else (the plan step by step, the agents' negotiation, messages, levers, rules, system health) sits behind
 * "Show details", and the rarely used views live in the ⋯ menu. Every word and number on screen is read from
 * the one world store; every control sends an input event to the backend.
 */
export default function App() {
  useEffect(() => connectWorld(), [])
  const loadBuilding = useBuilding((b) => b.load)
  const spec = useBuilding((b) => b.spec)
  const sensorId = useBuilding((b) => b.sensorId)
  const equipment = useBuilding((b) => b.equipment)
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
  const [connections, setConnections] = useState(false)
  const [selection, setSelection] = useSelection()
  const [mode, setMode] = useState<Mode>('overview')
  const [details, setDetails] = useState(false)
  const [render, setRenderState] = useState<Render>(loadRender)
  const setRender = (r: Render) => {
    setRenderState(r)
    try {
      localStorage.setItem(RENDER_KEY, r)
    } catch {
      /* the choice lasts this visit */
    }
  }
  const [cards, setCards] = useState<Record<CardId, boolean>>(loadCards)
  useEffect(() => {
    try {
      localStorage.setItem(CARDS_KEY, JSON.stringify(cards))
    } catch {
      /* a private window: the cards just forget */
    }
  }, [cards])
  const toggleCard = (id: CardId) => setCards((c) => ({ ...c, [id]: !c[id] }))
  // Open a detail card and bring it into view (the details open first).
  const openCard = useCallback((id: CardId) => {
    setMode('overview')
    setDetails(true)
    setCards((c) => (c[id] ? c : { ...c, [id]: true }))
    setTimeout(() => document.getElementById(`card-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 120)
  }, [])

  // Operations is the everyday view; an incident always brings the building back.
  const stage = world?.narrative.stage ?? 'quiet'
  const prevStage = useRef(stage)
  useEffect(() => {
    if (prevStage.current === 'quiet' && stage !== 'quiet') setMode('overview')
    prevStage.current = stage
  }, [stage])
  useEffect(() => {
    if (selection && mode === 'overview' && details) openCard('selected')
  }, [selection, mode, details, openCard])

  const drill = (kind: 'flood' | 'grid' | 'generator') => {
    if (stage !== 'quiet') return
    if (kind === 'flood' && sensorId) api.sensor(sensorId, 0.9).catch(() => {})
    const target = Object.values(equipment).find((e) => e.kind === (kind === 'grid' ? 'utility_feed' : 'generator'))
    if (kind !== 'flood' && target) api.command(target.id, 'off', kind === 'grid' ? 'grid' : 'fault').catch(() => {})
  }
  const planLevel = level === 'all' ? (heroLevel ?? levels[levels.length - 1]?.id ?? 'all') : level

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.altKey || e.ctrlKey || e.metaKey || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return
      if (e.key === 'd' || e.key === 'D') setDetails((d) => !d)
      if (e.key === '?') guide.setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Buds points at things: open the detail card or floor that holds them first.
  useEffect(() => {
    const onFocus = (e: Event) => {
      for (const f of (e as CustomEvent<BudsFocus[]>).detail ?? []) {
        if (f.kind === 'tab' && (f.id === 'agents' || f.id === 'messages' || f.id === 'cascade' || f.id === 'inputs' || f.id === 'rule' || f.id === 'people')) openCard(f.id)
        if (f.kind === 'agent') openCard('agents')
        if (f.kind === 'message') openCard('messages')
        if (f.kind === 'step' || (f.kind === 'panel' && f.id === 'plan')) openCard('plan')
        if (f.kind === 'panel' && (f.id === 'controls' || f.id === 'voice' || f.id === 'ledger')) openCard(f.id === 'controls' ? 'inputs' : f.id === 'voice' ? 'rule' : 'people')
        if (f.kind === 'level') setLevel(f.id)
      }
      setMode('overview')
    }
    window.addEventListener('haven:focus', onFocus)
    return () => window.removeEventListener('haven:focus', onFocus)
  }, [openCard])

  if (!world || !clock) {
    return (
      <div className="mac-shell flex h-full flex-col items-center justify-center gap-3 text-t3">
        <span className="h-2 w-2 rounded-full bg-haven-blue haven-pulse" />
        <span className="text-xs">connecting to the building…</span>
      </div>
    )
  }

  // The responder's phone link: the RA with something to do (a moving or done step), else the first RA.
  const actors = Object.values(world.actors)
  const responderActor = actors.find((a) => a.label.startsWith('RA') && a.status !== 'idle' && a.status !== 'offsite') ?? actors.find((a) => a.label.startsWith('RA')) ?? actors[0]

  return (
    <div className={`mac-shell ${mode === 'ops' ? 'is-ops' : ''}`}>
      <Nav
        mode={mode}
        setMode={setMode}
        world={world}
        clock={clock}
        connection={connection}
        buildingName={spec?.name ?? ''}
        responder={responderActor?.actor ?? 'staff'}
        responderLabel={responderActor?.label ?? 'A responder'}
        onGuide={() => guide.setOpen(true)}
        view={view}
        setView={setView}
        connections={connections}
        setConnections={setConnections}
      />

      {mode === 'ops' ? (
        <>
          <main className="mac-window mac-ops enter">
            <TitleBar title="Operations" subtitle={`${spec?.name ?? ''} · an ordinary night`} onClose={() => setMode('overview')} />
            <div className="mac-ops-body">
              <OpsView world={world} onDrill={(kind) => { drill(kind); setMode('overview') }} />
            </div>
          </main>
          {selection && (
            <aside className="ops-drawer mac-window enter" aria-label="Selected record">
              <div className="flex items-center justify-between px-4 pt-3">
                <span className="eyebrow">Record</span>
                <button className="mac-icon-btn" onClick={() => setSelection(null)} aria-label="Close record">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="overflow-y-auto p-4">
                <Inspector world={world} selection={selection} />
              </div>
            </aside>
          )}
        </>
      ) : (
        <main className="mac-main">
          <aside className="mac-window mac-workstation enter" aria-label="What is happening">
            <TitleBar title="What's happening" subtitle={spec?.name ?? ''} />
            <Panel world={world} clock={clock} onDrill={drill} onDemo={() => api.loadDemo().catch(() => {})} onOps={() => setMode('ops')} onPlan={() => openCard('plan')} details={details} setDetails={setDetails}>
              <Details world={world} clock={clock} cards={cards} toggle={toggleCard} connection={connection} integrations={integrations} selection={selection} clearSelection={() => setSelection(null)} />
            </Panel>
          </aside>
          <section className="mac-window mac-stage enter" aria-label="The building">
            <TitleBar title="The building" subtitle={view === '2d' ? 'floor plan' : ''} />
            <div className="mac-viewport" data-buds="panel:map">
              <div className={`absolute inset-0 ${view === '2d' ? 'px-4 pt-4 pb-20' : ''}`}>
                {view === '3d' ? (
                  <ViewErrorBoundary key={render} fallback={<FloorPlan world={world} level={planLevel} />}>
                    {render === 'live' ? (
                      <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-t3">drawing the building…</div>}>
                        <Twin level={level} setLevel={setLevel} connections={connections} />
                      </Suspense>
                    ) : (
                      <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-t3">loading the photoreal model…</div>}>
                        <Building3D level={level} connections={connections} />
                      </Suspense>
                    )}
                  </ViewErrorBoundary>
                ) : (
                  <FloorPlan world={world} level={planLevel} connections={connections} />
                )}
              </div>
              {view === '3d' && (
                <div className="mac-render">
                  <div className="mac-seg" style={{ ['--n' as string]: 2, ['--i' as string]: render === 'live' ? 0 : 1 }} role="tablist" aria-label="How the building is drawn">
                    <button role="tab" aria-selected={render === 'live'} className={`mac-seg-item ${render === 'live' ? 'is-on' : ''}`} onClick={() => setRender('live')} title="Generated from the building's plans: water, power, people and responders animated live">
                      <Activity className="h-3.5 w-3.5" /> Live animation
                    </button>
                    <button role="tab" aria-selected={render === 'photo'} className={`mac-seg-item ${render === 'photo' ? 'is-on' : ''}`} onClick={() => setRender('photo')} title="The photorealistic model built in Blender from the same spec, tinted by the same world state">
                      <Camera className="h-3.5 w-3.5" /> Photoreal
                    </button>
                  </div>
                </div>
              )}
              <Floors world={world} levels={levels} level={level} setLevel={setLevel} planLevel={planLevel} view={view} />
            </div>
          </section>
        </main>
      )}
      {guide.open && <Guide world={world} onClose={guide.close} />}
      <Buds />
    </div>
  )
}

/* ---- the details: every card the full workstation had, folded ---------------------------------------- */

function Details({ world, clock, cards, toggle, connection, integrations, selection, clearSelection }: {
  world: WorldState
  clock: Clock
  cards: Record<CardId, boolean>
  toggle: (id: CardId) => void
  connection: string
  integrations: Integrations | null
  selection: ReturnType<typeof useSelection>[0]
  clearSelection: () => void
}) {
  const agentInfo = useBuilding((b) => b.agents)
  const live = world.plan
  const approved = world.approved_plan
  const shown = approved ?? live
  const quiet = world.narrative.stage === 'quiet'
  const leftBehind = live.left_behind.length
  const vetoes = live.stances.filter((s) => s.stance === 'veto').length
  const criticalMessages = shown.messages?.filter((m) => m.priority === 'critical').length ?? 0
  const messages = shown.messages?.length ?? 0
  const doneSteps = approved ? approved.steps.filter((s) => world.actions[s.id]?.status === 'done').length : 0
  const agentIds = Object.keys(world.agents)
  const speaking = agentIds.filter((a) => world.agents[a]).length
  const needs = world.impact.residents.length
  const coming = world.forecast.events.length
  const happened = world.timeline.filter((t) => t.severity !== 'info').length
  const [live_, total] = servicesLive(integrations)
  const icon = (I: typeof Bot) => <I className="h-4 w-4" />
  const planSummary = shown.status === 'none'
    ? 'No plan needed right now'
    : approved
      ? approved.status === 'done' ? `Done · all ${approved.steps.length} steps complete` : `Approved · ${doneSteps} of ${approved.steps.length} steps done`
      : `Draft v${live.version} · ${live.steps.length} steps · waiting for you`

  return (
    <div className="mac-details enter">
      {selection && (
        <Widget id="selected" icon={icon(MousePointerClick)} title="Selected" summary="What you clicked on the building" open={cards.selected} onToggle={() => toggle('selected')}>
          <Inspector world={world} selection={selection} />
          <button className="btn-secondary btn-sm mt-3" onClick={clearSelection}>
            <X className="h-3 w-3" /> Clear selection
          </button>
        </Widget>
      )}
      <Widget id="plan" icon={icon(ClipboardList)} title="The plan" summary={planSummary} badge={leftBehind ? `${leftBehind} left behind` : null} badgeTone="violet" tone={leftBehind ? 'red' : undefined} open={cards.plan} onToggle={() => toggle('plan')} bodyClass="mac-fixed">
        <PlanPanel world={world} clock={clock} />
      </Widget>
      <Widget id="agents" icon={icon(Bot)} title="How the agents decided" summary={`${speaking} of ${agentIds.length || Object.keys(agentInfo).length} agents speaking${quiet ? '' : vetoes ? ` · ${vetoes} object` : ' · in agreement'}`} badge={vetoes || null} badgeTone="red" open={cards.agents} onToggle={() => toggle('agents')} bodyClass="mac-fixed" buds="tab:agents">
        <AgentConsole world={world} />
      </Widget>
      <Widget id="people" icon={icon(Users)} title="People" summary={needs ? `${needs} need help now or soon` : 'Everyone is fine'} badge={needs || null} badgeTone="amber" open={cards.people} onToggle={() => toggle('people')} bodyClass="mac-fixed" buds="tab:people">
        <ImpactLedger world={world} clock={clock} />
      </Widget>
      <Widget id="messages" icon={icon(Mail)} title="Messages" summary={messages ? `${messages} ready, each in its reader's language` : 'Nothing to send'} badge={criticalMessages || null} open={cards.messages} onToggle={() => toggle('messages')} bodyClass="mac-fixed" buds="tab:messages">
        <MessagesPanel world={world} clock={clock} />
      </Widget>
      <Widget id="cascade" icon={icon(BellRing)} title="Timeline" summary={quiet ? 'Nothing to report' : `${coming} expected if nobody acts · ${happened} so far`} open={cards.cascade} onToggle={() => toggle('cascade')} bodyClass="mac-fixed" buds="tab:cascade">
        <CascadePanel world={world} clock={clock} />
      </Widget>
      <Widget id="rule" icon={icon(Mic)} title="Say a rule" summary={world.rules.length ? `${world.rules.length} rule${world.rules.length === 1 ? '' : 's'} in force` : 'Tell HAVEN a constraint, by voice or typed'} badge={world.rules.length || null} open={cards.rule} onToggle={() => toggle('rule')} buds="tab:rule">
        <VoiceRule world={world} />
      </Widget>
      <Widget id="inputs" icon={icon(SlidersHorizontal)} title="Controls" summary="The sensor, the valves and the breakers" open={cards.inputs} onToggle={() => toggle('inputs')} buds="tab:inputs">
        <Controls world={world} />
      </Widget>
      <Widget id="glance" icon={icon(Building2)} title="Building at a glance" summary={glanceSummary(world)} open={cards.glance} onToggle={() => toggle('glance')}>
        <Glance world={world} />
      </Widget>
      <Widget id="system" icon={icon(HeartPulse)} title="System" summary={`${connection === 'open' ? 'Connected' : connection}${integrations ? ` · ${live_} of ${total} services live` : ''}${world.mode === 'replay' ? ' · replay' : ''}`} tone={connection !== 'open' ? 'amber' : undefined} open={cards.system} onToggle={() => toggle('system')}>
        <SystemHealth world={world} clock={clock} connection={connection} integrations={integrations} />
      </Widget>
    </div>
  )
}

/* ---- the floor picker under the building ---------------------------------------------------------- */

function Floors({ world, levels, level, setLevel, planLevel, view }: { world: WorldState; levels: Level[]; level: string; setLevel: (l: string) => void; planLevel: string; view: View }) {
  const darkNow = new Set(world.impact.dark_levels)
  const darkSoon = new Set(world.forecast.impact.dark_levels)
  const wetLevels = new Set(world.wet_spaces.map((s) => s.split('-')[0]))
  return (
    <div className="mac-floors" data-dock>
      <span className="mac-floors-label">{view === '3d' && level === 'all' ? 'Whole building' : levels.find((l) => l.id === planLevel)?.name}</span>
      <div className="mac-floor-seg" role="group" aria-label="Floors">
        {view === '3d' && (
          <button onClick={() => setLevel('all')} className={`mac-floor ${level === 'all' ? 'is-on' : ''}`} title="Whole building">
            All
          </button>
        )}
        {[...levels]
          .sort((a, b) => b.index - a.index)
          .map((lv) => {
            const now = darkNow.has(lv.id)
            const soon = !now && darkSoon.has(lv.id)
            const wet = wetLevels.has(lv.id)
            const on = view === '3d' ? level === lv.id : planLevel === lv.id
            return (
              <button key={lv.id} data-buds={`level:${lv.id}`} onClick={() => setLevel(lv.id)} className={`mac-floor mono ${on ? 'is-on' : ''}`} title={`${lv.name}${now ? ' · dark now' : soon ? ' · dark if nothing is done' : ''}${wet ? ' · water' : ''}`}>
                {lv.id}
                {(now || soon || wet) && <span className={`mac-floor-dot ${wet ? 'bg-haven-water' : now ? 'bg-haven-danger' : 'bg-haven-amber haven-pulse'}`} />}
              </button>
            )
          })}
      </div>
    </div>
  )
}

/* ---- window chrome --------------------------------------------------------------------------------- */

function TitleBar({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose?: () => void; children?: ReactNode }) {
  return (
    <header className="mac-titlebar">
      <div className="mac-title">
        <span className="mac-title-main">{title}</span>
        {subtitle && <span className="mac-title-sub">{subtitle}</span>}
      </div>
      {children && <div className="mac-toolbar">{children}</div>}
      {onClose && (
        <button className="mac-nav-btn" onClick={onClose} title="Hide" aria-label="Hide this window">
          <X className="h-4 w-4" />
        </button>
      )}
    </header>
  )
}

function Nav({ mode, setMode, world, clock, connection, buildingName, responder, responderLabel, onGuide, view, setView, connections, setConnections }: {
  mode: Mode
  setMode: (m: Mode) => void
  world: WorldState
  clock: Clock
  connection: string
  buildingName: string
  responder: string
  responderLabel: string
  onGuide: () => void
  view: View
  setView: (v: View) => void
  connections: boolean
  setConnections: (f: (c: boolean) => boolean) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const budsOn = useBudsOn((b) => b.on)
  const toggleBuds = useBudsOn((b) => b.toggle)
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])
  const act = (fn: () => Promise<unknown>) => () => {
    setError(null)
    setMenu(false)
    fn().catch((e: Error) => setError(e.message))
  }
  const quiet = world.narrative.stage === 'quiet'
  const done = world.approved_plan?.status === 'done'
  const replay = world.mode === 'replay'
  const status = quiet ? 'All quiet' : done ? 'Resolved' : world.approved_plan ? 'HAVEN is acting' : 'Incident'
  const dot = quiet ? 'is-calm' : done ? 'is-ok' : world.approved_plan ? 'is-acting' : 'is-hot'
  return (
    <header className="mac-nav">
      <a href="/app" className="mac-brand" title="Back to the workspace">
        <span className="mac-logo">
          <span />
        </span>
        <span className="leading-tight">
          <span className="block text-[13.5px] font-semibold tracking-[0.12em] text-t1">HAVEN</span>
          <span className="mac-hide-sm block max-w-[200px] truncate text-[10.5px] text-t3">{buildingName || 'command centre'}</span>
        </span>
      </a>

      <div className="mac-status" title={world.narrative.headline}>
        <span className={`calm-dot ${dot}`} />
        <span className="font-medium text-t1">{status}</span>
        <span className="mac-hide-sm mono text-t3">{formatTimeOfDay(clock.time_of_day)}</span>
        {replay && <span className="pill pill-amber pill-mono">replay · {clock.replay_remaining}</span>}
        {connection !== 'open' && <span className="pill pill-red">{connection}</span>}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {error && <span className="mac-hide-sm max-w-[220px] truncate text-[11px] text-haven-danger" title={error}>{error}</span>}
        {mode === 'ops' && (
          <button className="mac-chip" onClick={() => setMode('overview')}>
            <Building2 className="h-3.5 w-3.5" /> Back to the building
          </button>
        )}
        <div className="relative" ref={menuRef}>
          <button className={`mac-nav-btn ${menu ? 'is-on' : ''}`} onClick={() => setMenu((m) => !m)} title="More" aria-label="More" aria-expanded={menu} aria-haspopup="menu">
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menu && (
            <div className="mac-menu" role="menu">
              <div className="mac-menu-group">Demo</div>
              <button role="menuitem" className="mac-menu-item" onClick={act(api.loadDemo)}>
                <Play className="h-3.5 w-3.5" />
                <span>
                  Watch the recorded demo<small>Leak, the Maya moment, a rule, approval, done, at 5×</small>
                </span>
              </button>
              <button role="menuitem" className="mac-menu-item" onClick={act(api.reset)}>
                <RotateCcw className="h-3.5 w-3.5" />
                <span>
                  Start over<small>A quiet building, a new run</small>
                </span>
              </button>
              <hr className="mac-menu-sep" />
              <div className="mac-menu-group">Views</div>
              <button role="menuitem" className="mac-menu-item" onClick={() => { setMode(mode === 'ops' ? 'overview' : 'ops'); setMenu(false) }}>
                <Gauge className="h-3.5 w-3.5" />
                <span>
                  {mode === 'ops' ? 'Back to the building' : 'Operations'}
                  <small>Energy, plant health, the resilience audit</small>
                </span>
              </button>
              <button role="menuitemcheckbox" aria-checked={view === '2d'} className="mac-menu-item" onClick={() => { setView(view === '3d' ? '2d' : '3d'); setMenu(false) }}>
                {view === '3d' ? <MapIcon className="h-3.5 w-3.5" /> : <Box className="h-3.5 w-3.5" />}
                <span>
                  {view === '3d' ? 'Flat floor plan' : '3D building'}
                  <small>{view === '3d' ? 'One floor, drawn like a map' : 'Back to the 3D view'}</small>
                </span>
              </button>
              <button role="menuitemcheckbox" aria-checked={connections} className="mac-menu-item" onClick={() => { setConnections((c) => !c); setMenu(false) }}>
                <Share2 className="h-3.5 w-3.5" />
                <span>
                  {connections ? 'Hide connections' : 'Show connections'}
                  <small>What powers and feeds what</small>
                </span>
              </button>
              <button role="menuitemcheckbox" aria-checked={budsOn} className="mac-menu-item" onClick={() => { toggleBuds(); setMenu(false) }}>
                <AudioLines className="h-3.5 w-3.5" />
                <span>
                  {budsOn ? 'Turn Buds off' : 'Turn on Buds'}
                  <small>{budsOn ? 'The voice assistant is on (Alt+B)' : 'Ask about the building by voice (Alt+B)'}</small>
                </span>
              </button>
              <hr className="mac-menu-sep" />
              <div className="mac-menu-group">Other screens</div>
              <a role="menuitem" className="mac-menu-item" href="/phone" target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
                <Smartphone className="h-3.5 w-3.5" />
                <span>
                  Manager's phone<small>Approve from a phone</small>
                </span>
              </a>
              <a role="menuitem" className="mac-menu-item" href={`/phone?as=${responder}`} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
                <Radio className="h-3.5 w-3.5" />
                <span>
                  Responder's phone<small>{responderLabel} confirms steps</small>
                </span>
              </a>
              <a role="menuitem" className="mac-menu-item" href="/story">
                <BookOpen className="h-3.5 w-3.5" />
                <span>
                  The story<small>How HAVEN works</small>
                </span>
              </a>
              <hr className="mac-menu-sep" />
              <p className="px-3 pt-1 pb-1.5 text-[10.5px] text-t3">
                <kbd>D</kbd> details · <kbd>?</kbd> guide
              </p>
            </div>
          )}
        </div>
        <button className="mac-nav-btn" onClick={onGuide} title="Guide (?)" aria-label="Guide">
          <CircleHelp className="h-4 w-4" />
        </button>
        <ThemeToggle />
        <Account />
      </div>
    </header>
  )
}

/** Who the server says you are: the role chip, plus Clerk's account button when sign-in is on. */
function Account() {
  const me = useMe((m) => m.me)
  const AccountButton = useMe((m) => m.AccountButton)
  const load = useMe((m) => m.load)
  useEffect(() => {
    if (!useMe.getState().me) void load()
  }, [load])
  if (!me) return null
  const who = me.source === 'demo' ? 'Demo mode: no sign-in, every surface is open' : `Signed in as ${me.email ?? me.name ?? 'you'}`
  return (
    <>
      <span className="mac-status" title={who}>
        {ROLE_LABEL[me.role]}
        {me.source === 'demo' && <span className="text-t3">· demo</span>}
      </span>
      {AccountButton && <AccountButton />}
    </>
  )
}

function ThemeToggle() {
  const { pref, cycle } = useTheme()
  const label = { system: 'Theme: follows your device', light: 'Theme: light', dark: 'Theme: dark' }[pref]
  return (
    <button className="mac-nav-btn" onClick={cycle} title={`${label} (click to change)`} aria-label={label}>
      {pref === 'system' ? <SunMoon className="h-4 w-4" /> : pref === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
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
