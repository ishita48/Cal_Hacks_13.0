import { useEffect, useState } from 'react'
import { ArrowRight, Building2, GraduationCap, HeartHandshake, Lock, ShieldAlert, Wrench } from 'lucide-react'
import { request } from '../lib/api'
import { ROLE_LABEL, useMe } from '../state/me'
import { WORKSPACES, canOpen, readChoice, writeChoice, type Slug, type Workspace } from './workspaces'
import '../student/student.css'
import './roles.css'

const ICONS: Record<Slug, typeof GraduationCap> = { student: GraduationCap, ra: HeartHandshake, maintenance: Wrench, security: ShieldAlert, admin: Building2 }

/**
 * /app: the first screen after sign-in. Five workspaces; the ones this account may open are live, the rest
 * say why not. The server's role decides (GET /api/me); this page only remembers which door was last used.
 */
export default function Picker() {
  const me = useMe((m) => m.me)
  const error = useMe((m) => m.error)
  const load = useMe((m) => m.load)
  const Account = useMe((m) => m.AccountButton)
  useEffect(() => {
    if (!useMe.getState().me) void load()
  }, [load])

  const open = me ? WORKSPACES.filter((w) => canOpen(w, me)) : []
  const remembered = readChoice()
  const [chosen, setChosen] = useState<Slug | null>(null)
  const selected = chosen ?? (open.some((w) => w.slug === remembered) ? remembered : (open[0]?.slug ?? null))

  const enter = async (ws: Workspace) => {
    writeChoice(ws.slug)
    // The open demo has no accounts: the chosen role (and, for a student or an RA, a roster person) rides on each request.
    if (me?.source === 'demo' && ws.role) {
      let person: string | null = null
      if (ws.role === 'resident' || ws.role === 'ra') {
        const people = await request<{ id: string; role: string }[]>('GET', '/api/portal/demo-people').catch(() => [])
        person = people.find((p) => p.role === ws.role)?.id ?? null
      }
      try {
        localStorage.setItem('haven.role', ws.role)
        if (person) localStorage.setItem('haven.person', person)
        else localStorage.removeItem('haven.person')
      } catch {
        /* private window */
      }
    }
    location.assign(`/app/${ws.slug}`)
  }

  return (
    <div className="st wp">
      <main className="wp-main">
        <header className="wp-head">
          <a className="st-logo" href="/" aria-label="HAVEN home">
            H
          </a>
          {Account && <Account />}
        </header>
        <h1>Choose your workspace</h1>
        <p className="st-muted">
          {!me
            ? error || 'Checking your account…'
            : me.source === 'demo'
              ? 'Demo mode: every workspace is open, with synthetic people.'
              : `Signed in as ${me.email ?? me.name ?? 'you'} · ${ROLE_LABEL[me.role]}`}
        </p>
        <div className="wp-grid" role="radiogroup" aria-label="Workspace">
          {WORKSPACES.map((ws) => {
            const Icon = ICONS[ws.slug]
            const allowed = !!me && canOpen(ws, me)
            return (
              <button
                key={ws.slug}
                role="radio"
                aria-checked={selected === ws.slug}
                disabled={!allowed}
                className={`wp-card ${selected === ws.slug ? 'is-on' : ''}`}
                onClick={() => setChosen(ws.slug)}
                onDoubleClick={() => allowed && void enter(ws)}
              >
                <span className="wp-icon">{allowed ? <Icon size={22} /> : <Lock size={20} />}</span>
                <strong>{ws.label}</strong>
                <small>{allowed || !me ? ws.line : 'Not on your account. Ask the housing office.'}</small>
              </button>
            )
          })}
        </div>
        <button className="st-btn is-blue wp-go" disabled={!selected} onClick={() => selected && void enter(WORKSPACES.find((w) => w.slug === selected)!)}>
          Continue <ArrowRight size={18} />
        </button>
      </main>
    </div>
  )
}
