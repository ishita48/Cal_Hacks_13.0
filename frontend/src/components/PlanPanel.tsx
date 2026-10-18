import { useEffect, useRef, useState } from 'react'
import { api, formatClockHM, formatCountdown, formatTimeOfDay } from '../lib/api'
import { useBuilding } from '../state/building'
import type { ActionState, Clock, PlanStep, Stance, StepKind, WorldState } from '../state/types'

interface Props {
  world: WorldState
  clock: Clock
}

const KIND_GLYPH: Record<StepKind, [string, string]> = {
  isolate: ['⏻', 'bg-haven-power/20 text-haven-power'],
  valve: ['⟲', 'bg-haven-water/20 text-haven-water'],
  hold: ['⏳', 'bg-amber-400/20 text-amber-300'],
  escort: ['♿', 'bg-haven-safe/20 text-haven-safe'],
  relocate: ['⇢', 'bg-ink-700 text-slate-200'],
  move_item: ['❄', 'bg-haven-water/20 text-haven-water'],
  shelter: ['⌂', 'bg-ink-700 text-slate-200'],
  notify: ['✉', 'bg-ink-700 text-slate-300'],
  call: ['☎', 'bg-ink-700 text-slate-300'],
  ticket: ['#', 'bg-ink-700 text-slate-300'],
}

const STANCE_STYLE: Record<Stance['stance'], string> = {
  propose: 'text-haven-water',
  support: 'text-haven-safe',
  critique: 'text-amber-400',
  veto: 'text-haven-danger',
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
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Plan</h2>
        <div className="mt-2 rounded border border-dashed border-ink-700 px-3 py-4 text-center text-xs text-slate-600">
          No incident. The agents negotiate a plan the moment the chain is forecast.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Plan <span className="font-mono normal-case tracking-normal text-slate-600">v{plan.version} · {plan.status}</span>
          </h2>
          {plan.headline && <p className="mt-0.5 text-sm font-medium text-white">{plan.headline}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {approvedThis ? (
            <span
              className={`rounded border px-2 py-1 text-xs font-semibold ${
                plan.status === 'done' ? 'border-haven-safe bg-haven-safe/20 text-haven-safe' : 'border-haven-safe/60 bg-haven-safe/10 text-haven-safe haven-pulse'
              }`}
            >
              {plan.status === 'done' ? `Done · v${plan.version}` : `Executing v${plan.version}`}
            </span>
          ) : (
            <button
              disabled={replay}
              onClick={() => decide('approve')}
              className="rounded bg-haven-safe px-3 py-1.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-30"
            >
              Approve
            </button>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-haven-danger">{error}</p>}

      {executing && (
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500">
            <span>
              {doneCount} of {plan.steps.length} steps done{failedCount > 0 && <span className="text-haven-danger"> · {failedCount} failed</span>}
            </span>
            <span className="font-mono">{plan.steps.length ? Math.round((doneCount / plan.steps.length) * 100) : 0}%</span>
          </div>
          <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-ink-700">
            <div className="h-full bg-haven-safe transition-all duration-500" style={{ width: `${plan.steps.length ? (doneCount / plan.steps.length) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      {adviceDiffers && (
        <div className="rounded border border-amber-400/40 bg-amber-400/5 px-2.5 py-1.5 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-amber-400">current advice v{live.version} differs</span>
          <p className="mt-0.5 text-slate-300">{live.headline}</p>
        </div>
      )}

      {plan.left_behind.length > 0 && (
        <div className="rounded-lg border-2 border-haven-danger bg-haven-danger/15 px-3 py-2 haven-pulse">
          <div className="text-xs font-bold uppercase tracking-wider text-haven-danger">
            Left behind · {plan.left_behind.length}
          </div>
          <div className="mt-0.5 text-sm text-white">{plan.left_behind.map(nameOf).join(', ')}</div>
          <div className="text-[11px] text-haven-danger/90">A hard need nobody in the negotiation spoke for. This plan strands them.</div>
        </div>
      )}

      {Object.keys(plan.metrics).length > 0 && (
        <div className="grid grid-cols-4 gap-1">
          {Object.entries(plan.metrics).map(([k, v]) => {
            const hot = (k === 'stranded' || k === 'left_behind') && v > 0
            return (
              <div key={k} className={`rounded border px-2 py-1 ${hot ? 'border-haven-danger/60 bg-haven-danger/10' : 'border-ink-700 bg-ink-900'}`}>
                <div className={`text-base font-semibold tabular-nums ${hot ? 'text-haven-danger' : 'text-white'}`}>{Number.isInteger(v) ? v : v.toFixed(1)}</div>
                <div className="text-[10px] leading-tight text-slate-500">{METRIC_LABEL[k] ?? k.replace(/_/g, ' ')}</div>
              </div>
            )
          })}
        </div>
      )}

      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {plan.steps.map((s) => (
          <StepRow key={s.id} step={s} fresh={fresh.has(s.id)} base={base} clock={clock} action={executing ? world.actions[s.id] : undefined} />
        ))}
      </ol>

      {plan.rounds.length > 0 && (
        <div className="border-t border-ink-700 pt-2">
          <button onClick={() => setShowRounds((v) => !v)} className="flex w-full items-center justify-between text-[11px] text-slate-400 hover:text-slate-200">
            <span className="font-semibold uppercase tracking-wider">Negotiation · {plan.rounds.length} rounds</span>
            <span>{showRounds ? '▾' : '▸'}</span>
          </button>
          {showRounds && (
            <ol className="mt-1.5 max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {plan.rounds.map((r) => (
                <li key={r.n} className="rounded border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-slate-500">R{r.n}</span>
                    <span className="font-medium text-slate-100">{r.title}</span>
                    <span className={`ml-auto rounded border px-1.5 text-[10px] uppercase ${r.feasible ? 'border-haven-safe/60 text-haven-safe' : 'border-haven-danger/60 text-haven-danger'}`}>
                      {r.feasible ? 'feasible' : 'vetoed'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">{r.summary}</p>
                  {r.stances.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {r.stances.map((st, i) => (
                        <li key={`${st.agent}-${i}`} className="flex gap-1.5 text-[11px]">
                          <span className={`shrink-0 font-semibold uppercase ${STANCE_STYLE[st.stance]}`}>{st.stance}</span>
                          <span className="shrink-0 text-slate-300">{st.label}:</span>
                          <span className="text-slate-400">{st.reason}</span>
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
  const [glyph, cls] = KIND_GLYPH[step.kind] ?? ['•', 'bg-ink-700 text-slate-300']
  const startAt = base + step.at_s
  const startIn = startAt - clock.sim_time
  const deadlineAt = step.deadline_s != null ? base + step.deadline_s : null
  const deadlineIn = deadlineAt != null ? deadlineAt - clock.sim_time : null
  const status = action?.status
  const border =
    status === 'done' ? 'border-haven-safe/50' : status === 'failed' ? 'border-haven-danger/60' : status === 'assigned' ? 'border-amber-400/50' : 'border-ink-700'
  const actionTime = action ? formatTimeOfDay(clock.time_of_day - (clock.step - action.step) * clock.dt) : null
  return (
    <li className={`flex gap-2 rounded border bg-ink-900 px-2.5 py-1.5 text-xs ${border} ${fresh ? 'haven-flash' : ''} ${status === 'done' ? 'opacity-80' : ''}`}>
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] ${
          status === 'done' ? 'bg-haven-safe/20 text-haven-safe' : status === 'failed' ? 'bg-haven-danger/20 text-haven-danger' : status === 'assigned' ? 'bg-amber-400/20 text-amber-300 haven-pulse' : cls
        }`}
        title={status ? `${step.kind} · ${status}` : step.kind}
      >
        {status === 'done' ? '✓' : status === 'failed' ? '✗' : glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] text-slate-600">{step.order}</span>
          <span className="font-medium text-slate-100">{step.title}</span>
          {step.count > 0 && <span className="rounded bg-ink-700 px-1 text-[10px] text-slate-300">{step.count} people</span>}
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">{step.reason}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] text-slate-500">
          <span className="text-slate-400">{step.actor}</span>
          <span>
            {step.at_s > 0 ? `at ${formatClockHM(clock.time_of_day + startIn)} (in ${formatCountdown(startIn)})` : 'now'}
          </span>
          {deadlineAt != null && deadlineIn != null && (
            <span className={deadlineIn < 120 ? 'text-haven-danger' : 'text-amber-400'}>
              by {formatClockHM(clock.time_of_day + deadlineIn)} · {formatCountdown(deadlineIn)} left
            </span>
          )}
          {step.satisfies.length > 0 && <span className="truncate">for {step.satisfies.map((a) => a.replace('resident:', '')).join(', ')}</span>}
        </div>
        {action && (
          <div className={`mt-0.5 font-mono text-[10px] ${status === 'done' ? 'text-haven-safe' : status === 'failed' ? 'text-haven-danger' : 'text-amber-300'}`}>
            {status === 'done' ? '✓ done' : status === 'failed' ? '✗ failed' : '… assigned'} {actionTime}
            {action.detail ? ` · ${action.detail}` : ''}
          </div>
        )}
      </div>
    </li>
  )
}
