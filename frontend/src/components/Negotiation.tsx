import { api } from '../lib/api'
import { useBuilding } from '../state/building'
import type { Check, Stance, StanceKind, WorldState } from '../state/types'

/**
 * Two readings of the same plan, both derived from `plan.rounds` and `plan.checks`:
 * - Transcript: the negotiation as it happened. Round 1's proposal, every agent's stance on it as a
 *   bubble (with where it came from: the rule function, Claude, or Claude inside the agent's Fetch.ai
 *   identity), the revised proposal, round 2, and the checker's verdict.
 * - Constraints: the hard rules the optimiser cannot buy its way out of, who demanded each one, and
 *   whether the final plan holds it. This is the "constitutionally incapable of leaving someone behind"
 *   proof, as a ledger.
 */

const STANCE_PILL: Record<StanceKind, string> = { propose: 'pill-blue', support: 'pill-green', critique: 'pill-amber', veto: 'pill-red' }
const STANCE_VERB: Record<StanceKind, string> = { propose: 'proposes', support: 'supports', critique: 'wants a change', veto: 'vetoes' }

function Source({ s }: { s: Stance }) {
  const src = s.source ?? 'rules'
  const label = src === 'fetch:claude' ? 'claude · via fetch.ai' : src === 'claude' ? 'claude' : 'rules'
  const title = src === 'fetch:claude' ? "Reasoned with Claude inside this resident's Fetch.ai agent, signed, logged as an input event" : src === 'claude' ? 'Reasoned with Claude, logged as an input event' : 'The deterministic rule function'
  return (
    <span className={`pill ${src !== 'rules' ? 'pill-purple' : ''}`} title={title}>
      {label}
    </span>
  )
}

export function Transcript({ world }: { world: WorldState }) {
  const plan = world.approved_plan ?? world.plan
  if (plan.status === 'none' || plan.rounds.length === 0) {
    return <div className="glass-card px-3 py-6 text-center text-[12px] text-t3">No negotiation yet. It starts the moment the chain is forecast.</div>
  }
  const off = Object.entries(world.agents).filter(([, on]) => !on).map(([a]) => a)
  return (
    <ol className="space-y-3">
      {plan.rounds.map((r) => (
        <li key={r.n} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="mono text-[10px] text-t3">round {r.n}</span>
            <span className="text-[12px] font-semibold text-t1">{r.title}</span>
            <span className={`pill ml-auto ${r.feasible ? 'pill-green' : 'pill-red'}`}>{r.feasible ? 'feasible' : 'vetoed'}</span>
          </div>
          <div className="glass-card px-3 py-2 text-[11px] text-t2">
            <span className="eyebrow mr-2">{r.n === 1 ? 'on the table' : 'revised'}</span>
            {r.steps.slice(0, 5).map((s) => s.title).join(' · ')}
            {r.steps.length > 5 ? ` · +${r.steps.length - 5} more` : ''}
          </div>
          <ul className="space-y-1.5">
            {r.stances.map((s, i) => {
              const veto = s.stance === 'veto'
              return (
                <li key={`${s.agent}-${i}`} className={`bubble ${veto ? 'is-veto' : s.stance === 'support' ? 'is-support' : ''}`} data-buds={`agent:${s.agent}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-semibold text-t1">{s.label}</span>
                    <span className={`pill ${STANCE_PILL[s.stance]}`}>{STANCE_VERB[s.stance]}</span>
                    <span className="ml-auto">
                      <Source s={s} />
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] leading-snug text-t1">{s.reason}</p>
                  {s.constraint && (
                    <p className="mono mt-1 text-[10px] text-t3">
                      {s.constraint.type} · {s.constraint.rule}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          {r.n === 1 && off.length > 0 && (
            <div className="bubble is-silent">
              <span className="text-[12px] font-semibold text-t2">{off.length === 1 ? 'One agent is silent' : `${off.length} agents are silent`}</span>
              <p className="mt-0.5 text-[11px] text-t3">
                {off.slice(0, 3).map((a) => a.replace('resident:', '')).join(', ')}
                {off.length > 3 ? ` +${off.length - 3}` : ''} switched off: nobody speaks for their constraints.
                {plan.left_behind.length > 0 ? ` Left behind: ${plan.left_behind.join(', ')}.` : ''}
              </p>
            </div>
          )}
        </li>
      ))}
      {(
        <li className={`glass-card px-3 py-2 ${plan.left_behind.length || Number(plan.metrics.violations ?? 0) ? 'tint-red' : 'tint-green'}`}>
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-t1">Outcome</span>
            <span className="mono ml-auto text-[10px] text-t3">v{plan.version}</span>
          </div>
          <p className="mt-0.5 text-[12px] text-t1">{plan.headline}</p>
        </li>
      )}
    </ol>
  )
}

export function Constraints({ world }: { world: WorldState }) {
  const plan = world.approved_plan ?? world.plan
  const roster = useBuilding((b) => b.residents)
  if (plan.status === 'none') {
    return <div className="glass-card px-3 py-6 text-center text-[12px] text-t3">No constraints in play until there is an incident.</div>
  }
  // Every hard constraint an enabled agent demanded, with the step that satisfies it; then the checker's own verdicts.
  const demanded = new Map<string, { s: Stance; satisfied: string[] }>()
  for (const r of plan.rounds)
    for (const s of r.stances)
      if (s.constraint?.type === 'hard' && s.agent !== 'checker')
        demanded.set(s.constraint.code || s.agent, { s, satisfied: plan.steps.filter((st) => st.satisfies.includes(s.agent)).map((st) => st.title) })
  const silent = Object.entries(world.agents)
    .filter(([a, on]) => !on && a.startsWith('resident:'))
    .map(([a]) => a.replace('resident:', ''))
  const byCode = new Map<string, Check>(plan.checks.map((c) => [c.code, c]))
  return (
    <div className="space-y-3">
      <div>
        <div className="eyebrow mb-1.5">Hard constraints · demanded by the agents</div>
        <ul className="space-y-1.5">
          {[...demanded.values()].map(({ s, satisfied }) => {
            const ok = satisfied.length > 0 || s.stance === 'support'
            return (
              <li key={s.agent + (s.constraint?.code ?? '')} className={`glass-card flex items-start gap-2 px-3 py-2 ${ok ? '' : 'tint-red'}`} data-buds={`agent:${s.agent}`}>
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-haven-safe' : 'bg-haven-danger haven-ring'}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-t1">{s.constraint?.rule}</div>
                  <div className="mt-0.5 text-[11px] text-t2">
                    {s.label} · {ok ? (satisfied[0] ? `held by: ${satisfied[0]}` : 'holds') : 'not satisfied by this plan'}
                  </div>
                </div>
                <span className={`pill ${ok ? 'pill-green' : 'pill-red'}`}>{ok ? 'holds' : 'open'}</span>
              </li>
            )
          })}
          {silent.map((rid) => (
            <li key={rid} className="glass-card tint-amber flex items-start gap-2 px-3 py-2" data-buds={`agent:resident:${rid}`}>
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-haven-amber" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-t1">{roster[rid]?.name ?? rid}'s needs</div>
                <div className="mt-0.5 text-[11px] text-t2">Their agent is off: nobody demanded anything for them{plan.left_behind.includes(rid) ? ' and the plan leaves them behind' : ''}.</div>
              </div>
              <button className="btn-secondary btn-sm" onClick={() => api.toggleAgent(`resident:${rid}`, true).catch(() => {})}>
                Switch on
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="eyebrow mb-1.5">Checker · verified against the facts, whoever spoke</div>
        <ul className="space-y-1">
          {plan.checks.map((c) => {
            const same = byCode.get(c.code)
            return (
              <li key={c.code} className="flex items-start gap-2 text-[11px]">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${c.ok ? 'bg-haven-safe' : 'bg-haven-danger'}`} />
                <span className={c.ok ? 'text-t2' : 'font-medium text-haven-danger'}>
                  {c.label}
                  {c.detail ? <span className="text-t3"> · {c.detail}</span> : null}
                </span>
                <span className={`pill ml-auto shrink-0 ${same?.severity === 'safety' ? 'pill-red' : same?.severity === 'access' ? 'pill-purple' : ''}`}>{c.severity}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
