import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Pause, Play } from 'lucide-react'
import { api, formatTimeOfDay } from '../lib/api'
import { useBudsOn } from './Buds'
import { useBuilding } from '../state/building'
import type { Clock, Integrations, SponsorReport, WorldState } from '../state/types'

/**
 * The workstation's building blocks: a collapsible widget card, the building at a glance and the system's
 * health. Every number is read from the world store or the integrations flags; the only inputs are the
 * clock buttons, which send the same events as before.
 */

export type CardId = 'plan' | 'glance' | 'cascade' | 'agents' | 'people' | 'messages' | 'inputs' | 'rule' | 'system' | 'selected'

/**
 * One collapsible card. Closed, it is a single row: an icon, a title, a one-line summary and a badge, so the
 * column reads like a list of what is going on. Open, its body slides down; it unmounts once closed, so a
 * folded panel costs nothing per world frame.
 */
export function Widget({ id, icon, title, summary, badge, badgeTone = 'blue', open, onToggle, children, bodyClass = '', tone, buds }: {
  id: CardId
  icon: ReactNode
  title: string
  summary?: ReactNode
  badge?: number | string | null
  badgeTone?: 'blue' | 'red' | 'violet' | 'amber'
  open: boolean
  onToggle: () => void
  children: ReactNode
  bodyClass?: string
  tone?: 'red' | 'amber' | 'green'
  buds?: string
}) {
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      let raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => setExpanded(true))
      })
      return () => cancelAnimationFrame(raf)
    }
    setExpanded(false)
    const t = setTimeout(() => setMounted(false), 320)
    return () => clearTimeout(t)
  }, [open])
  return (
    <section id={`card-${id}`} className={`mac-card ${open ? 'is-open' : ''} ${tone ? `is-${tone}` : ''}`} data-card={id}>
      <button className="mac-card-head" onClick={onToggle} aria-expanded={open} aria-controls={`card-body-${id}`} data-buds={buds}>
        <span className="mac-card-icon">{icon}</span>
        <span className="min-w-0 flex-1 text-left">
          <span className="mac-card-title">{title}</span>
          {summary && <span className="mac-card-summary">{summary}</span>}
        </span>
        {badge != null && badge !== 0 && badge !== '' && <span className={`mac-badge is-${badgeTone}`}>{badge}</span>}
        <ChevronDown className="mac-card-chev" />
      </button>
      <div id={`card-body-${id}`} className={`mac-collapse ${expanded ? 'is-open' : ''}`}>
        <div>{mounted && <div className={`mac-card-body ${bodyClass}`}>{children}</div>}</div>
      </div>
    </section>
  )
}

/** The building at a glance: four facts a non-engineer can read, each with its meaning. */
export function Glance({ world }: { world: WorldState }) {
  const levels = useBuilding((b) => b.levels)
  const residents = useBuilding((b) => b.residents)
  const total = Object.keys(levels).length
  const dark = world.impact.dark_levels.length
  const lifts = Object.values(world.power.lifts)
  const liftsUp = lifts.filter(Boolean).length
  const people = Object.values(residents).filter((r) => r.role === 'resident').length || Object.keys(residents).length
  const needs = world.impact.residents.length
  const plantDown = Object.values(world.equipment).filter((e) => e.status === 'flooded' || e.status === 'offline' || e.status === 'isolated').length
  const wet = world.wet_spaces.length
  const tiles: { v: string; k: string; tone?: 'hot' | 'warm' | 'ok' }[] = [
    { v: `${total - dark}/${total}`, k: 'floors with power', tone: dark ? 'hot' : 'ok' },
    { v: lifts.length ? `${liftsUp}/${lifts.length}` : '—', k: 'lifts running', tone: lifts.length && liftsUp < lifts.length ? 'hot' : 'ok' },
    { v: String(people), k: needs ? `residents · ${needs} need help` : 'residents, all fine', tone: needs ? 'warm' : undefined },
    { v: String(wet), k: plantDown ? `wet rooms · ${plantDown} plant item${plantDown === 1 ? '' : 's'} down` : 'wet rooms', tone: wet ? 'warm' : 'ok' },
  ]
  return (
    <div className="mac-tiles">
      {tiles.map((t) => (
        <div key={t.k} className={`mac-tile ${t.tone ? `is-${t.tone}` : ''}`}>
          <span key={t.v} className="mac-tile-v fade-swap">
            {t.v}
          </span>
          <span className="mac-tile-k">{t.k}</span>
        </div>
      ))}
    </div>
  )
}

export function glanceSummary(world: WorldState): string {
  const dark = world.impact.dark_levels.length
  const wet = world.wet_spaces.length
  if (!dark && !wet) return 'Every floor powered, nothing wet'
  return [dark ? `${dark} floor${dark === 1 ? '' : 's'} dark` : null, wet ? `${wet} wet room${wet === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')
}

const SERVICES = (f: Integrations): [string, boolean, string][] => [
  ['Fetch.ai', f.fetch, f.agentverse ? 'resident agents on Agentverse' : f.fetch ? 'resident agents as local uAgents' : 'HAVEN_FETCH=0'],
  ['Claude', f.llm, f.negotiation ? 'agents reason with Claude; Buds' : f.llm ? 'rule parsing fallback + explanations + Buds' : 'set ANTHROPIC_API_KEY'],
  ['ElevenLabs', f.elevenlabs, f.elevenlabs ? (f.voice_agent ? 'voice + live voice agent' : "HAVEN's voice") : 'set ELEVENLABS_API_KEY (next: Cartesia, then browser)'],
  ['Cartesia', f.cartesia, f.cartesia ? 'second voice' : 'set CARTESIA_API_KEY'],
  ['Tiger', f.tiger, f.tiger ? 'sensor time-series' : 'set TIGER_DATABASE_URL (event log used)'],
  ['Twilio', f.twilio, f.twilio ? 'real plumber call + demo text' : 'set TWILIO_* (call simulated)'],
  ['Linear', f.linear, f.linear ? 'real facilities ticket' : 'set LINEAR_API_KEY (ticket simulated)'],
]

export function servicesLive(f: Integrations | null): [number, number] {
  if (!f) return [0, 0]
  const s = SERVICES(f)
  return [s.filter((x) => x[1]).length, s.length]
}

/** The system's health: the live link, the simulated clock, and which outside services are really connected. */
export function SystemHealth({ world, clock, connection, integrations }: { world: WorldState; clock: Clock; connection: string; integrations: Integrations | null }) {
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<SponsorReport | null>(null)
  const [checking, setChecking] = useState(false)
  const act = (fn: () => Promise<unknown>) => () => {
    setError(null)
    fn().catch((e: Error) => setError(e.message))
  }
  const check = (fresh: boolean) => {
    setChecking(true)
    api
      .sponsors(fresh)
      .then(setReport)
      .catch(() => {})
      .finally(() => setChecking(false))
  }
  const [live, total] = servicesLive(integrations)
  const budsOn = useBudsOn((b) => b.on)
  const setBuds = useBudsOn((b) => b.setOn)
  return (
    <div className="space-y-3">
      <div className="mac-rows">
        <div className="mac-row">
          <span className={`mac-led ${connection === 'open' ? 'is-ok' : connection === 'connecting' ? 'is-warm' : 'is-hot'}`} />
          <span className="flex-1">Live link to the building</span>
          <span className="text-t3">{connection === 'open' ? 'connected' : connection}</span>
        </div>
        <div className="mac-row">
          <span className={`mac-led ${world.mode === 'replay' ? 'is-warm' : 'is-ok'}`} />
          <span className="flex-1">{world.mode === 'replay' ? 'Replaying a recorded run' : 'Live run'}</span>
          {world.mode === 'replay' && <span className="mono text-t3">{clock.replay_remaining} left</span>}
        </div>
        <div className="mac-row">
          <span className={`mac-led ${clock.playing ? 'is-ok' : 'is-idle'}`} />
          <span className="flex-1">
            Simulated clock <span className="mono ml-1 text-t1">{formatTimeOfDay(clock.time_of_day)}</span>
          </span>
          <button className="mac-icon-btn" onClick={act(() => api.clock({ playing: !clock.playing }))} title={clock.playing ? 'Pause the clock' : 'Play'} aria-label={clock.playing ? 'Pause' : 'Play'}>
            {clock.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="mac-row">
          <span className="mac-led is-idle" />
          <span className="flex-1">Speed</span>
          <div className="seg seg-xs" title="Simulation speed">
            {[1, 5, 20, 60].map((s) => (
              <button key={s} className={`seg-item mono ${clock.speed === s ? 'is-on' : ''}`} onClick={act(() => api.clock({ speed: s }))}>
                {s}×
              </button>
            ))}
          </div>
        </div>
        <label className="mac-row cursor-pointer">
          <span className={`mac-led ${budsOn ? 'is-ok' : 'is-idle'}`} />
          <span className="min-w-0 flex-1">
            Buds voice assistant
            <span className="block text-[11px] text-t3">{budsOn ? 'Hold Ctrl+Alt to talk · Alt+C to chat' : 'Off: never listens or speaks'}</span>
          </span>
          <span className="switch">
            <input type="checkbox" checked={budsOn} onChange={(e) => setBuds(e.target.checked)} aria-label="Buds voice assistant" />
            <span className="track" />
            <span className="knob" />
          </span>
        </label>
      </div>
      {error && <p className="text-[11px] text-haven-danger">{error}</p>}

      {integrations && (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="mac-subhead">Connected services · {live} of {total} live</span>
            <button className="btn-secondary btn-sm" disabled={checking} onClick={() => check(!!report)} title="A read-only request per service whose answer only the live service could give">
              {checking ? 'Checking…' : report ? 'Re-check' : 'Prove it'}
            </button>
          </div>
          <ul className="mac-rows">
            {report
              ? report.sponsors.map((s) => (
                  <li key={s.id} className="mac-row items-start">
                    <span className={`mac-led mt-1 ${s.state === 'live' ? 'is-ok' : s.state === 'error' ? 'is-hot' : 'is-idle'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-t1">{s.name}</span>
                      <span className="block text-[11px] text-t3">{s.role}</span>
                      <span className={`mono block text-[10px] ${s.state === 'live' ? 'text-haven-safe' : s.state === 'error' ? 'text-haven-danger' : 'text-t3'}`}>
                        {s.proof}
                        {s.latency_ms != null ? ` · ${s.latency_ms} ms` : ''}
                      </span>
                    </span>
                  </li>
                ))
              : SERVICES(integrations).map(([name, on, note]) => (
                  <li key={name} className="mac-row">
                    <span className={`mac-led ${on ? 'is-ok' : 'is-idle'}`} />
                    <span className="w-24 shrink-0 font-medium text-t1">{name}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-t3" title={note}>
                      {on ? note : 'simulated'}
                    </span>
                  </li>
                ))}
          </ul>
          <p className="mt-1.5 text-[10.5px] text-t3">Services that are not connected are simulated, so the demo still runs end to end. Keys live in backend/.env.</p>
        </div>
      )}
    </div>
  )
}
