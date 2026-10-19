import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../lib/theme'
import type { Portal } from './data'
import { words, formOf, AVATARS } from './data'
import type { Snapshot } from './types'
import { Avatar, Card, PageTitle } from './ui'

export function Preferences({ data, portal }: { data: Snapshot; portal: Portal }) {
  const theme = useTheme()
  const p = data.profile
  const resident = data.viewer.role === 'resident'
  return (
    <>
      <PageTitle eyebrow="Preferences" title="Make it yours." subtitle="Private to your account. Other residents never see any of this." />
      <form
        className="hp-settings"
        onSubmit={async (e) => {
          const f = formOf(e)
          const form = e.currentTarget
          await portal.mutate(
            '/profile',
            {
              agent_name: f('agent_name'),
              avatar: f('avatar'),
              quiet_hours: f('quiet_hours') || p.quiet_hours,
              entry_permission: f('entry_permission') || p.entry_permission,
              accessibility: f('accessibility'),
              emergency_contact: f('emergency_contact'),
              email_updates: (form.elements.namedItem('email_updates') as HTMLInputElement).checked,
            },
            'PUT',
            'Preferences saved.',
          )
        }}
      >
        <Card title="Your agent">
          <div className="hp-form-row">
            <label>
              Name
              <input name="agent_name" defaultValue={p.agent_name} maxLength={40} required />
            </label>
            <label>
              Look
              <select name="avatar" defaultValue={p.avatar}>
                {Object.entries(AVATARS).map(([k, glyph]) => (
                  <option key={k} value={k}>
                    {glyph} {k}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Card>
        {resident && (
          <Card title="Your room and your time">
            <div className="hp-form">
              <label>
                Quiet hours
                <input name="quiet_hours" defaultValue={p.quiet_hours} />
              </label>
              <label>
                Room entry
                <select name="entry_permission" defaultValue={p.entry_permission}>
                  <option value="ask_first">Always ask me first</option>
                  <option value="when_home">Only when I'm home</option>
                  <option value="approved_appointment">Only at a visit I accepted</option>
                </select>
              </label>
              <label>
                Accessibility (private)
                <textarea name="accessibility" defaultValue={p.accessibility} maxLength={1200} rows={2} placeholder="Anything your agent should speak up for" />
              </label>
              <label>
                Personal emergency contact (private)
                <input name="emergency_contact" defaultValue={p.emergency_contact} maxLength={300} placeholder="Name and number" />
              </label>
            </div>
          </Card>
        )}
        <Card title="Notifications">
          <label className="hp-check">
            <input name="email_updates" type="checkbox" defaultChecked={p.email_updates} />
            Email me a copy of updates
          </label>
          <small className="hp-muted">
            {data.email_configured ? 'Copies go to the email you signed in with.' : 'Email is not set up for this building yet. Everything still arrives in your inbox.'}
          </small>
        </Card>
        <Card title="Appearance">
          <div className="hp-segment" role="radiogroup" aria-label="Theme">
            {(
              [
                ['system', Monitor, 'Match device'],
                ['light', Sun, 'Light'],
                ['dark', Moon, 'Dark'],
              ] as const
            ).map(([key, Icon, label]) => (
              <button type="button" role="radio" aria-checked={theme.pref === key} key={key} className={theme.pref === key ? 'is-on' : ''} onClick={() => theme.setPref(key)}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
        </Card>
        <button className="hp-btn is-primary" disabled={portal.busy}>
          Save preferences
        </button>
      </form>
    </>
  )
}

export function Team({ data, portal }: { data: Snapshot; portal: Portal }) {
  const admin = data.viewer.role === 'admin'
  const levelName = (id: string) => data.building.levels.find((l) => l.id === id)?.name ?? id
  return (
    <>
      <PageTitle eyebrow="Team" title="Who is on, and where." subtitle={admin ? 'Availability, floor assignments and the people behind every response.' : 'Set your availability so the team knows when to reach you.'} />
      {!admin && <DutyCard data={data} portal={portal} />}
      <Card title={admin ? 'Staff' : 'Your team'}>
        <div className="hp-list">
          {data.team.map((p) => (
            <div className="hp-person" key={p.id}>
              <Avatar name={p.name} />
              <span className="hp-row-text">
                <strong>{p.name}</strong>
                <small>
                  {p.role === 'ra' ? 'Resident assistant' : words(p.role)}
                  {p.level && ` · ${levelName(p.level)}`}
                  {p.duty.schedule && ` · ${p.duty.schedule}`}
                </small>
              </span>
              <span className={`hp-duty is-${p.duty.status ?? 'unset'}`}>{p.duty.status ? words(p.duty.status) : 'not set'}</span>
              {admin && p.role === 'ra' && (
                <form
                  className="hp-inline"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    const sel = e.currentTarget.elements.namedItem('levels') as HTMLSelectElement
                    await portal.mutate(`/assignments/${encodeURIComponent(p.id)}`, { levels: [...sel.selectedOptions].map((o) => o.value) }, 'PUT', `${p.name}'s floors saved.`)
                  }}
                >
                  <select name="levels" multiple aria-label={`Floors for ${p.name}`} defaultValue={data.assignments[p.id]?.levels ?? [p.level]}>
                    {data.building.levels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <button className="hp-btn" disabled={portal.busy}>
                    Assign
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

export function DutyCard({ data, portal }: { data: Snapshot; portal: Portal }) {
  const status = data.duty.status ?? 'available'
  const save = (next: string, schedule = data.duty.schedule ?? '') => portal.mutate('/duty', { status: next, schedule }, 'PUT', 'Availability saved.')
  return (
    <Card title="Your availability">
      <div className="hp-segment" role="radiogroup" aria-label="Availability">
        {(['available', 'busy', 'off_duty'] as const).map((s) => (
          <button key={s} role="radio" aria-checked={status === s} className={status === s ? 'is-on' : ''} disabled={portal.busy} onClick={() => void save(s)}>
            {words(s)}
          </button>
        ))}
      </div>
      <form
        className="hp-form-row"
        onSubmit={async (e) => {
          await save(status, formOf(e)('schedule'))
        }}
      >
        <label>
          Duty schedule
          <input name="schedule" defaultValue={data.duty.schedule} placeholder="e.g. Mon–Thu, 8 pm – midnight" maxLength={300} />
        </label>
        <button className="hp-btn" disabled={portal.busy}>
          Save
        </button>
      </form>
    </Card>
  )
}
