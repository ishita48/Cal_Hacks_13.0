import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, CheckCircle2, ChevronDown, CircleDashed, ClipboardList, Loader2, MapPin, Phone, PhoneCall, ScanLine, Siren, UserRound, Users, X, XCircle } from 'lucide-react'
import { VoiceRule } from '../components/VoiceRule'
import { select } from '../components/Inspector'
import { useRemembered } from '../components/StoryStrip'
import { api, formatClockHM, formatCountdown } from '../lib/api'
import { useBuilding } from '../state/building'
import type { Clock, OpsSnapshot, WorldState } from '../state/types'
import { useWorld } from '../state/world'
import { upcoming } from '../twin/model'
import { actorName, buildingStatus, checklist, greeting, incidentInfo, maintenance, needingHelp, phases, progress, raAvailability, routineCheck, wingOfSpace, wingsOf, type CheckLine, type NeedsHelp, type Phase, type WingId } from './logic'
import './panel.css'

/**
 * The workstation, minimal: a greeting and a wing picker; three widgets (active incidents, steps to approve,
 * people needing help) whose details open on a click; HAVEN's response with Review and Approve when there is a
 * plan; a routine check read from the building's own instruments; today's checklist from the maintenance audit;
 * and three emergency actions that are always there. Every number is the world's or the audit's. Approval is the
 * same input event the rest of HAVEN sends. A phone call is never shown as made: HAVEN opens the dialer, the
 * person makes the call.
 */

type Open = 'incidents' | 'steps' | 'people' | null
const WING_KEY = 'haven.wing'

export function Panel({ world, clock, onDrill, onDemo, onOps, onPlan, details, setDetails, children }: {
  world: WorldState
  clock: Clock
  onDrill: (kind: 'flood' | 'grid' | 'generator') => void
  onDemo: () => void
  onOps: () => void
  onPlan: () => void
  details: boolean
  setDetails: (f: (d: boolean) => boolean) => void
  children: ReactNode
}) {
  const [ops, refreshOps] = useOps()
  const spec = useBuilding((b) => b.spec)
  const spaces = useBuilding((b) => b.spaces)
  const equipment = useBuilding((b) => b.equipment)
  const levels = useBuilding((b) => b.levels)
  const storyIds = useBuilding((b) => b.storyIds)
  const footprint = spec?.footprint ?? []
  const wings = useMemo(() => wingsOf(footprint), [footprint])
  const [wing, setWingState] = useState<WingId | 'all'>(() => {
    try {
      return (localStorage.getItem(WING_KEY) as WingId | null) ?? 'all'
    } catch {
      return 'all'
    }
  })
  const setWing = (w: WingId | 'all') => {
    setWingState(w)
    try {
      localStorage.setItem(WING_KEY, w)
    } catch {
      /* the choice lasts this visit */
    }
  }
  const inWing = (spaceId: string | null | undefined) => wing === 'all' || wingOfSpace(spaceId ? spaces[spaceId] : undefined, footprint, wings) === wing

  const status = buildingStatus(world, ops)
  const incident = incidentInfo(world, spaces, equipment, levels)
  const help = needingHelp(world, storyIds)
  const people = help.people.filter((p) => inWing(p.room))
  const quiet = world.narrative.stage === 'quiet'
  const approved = world.approved_plan
  const done = approved?.status === 'done'
  // Urgent: before approval, the people in critical need; once a plan is approved, the people it leaves behind.
  const critical = approved ? approved.left_behind.length : people.filter((p) => p.severity === 'critical' || p.state === 'left').length
  const draft = !approved && world.plan.status === 'draft'
  const prog = progress(world)
  const toApprove = draft ? world.plan.steps.length : 0
  const [open, setOpen] = useState<Open>(null)
  const toggle = (o: Open) => setOpen((cur) => (cur === o ? null : o))
  const [sos, setSos] = useState<'911' | 'services' | 'ra' | null>(null)
  const wingName = wing === 'all' ? null : wings.find((w) => w.id === wing)?.name

  return (
    <div className="ws2">
      <div className="ws2-scroll">
        {/* ---- hello, and which part of the building ---- */}
        <header className="ws2-top" data-buds="panel:story">
          <div className="min-w-0">
            <h1 className="ws2-greet">{greeting(clock.time_of_day)}</h1>
            <p className={`ws2-status is-${status.health}`}>
              <i />
              {status.label}
              <span>· {formatClockHM(clock.time_of_day)}</span>
            </p>
          </div>
          {wings.length > 0 && (
            <label className="ws2-wing" title="Show the people and the checklist for one wing">
              <MapPin className="h-3.5 w-3.5" />
              <select value={wing} onChange={(e) => setWing(e.target.value as WingId | 'all')} aria-label="Part of the building">
                <option value="all">Whole building</option>
                {wings.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="h-3.5 w-3.5" />
            </label>
          )}
        </header>

        {/* ---- three widgets; details open below the one you click ---- */}
        <div className="ws2-widgets" role="tablist" aria-label="What needs you">
          <WidgetTile icon={<Siren className="h-4 w-4" />} label="Active incidents" sub={incident ? (done ? 'resolved' : incident.type) : 'none'} badge={!quiet && !done ? 1 : 0} open={open === 'incidents'} onClick={() => toggle('incidents')} />
          <WidgetTile icon={<ClipboardList className="h-4 w-4" />} label="Steps to approve" sub={draft ? `plan v${world.plan.version}` : approved ? (done ? 'all done' : `${prog?.done.length ?? 0} of ${approved.steps.length} done`) : 'none'} badge={toApprove} open={open === 'steps'} onClick={() => toggle('steps')} />
          <WidgetTile icon={<Users className="h-4 w-4" />} label="People needing help" sub={people.length ? `${people.length}${wingName ? ` in the ${wingName.toLowerCase()}` : approved ? ' affected, in the plan' : help.predicted && !quiet ? ' at risk' : ''}` : 'everyone is fine'} badge={critical} open={open === 'people'} onClick={() => toggle('people')} />
        </div>
        {open && (
          <div className="ws2-drawer enter" key={open}>
            {open === 'incidents' && <IncidentDetails world={world} clock={clock} incident={incident} />}
            {open === 'steps' && <StepsDetails world={world} onPlan={onPlan} />}
            {open === 'people' && <PeopleDetails people={people} predicted={help.predicted} wingName={wingName} />}
          </div>
        )}

        {/* ---- HAVEN's response, when there is one ---- */}
        {draft && <Response world={world} onPlan={onPlan} />}
        {approved && !done && prog && <Underway world={world} prog={prog} onPlan={onPlan} />}
        {done && approved && <Resolved world={world} />}

        {/* ---- routine work ---- */}
        <RoutineCheck world={world} clock={clock} refresh={refreshOps} />
        <Checklist ops={ops} world={world} inWing={(id) => inWing(id ? equipment[id]?.space : null)} wingName={wingName} onChanged={refreshOps} onOps={onOps} />
        {quiet && (
          <p className="ws2-drill">
            Practise:{' '}
            <button disabled={world.mode === 'replay'} onClick={() => onDrill('flood')}>flood drill</button> ·{' '}
            <button disabled={world.mode === 'replay'} onClick={() => onDrill('grid')}>grid outage</button> ·{' '}
            <button disabled={world.mode === 'replay'} onClick={() => onDrill('generator')}>generator trips</button> ·{' '}
            <button disabled={world.mode === 'replay'} onClick={onDemo}>watch the demo</button>
          </p>
        )}

        <button className={`ws2-more ${details ? 'is-open' : ''}`} onClick={() => setDetails((d) => !d)} aria-expanded={details}>
          {details ? 'Hide all details' : 'All details'} <ChevronDown className="h-3.5 w-3.5" />
        </button>
        {details && <div className="ws2-details">{children}</div>}
      </div>

      {/* ---- always there ---- */}
      <footer className="ws2-sos" aria-label="Emergency actions">
        <button className="ws2-sos-btn" onClick={() => setSos('services')}>
          <Phone className="h-4 w-4" />
          <span>Emergency services</span>
        </button>
        <button className="ws2-sos-btn" onClick={() => setSos('ra')}>
          <UserRound className="h-4 w-4" />
          <span>Contact an RA</span>
        </button>
        <button className="ws2-sos-btn is-911" onClick={() => setSos('911')}>
          <PhoneCall className="h-4 w-4" />
          <span>Call 911</span>
        </button>
      </footer>
      {sos && <Sos kind={sos} world={world} incident={incident} address={spec ? `${spec.name}, ${spec.address}` : ''} onKind={setSos} onClose={() => setSos(null)} />}
    </div>
  )
}

/** The maintenance audit (GET /api/ops), refreshed every 15 s and on demand. */
function useOps(): [OpsSnapshot | null, () => Promise<void>] {
  const [ops, setOps] = useState<OpsSnapshot | null>(null)
  const version = useWorld((s) => s.world?.version ?? 0)
  const last = useRef(0)
  const refresh = async () => {
    last.current = performance.now()
    const o = await api.ops().catch(() => null)
    if (o) setOps(o)
  }
  useEffect(() => {
    const wait = last.current === 0 ? 0 : Math.max(0, 15000 - (performance.now() - last.current))
    const t = setTimeout(() => void refresh(), wait)
    return () => clearTimeout(t)
  }, [version])
  return [ops, refresh]
}

function WidgetTile({ icon, label, sub, badge, open, onClick }: { icon: ReactNode; label: string; sub: string; badge: number; open: boolean; onClick: () => void }) {
  return (
    <button className={`ws2-tile ${open ? 'is-open' : ''}`} onClick={onClick} role="tab" aria-selected={open} aria-label={`${label}: ${badge || sub}`}>
      <span className="ws2-tile-icon">{icon}</span>
      {badge > 0 && (
        <span key={badge} className="ws2-badge pop">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      <span className="ws2-tile-label">{label}</span>
      <span className="ws2-tile-sub">{sub}</span>
    </button>
  )
}

function Card({ id, title, icon, tone, children, aside }: { id?: string; title: string; icon: ReactNode; tone?: 'hot' | 'ok' | 'acting'; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} className={`ws2-card ${tone ? `is-${tone}` : ''}`}>
      <header className="ws2-card-head">
        <span className="ws2-card-icon">{icon}</span>
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

/* ---- the widgets' details ---------------------------------------------------------------------- */

function IncidentDetails({ world, clock, incident }: { world: WorldState; clock: Clock; incident: ReturnType<typeof incidentInfo> }) {
  const [more, setMore] = useState(false)
  if (!incident) return <p className="ws2-empty">No active incidents. The water sensors are dry and every floor has power.</p>
  const n = world.narrative
  const remaining = n.contact_at_s != null ? n.contact_at_s - clock.sim_time : null
  const events = upcoming(world, clock)
  const critical = new Set(world.forecast.events.filter((e) => e.severity === 'critical').map((e) => `${e.kind}:${e.id}`))
  const next = [...events.filter((e) => critical.has(e.id)), ...events.filter((e) => !critical.has(e.id))].slice(0, 3).sort((a, b) => a.remaining - b.remaining)
  return (
    <div>
      <div className="ws2-row">
        <span className={`ws2-pill is-${incident.severity === 'Emergency' ? 'hot' : 'warm'}`}>{incident.severity}</span>
        <span className="ws2-strong">{incident.type}</span>
      </div>
      <p className="ws2-muted mt-1 flex items-center gap-1">
        <MapPin className="h-3 w-3" /> {incident.location}
      </p>
      <p className="ws2-head fade-swap" key={n.headline}>{n.headline}</p>
      {remaining != null && n.contact_name && !world.approved_plan && remaining > 0 && (
        <p className="ws2-count">
          {formatCountdown(remaining)} <span>until water reaches {n.contact_name}</span>
        </p>
      )}
      {more && n.detail && <p className="ws2-text enter">{n.detail}</p>}
      {more && next.length > 0 && !world.approved_plan && (
        <ol className="ws2-next enter">
          {next.map((e) => (
            <li key={e.id}>
              <span>{e.remaining > 0 ? `in ${formatCountdown(e.remaining)}` : 'now'}</span>
              {e.message}
            </li>
          ))}
        </ol>
      )}
      <button className="ws2-link" onClick={() => setMore((m) => !m)}>
        {more ? 'Less' : 'What happened and what fails next'}
      </button>
    </div>
  )
}

function StepsDetails({ world, onPlan }: { world: WorldState; onPlan: () => void }) {
  const plan = world.approved_plan ?? world.plan
  if (plan.status === 'none') return <p className="ws2-empty">Nothing to approve. When something happens, HAVEN's agents propose a plan here.</p>
  return (
    <div>
      <ol className="ws2-phases">
        {phases(plan, world.actions).map((g, i) => (
          <PhaseRow key={g.id} n={i + 1} phase={g} world={world} />
        ))}
      </ol>
      <button className="ws2-link" onClick={onPlan}>
        The full plan, step by step
      </button>
    </div>
  )
}

const STATE_WORD: Record<NeedsHelp['state'], string> = { left: 'left behind', moved: 'moved to safety', covered: 'in the plan', affected: 'affected' }

function PeopleDetails({ people, predicted, wingName }: { people: NeedsHelp[]; predicted: boolean; wingName: string | null | undefined }) {
  const [all, setAll] = useState(false)
  const levels = useBuilding((b) => b.levels)
  if (people.length === 0) return <p className="ws2-empty">Nobody needs help{wingName ? ` in the ${wingName.toLowerCase()}` : ''} right now.</p>
  const shown = all ? people : people.slice(0, 5)
  return (
    <div>
      {predicted && <p className="ws2-muted mb-1">If nobody acts, the hardest hit first.</p>}
      <ul className="ws2-people">
        {shown.map((p) => (
          <li key={p.id}>
            <button onClick={() => select({ kind: 'resident', id: p.id })} data-buds={`resident:${p.id}`}>
              <i className={`is-${p.state === 'left' ? 'left' : p.severity}`} />
              <span className="min-w-0 flex-1 text-left">
                <span className="ws2-strong">{p.name}</span> <span className="ws2-muted">{levels[p.level]?.name ?? p.level}</span>
                <span className="ws2-sub">{[p.needs, p.why].filter(Boolean).join(' · ')}</span>
              </span>
              <span className={`ws2-state is-${p.state}`}>{STATE_WORD[p.state]}</span>
            </button>
          </li>
        ))}
      </ul>
      {people.length > 5 && (
        <button className="ws2-link" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${people.length}`}
        </button>
      )}
    </div>
  )
}

function PhaseRow({ n, phase, world }: { n: number; phase: Phase; world: WorldState }) {
  const [open, setOpen] = useState(false)
  const complete = !!world.approved_plan && phase.done === phase.steps.length
  return (
    <li className="ws2-phase">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`ws2-phase-n ${complete ? 'is-done' : ''}`}>{complete ? <Check className="h-3 w-3" /> : n}</span>
        <span className="min-w-0 flex-1 text-left">
          <span className="ws2-strong">{phase.title}</span>
          <span className="ws2-sub">{phase.steps.length} step{phase.steps.length === 1 ? '' : 's'}{world.approved_plan ? ` · ${phase.done} done` : ''}</span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-t4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul className="ws2-steps enter">
          {phase.steps.map((s) => {
            const a = world.actions[s.id]
            return (
              <li key={s.id}>
                {a?.status === 'done' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-haven-safe" /> : a?.status === 'failed' ? <XCircle className="h-4 w-4 shrink-0 text-haven-danger" /> : a?.status === 'assigned' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-haven-blue" /> : <CircleDashed className="h-4 w-4 shrink-0 text-t4" />}
                <span className="min-w-0 flex-1">
                  {s.title}
                  <span className="ws2-sub">{actorName(s.actor, world.actors)}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

/* ---- HAVEN's response ------------------------------------------------------------------------------ */

function Response({ world, onPlan }: { world: WorldState; onPlan: () => void }) {
  const plan = world.plan
  const residents = useBuilding((b) => b.residents)
  const heroId = useBuilding((b) => b.heroId)
  const [review, setReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const left = plan.left_behind
  const failing = plan.checks.filter((c) => !c.ok)
  const groups = phases(plan, world.actions)
  const crew = maintenance(plan, world.actors)
  const ras = raAvailability(world.actors)
  const approve = () => {
    setError(null)
    setBusy(true)
    api
      .decidePlan(useWorld.getState().world?.plan.version ?? plan.version, 'approve')
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  return (
    <Card id="ws-response" title="HAVEN response" icon={<ClipboardList className="h-4 w-4" />} tone={left.length ? 'hot' : 'acting'} aside={<span className="ws2-muted ml-auto">plan v{plan.version}</span>}>
      <p className="ws2-reco fade-swap" key={world.narrative.next}>{world.narrative.next.replace(/^The agents propose: /, '')}</p>
      <ol className="ws2-mini">
        {groups.slice(0, 4).map((g, i) => (
          <li key={g.id}>
            <b>{i + 1}</b>
            {g.title}
          </li>
        ))}
      </ol>
      {(left.length > 0 || failing.length > 0) && (
        <div className="ws2-warn">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{left.length ? `Leaves ${left.map((id) => residents[id]?.name.split(' ')[0] ?? id).join(', ')} behind: nobody spoke for them.` : `${failing.length} check${failing.length === 1 ? '' : 's'} fail: ${failing.map((c) => c.label).join('; ')}`}</span>
        </div>
      )}
      {left.length > 0 && heroId && left.includes(heroId) && <AgentSwitch world={world} />}
      <div className="ws2-actions">
        <button className={`ws2-btn ${review ? 'is-on' : ''}`} onClick={() => setReview((r) => !r)} aria-expanded={review}>
          Review
        </button>
        <button className="ws2-btn is-primary" disabled={world.mode === 'replay' || busy || plan.status !== 'draft'} onClick={approve} data-buds="panel:approve">
          <Check className="h-4 w-4" /> {left.length ? `Approve anyway` : 'Approve'}
        </button>
      </div>
      {error && <p className="mt-2 text-[12px] text-haven-danger">{error}</p>}
      {review && (
        <div className="ws2-review enter">
          <ol className="ws2-phases">
            {groups.map((g, i) => (
              <PhaseRow key={g.id} n={i + 1} phase={g} world={world} />
            ))}
          </ol>
          {failing.length === 0 && <p className="ws2-ok"><CheckCircle2 className="h-3.5 w-3.5" /> All {plan.checks.length} safety and access checks pass.</p>}
          {crew.length > 0 && (
            <p className="ws2-text">
              <b>Maintenance:</b> {crew.map((c) => `${c.who}: ${c.what}`).join('; ')}
            </p>
          )}
          {ras.length > 0 && (
            <p className="ws2-text">
              <b>RAs:</b> {ras.filter((r) => r.status === 'idle').length} of {ras.length} free
            </p>
          )}
          <div className="ws2-sub mt-3 mb-1">Change the plan</div>
          <AgentSwitch world={world} />
          <VoiceRule world={world} />
          <button className="ws2-link mt-2" onClick={onPlan}>
            Every step, every agent's reasoning
          </button>
        </div>
      )}
    </Card>
  )
}

function AgentSwitch({ world }: { world: WorldState }) {
  const heroId = useBuilding((b) => b.heroId)
  const residents = useBuilding((b) => b.residents)
  const [error, setError] = useState<string | null>(null)
  const agent = heroId ? `resident:${heroId}` : null
  const on = agent && agent in world.agents ? world.agents[agent] : undefined
  if (!agent || on === undefined) return null
  const name = residents[heroId!]?.name.split(' ')[0] ?? heroId
  return (
    <label className="calm-switch ws2-switch" data-buds={`agent:${agent}`}>
      <span className="switch">
        <input type="checkbox" checked={on} disabled={world.mode === 'replay'} onChange={(e) => api.toggleAgent(agent, e.target.checked).catch((er: Error) => setError(er.message))} />
        <span className="track" />
        <span className="knob" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-t1">{name}'s agent {on ? 'is speaking for them' : 'is off'}</span>
        <span className="block text-[11.5px] text-t3">{on ? `Switch it off to see the plan without ${name}'s voice.` : `Nobody speaks for ${name}. Switch it back on and the plan changes.`}</span>
        {error && <span className="block text-[11px] text-haven-danger">{error}</span>}
      </span>
    </label>
  )
}

function Underway({ world, prog, onPlan }: { world: WorldState; prog: NonNullable<ReturnType<typeof progress>>; onPlan: () => void }) {
  const plan = world.approved_plan!
  const [review, setReview] = useState(false)
  const total = plan.steps.length
  return (
    <Card id="ws-progress" title="HAVEN response" icon={<ClipboardList className="h-4 w-4" />} tone="acting" aside={<span className="ws2-muted ml-auto">approved · {prog.done.length} of {total} done</span>}>
      <div className="progress my-2">
        <span style={{ width: `${total ? (prog.done.length / total) * 100 : 0}%` }} />
      </div>
      {prog.assigned.length > 0 && (
        <p className="ws2-text">
          <b>Waiting on:</b> {prog.assigned.slice(0, 3).map((s) => actorName(s.actor, world.actors)).join(', ')}
          {prog.assigned.length > 3 ? ` and ${prog.assigned.length - 3} more` : ''}
        </p>
      )}
      <div className="ws2-actions">
        <button className={`ws2-btn ${review ? 'is-on' : ''}`} onClick={() => setReview((r) => !r)} aria-expanded={review}>
          Review
        </button>
      </div>
      {review && (
        <div className="ws2-review enter">
          <ol className="ws2-phases">
            {phases(plan, world.actions).map((g, i) => (
              <PhaseRow key={g.id} n={i + 1} phase={g} world={world} />
            ))}
          </ol>
          {prog.acks.length > 0 && (
            <>
              <div className="ws2-sub mt-3 mb-1">Confirmed</div>
              <ul className="ws2-acks">
                {prog.acks.slice(0, 5).map((a) => (
                  <li key={a.id}>
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-haven-safe" />
                    <span>
                      {a.title} <span className="ws2-muted">· {a.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button className="ws2-link mt-2" onClick={onPlan}>
            Every step, with times
          </button>
        </div>
      )}
    </Card>
  )
}

function Resolved({ world }: { world: WorldState }) {
  const plan = world.approved_plan!
  const remembered = useRemembered(world)
  const [busy, setBusy] = useState(false)
  return (
    <Card id="ws-resolved" title="Resolved" icon={<CheckCircle2 className="h-4 w-4" />} tone="ok">
      <p className="ws2-text">
        {plan.metrics.relocated ?? 0} relocated, {plan.metrics.escorted ?? 0} escorted by lift, {plan.left_behind.length} left behind, {plan.metrics.violations ?? 0} rules broken.
      </p>
      {remembered && <p className="calm-memory">{remembered}</p>}
      <div className="ws2-actions">
        <button className="ws2-btn is-primary" disabled={world.mode === 'replay' || busy} onClick={() => { setBusy(true); api.reset().finally(() => setBusy(false)) }}>
          <Check className="h-4 w-4" /> Close the incident
        </button>
      </div>
    </Card>
  )
}

/* ---- routine check and today's checklist ------------------------------------------------------------- */

function RoutineCheck({ world, clock, refresh }: { world: WorldState; clock: Clock; refresh: () => Promise<void> }) {
  const [state, setState] = useState<{ at: string; lines: CheckLine[] } | 'running' | null>(null)
  const [shown, setShown] = useState(0)
  const equipment = useBuilding((b) => b.equipment)
  const sensorIds = useMemo(() => Object.values(equipment).filter((e) => e.kind === 'sensor').map((e) => e.id), [equipment])
  // a result belongs to the moment it was taken: when the situation changes, it is cleared rather than left stale
  const stage = world.narrative.stage
  const approvedAt = world.approved_plan?.version ?? null
  useEffect(() => setState(null), [stage, approvedAt])
  const run = async () => {
    setState('running')
    setShown(0)
    await refresh()
    const ops = await api.ops().catch(() => null)
    const w = useWorld.getState().world ?? world
    if (!ops) {
      setState(null)
      return
    }
    setState({ at: formatClockHM(useWorld.getState().clock?.time_of_day ?? clock.time_of_day), lines: routineCheck(w, ops, sensorIds) })
  }
  // the lines arrive one after another, like an inspection walking the building
  useEffect(() => {
    if (!state || state === 'running' || shown >= state.lines.length) return
    const t = setTimeout(() => setShown((n) => n + 1), 140)
    return () => clearTimeout(t)
  }, [state, shown])
  const issues = state && state !== 'running' ? state.lines.filter((l) => !l.ok).length : 0
  return (
    <section className="ws2-check">
      <button className="ws2-check-btn" onClick={run} disabled={state === 'running'}>
        {state === 'running' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
        {state === 'running' ? 'Checking the building…' : state ? 'Run the routine check again' : 'Start routine check'}
      </button>
      {state && state !== 'running' && (
        <div className="ws2-check-out">
          <div className={`ws2-check-sum ${issues ? 'is-warn' : 'is-ok'}`}>
            {issues ? `${issues} thing${issues === 1 ? '' : 's'} to look at` : 'All clear'} <span>· checked {state.at}</span>
          </div>
          <ul>
            {state.lines.slice(0, shown).map((l) => (
              <li key={l.id} className="enter">
                {l.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-haven-safe" /> : <AlertTriangle className="h-3.5 w-3.5 text-haven-amber" />}
                <span className="flex-1">{l.label}</span>
                <span className="ws2-muted">{l.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function Checklist({ ops, world, inWing, wingName, onChanged, onOps }: { ops: OpsSnapshot | null; world: WorldState; inWing: (equipmentId: string | null) => boolean; wingName: string | null | undefined; onChanged: () => Promise<void>; onOps: () => void }) {
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!ops) return null
  const items = checklist(ops).filter((f) => inWing(f.equipment))
  const doneCount = items.filter((f) => f.work_order?.status === 'done').length
  const shown = all ? items : items.slice(0, 4)
  const replay = world.mode === 'replay'
  const file = (id: string, status: 'open' | 'done') => {
    setBusy(id)
    setError(null)
    api
      .workOrder(id, status)
      .then(onChanged)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null))
  }
  return (
    <section className="ws2-list">
      <header>
        <h2>Today's checklist</h2>
        <span className="ws2-muted">
          {doneCount} of {items.length} done{wingName ? ` · ${wingName.toLowerCase()}` : ''}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="ws2-empty">Nothing on the list{wingName ? ` for the ${wingName.toLowerCase()}` : ''}.</p>
      ) : (
        <ul>
          {shown.map((f) => {
            const done = f.work_order?.status === 'done'
            const scheduled = f.work_order?.status === 'open'
            return (
              <li key={f.id} className={done ? 'is-done' : ''}>
                <label>
                  <input type="checkbox" checked={done} disabled={done || replay || busy === f.id} onChange={() => file(f.id, 'done')} aria-label={`Mark done: ${f.title}`} />
                  <span className="ws2-tick">{busy === f.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="ws2-item">{f.title}</span>
                    <span className="ws2-sub">
                      {f.severity === 'critical' ? 'critical' : f.severity}
                      {scheduled ? ' · work order open' : ''}
                      {f.stranded ? ` · would strand ${f.stranded}` : ''}
                    </span>
                  </span>
                </label>
                {!f.work_order && !done && (
                  <button className="ws2-mini-btn" disabled={replay || busy === f.id} onClick={() => file(f.id, 'open')} title="File a work order for facilities (Linear when it is set up)">
                    Schedule
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {error && <p className="mt-1 text-[11.5px] text-haven-danger">{error}</p>}
      <div className="flex items-center gap-3">
        {items.length > 4 && (
          <button className="ws2-link" onClick={() => setAll((a) => !a)}>
            {all ? 'Show fewer' : `Show all ${items.length}`}
          </button>
        )}
        <button className="ws2-link" onClick={onOps}>
          Plant health and energy
        </button>
      </div>
    </section>
  )
}

/* ---- emergency actions --------------------------------------------------------------------------------- */

const SERVICES_NUMBER = (import.meta.env.VITE_HAVEN_EMERGENCY_NUMBER as string | undefined)?.trim() || ''
const SERVICES_LABEL = (import.meta.env.VITE_HAVEN_EMERGENCY_LABEL as string | undefined)?.trim() || 'Emergency services'

/**
 * A confirmation sheet for each emergency action. Calls go through the device's dialer (tel:): HAVEN does not
 * place them and cannot see whether they connect, so it never says a call was made. What to tell the
 * dispatcher is read from the spec and the incident.
 */
function Sos({ kind, world, incident, address, onKind, onClose }: { kind: '911' | 'services' | 'ra'; world: WorldState; incident: ReturnType<typeof incidentInfo>; address: string; onKind: (k: '911' | 'services' | 'ra') => void; onClose: () => void }) {
  const [opened, setOpened] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const say = incident ? `${incident.type} at ${address}: ${incident.location}. ${world.narrative.headline}` : `${address}.`
  const ras = raAvailability(world.actors)
  const WORD: Record<string, string> = { idle: 'free', moving: 'on a task', done: 'finished a task', offsite: 'off site' }
  return (
    <div className="ws2-sheet-back" onClick={onClose}>
      <div className="ws2-sheet enter" role="dialog" aria-modal="true" aria-label={kind === 'ra' ? 'Contact an RA' : kind === '911' ? 'Call 911' : 'Contact emergency services'} onClick={(e) => e.stopPropagation()}>
        <button className="ws2-sheet-x" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
        {kind === '911' && (
          <>
            <h3>Call 911?</h3>
            <p className="ws2-text">This opens your phone's dialer with 911. HAVEN does not place the call and cannot see whether it connects: stay on the line with the dispatcher.</p>
            <div className="ws2-say">
              <span>Tell them</span>
              {say}
            </div>
            {opened ? (
              <p className="ws2-text">If your phone app did not open, dial 911 from any phone.</p>
            ) : (
              <div className="ws2-actions">
                <button className="ws2-btn" onClick={onClose}>Cancel</button>
                <a className="ws2-btn is-danger" href="tel:911" onClick={() => setOpened(true)}>
                  <PhoneCall className="h-4 w-4" /> Call 911
                </a>
              </div>
            )}
          </>
        )}
        {kind === 'services' && (
          <>
            <h3>Contact {SERVICES_LABEL.toLowerCase() === 'emergency services' ? 'emergency services' : SERVICES_LABEL}?</h3>
            {SERVICES_NUMBER ? (
              <>
                <p className="ws2-text">This opens your phone's dialer with {SERVICES_LABEL} ({SERVICES_NUMBER}). HAVEN does not place the call.</p>
                <div className="ws2-say">
                  <span>Tell them</span>
                  {say}
                </div>
                {opened ? (
                  <p className="ws2-text">If your phone app did not open, dial {SERVICES_NUMBER}.</p>
                ) : (
                  <div className="ws2-actions">
                    <button className="ws2-btn" onClick={onClose}>Cancel</button>
                    <a className="ws2-btn is-danger" href={`tel:${SERVICES_NUMBER.replace(/[^\d+]/g, '')}`} onClick={() => setOpened(true)}>
                      <Phone className="h-4 w-4" /> Call {SERVICES_LABEL}
                    </a>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="ws2-text">No emergency-services number is set up for this building yet, so HAVEN can't dial one. In a life-threatening emergency, call 911.</p>
                <p className="ws2-muted">To add one, set VITE_HAVEN_EMERGENCY_NUMBER (and VITE_HAVEN_EMERGENCY_LABEL) in frontend/.env.</p>
                <div className="ws2-actions">
                  <button className="ws2-btn" onClick={onClose}>Close</button>
                  <button className="ws2-btn is-danger" onClick={() => onKind('911')}>
                    <PhoneCall className="h-4 w-4" /> Call 911 instead
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {kind === 'ra' && (
          <>
            <h3>Contact an RA</h3>
            <p className="ws2-text">Who is free right now, from HAVEN's live view of the response. HAVEN has no phone numbers on file for RAs; when you approve a plan, each RA gets their assignment in their HAVEN app.</p>
            {ras.length === 0 ? (
              <p className="ws2-empty">No RAs on duty in HAVEN's roster.</p>
            ) : (
              <ul className="ws2-ras">
                {ras.map((r) => (
                  <li key={r.id}>
                    <span className={`ws2-dot is-${r.status}`} />
                    <span className="min-w-0 flex-1">
                      <span className="ws2-strong">{r.label}</span>
                      <span className="ws2-sub">{WORD[r.status] ?? r.status}</span>
                    </span>
                    <a className="ws2-mini-btn" href={`/phone?as=${r.id}`} target="_blank" rel="noreferrer">
                      Their HAVEN app
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
