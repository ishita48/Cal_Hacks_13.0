import { useEffect, useMemo, useRef, useState } from 'react'
import { Accessibility, Ambulance, ArrowBigUp, Car, CheckCircle2, DoorOpen, Flame, Radio, ShieldCheck, Siren, Zap, type LucideIcon } from 'lucide-react'
import { api } from '../lib/api'
import { Avatar, Shell, reveal, type RailItem } from '../roles/Shell'
import { useMe } from '../state/me'
import type { BuildingSpec } from '../state/types'
import { connectWorld, useWorld } from '../state/world'
import { greeting } from '../student/model'
import { securityView, type Escalation, type QueueRow, type SecurityView, type SiteMap } from './model'
import './security.css'

/**
 * Dispatch (/app/security): the life-safety escalation that needs responders first (hero, with the footprint and
 * the nearest step-free entrance), the escalation queue, and the responder units. It reads the live world over
 * /ws (only an admin opens it), holds no copy of it, and its one real action is the human gate itself:
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
  const name = me?.name ?? me?.email?.split('@')[0] ?? ''
  const rail: RailItem[] = [
    { label: 'Overview', icon: ShieldCheck, on: true, onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { label: 'Escalation queue', icon: ArrowBigUp, onClick: () => reveal(queue.current), dot: !!view?.active },
    { label: 'Responder units', icon: Radio, onClick: () => reveal(units.current) },
  ]

  if (!view)
    return (
      <Shell items={rail} tone="red">
        <div className="st-empty">
          <h1>{connection === 'closed' ? 'Dispatch is reconnecting…' : 'Opening dispatch…'}</h1>
          <p>Dispatch reads the live building. It opens for housing admins.</p>
        </div>
      </Shell>
    )

  const date = new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
  return (
    <Shell items={rail} initial={name[0] ?? 'D'} tone="red">
      <header className="st-top">
        <div>
          <h1>
            Dispatch · {greeting(new Date().getHours())}
            {name ? `, ${name.split(' ')[0]}` : ''}
          </h1>
          <p className="st-sub">
            {spec?.name ?? 'The building'} · Campus Safety · {date}
            {clock ? ` · ${clockTime(clock.time_of_day)}` : ''}
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
          <Avatar initial={name[0] ?? 'D'} tone="red" />
        </div>
      </header>
      <Body view={view} runId={world?.run_id ?? ''} queueRef={queue} unitsRef={units} />
    </Shell>
  )
}

/** The building's clock (seconds since midnight) the way a dispatcher reads it: 11:43 PM. */
function clockTime(seconds: number) {
  const s = Math.floor(seconds) % 86400
  const h = Math.floor(s / 3600)
  return `${h % 12 || 12}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
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
            <header className="sc-head">
              <h3 className="st-eyebrow">Active escalation</h3>
              <span className="sc-aside">priority · life-safety</span>
            </header>
            <div className="sc-who">
              <span className="sc-badge">{hero.stepFree ? <Accessibility size={30} /> : <Siren size={30} />}</span>
              <div>
                <h2>{hero.title}</h2>
                <p className="sc-sub">
                  {hero.name} · {hero.room} · {hero.where}
                </p>
              </div>
            </div>
            {view.brief && (
              <p className="sc-info">
                {view.brief.liftsDown ? 'Elevator offline' : 'Elevators running'} — resident needs {/^[aeiou]/.test(view.brief.need) ? 'an' : 'a'}{' '}
                <b>{view.brief.need}</b>.
                {view.brief.entrance && (
                  <>
                    {' '}
                    Nearest accessible way in is the <b>{view.brief.entrance}</b>.
                  </>
                )}{' '}
                {view.brief.responder}
                {view.brief.noSelfRoute ? '; no safe self-evacuation route exists.' : '.'}
              </p>
            )}
            {view.map && <SiteMapView map={view.map} />}
            <p className="sc-enroute">
              <Car size={18} />
              <span>Unit 1 en route · ETA 4 min{view.map?.entrance ? ` · via ${view.map.entrance.side} entrance` : ''}</span>
              <em>simulated</em>
            </p>
            <div className="sc-actions">
              <button className="st-btn sc-red" disabled={busy || !!view.dispatchBlocked} onClick={() => void dispatch()}>
                {view.approved ? 'Responders dispatched' : busy ? 'Dispatching…' : 'Dispatch responders'}
              </button>
              <button className="st-btn is-ghost" disabled={acked.includes(hero.id)} onClick={acknowledge}>
                {acked.includes(hero.id) ? 'Acknowledged' : 'Acknowledge'}
              </button>
            </div>
            <p className="sc-fine">{view.dispatchBlocked || `Dispatch approves plan v${view.planVersion}: every step in it goes out, not just this one.`}</p>
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
          <header className="sc-head">
            <h3 className="st-eyebrow">Responder units</h3>
            <span className="sc-aside" title="HAVEN dispatches no campus units yet: these rows are placeholders until a dispatch feed is connected.">
              simulated
            </span>
          </header>
          <ul className="sc-list">
            {units(hero).map((u) => (
              <li key={u.id}>
                <span className={`sc-icon is-${u.tone}`}>
                  <u.icon size={20} />
                </span>
                <div>
                  <strong>{u.label}</strong>
                  <small>{u.sub}</small>
                </div>
                <span className={`sc-unit is-${u.tone}`}>{u.status}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  )
}

// Simulated until a dispatch (CAD) feed exists: HAVEN itself sends no campus unit and calls no fire department.
// The card says "simulated"; the people, plan and responders elsewhere on this page are real.
function units(hero: Escalation | null): { id: string; icon: LucideIcon; label: string; sub: string; status: string; tone: string }[] {
  const first = hero?.name.split(' ')[0]
  return [
    { id: 'unit1', icon: Car, label: 'Campus Safety · Unit 1', sub: first ? `Assigned to ${first} · ETA 4 min` : 'On patrol', status: first ? 'En route' : 'Available', tone: first ? 'moving' : 'clear' },
    { id: 'ems', icon: Ambulance, label: 'Campus EMS', sub: 'Standing by', status: 'Available', tone: 'clear' },
    { id: 'sffd', icon: Flame, label: 'SFFD', sub: first ? 'Notified · auto-brief sent' : 'Not contacted', status: first ? 'Notified' : 'Idle', tone: first ? 'monitor' : 'idle' },
  ]
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

const QUEUE_TAG: Record<QueueRow['tag'], string> = { critical: 'Critical', assisted: 'Assisted', monitor: 'Monitor', clear: 'Clear' }

function QueueItem({ q }: { q: QueueRow }) {
  const Icon: LucideIcon = q.kind === 'person' ? Accessibility : q.kind === 'hazard' ? Zap : q.tag === 'clear' ? CheckCircle2 : DoorOpen
  return (
    <li>
      <span className={`sc-icon is-${q.tag}`}>
        <Icon size={20} />
      </span>
      <div>
        <strong>{q.title}</strong>
        <small>{q.sub}</small>
      </div>
      <span className={`sc-tag is-${q.tag}`}>{QUEUE_TAG[q.tag]}</span>
    </li>
  )
}

const SHORT = { North: 'N', South: 'S', East: 'E', West: 'W' }

/** Top-down footprint: the street doors, the step-free one responders use, the refuge, the way in. */
function SiteMapView({ map }: { map: SiteMap }) {
  const pad = 12
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
  const unit = map.unit && P(map.unit.x, map.unit.y)
  const door = map.entrance && P(map.entrance.x, map.entrance.y)
  // Labels stand clear of the way in: the unit's beyond it, outward from the door; the door's beside it.
  const out = unit && door ? (() => {
    const dx = unit.x - door.x
    const dy = unit.y - door.y
    const n = Math.hypot(dx, dy) || 1
    return { x: dx / n, y: dy / n }
  })() : null
  return (
    <figure className="sc-map">
      <figcaption className="sc-head">
        <span className="st-eyebrow">Building &amp; entrances</span>
        <span className="sc-aside">{map.route ? 'responder route' : `${map.exits.length} entrances`}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Footprint with ${map.exits.length} entrances${map.entrance ? `; responders enter at the ${map.entrance.label}` : ''}`}>
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
              <rect className={`sc-door ${on ? 'is-on' : ''}`} x={p.x - (on ? 3 : 2)} y={p.y - (on ? 2 : 1.4)} width={on ? 6 : 4} height={on ? 4 : 2.8} rx={0.8}>
                <title>{e.label}</title>
              </rect>
              <text
                className={`sc-door-label ${on ? 'is-on' : ''}`}
                x={on && out ? p.x - out.y * 4.2 : p.x}
                y={on && out ? p.y + out.x * 4.2 + 1 : p.y - 2.6}
                style={{ textAnchor: on && out ? (-out.y > 0.5 ? 'start' : -out.y < -0.5 ? 'end' : 'middle') : 'middle' }}
              >
                {on ? `${SHORT[e.side]} door ♿` : SHORT[e.side]}
              </text>
            </g>
          )
        })}
        {map.refuge &&
          (() => {
            const p = P(map.refuge.x, map.refuge.y)
            return (
              <g>
                <circle className="sc-refuge" cx={p.x} cy={p.y} r={2.2} />
                <text className="sc-refuge-label" x={p.x} y={p.y + 5.2}>
                  {map.refuge.label}
                </text>
              </g>
            )
          })()}
        {unit && (
          <g>
            <circle className="sc-unit-dot" cx={unit.x} cy={unit.y} r={3.2} />
            <text className="sc-unit-label" x={unit.x + (out?.x ?? 0) * 6} y={unit.y + (out?.y ?? 1) * 6 + 1}>
              Unit 1
            </text>
          </g>
        )}
        {tall && (
          <text className="sc-compass" x={W - 2} y={H - 2}>
            N →
          </text>
        )}
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
