import { lazy, Suspense, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Bell, CalendarClock, CheckCircle2, ClipboardList, Cog, Hand, HeartHandshake, Inbox as InboxIcon, Plus, ShieldCheck, Sparkles, Users } from 'lucide-react'
import type { Portal } from './data'
import { firstName, words, AVATARS } from './data'
import type { Snapshot, Tab } from './types'
import { ContactCard } from './Comms'
import { TicketList } from './Requests'
import { DutyCard } from './Settings'
import { Card, Stat, Status } from './ui'

const Building = lazy(() => import('./Building'))

const GREETING = {
  resident: 'Your home, looked after.',
  ra: 'Your floors, at a glance.',
  maintenance: 'Your jobs for today.',
  admin: 'The whole building, calmly.',
}

interface Props {
  data: Snapshot
  portal: Portal
  go: (tab: Tab) => void
  openTicket: (id: string) => void
  report: () => void
}

/** Each role's overview: the incident as they may see it, three numbers, their building, and one next step. */
export function Home({ data, portal, go, openTicket, report }: Props) {
  const { role, id: me } = data.viewer
  const open = data.requests.filter((t) => t.status !== 'resolved')
  const unread = data.inbox.filter((n) => !n.read).length
  const visits = open.filter((t) => t.appointment && t.appointment_status !== 'declined')
  const queue = open.filter((t) => !t.assigned_to && t.owner !== me)
  const mineJobs = open.filter((t) => t.assigned_to === me)
  const welfare = open.filter((t) => t.category === 'welfare' || t.category === 'assistance')
  const available = data.team.filter((p) => p.role === 'ra' && p.duty.status === 'available').length

  const stats = {
    resident: [
      <Stat key="a" icon={<ClipboardList size={18} />} value={open.length} label="Open requests" onClick={() => go('requests')} />,
      <Stat key="b" icon={<CalendarClock size={18} />} value={visits.length} label="Visits planned" onClick={() => go('requests')} />,
      <Stat key="c" icon={<Bell size={18} />} value={unread} label="New updates" tone={unread ? 'alert' : undefined} onClick={() => go('inbox')} />,
    ],
    ra: [
      <Stat key="a" icon={<HeartHandshake size={18} />} value={welfare.length} label="Support requests" tone={welfare.length ? 'alert' : undefined} onClick={() => go('requests')} />,
      <Stat key="b" icon={<Users size={18} />} value={data.incident.people.length} label="Check-ins now" tone={data.incident.people.length ? 'alert' : undefined} />,
      <Stat key="c" icon={<Bell size={18} />} value={unread} label="New updates" onClick={() => go('inbox')} />,
    ],
    maintenance: [
      <Stat key="a" icon={<ClipboardList size={18} />} value={mineJobs.length} label="My jobs" onClick={() => go('requests')} />,
      <Stat key="b" icon={<Hand size={18} />} value={queue.length} label="Waiting to claim" tone={queue.length ? 'alert' : undefined} onClick={() => go('requests')} />,
      <Stat key="c" icon={<CalendarClock size={18} />} value={visits.length} label="Visits" onClick={() => go('requests')} />,
    ],
    admin: [
      <Stat key="a" icon={<ClipboardList size={18} />} value={open.length} label="Open requests" onClick={() => go('requests')} />,
      <Stat key="b" icon={<Hand size={18} />} value={queue.length} label="Unassigned" tone={queue.length ? 'alert' : undefined} onClick={() => go('requests')} />,
      <Stat key="c" icon={<Users size={18} />} value={available} label="RAs available" onClick={() => go('team')} />,
    ],
  }[role]

  const radar = role === 'maintenance' ? [...mineJobs, ...queue] : open
  // Where the 3D view opens: a resident's room, an RA's first floor, the plant for maintenance, all for the admin.
  const own = role === 'resident' ? data.building.spaces.find((s) => s.kind === 'room')?.id : undefined
  const focus =
    role === 'resident' ? (data.building.spaces.find((s) => s.id === own)?.level ?? 'all')
    : role === 'ra' ? (data.viewer.levels[0] ?? 'all')
    : role === 'maintenance' ? (data.building.equipment[0]?.level ?? 'all')
    : 'all'
  const hour = new Date().getHours()
  const hello = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}${data.viewer.linked ? `, ${firstName(data.viewer.name)}` : ''}`
  const ra = data.contacts.find((c) => c.levels.length && !c.emergency)
  const emergency = data.contacts.find((c) => c.emergency)

  return (
    <>
      <div className="hp-hero">
        <div>
          <span className="hp-eyebrow">{hello}</span>
          <h1>{GREETING[role]}</h1>
        </div>
        <button className="hp-btn is-primary" onClick={report}>
          <Plus size={16} /> {role === 'resident' ? 'Report an issue' : 'New request'}
        </button>
      </div>

      {data.incident.active && <IncidentCard data={data} portal={portal} />}

      <div className="hp-stats">{stats}</div>

      <div className="hp-grid">
        <Card className="hp-building-card">
          <Suspense fallback={<div className="hp-building is-loading">Loading your building…</div>}>
            <Building data={data.building} own={own} mine={radar.map((t) => t.room)} focus={focus} />
          </Suspense>
        </Card>
        <div className="hp-side">
          <button className="hp-card hp-companion" onClick={() => go('ask')}>
            <span className="hp-orb">{AVATARS[data.profile.avatar] ?? <Sparkles size={22} />}</span>
            <span>
              <strong>Ask {data.profile.agent_name}</strong>
              <small>{role === 'ra' ? 'Who needs a check-in, what is still open.' : role === 'maintenance' ? 'Your jobs, visits and the plant.' : 'Your requests, your team, your building.'}</small>
            </span>
            <ArrowUpRight size={16} />
          </button>
          {role === 'resident' && (
            <>
              {ra && <ContactCard c={ra} compact />}
              {emergency && <ContactCard c={emergency} compact />}
            </>
          )}
          {(role === 'ra' || role === 'maintenance') && <DutyCard data={data} portal={portal} />}
          {role === 'admin' && (
            <a className="hp-card hp-companion" href="/command">
              <span className="hp-orb is-plain">
                <Cog size={20} />
              </span>
              <span>
                <strong>Open the command centre</strong>
                <small>The live simulation, the agents' plan and approval.</small>
              </span>
              <ArrowUpRight size={16} />
            </a>
          )}
        </div>
      </div>

      <Card
        title={role === 'maintenance' ? 'Jobs' : role === 'ra' ? 'Open on your floors' : 'On your radar'}
        action={
          <button className="hp-link" onClick={() => go('requests')}>
            See all <ArrowUpRight size={14} />
          </button>
        }
      >
        <TicketList items={radar.slice(0, 5)} open={openTicket} me={me} />
      </Card>
    </>
  )
}

/** The live incident, cut to what this role may see and do. The backend already did the cutting. */
function IncidentCard({ data, portal }: { data: Snapshot; portal: Portal }) {
  const inc = data.incident
  const role = data.viewer.role
  const [allPeople, setAllPeople] = useState(false)
  const people = allPeople ? inc.people : inc.people.slice(0, 4)
  const title = role === 'resident' ? (inc.affected ? 'Your floor is part of a building response' : 'A building response is in progress') : 'Building response in progress'
  return (
    <section className="hp-card hp-incident" role="alert">
      <header className="hp-incident-head">
        <span className="hp-incident-icon">
          <AlertTriangle size={20} />
        </span>
        <div>
          <span className="hp-eyebrow">{inc.approved ? 'Plan approved · in motion' : 'Plan being prepared'}</span>
          <h2>{title}</h2>
        </div>
        {role === 'admin' && (
          <a className="hp-btn is-primary" href="/command">
            Review and approve <ArrowUpRight size={15} />
          </a>
        )}
      </header>
      <p>{inc.message}</p>
      {inc.detail && <p className="hp-muted">{inc.detail}</p>}

      {inc.people.length > 0 && (
        <div className="hp-incident-block">
          <h3>Check on ({inc.people.length})</h3>
          <div className="hp-list">
            {people.map((p) => (
              <div className="hp-person" key={p.id}>
                <span className={`hp-avatar ${p.priority ? 'is-alert' : ''}`}>{p.name[0]}</span>
                <span className="hp-row-text">
                  <strong>
                    {p.name} · {p.room}
                  </strong>
                  <small>{p.situation.length ? p.situation.map(words).join(' · ') : 'May need a hand'}</small>
                </span>
                {p.left_behind ? <span className="hp-chip is-alert">nobody assigned</span> : p.now ? <span className="hp-chip is-alert">now</span> : <span className="hp-chip">soon</span>}
              </div>
            ))}
          </div>
          {inc.people.length > 4 && (
            <button className="hp-link" onClick={() => setAllPeople((a) => !a)}>
              {allPeople ? 'Show fewer' : `Show all ${inc.people.length}`}
            </button>
          )}
        </div>
      )}

      {inc.equipment.length > 0 && (
        <div className="hp-incident-block">
          <h3>Plant affected</h3>
          <div className="hp-chips">
            {inc.equipment.map((e) => (
              <span key={e.id} className="hp-chip is-alert">
                {e.name} · {words(e.status)}
              </span>
            ))}
          </div>
        </div>
      )}

      {inc.tasks.length > 0 && (
        <div className="hp-incident-block">
          <h3>{role === 'resident' ? 'What the plan does for you' : 'Your steps'}</h3>
          <div className="hp-list">
            {inc.tasks.map((t) => (
              <div className="hp-task" key={t.id}>
                {t.status === 'done' ? <CheckCircle2 size={18} className="is-done" /> : <ShieldCheck size={18} />}
                <span className="hp-row-text">
                  <strong>{t.title}</strong>
                  <small>{t.reason}</small>
                </span>
                {role !== 'resident' && t.status === 'assigned' ? (
                  <button className="hp-btn" disabled={portal.busy} onClick={() => void portal.mutate(`/tasks/${t.id}/done`, undefined, 'POST', 'Step confirmed.')}>
                    Done
                  </button>
                ) : (
                  <Status value={t.status} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {role !== 'admin' && (
        <p className="hp-muted hp-note">
          <InboxIcon size={13} /> Updates also arrive in your inbox. In immediate danger, call emergency services.
        </p>
      )}
    </section>
  )
}
