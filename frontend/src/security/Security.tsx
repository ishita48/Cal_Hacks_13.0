import { useEffect, useMemo, useRef, useState } from 'react'
import { Accessibility, CheckCircle2, DoorOpen, Home, ListOrdered, Radio, ShieldAlert, Siren, Truck, Zap, type LucideIcon } from 'lucide-react'
import { api, formatTimeOfDay } from '../lib/api'
import { Avatar, Shell, reveal, type RailItem } from '../roles/Shell'
import { useMe } from '../state/me'
import type { BuildingSpec } from '../state/types'
import { connectWorld, useWorld } from '../state/world'
import { greeting } from '../student/model'
import { securityView, type QueueRow, type SecurityView, type SiteMap } from './model'
import './security.css'

/**
 * Dispatch (/app/security): the life-safety escalation that needs responders first (hero, with the footprint and
 * the nearest step-free entrance), the escalation queue, and the responders who are moving. It reads the live
 * world over /ws (only an admin opens it), holds no copy of it, and its one action is the human gate itself:
 * "Dispatch responders" approves the plan on the table, the same decision the command centre makes.
 */
export default function Security() {
  useEffect(() => connectWorld(), [])
  const world = useWorld((w) => w.world)
  const clock = useWorld((w) => w.clock)
  const connection = useWorld((w) => w.connection)
  const me = useMe((m) => m.me)
  const [spec, setSpec] = useState<BuildingSpec | null>(null)
  useEffect(() => {
    api.building().then(setSpec).catch(() => setSpec(null))
  }, [])
  const view = useMemo(() => (world ? securityView(world, spec) : null), [world, spec])
  const queue = useRef<HTMLElement>(null)
  const units = useRef<HTMLElement>(null)
  const name = me?.name ?? me?.email?.split('@')[0] ?? (me?.source === 'demo' ? 'Dispatch' : '')
  const rail: RailItem[] = [
    { label: 'Overview', icon: Home, on: true, onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { label: 'Escalation queue', icon: ListOrdered, onClick: () => reveal(queue.current), dot: !!view?.active },
    { label: 'Responders', icon: Radio, onClick: () => reveal(units.current) },
  ]

  if (!view)
    return (
      <Shell items={rail}>
        <div className="st-empty">
          <h1>{connection === 'closed' ? 'Dispatch is reconnecting…' : 'Opening dispatch…'}</h1>
          <p>Dispatch reads the live building. It opens for housing admins.</p>
        </div>
      </Shell>
    )

  return (
    <Shell items={rail} initial={name[0] ?? 'D'}>
      <header className="st-top">
        <div>
          <h1>
            Dispatch · {greeting(new Date().getHours())}
            {name ? `, ${name.split(' ')[0]}` : ''}
          </h1>
          <p className="st-sub">
            Campus Safety · {spec?.name ?? 'the building'} · {clock ? formatTimeOfDay(clock.time_of_day).slice(0, 5) : '--:--'}
          </p>
        </div>
        <div className="st-who">
          <span className={`st-pill ${view.active ? 'is-alert' : 'is-ok'}`}>
            <i />
            {view.active ? `${view.active} active dispatch${view.active === 1 ? '' : 'es'}` : 'All clear'}
          </span>
          <div className="st-id">
            <strong>{name || 'Dispatch'}</strong>
            <small>Security · Dispatch</small>
          </div>
          <Avatar initial={name[0] ?? 'D'} />
        </div>
      </header>
      <Body view={view} runId={world?.run_id ?? ''} queueRef={queue} unitsRef={units} />
    </Shell>
  )
}

function Body({ view, runId, queueRef, unitsRef }: { view: SecurityView; runId: string; queueRef: React.RefObject<HTMLElement | null>; unitsRef: React.RefObject<HTMLElement | null> }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [acked, setAcked] = useState<string[]>(() => readAcks(runId))
  const hero = view.hero
  const dispatch = async () => {
    setBusy(true)
    setNote(null)
    try {
      await api.decidePlan(view.planVersion, 'approve', 'dispatch')
      setNote({ ok: true, text: `Plan v${view.planVersion} approved: every responder in it is dispatched.` })
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  const acknowledge = () => {
    if (!hero) return
    const next = [...new Set([...acked, hero.id])]
    setAcked(next)
    writeAcks(runId, next)
  }

  return (
    <>
      {note && <p className={`st-toast ${note.ok ? '' : 'is-error'}`} role="status">{note.text}</p>}
      <div className="st-grid sc-grid">
        {hero ? (
          <section className={`st-card sc-hero is-${hero.status}`} aria-live="polite">
            <header className="sc-hero-head">
              <span className="st-eyebrow">Active escalation</span>
              <span className={`sc-tag is-${hero.status === 'assisted' ? 'assisted' : 'critical'}`}>{hero.status === 'assisted' ? 'Responders assigned' : hero.leftBehind ? 'Nobody assigned' : !hero.step ? 'Not in the plan' : 'Awaiting dispatch'}</span>
            </header>
            <div className="sc-who">
              <span className="sc-badge">{hero.stepFree ? <Accessibility size={28} /> : <Siren size={28} />}</span>
              <div>
                <h2>{hero.title}</h2>
                <p className="sc-sub">
                  {hero.name} · {hero.room} · {hero.where}
                </p>
              </div>
            </div>
            {!!view.info.length && <p className="sc-info">{view.info.join(' · ')}</p>}
            {view.map && <SiteMapView map={view.map} />}
            <div className="sc-enroute">
              <Truck size={18} />
              <span>{view.responders.join(' · ')}</span>
            </div>
            <div className="sc-actions">
              <button className="st-btn sc-red" disabled={busy || !!view.dispatchBlocked} onClick={() => void dispatch()}>
                <Siren size={17} /> {view.approved ? 'Responders dispatched' : busy ? 'Dispatching…' : 'Dispatch responders'}
              </button>
              <button className="st-btn is-ghost" disabled={acked.includes(hero.id)} onClick={acknowledge}>
                {acked.includes(hero.id) ? <><CheckCircle2 size={17} /> Acknowledged</> : 'Acknowledge'}
              </button>
            </div>
            <p className="sc-fine">
              {view.dispatchBlocked || `Dispatch approves plan v${view.planVersion}: every step in it goes out, not just this one.`} Acknowledge is noted on this
              screen only.
            </p>
          </section>
        ) : (
          <section className="st-card st-hero is-ok sc-hero">
            <span className="st-hero-mark">
              <CheckCircle2 size={30} />
            </span>
            <h2>No active escalations</h2>
            <p>{view.incident ? 'A building response is under way, and nobody is in a life-safety situation.' : 'The building is quiet. Escalations appear here the moment someone needs responders.'}</p>
            {view.map && <SiteMapView map={view.map} />}
          </section>
        )}

        <section className="st-card sc-queue" ref={queueRef}>
          <h3 className="st-eyebrow">Escalation queue</h3>
          <Capped items={view.queue} render={(q) => <QueueItem key={q.id} q={q} />} />
        </section>

        <section className="st-card sc-units" ref={unitsRef}>
          <h3 className="st-eyebrow">Responder units</h3>
          {view.units.length ? (
            <Capped
              items={view.units}
              render={(u) => (
                <li key={u.id}>
                  <span className={`sc-icon is-${u.tone}`}>
                    <Radio size={18} />
                  </span>
                  <div>
                    <strong>{u.label}</strong>
                    <small>{u.sub}</small>
                  </div>
                  <span className={`sc-unit is-${u.tone}`}>{u.status}</span>
                </li>
              )}
            />
          ) : (
            <p className="st-muted">No responders are on the move. They appear here once a plan is approved.</p>
          )}
        </section>
      </div>
    </>
  )
}

/** A list that shows five and folds the rest behind "Show all". */
function Capped<T>({ items, render }: { items: T[]; render: (item: T) => React.ReactNode }) {
  const [all, setAll] = useState(false)
  return (
    <>
      <ul className={`sc-list ${all ? 'is-all' : ''}`}>{(all ? items : items.slice(0, 5)).map(render)}</ul>
      {items.length > 5 && (
        <button className="sc-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  )
}

const QUEUE_ICON: Record<QueueRow['kind'], LucideIcon> = { person: Accessibility, hazard: Zap, entrance: DoorOpen }
const QUEUE_TAG: Record<QueueRow['tag'], string> = { critical: 'Critical', assisted: 'Assisted', monitor: 'Monitor', clear: 'Clear' }

function QueueItem({ q }: { q: QueueRow }) {
  const Icon = q.tag === 'critical' ? ShieldAlert : QUEUE_ICON[q.kind]
  return (
    <li>
      <span className={`sc-icon is-${q.tag}`}>
        <Icon size={18} />
      </span>
      <div>
        <strong>{q.title}</strong>
        <small>{q.sub}</small>
      </div>
      <span className={`sc-tag is-${q.tag}`}>{QUEUE_TAG[q.tag]}</span>
    </li>
  )
}

/** Top-down footprint: the street doors, the step-free one responders should use, the refuge, the way in. */
function SiteMapView({ map }: { map: SiteMap }) {
  const pad = 6
  const { x0, y0, x1, y1 } = map.box
  // A tall building turns a quarter (north to the right) so it fills the landscape card.
  const tall = y1 - y0 > x1 - x0
  const W = (tall ? y1 - y0 : x1 - x0) + pad * 2
  const H = (tall ? x1 - x0 : y1 - y0) + pad * 2
  const P = (x: number, y: number) => (tall ? { x: y - y0 + pad, y: x - x0 + pad } : { x: x - x0 + pad, y: y1 - y + pad })
  const R = (r: SiteMap['box']) => {
    const a = P(r.x0, r.y0)
    const b = P(r.x1, r.y1)
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
  }
  return (
    <figure className="sc-map">
      <figcaption className="sc-map-head">
        <span className="st-eyebrow">Building &amp; entrances</span>
        {map.entrance && <span className="sc-map-door">Use: {map.entrance.label}</span>}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Footprint with ${map.exits.length} entrances${map.entrance ? `; responders enter at ${map.entrance.label}` : ''}`}>
        {map.footprint.map((r, i) => (
          <rect key={i} className="sc-fp" {...R(r)} rx={0.8} />
        ))}
        {map.lifts.map((l, i) => {
          const p = P(l.x, l.y)
          return <rect key={i} className={`sc-lift ${l.down ? 'is-down' : ''}`} x={p.x - 1.6} y={p.y - 1.6} width={3.2} height={3.2} rx={0.6} />
        })}
        {map.route && <polyline className="sc-route" points={map.route.map((q) => P(q.x, q.y)).map((q) => `${q.x},${q.y}`).join(' ')} />}
        {map.exits.map((e) => {
          const p = P(e.x, e.y)
          const on = map.entrance?.id === e.id
          return (
            <g key={e.id}>
              <circle className={`sc-door ${on ? 'is-on' : ''}`} cx={p.x} cy={p.y} r={on ? 2.4 : 1.6}>
                <title>{e.label}</title>
              </circle>
            </g>
          )
        })}
        {map.refuge &&
          (() => {
            const p = P(map.refuge.x, map.refuge.y)
            return (
              <g>
                <circle className="sc-refuge" cx={p.x} cy={p.y} r={2.4} />
                <text className="sc-refuge-label" x={p.x} y={p.y - 4}>
                  {map.refuge.label}
                </text>
              </g>
            )
          })()}
      </svg>
      <div className="sc-key">
        <span>
          <i className="is-door" /> entrance
        </span>
        <span>
          <i className="is-on" /> responders enter
        </span>
        <span>
          <i className="is-refuge" /> refuge
        </span>
        <span>
          <i className="is-lift" /> lift
        </span>
      </div>
    </figure>
  )
}

// Acknowledged escalations, per viewer and per incident: a note to self on this screen, nothing the server keeps.
function readAcks(runId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(`haven.ack.${runId}`) ?? '[]') as string[]
  } catch {
    return []
  }
}
function writeAcks(runId: string, ids: string[]) {
  try {
    localStorage.setItem(`haven.ack.${runId}`, JSON.stringify(ids))
  } catch {
    /* private window */
  }
}
