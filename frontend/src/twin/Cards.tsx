import { useState, type ReactNode } from 'react'
import { Activity, ChevronDown, Droplets, Lightbulb, Users, X, Zap } from 'lucide-react'
import { NEED_LABEL, PRESENCE_LABEL } from '../lib/labels'
import { useBuilding } from '../state/building'
import type { WorldState } from '../state/types'
import type { Selection } from '../components/Inspector'
import { TONE, needWords, type LevelStatus, type LiftShaft, type PersonMark, type RouteLine, type StepBeacon, type Tab, type Upcoming } from './model'

/**
 * The glass over the twin: the tab switcher, one card per tab with only what matters (details open on
 * click), and the record of whatever was clicked. Every line reads the world, the plan or the spec; when
 * the world has nothing to say ("no plan yet", "all floors powered") the card says that, never a guess.
 */

export interface Derived {
  status: Record<string, LevelStatus>
  people: PersonMark[]
  routes: RouteLine[]
  beacons: StepBeacon[]
  lifts: LiftShaft[]
  upcoming: Upcoming[]
}

/** A floating glass card that can fold to its title. */
function Card({ eyebrow, title, children, tone, onClose }: { eyebrow: ReactNode; title: ReactNode; children?: ReactNode; tone?: 'calm' | 'hot' | 'warm' | 'ok' | 'acting'; onClose?: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <section className={`tw-card ${tone ? `is-${tone}` : ''}`}>
      <header className="tw-card-head">
        <div className="min-w-0 flex-1">
          <div className="tw-eyebrow">{eyebrow}</div>
          <h2 className="tw-title">{title}</h2>
        </div>
        {onClose ? (
          <button className="mac-icon-btn" onClick={onClose} aria-label="Close">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          children && (
            <button className="mac-icon-btn" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Fold the card' : 'Open the card'} aria-expanded={open}>
              <ChevronDown className="h-3.5 w-3.5 transition-transform" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
            </button>
          )
        )}
      </header>
      {open && children && <div className="tw-card-body">{children}</div>}
    </section>
  )
}

function Row({ icon, label, value, tone, onClick, hint }: { icon: ReactNode; label: string; value: ReactNode; tone?: 'hot' | 'warm' | 'ok' | 'calm'; onClick?: () => void; hint?: string }) {
  const body = (
    <>
      <span className={`tw-row-icon ${tone ? `is-${tone}` : ''}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="tw-row-label">{label}</span>
        <span className="tw-row-value">{value}</span>
      </span>
    </>
  )
  return onClick ? (
    <button className="tw-row is-link" onClick={onClick} title={hint}>
      {body}
    </button>
  ) : (
    <div className="tw-row">{body}</div>
  )
}

function Legend({ items }: { items: [string, string, boolean?][] }) {
  return (
    <div className="tw-legend">
      {items.map(([c, l, round]) => (
        <span key={l}>
          <i style={{ background: c, borderRadius: round ? 999 : 3 }} />
          {l}
        </span>
      ))}
    </div>
  )
}

/* ---- what the colours mean, for the view on screen ---- */

/** One small glass card: what the Building tab is showing right now and what each colour means. */
export function ViewLegend({ mode, level }: { mode: Tab; level: string }) {
  if (mode === 'building')
    return <div className="tw-legend-card is-hint">{level === 'all' ? 'Click a floor to look inside. Drag to turn, scroll to zoom.' : 'Click a room for its record.'}</div>
  if (mode === 'status')
    return (
      <details className="tw-legend-card">
        <summary className="tw-legend-title">Key · live status</summary>
        <Legend items={[['#6cc3ff', 'water'], [TONE.critical, 'no power'], ['#ffc56b', 'loses power if nobody acts'], ['#ff7a6b', 'equipment failed', true], ['#ffb84d', 'water will reach it', true], ['#5fd4a0', 'lift running']]} />
      </details>
    )
  return (
    <details className="tw-legend-card">
      <summary className="tw-legend-title">Key · the response</summary>
      <Legend items={[['#5aa8ff', 'step under way', true], ['#5fd4a0', 'step done', true], ['#c9c6e6', 'not started yet', true], ['#ff7a6b', 'step failed', true], [TONE.moved, 'moved to safety', true], [TONE.left, 'left behind', true]]} />
    </details>
  )
}

/* ---- People ----------------------------------------------------------------------------------- */

export function PeopleCard({ world, d, setLevel, onPerson }: { world: WorldState; d: Derived; setLevel: (l: string) => void; onPerson: (id: string) => void }) {
  const storyIds = useBuilding((b) => b.storyIds)
  const residents = useBuilding((b) => b.residents)
  const levels = useBuilding((b) => b.levels)
  const need = world.impact.residents.filter((r) => r.severity !== 'info').length
  const left = world.plan.left_behind.length
  const moved = Object.keys(world.moved).length
  const named = storyIds.map((id) => d.people.find((p) => p.id === id) ?? null).filter((p): p is PersonMark => !!p)
  const away = storyIds.filter((id) => !d.people.some((p) => p.id === id))
  return (
    <Card eyebrow="People" title={need ? `${need} ${need === 1 ? 'person needs' : 'people need'} help` : 'Everyone is fine'} tone={left ? 'hot' : need ? 'warm' : 'ok'}>
      <div className="tw-stats">
        <span><b>{d.people.length}</b> in the building</span>
        <span className={left ? 'is-hot' : ''}><b>{left}</b> left behind</span>
        <span><b>{moved}</b> moved</span>
        <span><b>{d.routes.length}</b> step-free route{d.routes.length === 1 ? '' : 's'}</span>
      </div>
      <ul className="tw-people">
        {named.map((p) => (
          <li key={p.id}>
            <button
              onClick={() => {
                setLevel(p.level)
                onPerson(p.id)
              }}
              data-buds={`resident:${p.id}`}
            >
              <i style={{ background: TONE[p.tone] }} />
              <span className="min-w-0 flex-1 text-left">
                <span className="tw-person-name">{p.name}</span>
                <span className="tw-person-sub">
                  {[needWords(p.needs), levels[p.level]?.name].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className={`tw-person-status is-${p.tone}`}>{p.status}</span>
            </button>
          </li>
        ))}
        {away.map((id) => (
          <li key={id} className="opacity-60">
            <div className="tw-person-row">
              <i style={{ background: '#d6d8e6' }} />
              <span className="min-w-0 flex-1">
                <span className="tw-person-name">{residents[id]?.name ?? id}</span>
                <span className="tw-person-sub">{PRESENCE_LABEL[residents[id]?.presence ?? ''] ?? 'away'}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
      <Legend items={[[TONE.critical, 'needs help now', true], [TONE.warning, 'needs help soon', true], [TONE.left, 'left behind', true], [TONE.moved, 'moved to safety', true], [TONE.calm, 'fine', true], ['#38c98a', 'step-free route']]} />
    </Card>
  )
}

/* ---- the record of what was clicked ------------------------------------------------------------ */

export function SelectionCard({ selection, world, people, onClose }: { selection: Selection; world: WorldState; people: PersonMark[]; onClose: () => void }) {
  const spaces = useBuilding((b) => b.spaces)
  const equipment = useBuilding((b) => b.equipment)
  const residents = useBuilding((b) => b.residents)
  const levels = useBuilding((b) => b.levels)
  if (selection.kind === 'space') {
    const s = spaces[selection.id]
    if (!s) return null
    const water = world.water[s.id]?.depth ?? 0
    const who = people.filter((p) => p.space === s.id)
    return (
      <Card eyebrow={`${levels[s.level]?.name ?? s.level} · ${s.kind}`} title={s.name} onClose={onClose}>
        <div className="tw-rows">
          <Row icon={<Users className="h-3.5 w-3.5" />} label="Here now" value={who.length ? who.map((p) => p.name.split(' ')[0]).slice(0, 4).join(', ') + (who.length > 4 ? ` and ${who.length - 4} more` : '') : 'nobody'} />
          <Row icon={<Lightbulb className="h-3.5 w-3.5" />} label="Power" value={world.power.levels[s.level] === false ? 'off' : 'on'} tone={world.power.levels[s.level] === false ? 'hot' : 'ok'} />
          {water > 0.005 && <Row icon={<Droplets className="h-3.5 w-3.5" />} label="Water" value={`${Math.round(water * 100)} cm`} tone="hot" />}
        </div>
        <p className="tw-hint">The full record is open in the workstation.</p>
      </Card>
    )
  }
  if (selection.kind === 'equipment') {
    const e = equipment[selection.id]
    if (!e) return null
    const st = world.equipment[e.id]?.status ?? 'online'
    const leak = world.leaks[e.id]
    return (
      <Card eyebrow={`${levels[e.level]?.name ?? e.level} · plant`} title={e.name} onClose={onClose}>
        <div className="tw-rows">
          <Row icon={<Zap className="h-3.5 w-3.5" />} label="State" value={st} tone={st === 'online' || st === 'closed' ? 'ok' : 'hot'} />
          {e.flood_height != null && <Row icon={<Droplets className="h-3.5 w-3.5" />} label="Fails under" value={`${Math.round(e.flood_height * 100)} cm of water`} />}
          {leak?.active && <Row icon={<Droplets className="h-3.5 w-3.5" />} label="Leaking" value={`${leak.flow_lps.toFixed(0)} litres a second`} tone="hot" />}
        </div>
        <p className="tw-hint">The full record is open in the workstation.</p>
      </Card>
    )
  }
  const r = residents[selection.id]
  if (!r) return null
  const mark = people.find((p) => p.id === r.id)
  return (
    <Card eyebrow={`${levels[r.level]?.name ?? r.level} · resident`} title={r.name} onClose={onClose}>
      <div className="tw-rows">
        <Row icon={<Users className="h-3.5 w-3.5" />} label="Right now" value={mark ? mark.status : (PRESENCE_LABEL[r.presence] ?? r.presence)} tone={mark ? (mark.tone === 'critical' || mark.tone === 'left' ? 'hot' : mark.tone === 'warning' ? 'warm' : 'ok') : undefined} />
        {r.needs.length > 0 && <Row icon={<Activity className="h-3.5 w-3.5" />} label="Needs" value={r.needs.map((n) => NEED_LABEL[n] ?? n).join(', ')} />}
      </div>
      <p className="tw-hint">The full record is open in the workstation.</p>
    </Card>
  )
}
