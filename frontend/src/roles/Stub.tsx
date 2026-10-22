import { useEffect } from 'react'
import { ArrowLeft, Building2 } from 'lucide-react'
import { useMe } from '../state/me'
import { canOpen, type Workspace } from './workspaces'
import '../student/student.css'
import './roles.css'

/** A staff workspace that is not built yet: its name, a way back, and (for the admin) the command centre. */
export default function Stub({ ws }: { ws: Workspace }) {
  const me = useMe((m) => m.me)
  const load = useMe((m) => m.load)
  useEffect(() => {
    if (!useMe.getState().me) void load()
  }, [load])
  const allowed = !me || canOpen(ws, me)
  return (
    <div className="st wp">
      <main className="wp-main">
        <h1>{ws.label}</h1>
        <p className="st-muted">{allowed ? 'This workspace is coming next.' : 'This workspace is not on your account.'}</p>
        <div className="wp-actions">
          <a className="st-btn is-ghost" href="/app">
            <ArrowLeft size={18} /> Switch workspace
          </a>
          {ws.slug === 'admin' && allowed && (
            <a className="st-btn is-navy" href="/command">
              <Building2 size={18} /> Open the command centre
            </a>
          )}
        </div>
      </main>
    </div>
  )
}
