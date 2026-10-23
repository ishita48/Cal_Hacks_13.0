import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpDown, Check, ClipboardList, Droplets, Home, Lightbulb, Navigation, Refrigerator, ShieldAlert, ShieldCheck, Wrench, Zap, type LucideIcon } from 'lucide-react'
import { api } from '../lib/api'
import { usePortal } from '../portal/data'
import { Avatar, Shell, reveal, type RailItem } from '../roles/Shell'
import type { BuildingSpec } from '../state/types'
import { greeting } from '../student/model'
import { maintenanceView, type MaintenanceView, type Route, type Shutdown, type WorkOrder } from './model'
import './maintenance.css'

/**
 * Facilities' screen (/app/maintenance): the one fault to deal with first and how to get there (hero), today's
 * work orders, and every shutdown with its on-site confirmation. The data is the maintenance projection from
 * the server; "Confirm shutdown" is the same acknowledgement the responder phone sends, and a shutdown reads
 * Verified only when a person confirmed it (done by HAVEN or at a deadline is not enough).
 */
export default function Maintenance() {
  const portal = usePortal()
  const { data, error } = portal
  const [spec, setSpec] = useState<BuildingSpec | null>(null)
  useEffect(() => {
    api.building().then(setSpec).catch(() => setSpec(null))
  }, [])
  const view = useMemo(() => (data && data.viewer.role === 'maintenance' ? maintenanceView(data, spec) : null), [data, spec])
  const orders = useRef<HTMLElement>(null)
  const shut = useRef<HTMLElement>(null)
  const rail: RailItem[] = [
    { label: 'Overview', icon: Home, on: true, onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { label: 'Work orders', icon: ClipboardList, onClick: () => reveal(orders.current), dot: !!view?.urgent },
    { label: 'Shutdowns', icon: ShieldCheck, onClick: () => reveal(shut.current) },
  ]

  if (!data || !view)
    return (
      <Shell items={rail}>
        <div className="st-empty">
          <h1>{error ? 'We could not load the plant' : data ? 'This dashboard is for facilities' : 'Getting the plant ready…'}</h1>
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
    <Shell items={rail} initial={view.name[0]}>
      <header className="st-top">
        <div>
          <h1>
            {greeting(new Date().getHours())}, {view.name}
          </h1>
          <p className="st-sub">
            Facilities · {view.building} · {new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
          </p>
        </div>
        <div className="st-who">
          <span className={`st-pill ${view.urgent ? 'is-alert' : 'is-ok'}`}>
            <i />
            {view.urgent ? `${view.urgent} urgent fault${view.urgent === 1 ? '' : 's'}` : 'All plant normal'}
          </span>
          <div className="st-id">
            <strong>{view.name}</strong>
            <small>Maintenance · Facilities</small>
          </div>
          <Avatar initial={view.name[0]} />
        </div>
      </header>

      {portal.notice && <p className="st-toast" role="status">{portal.notice}</p>}
      {portal.error && <p className="st-toast is-error" role="alert">{portal.error}</p>}

      <div className="st-grid mt-grid">
        <HeroCard view={view} portal={portal} />

        <section className="st-card mt-orders" ref={orders}>
          <h3 className="st-eyebrow">Today's work orders</h3>
          <Orders orders={view.orders} />
        </section>

        <section className="st-card mt-shut" ref={shut}>
          <h3 className="st-eyebrow">Verified shutdown states</h3>
          {view.shutdowns.length ? (
            <ul>
              {view.shutdowns.map((s) => (
                <ShutdownRow key={s.id} s={s} portal={portal} />
              ))}
            </ul>
          ) : (
            <p className="st-muted">No shutdowns. When the plan isolates plant, each one waits here for a person to confirm it on site.</p>
          )}
        </section>
      </div>
    </Shell>
  )
}

function HeroCard({ view, portal }: { view: MaintenanceView; portal: ReturnType<typeof usePortal> }) {
  const [showRoute, setShowRoute] = useState(false)
  const hero = view.hero
  if (!hero)
    return (
      <section className="st-card st-hero is-ok mt-hero">
        <span className="st-hero-mark">
          <Check size={30} />
        </span>
        <h2>No urgent faults</h2>
        <p>
          {view.orders.length
            ? 'Nothing is flooded or isolated. Open work orders are on the right.'
            : 'Every piece of plant HAVEN watches is running. You will be alerted the moment that changes.'}
        </p>
      </section>
    )
  const { fault } = hero
  const confirm = () => fault.task && void portal.mutate(`/tasks/${fault.task.id}/done`, undefined, 'POST', 'Confirmed on site. The shutdown is verified.')
  return (
    <section className={`st-card mt-hero is-${fault.severity}`} aria-live="polite">
      <span className={`mt-sev is-${fault.severity}`}>{fault.severity === 'hazard' ? 'Hazard' : 'Isolated'}</span>
      <div className="mt-hero-who">
        <span className="mt-badge">
          <AssetIcon kind={fault.kind} size={28} />
        </span>
        <div>
          <h2>{fault.name}</h2>
          <p className="mt-where">{fault.where}</p>
        </div>
      </div>
      <p className="mt-note">
        <ShieldAlert size={18} />
        <span>
          <strong>{fault.kind === 'valve' ? 'Do not reopen. ' : 'Do not energize. '}</strong>
          {hero.note}
        </span>
      </p>
      <div className="mt-actions">
        <button className="st-btn is-navy" onClick={() => setShowRoute(!showRoute)} aria-expanded={showRoute}>
          <Navigation size={17} /> Route to asset
        </button>
        <button className="st-btn is-ghost" onClick={confirm} disabled={!!hero.confirmBlocked || portal.busy}>
          {fault.task?.verified ? 'Shutdown verified' : 'Confirm shutdown'}
        </button>
      </div>
      {hero.confirmBlocked && <p className="mt-fine">{hero.confirmBlocked}</p>}
      {hero.route && <Elevation route={hero.route} />}
      {showRoute && hero.route && (
        <ol className="mt-steps">
          {hero.route.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
    </section>
  )
}

const ICONS: [RegExp, LucideIcon][] = [
  [/lift|elevator/, ArrowUpDown],
  [/fridge/, Refrigerator],
  [/panel|lighting/, Lightbulb],
  [/pump|valve|water|riser|plumbing/, Droplets],
  [/switch|feed|generator|transfer|electrical/, Zap],
]
function AssetIcon({ kind, size = 18 }: { kind: string; size?: number }) {
  const Icon = ICONS.find(([re]) => re.test(kind))?.[1] ?? Wrench
  return <Icon size={size} />
}

const ORDER_LABEL = { urgent: 'Urgent', open: 'Open', done: 'Done' }

function Orders({ orders }: { orders: WorkOrder[] }) {
  const [all, setAll] = useState(false)
  if (!orders.length) return <p className="st-muted">No work orders today.</p>
  const rows = all ? orders : orders.slice(0, 5)
  return (
    <>
      <ul className={`mt-list ${all ? 'is-all' : ''}`}>
        {rows.map((o) => (
          <li key={o.id}>
            <span className={`mt-icon is-${o.status}`}>
              <AssetIcon kind={o.kind} />
            </span>
            <div>
              <strong>{o.title}</strong>
              <small>{o.where}</small>
            </div>
            <span className={`mt-tag is-${o.status}`}>{ORDER_LABEL[o.status]}</span>
          </li>
        ))}
      </ul>
      {orders.length > 5 && (
        <button className="mt-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${orders.length}`}
        </button>
      )}
    </>
  )
}

function ShutdownRow({ s, portal }: { s: Shutdown; portal: ReturnType<typeof usePortal> }) {
  return (
    <li className={`mt-shut-row is-${s.state}`}>
      <span className="mt-shut-mark">{s.state === 'verified' ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}</span>
      <div>
        <strong>{s.name}</strong>
        <small>{s.text}</small>
      </div>
      {s.state === 'verified' ? (
        <span className="mt-tag is-done">Verified</span>
      ) : (
        <button
          className="st-btn is-small is-blue"
          disabled={s.state === 'waiting' || portal.busy}
          onClick={() => void portal.mutate(`/tasks/${s.id}/done`, undefined, 'POST', `${s.name}: confirmed on site.`)}
        >
          Confirm
        </button>
      )}
    </li>
  )
}

/** Side elevation: floors as bands, risers as columns, the dashed way from the office to the asset. */
function Elevation({ route }: { route: Route }) {
  const pad = 3
  const { x0, x1, z0, z1 } = route.span
  const W = x1 - x0 + pad * 2
  const H = z1 - z0 + pad * 2
  const X = (x: number) => x - x0 + pad
  const Z = (z: number) => z1 - z + pad
  return (
    <figure className="mt-elev">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Route: ${route.steps.join(', then ')}`}>
        {route.floors.map((f) => (
          <g key={f.id}>
            <rect className={`mt-floor ${f.hot ? 'is-hot' : ''}`} x={X(x0)} y={Z(f.z1)} width={x1 - x0} height={f.z1 - f.z0 - 0.35} rx={0.6} />
            <text className="mt-floor-label" x={X(x0) - 0.8} y={Z((f.z0 + f.z1) / 2)}>
              {f.label}
            </text>
          </g>
        ))}
        {route.risers.map((r) => (
          <rect key={r.x} className={`mt-riser ${r.hot ? 'is-hot' : ''}`} x={X(r.x) - 0.6} y={Z(r.z1)} width={1.2} height={r.z1 - r.z0} rx={0.4} />
        ))}
        <polyline className="mt-path" points={route.path.map((p) => `${X(p.x)},${Z(p.z) - 1}`).join(' ')} />
        <circle className="mt-from" cx={X(route.from.x)} cy={Z(route.from.z) - 1} r={1.1} />
        <circle className="mt-to" cx={X(route.to.x)} cy={Z(route.to.z) - 1} r={1.4} />
      </svg>
      <figcaption>
        <span>
          <i className="mt-key is-from" /> {route.from.label}
        </span>
        <span>
          <i className="mt-key is-to" /> {route.to.label}
        </span>
      </figcaption>
    </figure>
  )
}
