import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, formatClockHM, formatCountdown, formatTimeOfDay } from '../lib/api'
import { speak, stopSpeaking } from '../lib/speak'
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

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

type Row = { step: PlanStep; ghost: boolean }

/** The computed plan: steps with reasons, who is left behind, the negotiation that produced it. */
export function PlanPanel({ world, clock }: Props) {
  const roster = useBuilding((b) => b.residents)
  const live = world.plan
  const executing = world.approved_plan
  const plan = executing ?? live
  const [showRounds, setShowRounds] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The plan reshuffle, driven by plan.version: new steps enter, removed steps collapse out as
  // short-lived ghosts at their old position, steps that moved slide to their new place (FLIP).
  const prevSteps = useRef<PlanStep[]>(plan.steps)
  const prevVersion = useRef<number>(plan.version)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [ghosts, setGhosts] = useState<{ step: PlanStep; index: number }[]>([])
  useEffect(() => {
    if (plan.version !== prevVersion.current) {
      const ids = new Set(plan.steps.map((s) => s.id))
      const prevIds = new Set(prevSteps.current.map((s) => s.id))
      const added = new Set([...ids].filter((id) => !prevIds.has(id)))
      const removed = prevSteps.current.map((s, i) => ({ step: s, index: i })).filter((g) => !ids.has(g.step.id))
      setFresh(added)
      setGhosts(removed)
      prevSteps.current = plan.steps
      prevVersion.current = plan.version
      const t1 = setTimeout(() => setFresh(new Set()), 2000)
      const t2 = setTimeout(() => setGhosts([]), 400)
      return () => {
        clearTimeout(t1)
        clearTimeout(t2)
      }
    }
    prevSteps.current = plan.steps
  }, [plan.version, plan.steps])

  // FLIP: remember where each row was; after a version change, animate from there to here.
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const lastRects = useRef(new Map<string, DOMRect>())
  const flipVersion = useRef(plan.version)
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>()
    const animate = plan.version !== flipVersion.current && !reducedMotion()
    flipVersion.current = plan.version
    for (const [id, el] of rowRefs.current) {
      const rect = el.getBoundingClientRect()
      next.set(id, rect)
      const prev = lastRects.current.get(id)
      if (animate && prev) {
        const dy = prev.top - rect.top
        if (Math.abs(dy) > 1 && typeof el.animate === 'function') {
          el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
            duration: 450,
            easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
          })
        }
      }
    }
    lastRects.current = next
  })

  const rows: Row[] = plan.steps.map((step) => ({ step, ghost: false }))
  for (const g of [...ghosts].sort((a, b) => a.index - b.index)) rows.splice(Math.min(g.index, rows.length), 0, { step: g.step, ghost: true })

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

  // The left-behind block keeps its last names while it slides closed.
  const lastLeftBehind = useRef<string[]>(plan.left_behind)
  if (plan.left_behind.length > 0) lastLeftBehind.current = plan.left_behind
  const leftNames = (plan.left_behind.length ? plan.left_behind : lastLeftBehind.current).map(nameOf).join(', ')

  if (plan.status === 'none' || (plan.steps.length === 0 && plan.rounds.length === 0)) {
    return (
      <div className="flex h-full flex-col">
        <span className="eyebrow" data-buds="panel:plan">Plan</span>
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
            <span key={plan.version} className="mono fade-swap text-[10px] text-t3">
              v{plan.version}
            </span>
            {approvedThis ? (
              <span key={plan.status} className={`pill pop ${plan.status === 'done' ? 'pill-green' : 'pill-orange haven-pulse'}`}>
                {plan.status === 'done' ? 'Done' : 'Executing'}
              </span>
            ) : (
              <span className="pill">{plan.status}</span>
            )}
          </div>
          {plan.headline && (
            <p key={plan.headline} className="fade-swap mt-1 text-[15px] font-semibold leading-snug text-t1">
              {plan.headline}
            </p>
          )}
          <BriefButton />
        </div>
        {!approvedThis && (
          <button disabled={replay} onClick={() => decide('approve')} className="btn-primary shrink-0">
            Approve
          </button>
        )}
      </div>
      {error && <p className="text-[11px] text-haven-danger">{error}</p>}

      {executing && (
        <div className="enter">
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
        <div className="glass-card tint-amber enter px-3 py-2">
          <div className="eyebrow text-haven-amber">Current advice v{live.version} differs</div>
          <p className="mt-0.5 text-[12px] text-t2">{live.headline}</p>
        </div>
      )}

      <div className={`reveal ${plan.left_behind.length > 0 ? 'is-open' : ''}`} aria-hidden={plan.left_behind.length === 0}>
        <div>
          <div className="glass-card tint-red px-3.5 py-3">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-haven-danger haven-ring" />
              <span className="text-[14px] font-semibold text-haven-danger">Left behind · {plan.left_behind.length || lastLeftBehind.current.length}</span>
            </div>
            <div className="mt-1 text-[14px] font-medium text-t1">{leftNames}</div>
            <div className="mt-0.5 text-[11px] text-t2">A hard need nobody in the negotiation spoke for. This plan strands them.</div>
          </div>
        </div>
      </div>

      {plan.checks.length > 0 && <Checks checks={plan.checks} />}

      {Object.keys(plan.metrics).length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {Object.entries(plan.metrics).map(([k, v]) => {
            const hot = (k === 'stranded' || k === 'left_behind') && v > 0
            return (
              <div key={k} className="glass-card px-2.5 py-2">
                <div key={String(v)} className={`num fade-swap text-[22px] leading-none ${hot ? 'text-haven-danger glow-red' : 'text-t1'}`}>
                  {Number.isInteger(v) ? v : v.toFixed(1)}
                </div>
                <div className="label mt-1 leading-tight">{METRIC_LABEL[k] ?? k.replace(/_/g, ' ')}</div>
              </div>
            )
          })}
        </div>
      )}

      <ol className="min-h-0 flex-1 overflow-y-auto pr-1">
        {rows.map(({ step, ghost }) => (
          <StepRow
            key={ghost ? `ghost-${step.id}` : step.id}
            step={step}
            ghost={ghost}
            fresh={fresh.has(step.id)}
            base={base}
            clock={clock}
            action={executing ? world.actions[step.id] : undefined}
            rowRef={(el) => {
              if (ghost) return
              if (el) rowRefs.current.set(step.id, el)
              else rowRefs.current.delete(step.id)
            }}
          />
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
          <div className={`reveal ${showRounds ? 'is-open' : ''}`}>
            <div>
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
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StepRow({
  step,
  ghost,
  fresh,
  base,
  clock,
  action,
  rowRef,
}: {
  step: PlanStep
  ghost: boolean
  fresh: boolean
  base: number
  clock: Clock
  action?: ActionState
  rowRef: (el: HTMLLIElement | null) => void
}) {
  const glyph = KIND_GLYPH[step.kind] ?? '•'
  const startAt = base + step.at_s
  const startIn = startAt - clock.sim_time
  const deadlineAt = step.deadline_s != null ? base + step.deadline_s : null
  const deadlineIn = deadlineAt != null ? deadlineAt - clock.sim_time : null
  const status = action?.status
  const actionTime = action ? formatTimeOfDay(clock.time_of_day - (clock.step - action.step) * clock.dt) : null
  return (
    <li
      data-buds={ghost ? undefined : `step:${step.id}`}
      ref={rowRef}
      className={`row flex gap-3 rounded-lg py-2.5 ${ghost ? 'leave' : ''} ${fresh ? 'haven-flash enter' : ''} ${status === 'done' ? 'opacity-75' : ''}`}
      style={{ transition: 'opacity 300ms ease' }}
    >
      <StatusGlyph status={status} glyph={glyph} title={status ? `${step.kind} · ${status}` : step.kind} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-t1">{step.title}</span>
          {step.count > 0 && <span className="pill mono shrink-0">{step.count}</span>}
          <span className="pill pill-mono pill-count ml-auto shrink-0">
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
          <div key={status} className={`mono fade-swap mt-1 text-[10px] ${status === 'done' ? 'text-haven-safe' : status === 'failed' ? 'text-haven-danger' : 'text-haven-power'}`}>
            {status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'assigned'} {actionTime}
            {action.detail ? ` · ${action.detail}` : ''}
          </div>
        )}
      </div>
    </li>
  )
}

function StatusGlyph({ status, glyph, title }: { status?: ActionState['status']; glyph: string; title: string }) {
  const base = 'glyph mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px]'
  // Keyed on status so each transition (ring -> assigned -> done) pops once.
  if (status === 'done')
    return (
      <span key="done" className={`${base} pop-check bg-haven-safe text-black`} title={title}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.5 5.5l2.5 2.5 4.5-5" />
        </svg>
      </span>
    )
  if (status === 'failed')
    return (
      <span key="failed" className={`${base} pop-check bg-haven-danger text-white`} title={title}>
        ✕
      </span>
    )
  if (status === 'assigned')
    return (
      <span key="assigned" className={`${base} pop-check bg-haven-power text-black haven-pulse`} title={title}>
        {glyph}
      </span>
    )
  return (
    <span key="pending" className={`${base} border border-white/15 text-t2`} title={title}>
      {glyph}
    </span>
  )
}

function Checks({ checks }: { checks: import('../state/types').Check[] }) {
  const [open, setOpen] = useState(false)
  const bad = checks.filter((c) => !c.ok)
  const shown = open ? checks : bad
  return (
    <div className={`glass-card agent-card px-3.5 py-2.5 ${bad.length ? 'tint-red' : ''}`}>
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        <span className={`h-2 w-2 rounded-full transition-colors duration-300 ${bad.length ? 'bg-haven-danger haven-ring' : 'bg-haven-safe'}`} />
        <span key={bad.length} className={`fade-swap text-[13px] font-semibold ${bad.length ? 'text-haven-danger' : 'text-t1'}`}>
          {bad.length ? `${bad.length} violation${bad.length === 1 ? '' : 's'}` : `${checks.length} checks pass`}
        </span>
        <span className="label ml-1">checker agent · verified against the facts, not against who spoke</span>
        <span className="mono ml-auto text-[10px] text-t3">{open ? 'hide' : 'show all'}</span>
      </button>
      <div className={`reveal ${shown.length > 0 ? 'is-open' : ''}`}>
        <div>
          <ul className="mt-2 space-y-1">
            {shown.map((c) => (
              <li key={c.code} className="enter flex items-start gap-2 text-[11px]">
                <span className={`mono mt-px w-3 shrink-0 text-center ${c.ok ? 'text-haven-safe' : 'text-haven-danger'}`}>{c.ok ? '✓' : '✕'}</span>
                <span className={c.ok ? 'text-t2' : 'text-t1'}>
                  {c.label}
                  <span className="text-t3"> · {c.detail}</span>
                </span>
                <span className="pill ml-auto shrink-0">{c.severity}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function BriefButton() {
  const [state, setState] = useState<'idle' | 'loading' | 'speaking'>('idle')
  const [source, setSource] = useState<string | null>(null)
  const run = async () => {
    if (state === 'speaking') {
      stopSpeaking()
      setState('idle')
      return
    }
    setState('loading')
    try {
      const b = await api.brief()
      setSource(b.source)
      setState('speaking')
      const via = await speak(b.text)
      setSource(`${b.source} · ${via}`)
    } finally {
      setTimeout(() => setState('idle'), 1500)
    }
  }
  return (
    <div className="mt-2 flex items-center gap-2">
      <button className="btn-secondary btn-sm" onClick={run} disabled={state === 'loading'}>
        {state === 'speaking' ? '■ Stop' : state === 'loading' ? '…' : '▶ Brief me'}
      </button>
      {source && <span className="mono text-[10px] text-t3">{source}</span>}
    </div>
  )
}
