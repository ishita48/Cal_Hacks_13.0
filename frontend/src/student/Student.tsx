import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Accessibility, AlertTriangle, Bell, CalendarClock, Check, ClipboardList, Home, LifeBuoy, Mail, Route as RouteIcon, Siren, X } from 'lucide-react'
import { api, request } from '../lib/api'
import { usePortal } from '../portal/data'
import { Avatar, Shell as Frame, reveal } from '../roles/Shell'
import type { BuildingSpec } from '../state/types'
import { ago, greeting, studentView, type InboxRow, type Route, type StudentView } from './model'
import './student.css'

/**
 * The student's screen (/app/student): four cards, one job each. Is this about me (hero), who helps me
 * (RA), what needs my attention (inbox), how I get out step-free (route). The data is the resident's own
 * projection from the server; this page holds no copy of the world and decides nothing about safety.
 */
export default function Student() {
  const portal = usePortal()
  const { data, error } = portal
  const [spec, setSpec] = useState<BuildingSpec | null>(null)
  useEffect(() => {
    api.building().then(setSpec).catch(() => setSpec(null))
  }, [])
  const view = useMemo(() => (data ? studentView(data, spec) : null), [data, spec])

  if (!data || !view)
    return (
      <Shell>
        <div className="st-empty">
          <h1>{error ? 'We could not load your dashboard' : 'Getting your dashboard ready…'}</h1>
          {error && <p>{error}</p>}
          {error && (
            <button className="st-btn is-navy" onClick={() => location.reload()}>
              Try again
            </button>
          )}
        </div>
      </Shell>
    )

  if (data.viewer.role !== 'resident')
    return (
      <Shell>
        <div className="st-empty">
          <h1>This dashboard is for students</h1>
          <p>Your account opens a different workspace.</p>
          <a className="st-btn is-navy" href="/app">
            Choose my workspace
          </a>
        </div>
      </Shell>
    )

  return <Dashboard view={view} portal={portal} />
}

function Dashboard({ view, portal }: { view: StudentView; portal: ReturnType<typeof usePortal> }) {
  const [sheet, setSheet] = useState<'ask' | 'message' | null>(null)
  const routeRef = useRef<HTMLElement>(null)
  const inboxRef = useRef<HTMLElement>(null)
  const go = (ref: React.RefObject<HTMLElement | null>) => reveal(ref.current)
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })

  return (
    <Shell
      onInbox={() => go(inboxRef)}
      onRoute={() => go(routeRef)}
      initial={view.first[0] ?? '?'}
      unread={view.inbox.filter((r) => r.unread).length}
    >
      <header className="st-top">
        <div>
          <h1>
            {greeting(new Date().getHours())}, {view.first}
          </h1>
          <p className="st-sub">
            {view.building} · {today}
          </p>
        </div>
        <div className="st-who">
          <span className={`st-pill is-${view.pill.tone}`}>
            <i />
            {view.pill.label}
          </span>
          <div className="st-id">
            <strong>{view.name}</strong>
            <small>{view.room && view.floor ? `${view.room} · ${view.floor}` : 'Room not linked yet'}</small>
          </div>
          <Avatar initial={view.first[0] ?? '?'} />
        </div>
      </header>

      {portal.notice && <p className="st-toast" role="status">{portal.notice}</p>}
      {portal.error && <p className="st-toast is-error" role="alert">{portal.error}</p>}

      <div className="st-grid">
        <section className={`st-card st-hero is-${view.hero.tone}`} aria-live="polite">
          <span className="st-hero-mark">{view.hero.tone === 'ok' ? <Check size={30} /> : view.hero.tone === 'warn' ? <LifeBuoy size={30} /> : <Siren size={30} />}</span>
          <h2>{view.hero.title}</h2>
          <p>{view.hero.text}</p>
          <button className="st-btn is-navy" onClick={() => go(routeRef)}>
            View my safety plan
          </button>
        </section>

        <section className="st-card st-help">
          <h3 className="st-eyebrow">Need help?</h3>
          {view.ra ? (
            <div className="st-ra">
              <span className="st-ra-badge">RA</span>
              <div>
                <strong>
                  {view.ra.contact.name.split(' ')[0]} · {view.ra.role}
                </strong>
                <small>{view.ra.contact.phone ? view.ra.contact.phone : 'Your floor’s resident assistant'}</small>
              </div>
            </div>
          ) : (
            <p className="st-muted">No RA is linked to your floor yet. The front desk can help in the meantime.</p>
          )}
          <div className="st-help-actions">
            <button className="st-btn is-blue" onClick={() => setSheet('ask')}>
              Ask RA agent
            </button>
            <button className="st-btn is-ghost" onClick={() => setSheet('message')} disabled={!view.linked}>
              Message {view.ra ? view.ra.contact.name.split(' ')[0] : 'housing'}
            </button>
          </div>
        </section>

        <section className="st-card st-inbox" ref={inboxRef}>
          <h3 className="st-eyebrow">Inbox</h3>
          {view.inbox.length ? (
            <ul>
              {view.inbox.slice(0, 4).map((row) => (
                <InboxItem key={row.id} row={row} portal={portal} />
              ))}
            </ul>
          ) : (
            <p className="st-muted">Nothing new. Alerts and plans to review land here.</p>
          )}
        </section>

        <section className="st-card st-route" ref={routeRef}>
          <h3 className="st-eyebrow">Your way out</h3>
          <RouteMap route={view.route} />
          <p className="st-route-line">
            <span className={`st-chip ${view.route.reachable ? '' : 'is-warn'}`}>
              {view.route.reachable ? <Accessibility size={14} /> : <AlertTriangle size={14} />}
              {view.route.reachable ? 'Step-free' : 'No step-free route'}
            </span>
            <strong>
              {view.route.summary}
              {view.route.minutes ? ` · about ${view.route.minutes} min` : ''}
            </strong>
          </p>
        </section>
      </div>

      {sheet === 'ask' && <AskSheet onClose={() => setSheet(null)} />}
      {sheet === 'message' && <MessageSheet to={view.ra?.contact.name.split(' ')[0] ?? 'housing'} portal={portal} onClose={() => setSheet(null)} />}
    </Shell>
  )
}

/** The student rail: overview, inbox, way out. */
function Shell({ children, onInbox, onRoute, initial, unread = 0 }: { children: ReactNode; onInbox?: () => void; onRoute?: () => void; initial?: string; unread?: number }) {
  const items = [
    { label: 'Overview', icon: Home, on: true, onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
    { label: unread ? `Inbox, ${unread} unread` : 'Inbox', icon: Mail, onClick: onInbox, dot: !!unread },
    { label: 'Your way out', icon: RouteIcon, onClick: onRoute },
  ]
  return (
    <Frame items={items} initial={initial}>
      {children}
    </Frame>
  )
}

const ICON = { alert: Bell, visit: CalendarClock, notice: ClipboardList }

function InboxItem({ row, portal }: { row: InboxRow; portal: ReturnType<typeof usePortal> }) {
  const Icon = ICON[row.kind]
  const markRead = () => {
    if (row.unread && !row.visit) void portal.mutate(`/inbox/${encodeURIComponent(row.id)}/read`, undefined, 'POST', 'Marked as read.')
  }
  const answer = (action: 'accept' | 'decline') =>
    row.visit && void portal.mutate(`/requests/${row.visit.requestId}`, { action, expected_version: row.visit.version }, 'POST', action === 'accept' ? 'Visit accepted.' : 'Visit declined.')
  return (
    <li className={`st-row ${row.unread ? 'is-unread' : ''}`}>
      <span className={`st-row-icon is-${row.kind}`}>
        <Icon size={18} />
      </span>
      <button className="st-row-body" onClick={markRead} disabled={!row.unread || !!row.visit}>
        <strong>{row.title}</strong>
        <span>{row.text}</span>
      </button>
      {row.visit ? (
        <span className="st-row-actions">
          <button className="st-btn is-small is-blue" disabled={portal.busy} onClick={() => answer('accept')}>
            Accept
          </button>
          <button className="st-btn is-small is-ghost" disabled={portal.busy} onClick={() => answer('decline')}>
            Decline
          </button>
        </span>
      ) : (
        <time>{ago(row.at)}</time>
      )}
    </li>
  )
}

function RouteMap({ route }: { route: Route }) {
  if (!route.stops.length) return <div className="st-map is-empty">{route.summary}</div>
  return (
    <div className="st-map" role="img" aria-label={`Route: ${route.stops.map((s) => s.label).join(', then ')}`}>
      {route.stops.map((s, i) => (
        <Fragment key={s.kind + s.label}>
          {i > 0 && <span className={`st-link ${s.down || route.stops[i - 1].down ? 'is-broken' : ''}`} />}
          <div className={`st-stop is-${s.kind} ${s.down ? 'is-down' : ''}`}>
            {(s.kind === 'room' || (s.kind === 'exit' && route.reachable)) && <i className="st-pin" />}
            <span>{s.label}</span>
            {s.down && <small>Out of service</small>}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="st-scrim" onClick={onClose}>
      <div className="st-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="st-icon" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

function AskSheet({ onClose }: { onClose: () => void }) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const text = String(new FormData(e.currentTarget).get('q') ?? '').trim()
    if (!text) return
    setBusy(true)
    try {
      setAnswer((await request<{ text: string }>('POST', '/api/portal/ask', { text })).text)
    } catch (err) {
      setAnswer(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title="Ask RA agent" onClose={onClose}>
      <form onSubmit={submit}>
        <textarea name="q" rows={3} autoFocus placeholder="Is anything happening in the building? Who is my RA?" />
        <button className="st-btn is-blue" disabled={busy}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {answer && <p className="st-answer">{answer}</p>}
      <p className="st-muted">The agent answers from your own information only. In immediate danger, call emergency services.</p>
    </Sheet>
  )
}

function MessageSheet({ to, portal, onClose }: { to: string; portal: ReturnType<typeof usePortal>; onClose: () => void }) {
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const text = String(new FormData(e.currentTarget).get('m') ?? '').trim()
    if (text.length < 3) return
    // A message to the RA is an assistance request: it reaches the RA for this floor and stays on record.
    const ok = await portal.mutate('/requests', { title: `Message for ${to}`, description: text, category: 'assistance', urgency: 'soon' }, 'POST', `Sent to ${to}.`)
    if (ok) onClose()
  }
  return (
    <Sheet title={`Message ${to}`} onClose={onClose}>
      <form onSubmit={submit}>
        <textarea name="m" rows={4} autoFocus minLength={3} maxLength={3000} placeholder="What do you need?" />
        <button className="st-btn is-blue" disabled={portal.busy}>
          {portal.busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </Sheet>
  )
}
