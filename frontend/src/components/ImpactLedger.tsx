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
  const others = onlyFlagged ? [] : impact.others.map((id) => roster[id]).filter((r): r is NonNullable<typeof r> => !!r)

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Impact ledger</span>
        <div className="seg seg-xs">
          {(['now', 'forecast'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`seg-item ${showing === v ? 'is-on' : ''}`}>
              {v === 'now' ? 'Now' : 'If nothing is done'}
            </button>
          ))}
        </div>
      </div>

      {outcome && (
        <div className="glass-card tint-green px-3.5 py-2.5">
          <div className="eyebrow text-haven-safe">Outcome · plan v{outcome.version} done</div>
          <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-t1">
            <li className="flex items-center gap-1.5">
              <Check /> everyone with a need: named step
            </li>
            <li className="flex items-center gap-1.5">
              <Check /> {outcome.metrics.relocated ?? 0} relocated
            </li>
            <li className={`flex items-center gap-1.5 ${outcome.left_behind.length ? 'text-haven-danger' : ''}`}>
              {outcome.left_behind.length ? <span className="text-haven-danger">✕</span> : <Check />} {outcome.left_behind.length} left behind
            </li>
            <li className="flex items-center gap-1.5">
              <Check /> {minutesToDone != null ? `${minutesToDone.toFixed(0)} min detection → done` : 'done'}
            </li>
          </ul>
        </div>
      )}

      <div className="grid grid-cols-4 gap-2">
        {STAT_KEYS.map(([k, label]) => {
          const n = impact.counts[k] ?? 0
          const hot = n > 0 && ['stranded', 'medication_at_risk', 'device_power_lost'].includes(k)
          return (
            <div key={k} className="glass-card px-2.5 py-2">
              <div className={`num text-[26px] leading-none ${hot ? 'text-haven-danger glow-red' : n > 0 ? 'text-t1' : 'text-t3'}`}>{n}</div>
              <div className="label mt-1 leading-tight">{label}</div>
            </div>
          )
        })}
      </div>

      {(impact.dark_levels.length > 0 || impact.lifts_down.length > 0 || impact.fridges_down.length > 0 || impact.wet_spaces.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {impact.dark_levels.length > 0 && <span className="pill pill-red">dark · {impact.dark_levels.join(', ')}</span>}
          {impact.lifts_down.length > 0 && <span className="pill pill-red">lifts down · {impact.lifts_down.join(', ')}</span>}
          {impact.fridges_down.length > 0 && <span className="pill pill-amber">fridges off · {impact.fridges_down.length}</span>}
          {impact.wet_spaces.length > 0 && <span className="pill pill-cyan">wet · {impact.wet_spaces.length} spaces</span>}
        </div>
      )}

      <label className="flex items-center gap-2 text-[11px] text-t3">
        <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} className="h-3.5 w-3.5 accent-[#0a84ff]" />
        only people with a specific need
        <span className="mono ml-auto text-[10px]">
          {impact.residents.length} / {total}
        </span>
      </label>

      <ul className="min-h-0 flex-1 overflow-y-auto pr-1">
        {total === 0 && <li className="glass-card px-3 py-5 text-center text-[12px] text-t3">Nobody affected.</li>}
        {impact.residents.map((r) => (
          <li key={r.id} className="row py-2">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[r.severity]}`} />
              <span className="text-[13px] font-medium text-t1">{r.name}</span>
              {r.role === 'ra' && <span className="pill">RA</span>}
              <span className="mono ml-auto truncate text-[11px] text-t3">
                {whereNow(r.id) ? <span className="text-haven-safe">now in {whereNow(r.id)}</span> : `${spaces[r.room]?.name ?? r.room} · ${PRESENCE_LABEL[r.presence] ?? r.presence}`}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1 pl-3.5">
              {r.impacts
                .filter((i) => i !== 'power_lost' || r.impacts.length === 1)
                .map((i) => (
                  <span
                    key={i}
                    className={`pill ${['stranded', 'medication_at_risk', 'device_power_lost'].includes(i) ? 'pill-red' : i === 'away' || i === 'power_lost' ? '' : 'pill-amber'}`}
                  >
                    {IMPACT_LABEL[i] ?? i}
                  </span>
                ))}
              {r.needs.map((n) => (
                <span key={n} className="pill">
                  {NEED_LABEL[n] ?? n}
                </span>
              ))}
              {r.lang !== 'en' && <span className="pill mono">{r.lang}</span>}
            </div>
          </li>
        ))}
        {others.map((r) => (
          <li key={r.id} className="row flex items-center gap-2 py-1.5 text-[12px] text-t2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-t3/60" />
            <span>{r.name}</span>
            <span className="mono ml-auto truncate text-[11px] text-t3">
              {whereNow(r.id) ? <span className="text-haven-safe">now in {whereNow(r.id)}</span> : `${spaces[r.room]?.name ?? r.room} · ${PRESENCE_LABEL[r.presence] ?? r.presence}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#30d158" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 5.5l2.5 2.5 4.5-5" />
    </svg>
  )
}
