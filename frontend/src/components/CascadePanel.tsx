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
        <div className="mb-2 flex items-baseline justify-between">
          <span className="eyebrow">Forecast · chain of consequences</span>
          <span className="mono text-[10px] text-t3">{upcoming.length ? `${upcoming.length} predicted` : f.settled ? 'nothing pending' : ''}</span>
        </div>
        <ol className="min-h-0 flex-1 overflow-y-auto pr-1">
          {upcoming.length === 0 && <li className="glass-card px-3 py-5 text-center text-[12px] text-t3">No leak. The chain appears here the moment the sensor fires.</li>}
          {upcoming.map((e, i) => (
            <li key={`${e.kind}-${e.id}-${i}`} className="row flex items-start gap-2.5 py-2">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[e.severity]}`} />
              <div className="min-w-0 flex-1">
                <div className={`text-[12px] leading-snug ${e.severity === 'critical' ? SEVERITY_TEXT.critical : 'text-t1'}`}>{e.message}</div>
                <div className="mono mt-0.5 flex gap-2 text-[10px] text-t3">
                  <span>{formatClockHM(clock.time_of_day + (e.at - clock.sim_time))}</span>
                  {e.cause && <span className="truncate">← {e.cause}</span>}
                </div>
              </div>
              <span className="pill pill-mono mt-0.5 shrink-0">in {formatCountdown(e.remaining)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="hairline flex min-h-0 flex-1 flex-col pt-3">
        <span className="eyebrow mb-2">Timeline · what happened</span>
        <ol className="min-h-0 flex-1 overflow-y-auto pr-1">
          {timeline.length === 0 && <li className="glass-card px-3 py-5 text-center text-[12px] text-t3">Nothing yet.</li>}
          {timeline.map((t, i) => (
            <li key={`${t.step}-${i}`} className="row flex items-start gap-2.5 py-1.5">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[t.severity]}`} />
              <span className={`min-w-0 flex-1 text-[12px] leading-snug ${t.severity === 'critical' ? SEVERITY_TEXT.critical : t.severity === 'warning' ? 'text-t1' : 'text-t2'}`}>{t.message}</span>
              <span className="mono shrink-0 text-[10px] text-t3">{formatTimeOfDay(clock.time_of_day - (clock.step - t.step) * clock.dt)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
