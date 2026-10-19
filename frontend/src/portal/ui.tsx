import { useEffect, type ReactNode } from 'react'
import { ArrowUpRight, Check, X } from 'lucide-react'
import { words } from './data'

/** The portal's few building blocks: glass cards, a page title, a stat tile, a status pill, a dialog. */

export function Card({ children, className = '', title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`hp-card ${className}`}>
      {(title || action) && (
        <header className="hp-card-head">
          <h2>{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function PageTitle({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="hp-page-head">
      <div>
        {eyebrow && <span className="hp-eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function Stat({ icon, value, label, tone, onClick }: { icon: ReactNode; value: number | string; label: string; tone?: 'alert'; onClick?: () => void }) {
  return (
    <button className={`hp-stat ${tone === 'alert' ? 'is-alert' : ''}`} onClick={onClick} disabled={!onClick}>
      <span className="hp-stat-icon">{icon}</span>
      <strong>{value}</strong>
      <span>{label}</span>
      {onClick && <ArrowUpRight size={15} className="hp-stat-go" />}
    </button>
  )
}

export function Status({ value }: { value: string }) {
  return <span className={`hp-status is-${value}`}>{words(value)}</span>
}

export function Empty({ title, text, icon }: { title: string; text?: string; icon?: ReactNode }) {
  return (
    <div className="hp-empty">
      {icon ?? <Check size={22} />}
      <strong>{title}</strong>
      {text && <p>{text}</p>}
    </div>
  )
}

export function Avatar({ name }: { name: string }) {
  return <span className="hp-avatar">{name.slice(0, 1).toUpperCase()}</span>
}

export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [close])
  return (
    <div className="hp-shade" onClick={(e) => e.target === e.currentTarget && close()}>
      <section className="hp-modal" role="dialog" aria-modal="true" aria-label={title}>
        <button className="hp-icon-btn hp-modal-close" aria-label="Close" onClick={close}>
          <X size={18} />
        </button>
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  )
}
