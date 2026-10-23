import type { ReactNode } from 'react'
import { Eye, LayoutGrid, type LucideIcon } from 'lucide-react'
import { getPreview, setPreview } from '../lib/api'
import { ROLE_LABEL, useMe } from '../state/me'
import '../student/student.css'

type Tone = 'blue' | 'green' | 'red'

export interface RailItem {
  label: string
  icon: LucideIcon
  onClick?: () => void
  on?: boolean
  dot?: boolean
}

/** The role screens' frame: a slim icon rail (a bottom bar on phones) and the page. */
export function Shell({ items, initial, tone = 'blue', children }: { items: RailItem[]; initial?: string; tone?: Tone; children: ReactNode }) {
  const Account = useMe((m) => m.AccountButton)
  return (
    <div className="st">
      <nav className="st-rail" aria-label="Sections">
        <a className="st-logo" href="/" aria-label="HAVEN home">
          H
        </a>
        {items.map(({ label, icon: Icon, onClick, on, dot }) => (
          <button key={label} className={on ? 'is-on' : ''} aria-label={label} aria-current={on ? 'page' : undefined} onClick={onClick} disabled={!onClick}>
            <Icon size={20} />
            {dot && <b className="st-dot" />}
          </button>
        ))}
        <a href="/app" aria-label="Switch workspace">
          <LayoutGrid size={20} />
        </a>
        <span className="st-rail-foot">{Account ? <Account /> : initial ? <Avatar initial={initial} small tone={tone} /> : null}</span>
      </nav>
      <main className="st-main">
        <PreviewBar />
        {children}
      </main>
    </div>
  )
}

export function Avatar({ initial, small, tone = 'blue' }: { initial: string; small?: boolean; tone?: Tone }) {
  return <span className={`st-avatar ${small ? 'is-small' : ''} is-${tone}`}>{initial.toUpperCase()}</span>
}

/** Scroll a card into view (the rail's targets). */
export const reveal = (el: HTMLElement | null) => el?.scrollIntoView({ behavior: 'smooth', block: 'center' })

/** Shown while an admin previews another role: whose eyes, that it is read-only, and the way out. */
function PreviewBar() {
  const me = useMe((m) => m.me)
  const preview = getPreview()
  if (!preview || me?.role !== 'admin' || me.source !== 'clerk') return null
  const exit = () => {
    setPreview(null)
    location.assign('/app')
  }
  return (
    <p className="st-preview" role="status">
      <Eye size={16} />
      <span>
Admin preview: exactly what this {ROLE_LABEL[preview.role]} sees · read-only
      </span>
      <button onClick={exit}>Exit preview</button>
    </p>
  )
}
