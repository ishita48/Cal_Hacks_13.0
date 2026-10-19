import { useState } from 'react'
import { CalendarClock, ChevronRight, Hand, LifeBuoy, Send, Wrench } from 'lucide-react'
import type { Portal } from './data'
import { when, words, formOf } from './data'
import type { Snapshot, Ticket } from './types'
import { Empty, Modal, Status } from './ui'

const SUPPORT = new Set(['welfare', 'assistance'])

export function TicketList({ items, open, me }: { items: Ticket[]; open: (id: string) => void; me: string }) {
  if (!items.length) return <Empty title="Nothing waiting here." text="New requests and updates show up here as they happen." />
  return (
    <div className="hp-list">
      {items.map((t) => (
        <button className="hp-row" key={t.id} onClick={() => open(t.id)}>
          <span className={`hp-row-icon ${t.urgency === 'urgent' ? 'is-urgent' : ''}`}>{SUPPORT.has(t.category) ? <LifeBuoy size={18} /> : <Wrench size={18} />}</span>
          <span className="hp-row-text">
            <strong>{t.title}</strong>
            <small>
              {words(t.category)} · {when(t.updated_at)}
              {t.appointment && t.appointment_status !== 'declined' && ` · visit ${words(t.appointment_status)}`}
              {!t.assigned_to && t.owner !== me && ' · unclaimed'}
            </small>
          </span>
          <Status value={t.status} />
          <ChevronRight size={16} className="hp-row-go" />
        </button>
      ))}
    </div>
  )
}

export function ReportModal({ data, portal, close }: { data: Snapshot; portal: Portal; close: () => void }) {
  const own = data.building.spaces.find((s) => s.kind === 'room' && s.authorized)
  return (
    <Modal title="Let's take care of it." close={close}>
      <p className="hp-muted">Tell the housing team what needs attention. For immediate danger, call emergency services first.</p>
      <form
        className="hp-form"
        onSubmit={async (e) => {
          const f = formOf(e)
          const body = { title: f('title'), category: f('category'), urgency: f('urgency'), room: f('room'), description: f('description') }
          if (await portal.mutate('/requests', body, 'POST', 'Request sent. You will see every update here.')) close()
        }}
      >
        <label>
          What needs attention?
          <input name="title" required minLength={3} maxLength={150} placeholder="e.g. The AC is not cooling" />
        </label>
        <div className="hp-form-row">
          <label>
            Category
            <select name="category" defaultValue="maintenance">
              <option value="maintenance">Maintenance</option>
              <option value="ac">Heating / AC</option>
              <option value="plumbing">Plumbing / leak</option>
              <option value="electrical">Electrical</option>
              <option value="welfare">Check on me</option>
              <option value="assistance">I need assistance</option>
            </select>
          </label>
          <label>
            Priority
            <select name="urgency" defaultValue="routine">
              <option value="routine">Routine</option>
              <option value="soon">Soon</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
        </div>
        <label>
          Where
          <select name="room" required defaultValue={own?.id ?? ''}>
            <option value="">Choose a place you can report for</option>
            {data.building.spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          A little more detail
          <textarea name="description" rows={3} maxLength={3000} placeholder="What is happening, and since when?" />
        </label>
        <button className="hp-btn is-primary" disabled={portal.busy}>
          Send request <Send size={15} />
        </button>
      </form>
    </Modal>
  )
}

export function TicketDetail({ ticket: t, data, portal, close }: { ticket: Ticket; data: Snapshot; portal: Portal; close: () => void }) {
  const role = data.viewer.role
  const me = data.viewer.id
  const owner = t.owner === me
  const staff = role !== 'resident'
  const mine = t.assigned_to === me
  const [present, setPresent] = useState(false)
  const update = (body: Record<string, unknown>, done = 'Updated.') => portal.mutate(`/requests/${t.id}`, { ...body, expected_version: t.version }, 'POST', done)
  const canWork = role === 'admin' || role === 'ra' || (role === 'maintenance' && mine)
  const awaitingMe = t.appointment_status === 'proposed' && t.proposed_by !== me && (owner || (staff && t.proposed_by === t.owner))

  return (
    <Modal title={t.title} close={close}>
      <div className="hp-chips">
        <Status value={t.status} />
        <span className="hp-chip">{data.building.spaces.find((s) => s.id === t.room)?.name ?? t.room}</span>
        <span className={`hp-chip ${t.urgency === 'urgent' ? 'is-alert' : ''}`}>{words(t.urgency)}</span>
        <span className="hp-chip">{words(t.category)}</span>
      </div>
      {t.description && <p className="hp-detail-text">{t.description}</p>}

      {role === 'maintenance' && !t.assigned_to && (
        <button className="hp-btn is-primary" disabled={portal.busy} onClick={() => void update({ action: 'claim' }, 'The job is yours.')}>
          <Hand size={15} /> Claim this job
        </button>
      )}

      {canWork && t.status !== 'resolved' && (
        <div className="hp-actions">
          {t.status === 'open' && (
            <button className="hp-btn" disabled={portal.busy} onClick={() => void update({ action: 'acknowledge' })}>
              Acknowledge
            </button>
          )}
          {role !== 'ra' && t.status !== 'in_progress' && (
            <button className="hp-btn" disabled={portal.busy} onClick={() => void update({ action: 'start', resident_present: present })}>
              Start work
            </button>
          )}
          {role === 'ra' && SUPPORT.has(t.category) && (
            <button className="hp-btn" disabled={portal.busy} onClick={() => void update({ action: 'welfare', text: 'Welfare check done by the RA.' })}>
              Record welfare check
            </button>
          )}
          <button className="hp-btn is-primary" disabled={portal.busy} onClick={() => void update({ action: 'resolve', resident_present: present }, 'Marked complete.')}>
            Mark complete
          </button>
        </div>
      )}

      {role === 'admin' && (
        <form
          className="hp-form-row"
          onSubmit={async (e) => {
            const f = formOf(e)
            await update({ action: 'assign', assigned_to: f('assigned_to') }, 'Assigned.')
          }}
        >
          <label>
            Assign to
            <select name="assigned_to" defaultValue={t.assigned_to} required>
              <option value="">Choose someone</option>
              {data.team.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {words(p.role)}
                </option>
              ))}
            </select>
          </label>
          <button className="hp-btn" disabled={portal.busy}>
            Assign
          </button>
        </form>
      )}

      {!SUPPORT.has(t.category) && (
        <div className="hp-visit">
          <strong>
            <CalendarClock size={16} /> Visit
          </strong>
          <p>
            Entry: {words(t.entry_permission || 'ask_first')} · Quiet hours {t.quiet_hours}
          </p>
          {t.appointment ? (
            <p>
              {when(t.appointment)} · <b>{words(t.appointment_status)}</b>
            </p>
          ) : (
            <p>No visit arranged yet.</p>
          )}
          {awaitingMe && (
            <div className="hp-actions">
              <button className="hp-btn is-primary" disabled={portal.busy} onClick={() => void update({ action: 'accept' }, 'Visit accepted.')}>
                Accept visit
              </button>
              <button className="hp-btn" disabled={portal.busy} onClick={() => void update({ action: 'decline' }, 'Asked for another time.')}>
                Ask for another time
              </button>
            </div>
          )}
          {staff && t.entry_permission === 'when_home' && (
            <label className="hp-check">
              <input type="checkbox" checked={present} onChange={(e) => setPresent(e.target.checked)} />
              The resident is home for this visit
            </label>
          )}
          {(owner || canWork) && t.status !== 'resolved' && (
            <form
              className="hp-form-row"
              onSubmit={async (e) => {
                const at = formOf(e)('appointment')
                if (at) await update({ action: 'propose', appointment: new Date(at).toISOString() }, 'Visit proposed. The other side confirms it.')
              }}
            >
              <label>
                Propose a time
                <input name="appointment" type="datetime-local" required />
              </label>
              <button className="hp-btn" disabled={portal.busy}>
                Propose
              </button>
            </form>
          )}
          <small>A proposed visit is not permission to enter. The resident accepts it first.</small>
        </div>
      )}

      <h3 className="hp-sub">Conversation</h3>
      <ol className="hp-history">
        {t.history.map((h, i) => (
          <li key={i}>
            <strong>{words(h.action)}</strong>
            <small>{when(h.at)}</small>
            {h.text && <p>{h.text}</p>}
          </li>
        ))}
      </ol>
      <form
        className="hp-compose"
        onSubmit={async (e) => {
          const el = e.currentTarget
          if (await update({ action: 'note', text: formOf(e)('text') }, 'Message sent.')) el.reset()
        }}
      >
        <input aria-label="Message" name="text" required maxLength={3000} placeholder={owner ? 'Message your housing team…' : 'Message the resident and team…'} />
        <button className="hp-btn is-primary" disabled={portal.busy} aria-label="Send">
          <Send size={15} />
        </button>
      </form>
    </Modal>
  )
}
