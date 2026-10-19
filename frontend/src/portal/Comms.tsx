import { Bell, Mail, Phone, ShieldAlert, UserRound } from 'lucide-react'
import type { Portal } from './data'
import { when, words, formOf } from './data'
import type { Contact, Snapshot } from './types'
import { Card, Empty, PageTitle } from './ui'

/** What the email line under a notice means. "accepted" is the provider taking it, never "delivered". */
const EMAIL: Record<string, string> = {
  accepted: 'Email copy accepted by Resend',
  failed: 'Email copy failed; this inbox is the record',
  not_configured: 'In app only (email is off)',
  no_verified_address: 'In app only (no verified email yet)',
  disabled: 'In app only (you turned email off)',
  in_app_only: 'In app only',
}

export function Inbox({ data, portal, openTicket }: { data: Snapshot; portal: Portal; openTicket: (id: string) => void }) {
  return (
    <>
      <PageTitle eyebrow="Inbox" title="Everything, in one place." subtitle="Every update lands here first. Email is only a copy." />
      <Card>
        {data.inbox.length ? (
          <div className="hp-list">
            {data.inbox.map((n) => (
              <article className={`hp-notice ${n.read ? '' : 'is-unread'}`} key={n.id}>
                <Bell size={18} />
                <div>
                  <strong>{n.title}</strong>
                  <p>{n.text}</p>
                  <small>
                    {when(n.created_at)} · {EMAIL[n.email_status] ?? words(n.email_status)}
                  </small>
                  <div className="hp-actions">
                    {n.request_id && (
                      <button className="hp-link" onClick={() => openTicket(n.request_id)}>
                        Open request
                      </button>
                    )}
                    {!n.read && (
                      <button className="hp-link" onClick={() => void portal.mutate(`/inbox/${n.id}/read`, undefined, 'POST', 'Marked as read.')}>
                        Mark read
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty icon={<Bell size={22} />} title="You're all caught up." text="Request updates and visit changes arrive here." />
        )}
      </Card>
    </>
  )
}

export function Contacts({ data, portal }: { data: Snapshot; portal: Portal }) {
  const emergency = data.contacts.filter((c) => c.emergency)
  const support = data.contacts.filter((c) => !c.emergency)
  const admin = data.viewer.role === 'admin'
  return (
    <>
      <PageTitle eyebrow="Contact Corner" title="Real people, right here." subtitle="Your housing team, with emergency services kept apart from everyday support." />
      <div className="hp-contact-grid">
        {emergency.map((c) => (
          <ContactCard key={c.id} c={c} admin={admin} portal={portal} />
        ))}
      </div>
      <h3 className="hp-sub">Housing support</h3>
      <div className="hp-contact-grid">
        {support.map((c) => (
          <ContactCard key={c.id} c={c} admin={admin} portal={portal} />
        ))}
      </div>
      {admin && <p className="hp-muted hp-note">Only details an admin enters appear here. HAVEN never makes up a number or an address.</p>}
    </>
  )
}

/** The emergency card first, the RA and the housing desks after; click-to-call and email only when a real value is set. */
export function ContactCard({ c, admin, portal, compact }: { c: Contact; admin?: boolean; portal?: Portal; compact?: boolean }) {
  const label = c.emergency ? 'Emergency services' : c.levels.length ? 'Your resident assistant' : 'Housing support'
  return (
    <section className={`hp-card hp-contact ${c.emergency ? 'is-emergency' : ''} ${compact ? 'is-compact' : ''}`}>
      <span className="hp-contact-icon">{c.emergency ? <ShieldAlert size={18} /> : <UserRound size={18} />}</span>
      <span className="hp-eyebrow">{label}</span>
      <h3>{c.name}</h3>
      <div className="hp-actions">
        {c.phone ? (
          <a className={`hp-btn ${c.emergency ? 'is-danger' : ''}`} href={`tel:${c.phone}`}>
            <Phone size={14} /> {c.phone}
          </a>
        ) : (
          <span className="hp-muted">Phone not set yet</span>
        )}
        {c.email && (
          <a className="hp-btn" href={`mailto:${c.email}`}>
            <Mail size={14} /> Email
          </a>
        )}
      </div>
      {!compact && c.instructions && <p className="hp-muted">{c.instructions}</p>}
      {!compact && c.emergency && <small>For immediate danger. Tapping opens your phone's dialer; HAVEN never claims a call was made.</small>}
      {admin && portal && (
        <details className="hp-edit">
          <summary>Edit</summary>
          <form
            className="hp-form"
            onSubmit={async (e) => {
              const f = formOf(e)
              await portal.mutate(
                `/contacts/${c.id}`,
                { name: f('name'), phone: f('phone'), email: f('email'), emergency: c.emergency, levels: c.levels, instructions: f('instructions') },
                'PUT',
                'Contact saved.',
              )
            }}
          >
            <label>
              Name
              <input name="name" defaultValue={c.name} required />
            </label>
            <label>
              Phone
              <input name="phone" type="tel" defaultValue={c.phone} />
            </label>
            <label>
              Email
              <input name="email" type="email" defaultValue={c.email} />
            </label>
            <label>
              Instructions
              <textarea name="instructions" defaultValue={c.instructions} maxLength={2000} rows={2} />
            </label>
            <button className="hp-btn is-primary" disabled={portal.busy}>
              Save
            </button>
          </form>
        </details>
      )}
    </section>
  )
}
