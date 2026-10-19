import { useEffect, useState } from 'react'
import { api, formatCountdown } from '../lib/api'
import { useBuilding } from '../state/building'
import type { Clock, IncidentMemory, WorldState } from '../state/types'
import { useWorld } from '../state/world'
import { stages } from './Lifecycle'

/**
 * The story strip: what is happening, what it means, what HAVEN proposes and what the person at this
 * screen should do, in the backend's own words (world.narrative, a derived view every surface shares).
 * The two controls the demo turns on live here as well: the first named resident's agent (the Maya
 * moment) and Approve. Numbers are facts with their meaning spelled out, never bare.
 */
export function StoryStrip({ world, clock }: { world: WorldState; clock: Clock }) {
  const n = world.narrative
  const heroId = useBuilding((b) => b.heroId)
  const residents = useBuilding((b) => b.residents)
  const [error, setError] = useState<string | null>(null)
  // Cross-incident memory: how this incident compares with the last one, and what is remembered on a quiet night.
  const done = world.approved_plan?.status === 'done'
  const [memory, setMemory] = useState<IncidentMemory | null>(null)
  useEffect(() => {
    if (world.mode !== 'live' && !done) return
    api.incidents().then(setMemory).catch(() => {})
  }, [done, world.run_id, world.mode])
  const remembered = (() => {
    if (!memory) return null
    if (done && memory.current) {
      const c = memory.comparison
      if (!c) return 'First incident remembered: the next one will be compared with it.'
      const faster = c.minutes_faster >= 0 ? `${c.minutes_faster} min faster` : `${-c.minutes_faster} min slower`
      return `${faster} than the last incident, ${c.left_behind_delta <= 0 ? 'nobody more' : `${c.left_behind_delta} more`} left behind.`
    }
    if (n.stage === 'quiet' && memory.incidents.length > 0) {
      const last = memory.incidents[0]
      return `${memory.incidents.length} earlier incident${memory.incidents.length === 1 ? '' : 's'} remembered; the last took ${last.minutes_to_done} min from drip to done${last.rules.length ? ` under the rule "${last.rules[0].replace(/_/g, ' ')}"` : ''}.`
    }
    return null
  })()
  const heroAgent = heroId ? `resident:${heroId}` : null
  const heroOn = heroAgent && heroAgent in world.agents ? world.agents[heroAgent] : undefined
  const heroName = heroId ? (residents[heroId]?.name.split(' ')[0] ?? heroId) : null
  const live = world.plan
  const shown = world.approved_plan ?? live
  const incident = shown.status !== 'none'
  const replay = world.mode === 'replay'
  const leftBehind = live.left_behind.length
  const violations = Number(shown.metrics.violations ?? 0)
  const remaining = n.contact_at_s != null ? n.contact_at_s - clock.sim_time : null
  const list = stages(world, clock)
  const act = (fn: () => Promise<unknown>) => () => {
    setError(null)
    fn().catch((e: Error) => setError(e.message))
  }

  return (
    <div className="story" data-buds="panel:story">
      <div className="min-w-0">
        <ol className="story-stage" aria-label="Where the system is">
          {list.map((s, i) => (
            <li key={s.id} className="flex items-center">
              <span className={`rail-step ${s.on ? 'is-on' : ''} ${s.now ? 'is-now' : ''}`} title={s.note}>
                <i />
                {s.label}
              </span>
              {i < list.length - 1 && <span className={`rail-link ${list[i + 1].on ? 'is-on' : ''}`} />}
            </li>
          ))}
        </ol>
        <p key={n.headline} className="story-headline fade-swap" data-buds="panel:headline">
          {n.headline}
        </p>
        {n.detail && <p className="story-detail">{n.detail}</p>}
        {remembered && <p className="story-detail text-haven-purple">{remembered}</p>}
        {n.next && (
          <p key={n.next} className="story-next fade-swap">
            {leftBehind > 0 && !world.approved_plan ? <b className="text-haven-purple">{n.next}</b> : <b>{n.next}</b>}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {incident && !world.approved_plan && live.status === 'draft' && (
            <button className="btn-primary" disabled={replay} onClick={act(() => api.decidePlan(useWorld.getState().world?.plan.version ?? live.version, 'approve'))} data-buds="panel:approve">
              Approve plan v{live.version}
            </button>
          )}
          {incident && heroAgent && heroName && heroOn !== undefined && (
            <button
              className={`hero-switch ${heroOn ? '' : 'is-off'}`}
              disabled={replay}
              onClick={act(() => api.toggleAgent(heroAgent, !heroOn))}
              title={heroOn ? `${heroName}'s own agent is in the negotiation. Switch it off and nobody speaks for ${heroName}: watch the plan change.` : `Nobody is speaking for ${heroName}. Switch the agent back on.`}
              data-buds={`agent:${heroAgent}`}
            >
              <span className={`h-2 w-2 rounded-full ${heroOn ? 'bg-haven-safe' : 'bg-haven-purple'}`} />
              {heroOn ? `${heroName}'s agent is speaking · switch it off` : `${heroName}'s agent is off · switch it on`}
            </button>
          )}
          {n.ask && <span className="story-ask">{n.ask}</span>}
          {error && <span className="text-[11px] text-haven-danger">{error}</span>}
        </div>
      </div>
      {incident && (
        <div className="story-facts">
          {remaining != null && n.contact_name && (
            <Fact v={remaining > 0 ? formatCountdown(remaining) : 'now'} k={`until water reaches ${n.contact_name}`} tone={remaining < 300 ? 'hot' : 'warm'} live />
          )}
          <Fact v={n.affected_if_nothing_done} k="residents affected if nobody acts" tone={n.affected_if_nothing_done ? 'warm' : undefined} />
          <Fact v={n.affected_by_plan} k="people the plan moves or tells" />
          <Fact v={leftBehind} k="left behind by the plan" tone={leftBehind ? 'hot' : 'ok'} buds="panel:plan" />
          <Fact v={violations} k="hard rules broken" tone={violations ? 'hot' : 'ok'} />
        </div>
      )}
    </div>
  )
}

/** A number with its meaning. A value that changes on its own every second (a countdown) is not re-animated, or it would flicker. */
function Fact({ v, k, tone, buds, live }: { v: number | string; k: string; tone?: 'hot' | 'warm' | 'ok'; buds?: string; live?: boolean }) {
  return (
    <div className={`fact ${tone ? `is-${tone}` : ''}`} data-buds={buds}>
      <span key={live ? 'live' : String(v)} className={`fact-v ${live ? '' : 'fade-swap'}`}>
        {v}
      </span>
      <span className="fact-k">{k}</span>
    </div>
  )
}
