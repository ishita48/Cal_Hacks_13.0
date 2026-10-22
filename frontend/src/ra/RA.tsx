import { useMemo, useRef, useState } from 'react'
import { Accessibility, ArrowUpCircle, Bell, Check, CheckCircle2, ClipboardList, Home, Map as MapIcon, MessageSquare, Phone, Users } from 'lucide-react'
import { usePortal } from '../portal/data'
import { Avatar, Shell, reveal, type RailItem } from '../roles/Shell'
import { ago, greeting } from '../student/model'
import { STATUS_LABEL, raView, type FloorMap, type RaView, type Update } from './model'
import './ra.css'

/**
 * The RA's screen (/app/ra): who on my floor needs me first (hero), everyone on the floor (residents), what
 * changed (updates), where they are (floor map). The data is the RA's own projection from the server: people
 * by situation, never medical detail. Confirming a step is the same acknowledgement the responder phone sends.
 */
export default function RA() {
  const portal = usePortal()
  const { data, error } = portal
  const [level, setLevel] = useState<string | undefined>()
  const view = useMemo(() => (data && data.viewer.role === 'ra' ? raView(data, level) : null), [data, level])
  const top = useRef<HTMLElement>(null)
  const people = useRef<HTMLElement>(null)
  const feed = useRef<HTMLElement>(null)
  const map = useRef<HTMLElement>(null)
  const rail: RailItem[] = [
    { label: 'Overview', icon: Home, on: true, onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { label: 'My residents', icon: Users, onClick: () => reveal(people.current) },
    { label: 'Updates', icon: Bell, onClick: () => reveal(feed.current), dot: !!view?.attention },
    { label: 'Floor map', icon: MapIcon, onClick: () => reveal(map.current) },
  ]

  if (!data || !view)
    return (
      <Shell items={rail} tone="green">
        <div className="st-empty">
          <h1>{error ? 'We could not load your floor' : data ? 'This dashboard is for RAs' : 'Getting your floor ready…'}</h1>
          {error && <p>{error}</p>}
          {data && !error && <p>Your account opens a different workspace.</p>}
          {(error || data) && (
            <a className="st-btn is-navy" href={error ? location.pathname : '/app'}>
              {error ? 'Try again' : 'Choose my workspace'}
            </a>
          )}
        </div>
      </Shell>
    )

  return (
    <Shell items={rail} initial={view.first[0]} tone="green">
      <header className="st-top" ref={top}>
        <div>
          <h1>
            {view.floors} · {greeting(new Date().getHours())}, {view.first}
          </h1>
          <p className="st-sub">
            {view.building} · {new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · {view.residentCount} residents
          </p>
        </div>
        <div className="st-who">
          <span className={`st-pill ${view.attention ? 'is-warn' : 'is-ok'}`}>
            <i />
            {view.attention ? `${view.attention} ${view.attention === 1 ? 'needs' : 'need'} attention` : `${view.floors} clear`}
          </span>
          <div className="st-id">
            <strong>{view.name}</strong>
            <small>Resident Advisor · {view.floors}</small>
          </div>
          <Avatar initial={view.first[0]} tone="green" />
        </div>
      </header>

      {portal.notice && <p className="st-toast" role="status">{portal.notice}</p>}
      {portal.error && <p className="st-toast is-error" role="alert">{portal.error}</p>}

      <div className="st-grid ra-grid">
        <HeroCard view={view} portal={portal} />

        <section className="st-card ra-people" ref={people}>
          <CardHead title="My residents" aside={view.floors} />
          <Residents view={view} />
        </section>

        <section className="st-card ra-feed" ref={feed}>
          <CardHead title="Updates" />
          {view.updates.length ? (
            <ul>
              {view.updates.slice(0, 5).map((u) => (
                <UpdateRow key={u.id} u={u} />
              ))}
            </ul>
          ) : (
            <p className="st-muted">Quiet so far. Escalations, your plan steps and support requests show up here.</p>
          )}
        </section>

        <section className="st-card ra-map" ref={map}>
          <CardHead
            title={view.map?.label ?? view.floors}
            aside={
              view.levels.length > 1 ? (
                <span className="ra-levels">
                  {view.levels.map((l) => (
                    <button key={l} className={view.map?.level === l ? 'is-on' : ''} onClick={() => setLevel(l)}>
                      {l}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="ra-live">{portal.connected ? 'live' : 'reconnecting'}</span>
              )
            }
          />
          {view.map ? <FloorPlan map={view.map} /> : <p className="st-muted">No plan of this floor is available.</p>}
        </section>
      </div>
    </Shell>
  )
}

function CardHead({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <header className="ra-head">
      <h3 className="st-eyebrow">{title}</h3>
      {aside && <span className="ra-aside">{aside}</span>}
    </header>
  )
}

function HeroCard({ view, portal }: { view: RaView; portal: ReturnType<typeof usePortal> }) {
  const hero = view.hero
  if (!hero)
    return (
      <section className="st-card st-hero is-ok ra-hero">
        <span className="st-hero-mark">
          <Check size={30} />
        </span>
        <h2>{view.floors} is clear</h2>
        <p>{view.incident ? 'A building response is under way, and nobody on your floor is flagged.' : 'Nobody on your floor needs you right now.'} You'll be alerted the moment that changes.</p>
      </section>
    )
  const { person } = hero
  const first = person.name.split(' ')[0]
  const confirm = () => hero.task && void portal.mutate(`/tasks/${hero.task.id}/done`, undefined, 'POST', 'Confirmed. The plan shows the step as done.')
  return (
    <section className={`st-card ra-hero is-${person.status}`} aria-live="polite">
      <div className="ra-hero-who">
        <span className="ra-badge">{first[0]}</span>
        <div>
          <h2>{first} needs you</h2>
          <p className="ra-hero-sub">
            {person.name}
            {person.room ? ` · ${person.room}` : ''}
          </p>
        </div>
      </div>
      <span className={`ra-tag is-${person.status} is-wide`}>
        {person.situation.includes('stranded') ? <Accessibility size={15} /> : <ArrowUpCircle size={15} />}
        {hero.badge}
      </span>
      <p className="ra-hero-text">{hero.text}</p>
      <div className="ra-actions">
        {/* HAVEN keeps no resident phone numbers: the button says so instead of pretending to dial. */}
        <button className="st-btn is-navy" disabled title={`No phone number for ${first} is on file`}>
          <Phone size={17} /> Call {first}
        </button>
        <button className="st-btn is-ghost" disabled={!!hero.confirmBlocked || portal.busy} onClick={confirm}>
          Confirm refuge plan
        </button>
      </div>
      <p className="ra-fine">
        No phone number is on file{person.room ? `: go to ${person.room}` : ''}. {hero.confirmBlocked}
      </p>
    </section>
  )
}

function Residents({ view }: { view: RaView }) {
  const [all, setAll] = useState(false)
  const rows = all ? view.residents : view.residents.slice(0, 5)
  const floorName = (lv: string) => (view.levels.length > 1 ? lv : view.floors)
  if (!view.residents.length) return <p className="st-muted">No residents are listed on your floor.</p>
  return (
    <>
      <ul className={`ra-list ${all ? 'is-all' : ''}`}>
        {rows.map((r) => (
          <li key={r.id}>
            <span className={`ra-initial is-${r.status}`}>{r.name[0]}</span>
            <div>
              <strong>{r.name}</strong>
              <small>{r.room ?? floorName(r.level)}</small>
            </div>
            <span className={`ra-tag is-${r.status}`}>{STATUS_LABEL[r.status]}</span>
          </li>
        ))}
      </ul>
      {view.residents.length > 5 && (
        <button className="ra-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${view.residents.length}`}
        </button>
      )}
    </>
  )
}

const UPDATE_ICON = { escalation: ArrowUpCircle, step: ClipboardList, request: MessageSquare, notice: Bell, done: CheckCircle2 }

function UpdateRow({ u }: { u: Update }) {
  const Icon = UPDATE_ICON[u.kind]
  return (
    <li className="st-row">
      <span className={`st-row-icon ra-icon is-${u.kind}`}>
        <Icon size={18} />
      </span>
      <div className="st-row-body">
        <strong>{u.title}</strong>
        <span>{u.text}</span>
      </div>
      <time>{ago(u.at)}</time>
    </li>
  )
}

function FloorPlan({ map }: { map: FloorMap }) {
  const pad = 2
  const { x0, y0, x1, y1 } = map.box
  // A tall floor turns a quarter (north to the right) so it fills the landscape card.
  const tall = y1 - y0 > x1 - x0
  const W = (tall ? y1 - y0 : x1 - x0) + pad * 2
  const H = (tall ? x1 - x0 : y1 - y0) + pad * 2
  // Spec y points north; SVG y points down.
  const P = (x: number, y: number) => (tall ? { x: y - y0 + pad, y: x - x0 + pad } : { x: x - x0 + pad, y: y1 - y + pad })
  const R = (r: FloorMap['box']) => {
    const a = P(r.x0, r.y0)
    const b = P(r.x1, r.y1)
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
  }
  const C = (r: FloorMap['box']) => P((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)
  const hero = map.spaces.find((s) => s.mark === 'hero')
  return (
    <figure className="ra-plan">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${map.label} plan. ${map.note}`}>
        {map.spaces.map((s) => (
          <rect key={s.id} className={`ra-sp is-${s.kind} ${s.mark ? `is-${s.mark}` : ''}`} {...R(s.rect)} rx={0.6}>
            <title>{s.name}</title>
          </rect>
        ))}
        {map.route && <polyline className="ra-route" points={map.route.map((p) => P(p.x, p.y)).map((q) => `${q.x},${q.y}`).join(' ')} />}
        {map.spaces
          .filter((s) => s.mark === 'lift' || s.mark === 'lift-down')
          .map((s) => (
            <text key={`t${s.id}`} className={`ra-label ${s.mark === 'lift-down' ? 'is-down' : ''}`} {...C(s.rect)}>
              {s.mark === 'lift-down' ? '×' : 'L'}
            </text>
          ))}
        {hero && (
          <text className="ra-label is-hero" x={C(hero.rect).x} y={R(hero.rect).y - 1.6}>
            {hero.name.replace(/^Room /, '')}
          </text>
        )}
      </svg>
      <figcaption>
        <span className="ra-key is-hero" /> needs you <span className="ra-key is-flag" /> check-in <span className="ra-key is-lift" /> lift <span className="ra-key is-lift-down" /> lift down
        {map.note && <strong>{map.note}</strong>}
      </figcaption>
    </figure>
  )
}
