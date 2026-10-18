import { formatCountdown } from '../lib/api'
import type { Clock, WorldState } from '../state/types'

/**
 * Where the system is in the story, read straight off the world: the sensor, the traced chain, the
 * negotiation, the manager's rules, the approval, execution, done. Each stage is lit by a fact in the
 * state, never by a timer, so the rail never lies about what has happened.
 */

type Stage = { id: string; label: string; on: boolean; now: boolean; note: string }

export function stages(world: WorldState, clock: Clock): Stage[] {
  const wet = !!world.sensors['basement_mech_1']?.wet || world.wet_spaces.length > 0
  const traced = world.forecast.events.length > 0
  const plan = world.plan
  const negotiated = plan.status !== 'none' && plan.rounds.length > 0
  const governed = world.rules.length > 0
  const approved = world.approved_plan != null
  const actions = Object.values(world.actions)
  const acting = actions.length > 0
  const done = world.approved_plan?.status === 'done'
  const contact = world.forecast.events.find((e) => e.kind === 'flooded' || e.kind === 'lifts_down')
  const contactIn = contact ? Math.max(0, world.forecast.computed_step * clock.dt + contact.eta_s - clock.sim_time) : null
  const modelStances = plan.stances.filter((s) => s.source && s.source !== 'rules').length
  const vetoes = plan.rounds[0]?.stances.filter((s) => s.stance === 'veto').length ?? 0
  const doneSteps = actions.filter((a) => a.status === 'done').length
  const out: Stage[] = [
    { id: 'detect', label: 'Detect', on: wet, now: false, note: wet ? `${world.sensors['basement_mech_1']?.source ?? 'sensor'} reading · water in the basement` : 'a $4 probe in the basement' },
    { id: 'trace', label: 'Trace', on: traced, now: false, note: traced ? `${world.forecast.events.length} consequences forecast${contactIn != null ? ` · contact in ${formatCountdown(contactIn)}` : ''}` : 'one dependency graph' },
    { id: 'negotiate', label: 'Negotiate', on: negotiated, now: false, note: negotiated ? `${plan.enabled_agents.length} agents · ${vetoes} veto${vetoes === 1 ? '' : 'es'} in round 1${modelStances ? ` · ${modelStances} reasoned by Claude` : ''}` : 'specialists + one agent per resident' },
    { id: 'govern', label: 'Govern', on: governed, now: false, note: governed ? world.rules.map((r) => r.rule).join(' · ') : 'say a rule; every agent re-plans' },
    { id: 'approve', label: 'Approve', on: approved, now: false, note: approved ? `plan v${world.approved_plan?.version} approved` : negotiated ? `plan v${plan.version} waiting for a human` : 'nothing fires without a human' },
    { id: 'act', label: 'Act', on: acting, now: false, note: acting ? `${doneSteps} of ${world.approved_plan?.steps.length ?? 0} steps done` : 'plumber, breakers, escorts, messages' },
    { id: 'done', label: 'Done', on: !!done, now: false, note: done ? `${plan.left_behind.length} left behind · ${Number(world.approved_plan?.metrics.violations ?? 0)} violations` : 'nobody left behind' },
  ]
  const last = [...out].reverse().find((s) => s.on)
  if (last && !done) last.now = true
  else if (!last) out[0].now = true
  return out
}

export function Lifecycle({ world, clock }: { world: WorldState; clock: Clock }) {
  const list = stages(world, clock)
  const current = list.find((s) => s.now) ?? list[list.length - 1]
  return (
    <div className="glass-card flex items-stretch overflow-hidden" data-buds="panel:lifecycle" title="Where the system is in the story, read from the world state">
      <ol className="flex items-center gap-0.5 px-2 py-1.5">
        {list.map((s, i) => (
          <li key={s.id} className="flex items-center">
            <span
              className={`rail-step ${s.on ? 'is-on' : ''} ${s.now ? 'is-now' : ''}`}
              title={s.note}
            >
              <i />
              {s.label}
            </span>
            {i < list.length - 1 && <span className={`rail-link ${list[i + 1].on ? 'is-on' : ''}`} />}
          </li>
        ))}
      </ol>
      <div className="hairline-l flex min-w-0 items-center gap-2 px-3 text-[11px]">
        <span className="shrink-0 font-semibold text-t1">{current.label}</span>
        <span className="truncate text-t2" title={current.note}>
          {current.note}
        </span>
      </div>
    </div>
  )
}
