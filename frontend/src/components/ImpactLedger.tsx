import { useState } from 'react'
import { IMPACT_LABEL, NEED_LABEL, PRESENCE_LABEL, SEVERITY_DOT } from '../lib/labels'
import { useBuilding } from '../state/building'
import type { Clock, Impact, WorldState } from '../state/types'

interface Props {
  world: WorldState
  clock?: Clock
}

const STAT_KEYS: [string, string][] = [
  ['affected', 'affected'],
  ['on_dark_floors', 'on dark floors'],
  ['asleep', 'asleep'],
  ['stranded', 'stranded'],
  ['medication_at_risk', 'meds at risk'],
  ['device_power_lost', 'device power'],
  ['needs_visual_alert', 'visual alert'],
  ['away', 'away'],
]

/** Who is affected, now or if nothing is done. Every row is a person the agents will speak for. */
export function ImpactLedger({ world, clock }: Props) {
  const spaces = useBuilding((b) => b.spaces)
  const roster = useBuilding((b) => b.residents)
  const outcome = world.approved_plan?.status === 'done' ? world.approved_plan : null
  const whereNow = (id: string): string | null => {
    const sp = world.moved[id]
    if (!sp) return null
    if (sp === 'outside') return 'another building'
    return spaces[sp]?.name ?? sp
  }
  const minutesToDone = (() => {
    if (!outcome || !clock) return null
    const start = world.timeline.find((t) => t.kind === 'sensor_wet')?.step
    const doneSteps = world.timeline.filter((t) => t.kind === 'action' && t.data.status === 'done').map((t) => t.step)
    if (start == null || doneSteps.length === 0) return null
    return ((Math.max(...doneSteps) - start) * clock.dt) / 60
  })()
  const hasNow = world.impact.residents.length > 0
  const [view, setView] = useState<'auto' | 'now' | 'forecast'>('auto')
  const showing: 'now' | 'forecast' = view === 'auto' ? (hasNow ? 'now' : 'forecast') : view
  const impact: Impact = showing === 'now' ? world.impact : world.forecast.impact
  const [onlyFlagged, setOnlyFlagged] = useState(true)

  const total = impact.residents.length + impact.others.length
  const others = onlyFlagged
    ? []
    : impact.others.map((id) => roster[id]).filter((r): r is NonNullable<typeof r> => !!r)

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Impact ledger</h2>
        <div className="flex gap-1 text-[10px]">
          {(['now', 'forecast'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-2 py-0.5 uppercase tracking-wider ${showing === v ? 'bg-slate-200 text-ink-900' : 'bg-ink-700 text-slate-400 hover:bg-ink-600'}`}
            >
              {v === 'now' ? 'now' : 'if nothing is done'}
            </button>
          ))}
        </div>
      </div>

      {outcome && (
        <div className="rounded-lg border border-haven-safe/60 bg-haven-safe/10 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-haven-safe">Outcome · plan v{outcome.version} done</div>
          <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-slate-200">
            <li>✓ everyone with a need: named step</li>
            <li>✓ {outcome.metrics.relocated ?? 0} relocated</li>
            <li className={outcome.left_behind.length ? 'text-haven-danger' : ''}>
              {outcome.left_behind.length ? '✗' : '✓'} {outcome.left_behind.length} left behind
            </li>
            <li>{minutesToDone != null ? `✓ ${minutesToDone.toFixed(0)} min detection → done` : '✓ done'}</li>
          </ul>
        </div>
      )}

      <div className="grid grid-cols-4 gap-1">
        {STAT_KEYS.map(([k, label]) => {
          const n = impact.counts[k] ?? 0
          const hot = n > 0 && ['stranded', 'medication_at_risk', 'device_power_lost'].includes(k)
          return (
            <div key={k} className={`rounded border px-2 py-1 ${hot ? 'border-haven-danger/60 bg-haven-danger/10' : 'border-ink-700 bg-ink-900'}`}>
              <div className={`text-lg font-semibold tabular-nums ${hot ? 'text-haven-danger' : n > 0 ? 'text-white' : 'text-slate-600'}`}>{n}</div>
              <div className="text-[10px] leading-tight text-slate-500">{label}</div>
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap gap-1 text-[10px] text-slate-400">
        {impact.dark_levels.length > 0 && <Chip tone="danger">dark: {impact.dark_levels.join(', ')}</Chip>}
        {impact.lifts_down.length > 0 && <Chip tone="danger">lifts down: {impact.lifts_down.join(', ')}</Chip>}
        {impact.fridges_down.length > 0 && <Chip tone="warn">fridges off: {impact.fridges_down.length}</Chip>}
        {impact.wet_spaces.length > 0 && <Chip tone="water">wet: {impact.wet_spaces.length} spaces</Chip>}
      </div>

      <label className="flex items-center gap-2 text-[11px] text-slate-500">
        <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} className="accent-slate-300" />
        only people with a specific need ({impact.residents.length} of {total})
      </label>

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {total === 0 && (
          <li className="rounded border border-dashed border-ink-700 px-3 py-4 text-center text-xs text-slate-600">Nobody affected.</li>
        )}
        {impact.residents.map((r) => (
          <li key={r.id} className="rounded border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[r.severity]}`} />
              <span className="font-medium text-white">{r.name}</span>
              {r.role === 'ra' && <span className="rounded bg-ink-700 px-1 text-[9px] uppercase text-slate-400">RA</span>}
              <span className="ml-auto font-mono text-[10px] text-slate-500">
                {whereNow(r.id) ? <span className="text-haven-safe">now in {whereNow(r.id)}</span> : `${spaces[r.room]?.name ?? r.room} · ${PRESENCE_LABEL[r.presence] ?? r.presence}`}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {r.impacts
                .filter((i) => i !== 'power_lost' || r.impacts.length === 1)
                .map((i) => (
                  <Chip key={i} tone={['stranded', 'medication_at_risk', 'device_power_lost'].includes(i) ? 'danger' : i === 'away' || i === 'power_lost' ? 'muted' : 'warn'}>
                    {IMPACT_LABEL[i] ?? i}
                  </Chip>
                ))}
              {r.needs.map((n) => (
                <Chip key={n} tone="muted">
                  {NEED_LABEL[n] ?? n}
                </Chip>
              ))}
              {r.lang !== 'en' && <Chip tone="muted">{r.lang}</Chip>}
            </div>
          </li>
        ))}
        {others.map((r) => (
          <li key={r.id} className="flex items-center gap-2 rounded border border-ink-700/60 bg-ink-900/60 px-2.5 py-1 text-xs text-slate-400">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-600" />
            <span>{r.name}</span>
            <span className="ml-auto font-mono text-[10px] text-slate-500">
              {whereNow(r.id) ? <span className="text-haven-safe">now in {whereNow(r.id)}</span> : `${spaces[r.room]?.name ?? r.room} · ${PRESENCE_LABEL[r.presence] ?? r.presence}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Chip({ tone, children }: { tone: 'danger' | 'warn' | 'water' | 'muted'; children: React.ReactNode }) {
  const cls = {
    danger: 'border-haven-danger/50 text-haven-danger',
    warn: 'border-amber-400/50 text-amber-400',
    water: 'border-haven-water/50 text-haven-water',
    muted: 'border-ink-600 text-slate-400',
  }[tone]
  return <span className={`rounded border px-1.5 py-px text-[10px] ${cls}`}>{children}</span>
}
