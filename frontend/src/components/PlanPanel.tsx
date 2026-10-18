import { useEffect, useRef, useState } from 'react'
import { api, formatClockHM, formatCountdown, formatTimeOfDay } from '../lib/api'
import { useBuilding } from '../state/building'
import type { ActionState, Clock, PlanStep, Stance, StepKind, WorldState } from '../state/types'

interface Props {
  world: WorldState
  clock: Clock
}

const KIND_GLYPH: Record<StepKind, string> = {
  isolate: '⏻',
  valve: '⟲',
  hold: '⏳',
  escort: '♿',
  relocate: '⇢',
  move_item: '❄',
  shelter: '⌂',
  notify: '✉',
  call: '☎',
  ticket: '#',
}

const STANCE_PILL: Record<Stance['stance'], string> = {
  propose: 'pill-blue',
  support: 'pill-green',
  critique: 'pill-amber',
  veto: 'pill-red',
}

const METRIC_LABEL: Record<string, string> = {
  relocated: 'relocated',
  escorted: 'escorted',
  stranded: 'stranded',
  left_behind: 'left behind',
  window_min: 'lift window (min)',
  capacity_used: 'capacity used',
  capacity_total: 'capacity total',
  notified: 'notified',
  steps: 'steps',
  vetoes: 'vetoes',
  rounds: 'rounds',
}

/** The computed plan: steps with reasons, who is left behind, the negotiation that produced it. */
export function PlanPanel({ world, clock }: Props) {
  const roster = useBuilding((b) => b.residents)
  const live = world.plan
  const executing = world.approved_plan
  const plan = executing ?? live
  const [showRounds, setShowRounds] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Highlight steps that were not in the previous plan version, so a toggle visibly reshuffles.
  const prevIds = useRef<Set<string>>(new Set())
  const prevVersion = useRef<number>(plan.version)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (plan.version !== prevVersion.current) {
      const ids = new Set(plan.steps.map((s) => s.id))
      const added = new Set([...ids].filter((id) => !prevIds.current.has(id)))
      setFresh(added)
      prevIds.current = ids
      prevVersion.current = plan.version
      const t = setTimeout(() => setFresh(new Set()), 2000)
      return () => clearTimeout(t)
    }
    prevIds.current = new Set(plan.steps.map((s) => s.id))
  }, [plan.version, plan.steps])

  const approvedThis = executing !== null
  const adviceDiffers = executing !== null && live.version !== executing.version
  const base = plan.computed_step * clock.dt
  const replay = world.mode === 'replay'
  const doneCount = plan.steps.filter((s) => world.actions[s.id]?.status === 'done').length
  const failedCount = plan.steps.filter((s) => world.actions[s.id]?.status === 'failed').length

  const decide = (decision: 'approve' | 'reject') => {
    setError(null)
    api.decidePlan(live.version, decision).catch((e: Error) => setError(e.message))
  }

  const nameOf = (id: string) => roster[id]?.name ?? id

  if (plan.status === 'none' || (plan.steps.length === 0 && plan.rounds.length === 0)) {
    return (
      <div className="flex h-full flex-col">
        <span className="eyebrow">Plan</span>
        <div className="glass-card mt-3 px-3 py-6 text-center text-[12px] text-t3">No incident. The agents negotiate a plan the moment the chain is forecast.</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="eyebrow">Plan</span>
            <span className="mono text-[10px] text-t3">v{plan.version}</span>
            {approvedThis ? (
              <span className={`pill ${plan.status === 'done' ? 'pill-green' : 'pill-orange haven-pulse'}`}>{plan.status === 'done' ? 'Done' : 'Executing'}</span>
            ) : (
              <span className="pill">{plan.status}</span>
            )}
          </div>
          {plan.headline && <p className="mt-1 text-[15px] font-semibold leading-snug text-t1">{plan.headline}</p>}
        </div>
        {!approvedThis && (
          <button disabled={replay} onClick={() => decide('approve')} className="btn-primary shrink-0">
            Approve
          </button>
        )}
      </div>
      {error && <p className="text-[11px] text-haven-danger">{error}</p>}

      {executing && (
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-t3">
            <span>
              {doneCount} of {plan.steps.length} steps done
              {failedCount > 0 && <span className="text-haven-danger"> · {failedCount} failed</span>}
            </span>
            <span className="mono">{plan.steps.length ? Math.round((doneCount / plan.steps.length) * 100) : 0}%</span>
          </div>
          <div className="progress">
            <span style={{ width: `${plan.steps.length ? (doneCount / plan.steps.length) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      {adviceDiffers && (
        <div className="glass-card tint-amber px-3 py-2">
          <div className="eyebrow text-haven-amber">Current advice v{live.version} differs</div>
          <p className="mt-0.5 text-[12px] text-t2">{live.headline}</p>
        </div>
      )}

      {plan.left_behind.length > 0 && (
        <div className="glass-card tint-red px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-haven-danger haven-ring" />
            <span className="text-[14px] font-semibold text-haven-danger">Left behind · {plan.left_behind.length}</span>
          </div>
          <div className="mt-1 text-[14px] font-medium text-t1">{plan.left_behind.map(nameOf).join(', ')}</div>
          <div className="mt-0.5 text-[11px] text-t2">A hard need nobody in the negotiation spoke for. This plan strands them.</div>
        </div>
      )}

      {Object.keys(plan.metrics).length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {Object.entries(plan.metrics).map(([k, v]) => {
            const hot = (k === 'stranded' || k === 'left_behind') && v > 0
            return (
              <div key={k} className="glass-card px-2.5 py-2">
                <div className={`num text-[22px] leading-none ${hot ? 'text-haven-danger glow-red' : 'text-t1'}`}>{Number.isInteger(v) ? v : v.toFixed(1)}</div>
                <div className="label mt-1 leading-tight">{METRIC_LABEL[k] ?? k.replace(/_/g, ' ')}</div>
              </div>
            )
          })}
        </div>
      )}

      <ol className="min-h-0 flex-1 overflow-y-auto pr-1">
        {plan.steps.map((s) => (
          <StepRow key={s.id} step={s} fresh={fresh.has(s.id)} base={base} clock={clock} action={executing ? world.actions[s.id] : undefined} />
        ))}
      </ol>

      {plan.rounds.length > 0 && (
        <div className="hairline pt-2.5">
          <button onClick={() => setShowRounds((v) => !v)} className="flex w-full items-center justify-between text-[11px] text-t2 transition-colors hover:text-t1">
            <span className="eyebrow">Negotiation · {plan.rounds.length} rounds</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ transform: showRounds ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}>
              <path d="M2 3.5l3 3 3-3" />
            </svg>
          </button>
          {showRounds && (
            <ol className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
              {plan.rounds.map((r) => (
                <li key={r.n} className="glass-card px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="mono text-[10px] text-t3">R{r.n}</span>
                    <span className="text-[12px] font-medium text-t1">{r.title}</span>
                    <span className={`pill ml-auto ${r.feasible ? 'pill-green' : 'pill-red'}`}>{r.feasible ? 'feasible' : 'vetoed'}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-t2">{r.summary}</p>
                  {r.stances.length > 0 && (
                    <ul className="mt-1.5 space-y-1">
                      {r.stances.map((st, i) => (
                        <li key={`${st.agent}-${i}`} className="flex items-start gap-1.5 text-[11px]">
                          <span className={`pill ${STANCE_PILL[st.stance]} shrink-0`}>{st.stance}</span>
                          <span className="shrink-0 text-t1">{st.label}</span>
                          <span className="text-t2">{st.reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

function StepRow({ step, fresh, base, clock, action }: { step: PlanStep; fresh: boolean; base: number; clock: Clock; action?: ActionState }) {
  const glyph = KIND_GLYPH[step.kind] ?? '•'
  const startAt = base + step.at_s
  const startIn = startAt - clock.sim_time
  const deadlineAt = step.deadline_s != null ? base + step.deadline_s : null
  const deadlineIn = deadlineAt != null ? deadlineAt - clock.sim_time : null
  const status = action?.status
  const actionTime = action ? formatTimeOfDay(clock.time_of_day - (clock.step - action.step) * clock.dt) : null
  return (
    <li className={`row flex gap-3 rounded-lg py-2.5 ${fresh ? 'haven-flash' : ''} ${status === 'done' ? 'opacity-75' : ''}`}>
      <StatusGlyph status={status} glyph={glyph} title={status ? `${step.kind} · ${status}` : step.kind} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-t1">{step.title}</span>
          {step.count > 0 && <span className="pill mono shrink-0">{step.count}</span>}
          <span className="pill pill-mono ml-auto shrink-0">
            {step.at_s > 0 ? `${formatClockHM(clock.time_of_day + startIn)} · in ${formatCountdown(startIn)}` : 'now'}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-t2">{step.reason}</div>
        <div className="mono mt-1 flex flex-wrap gap-x-2 text-[10px] text-t3">
          <span className="text-t2">{step.actor}</span>
          {deadlineAt != null && deadlineIn != null && (
            <span className={deadlineIn < 120 ? 'text-haven-danger' : 'text-haven-amber'}>
              by {formatClockHM(clock.time_of_day + deadlineIn)} · {formatCountdown(deadlineIn)} left
            </span>
          )}
          {step.satisfies.length > 0 && <span className="truncate">for {step.satisfies.map((a) => a.replace('resident:', '')).join(', ')}</span>}
        </div>
        {action && (
          <div className={`mono mt-1 text-[10px] ${status === 'done' ? 'text-haven-safe' : status === 'failed' ? 'text-haven-danger' : 'text-haven-power'}`}>
            {status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'assigned'} {actionTime}
            {action.detail ? ` · ${action.detail}` : ''}
          </div>
        )}
      </div>
    </li>
  )
}

function StatusGlyph({ status, glyph, title }: { status?: ActionState['status']; glyph: string; title: string }) {
  const base = 'mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px]'
  if (status === 'done')
    return (
      <span className={`${base} bg-haven-safe text-black`} title={title}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.5 5.5l2.5 2.5 4.5-5" />
        </svg>
      </span>
    )
  if (status === 'failed')
    return (
      <span className={`${base} bg-haven-danger text-white`} title={title}>
        ✕
      </span>
    )
  if (status === 'assigned')
    return (
      <span className={`${base} bg-haven-power text-black haven-pulse`} title={title}>
        {glyph}
      </span>
    )
  return (
    <span className={`${base} border border-white/15 text-t2`} title={title}>
      {glyph}
    </span>
  )
}
