import { useEffect, useState } from 'react'
import { ArrowRight, Building2, HeartHandshake, Home, Wrench } from 'lucide-react'
import { request } from '../lib/api'
import { ROLE_LABEL, type Role } from '../state/me'
import { writeFlag } from './data'

const ROLES: { role: Role; icon: typeof Home; line: string }[] = [
  { role: 'resident', icon: Home, line: 'Report issues, arrange visits, reach your RA.' },
  { role: 'ra', icon: HeartHandshake, line: 'Your floors, check-ins and support requests.' },
  { role: 'maintenance', icon: Wrench, line: 'Claim jobs, plan visits, see the plant.' },
  { role: 'admin', icon: Building2, line: 'Everything, plus the command centre.' },
]

/**
 * Demo only (no Clerk key): pick a role and a roster identity to see what that person sees. The backend
 * answers /api/portal/demo-people with 404 once sign-in is on, and roles then come from Clerk alone.
 */
export function RolePicker({ current }: { current: Role }) {
  const [role, setRole] = useState<Role>(current)
  const [people, setPeople] = useState<{ id: string; name: string; role: string }[]>([])
  const [person, setPerson] = useState('')
  useEffect(() => {
    request<typeof people>('GET', '/api/portal/demo-people').then(setPeople).catch(() => {})
  }, [])
  const options = people.filter((p) => p.role === role)
  const chosen = person && options.some((p) => p.id === person) ? person : (options[0]?.id ?? '')

  const enter = () => {
    try {
      localStorage.setItem('haven.role', role)
      if (chosen) localStorage.setItem('haven.person', chosen)
      else localStorage.removeItem('haven.person')
    } catch {
      /* private window */
    }
    writeFlag('haven.portal.entered', true)
    location.reload()
  }

  return (
    <main className="hp-root hp-center">
      <div className="hp-picker">
        <span className="hp-eyebrow">HAVEN demo · synthetic people</span>
        <h1>Whose day is it?</h1>
        <p className="hp-muted">Each role sees a different, privacy-filtered slice of the same live building.</p>
        <div className="hp-picker-grid" role="radiogroup" aria-label="Role">
          {ROLES.map(({ role: r, icon: Icon, line }) => (
            <button key={r} role="radio" aria-checked={role === r} className={`hp-card hp-role ${role === r ? 'is-on' : ''}`} onClick={() => setRole(r)}>
              <Icon size={22} />
              <strong>{ROLE_LABEL[r]}</strong>
              <small>{line}</small>
            </button>
          ))}
        </div>
        {options.length > 0 && (
          <label className="hp-picker-person">
            As
            <select value={chosen} onChange={(e) => setPerson(e.target.value)}>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="hp-btn is-primary is-large" onClick={enter}>
          Enter as {ROLE_LABEL[role]} <ArrowRight size={16} />
        </button>
        <small className="hp-muted">With sign-in on, your account decides your role and this picker disappears.</small>
      </div>
    </main>
  )
}
