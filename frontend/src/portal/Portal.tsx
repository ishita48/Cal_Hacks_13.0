import { useEffect, useState } from 'react'
import { ArrowLeftRight, Bell, Building2, ClipboardList, Home as HomeIcon, LifeBuoy, Monitor, Moon, Settings2, Sparkles, Sun, Users, Wrench, X } from 'lucide-react'
import { useTheme } from '../lib/theme'
import { ROLE_LABEL, useMe, type Role } from '../state/me'
import { Ask } from './Ask'
import { Contacts, Inbox } from './Comms'
import { readFlag, usePortal, writeFlag } from './data'
import { Home } from './Home'
import { ReportModal, TicketDetail, TicketList } from './Requests'
import { RolePicker } from './RolePicker'
import { Preferences, Team } from './Settings'
import type { Tab } from './types'
import { Card, PageTitle } from './ui'
import './portal.css'

const REQUESTS_LABEL: Record<Role, string> = { resident: 'My requests', ra: 'Support', maintenance: 'Work orders', admin: 'Requests' }

/**
 * The workspace every signed-in person lands on. The role is the server's: Clerk says who you are, the
 * backend decides what that role may see, and this shell only lays out the projection it was sent.
 * Without Clerk (the demo) a picker chooses a demo role and roster identity, and the page says so.
 */
export default function Portal() {
  const portal = usePortal()
  const { data, connected, error, notice } = portal
  const [tab, setTab] = useState<Tab>('home')
  const [ticketId, setTicketId] = useState<string | null>(null)
  const [reporting, setReporting] = useState(false)
  const [picking, setPicking] = useState(() => !readFlag('haven.portal.entered'))
  const Account = useMe((m) => m.AccountButton)

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => portal.setNotice(''), 3500)
    return () => clearTimeout(t)
  }, [notice, portal])

  if (!data)
    return (
      <main className="hp-root hp-center">
        <span className="hp-orb">✦</span>
        <h1>Welcome to HAVEN</h1>
        <p className="hp-muted">{error || 'Getting your workspace ready…'}</p>
        {error && (
          <button className="hp-btn" onClick={() => location.reload()}>
            Try again
          </button>
        )}
      </main>
    )

  const demo = data.viewer.source === 'demo'
  if (demo && picking) return <RolePicker current={data.viewer.role} />

  const role = data.viewer.role
  const open = data.requests.filter((t) => t.status !== 'resolved')
  const unread = data.inbox.filter((n) => !n.read).length
  const ticket = data.requests.find((t) => t.id === ticketId)
  const nav: { id: Tab; label: string; icon: typeof HomeIcon; count?: number }[] = [
    { id: 'home', label: 'Overview', icon: HomeIcon },
    { id: 'requests', label: REQUESTS_LABEL[role], icon: role === 'maintenance' ? Wrench : ClipboardList, count: open.length },
    { id: 'inbox', label: 'Inbox', icon: Bell, count: unread },
    { id: 'contacts', label: 'Contacts', icon: LifeBuoy },
    { id: 'ask', label: 'Ask HAVEN', icon: Sparkles },
    ...(role === 'resident' ? [] : [{ id: 'team' as Tab, label: 'Team', icon: Users }]),
  ]

  return (
    <div className="hp-root hp-shell">
      <aside className="hp-sidebar">
        <a className="hp-brand" href="/">
          <span className="hp-brand-dot" />
          HAVEN
        </a>
        <div className="hp-whoami">
          <strong>{data.viewer.name}</strong>
          <small>
            {ROLE_LABEL[role]} · {data.building.name}
          </small>
        </div>
        <nav>
          {nav.map((n) => (
            <button key={n.id} className={tab === n.id ? 'is-on' : ''} onClick={() => setTab(n.id)} aria-current={tab === n.id ? 'page' : undefined}>
              <n.icon size={18} />
              <span>{n.label}</span>
              {!!n.count && <b>{n.count}</b>}
            </button>
          ))}
          {role === 'admin' && (
            <a href="/command">
              <Building2 size={18} />
              <span>Command centre</span>
            </a>
          )}
        </nav>
        <div className="hp-sidebar-foot">
          <button className={tab === 'settings' ? 'is-on' : ''} onClick={() => setTab('settings')}>
            <Settings2 size={18} />
            <span>Preferences</span>
          </button>
          {demo && (
            <button
              onClick={() => {
                writeFlag('haven.portal.entered', false)
                setPicking(true)
              }}
            >
              <ArrowLeftRight size={18} />
              <span>Switch role</span>
            </button>
          )}
        </div>
      </aside>

      <div className="hp-content">
        <header className="hp-topbar">
          <span className={`hp-live ${connected ? '' : 'is-off'}`}>
            <i /> {connected ? 'Live' : 'Reconnecting…'}
            {demo && <em>Demo · synthetic people</em>}
          </span>
          <div className="hp-top-actions">
            {demo && (
              <button className="hp-icon-btn hp-only-small" aria-label="Switch demo role" onClick={() => (writeFlag('haven.portal.entered', false), setPicking(true))}>
                <ArrowLeftRight size={18} />
              </button>
            )}
            <button className="hp-icon-btn hp-only-small" aria-label="Preferences" onClick={() => setTab('settings')}>
              <Settings2 size={18} />
            </button>
            <ThemeButton />
            <button className="hp-icon-btn" aria-label={`Inbox, ${unread} unread`} onClick={() => setTab('inbox')}>
              <Bell size={18} />
              {!!unread && <i className="hp-badge">{unread}</i>}
            </button>
            {Account ? <Account /> : <span className="hp-avatar">{data.viewer.name[0]}</span>}
          </div>
        </header>

        <main className="hp-main">
          {error && (
            <div role="alert" className="hp-toast is-error">
              {error}
              <button className="hp-icon-btn" aria-label="Dismiss" onClick={() => portal.setError('')}>
                <X size={15} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="hp-toast">
              {notice}
            </div>
          )}

          {tab === 'home' && <Home data={data} portal={portal} go={setTab} openTicket={setTicketId} report={() => setReporting(true)} />}
          {tab === 'requests' && (
            <>
              <PageTitle
                eyebrow={REQUESTS_LABEL[role]}
                title={role === 'maintenance' ? 'Your work, in order.' : role === 'ra' ? 'Support on your floors.' : 'Every request, in view.'}
                subtitle="Track progress, arrange visits and keep the conversation in one place."
                action={
                  <button className="hp-btn is-primary" onClick={() => setReporting(true)}>
                    New request
                  </button>
                }
              />
              <Card>
                <TicketList items={data.requests} open={setTicketId} me={data.viewer.id} />
              </Card>
            </>
          )}
          {tab === 'inbox' && <Inbox data={data} portal={portal} openTicket={setTicketId} />}
          {tab === 'contacts' && <Contacts data={data} portal={portal} />}
          {tab === 'ask' && <Ask data={data} />}
          {tab === 'team' && role !== 'resident' && <Team data={data} portal={portal} />}
          {tab === 'settings' && <Preferences data={data} portal={portal} />}
        </main>
      </div>

      <nav className="hp-tabbar" aria-label="Sections">
        {nav.slice(0, 5).map((n) => (
          <button key={n.id} className={tab === n.id ? 'is-on' : ''} onClick={() => setTab(n.id)} aria-label={n.label}>
            <n.icon size={20} />
            {!!n.count && <b>{n.count}</b>}
          </button>
        ))}
      </nav>

      {reporting && <ReportModal data={data} portal={portal} close={() => setReporting(false)} />}
      {ticket && <TicketDetail ticket={ticket} data={data} portal={portal} close={() => setTicketId(null)} />}
    </div>
  )
}

function ThemeButton() {
  const { pref, cycle } = useTheme()
  const Icon = pref === 'system' ? Monitor : pref === 'dark' ? Moon : Sun
  const label = { system: 'Theme matches your device', light: 'Light theme', dark: 'Dark theme' }[pref]
  return (
    <button className="hp-icon-btn" onClick={cycle} title={`${label} (click to change)`} aria-label={label}>
      <Icon size={18} />
    </button>
  )
}
