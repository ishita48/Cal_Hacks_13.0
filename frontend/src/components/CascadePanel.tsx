import { formatClockHM, formatCountdown, formatTimeOfDay } from '../lib/api'
import { SEVERITY_DOT, SEVERITY_TEXT } from '../lib/labels'
import type { Clock, WorldState } from '../state/types'

interface Props {
  world: WorldState
  clock: Clock
}

const QUIET_KINDS = new Set(['offline'])

/** What will happen (forecast, counting down) above what has happened (timeline). */
export function CascadePanel({ world, clock }: Props) {
  const f = world.forecast
  const computedAt = f.computed_step * clock.dt
  const upcoming = f.events
    .filter((e) => e.severity !== 'info' || !QUIET_KINDS.has(e.kind))
    .map((e) => ({ ...e, at: computedAt + e.eta_s, remaining: computedAt + e.eta_s - clock.sim_time }))
    .filter((e) => e.remaining > -1)

  const timeline = [...world.timeline].reverse()

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <section className="flex min-h-0 flex-1 flex-col">
        <h2 className="mb-2 flex items-baseline justify-between text-xs font-semibold uppercase tracking-wider text-slate-500">
          <span>Forecast · chain of consequences</span>
          <span className="font-mono normal-case tracking-normal text-slate-600">
            {upcoming.length ? `${upcoming.length} predicted` : f.settled ? 'nothing pending' : ''}
          </span>
        </h2>
        <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {upcoming.length === 0 && (
            <li className="rounded border border-dashed border-ink-700 px-3 py-4 text-center text-xs text-slate-600">
              No leak. The chain appears here the moment the sensor fires.
            </li>
          )}
          {upcoming.map((e, i) => (
            <li key={`${e.kind}-${e.id}-${i}`} className="flex gap-2 rounded border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[e.severity]}`} />
              <div className="min-w-0 flex-1">
                <div className={SEVERITY_TEXT[e.severity]}>{e.message}</div>
                <div className="mt-0.5 flex gap-2 font-mono text-[10px] text-slate-500">
                  <span>{formatClockHM(clock.time_of_day + (e.at - clock.sim_time))}</span>
                  <span className="text-slate-400">in {formatCountdown(e.remaining)}</span>
                  {e.cause && <span className="truncate">← {e.cause}</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex min-h-0 flex-1 flex-col border-t border-ink-700 pt-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Timeline · what happened</h2>
        <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {timeline.map((t, i) => (
            <li key={`${t.step}-${i}`} className="flex gap-2 rounded border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs">
              <span className="shrink-0 font-mono text-slate-500">{formatTimeOfDay(clock.time_of_day - (clock.step - t.step) * clock.dt)}</span>
              <span className={SEVERITY_TEXT[t.severity]}>{t.message}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
