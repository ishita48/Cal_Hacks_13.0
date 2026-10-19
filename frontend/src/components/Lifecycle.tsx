import { formatCountdown } from '../lib/api'
import type { Clock, WorldState } from '../state/types'

/**
 * Where the system is in the story, read straight off the world: the sensor, the traced chain, the
 * negotiation, the manager's rules, the approval, execution, done. Each stage is lit by a fact in the
 * state, never by a timer, so the rail never lies about what has happened. Rendered by the story strip.
 */

export type Stage = { id: string; label: string; on: boolean; now: boolean; note: string }

export function stages(world: WorldState, clock: Clock): Stage[] {
  const wetSensor = Object.entries(world.sensors).find(([, s]) => s.wet)
  const wet = !!wetSensor || world.wet_spaces.length > 0
  const traced = world.forecast.events.length > 0
  const plan = world.plan
  const negotiated = plan.status !== 'none' && plan.rounds.length > 0
  const governed = world.rules.length > 0
  const approved = world.approved_plan != null
  const actions = Object.values(world.actions)
  const acting = actions.length > 0
  const done = world.approved_plan?.status === 'done'
  const contact = world.narrative.contact_at_s
  const contactIn = contact != null ? Math.max(0, contact - clock.sim_time) : null
  const modelStances = plan.stances.filter((s) => s.source && s.source !== 'rules').length
  const vetoes = plan.rounds[0]?.stances.filter((s) => s.stance === 'veto').length ?? 0
  const doneSteps = actions.filter((a) => a.status === 'done').length
  const out: Stage[] = [
    { id: 'detect', label: 'Detect', on: wet, now: false, note: wet ? `${wetSensor?.[1].source ?? 'sensor'} reading from ${wetSensor?.[0] ?? 'the probe'}` : 'a $4 probe in the basement' },
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
