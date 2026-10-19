import { useState } from 'react'
import { ArrowRight, Check, Droplets, Fuel, LayoutGrid, Zap } from 'lucide-react'
import { api, formatCountdown } from '../lib/api'
import { useBuilding } from '../state/building'
import type { Clock, WorldState } from '../state/types'
import { useWorld } from '../state/world'

/**
 * The calm view: one glass card for someone who is not an engineer. What is happening, what it puts at
 * risk, what HAVEN recommends, and one thing to do. Every sentence comes from the backend's narrative;
 * nothing here is typed in. Everything else (the plan's steps, the agents, the messages, the levers) is a
 * tap away under Details, never in the way.
 */
export function CalmView({ world, clock, onDetails, onOps, onDrill }: { world: WorldState; clock: Clock; onDetails: () => void; onOps: () => void; onDrill: (kind: 'flood' | 'grid' | 'generator') => void }) {
  const n = world.narrative
  const heroId = useBuilding((b) => b.heroId)
  const residents = useBuilding((b) => b.residents)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const heroAgent = heroId ? `resident:${heroId}` : null
  const heroOn = heroAgent && heroAgent in world.agents ? world.agents[heroAgent] : undefined
  const heroName = heroId ? (residents[heroId]?.name.split(' ')[0] ?? heroId) : null
  const live = world.plan
  const approved = world.approved_plan
  const quiet = n.stage === 'quiet'
  const done = approved?.status === 'done'
  const replay = world.mode === 'replay'
  const leftBehind = live.left_behind.length
  const remaining = n.contact_at_s != null ? n.contact_at_s - clock.sim_time : null
  const steps = approved?.steps.length ?? 0
  const doneSteps = approved ? approved.steps.filter((s) => world.actions[s.id]?.status === 'done').length : 0

  const act = (fn: () => Promise<unknown>) => () => {
    setError(null)
    setBusy(true)
    fn()
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  const approve = act(() => api.decidePlan(useWorld.getState().world?.plan.version ?? live.version, 'approve'))

  // The risk, as three soft facts. Only the ones that mean something right now.
  const facts: { v: string; k: string; tone?: 'hot' | 'warm' | 'ok' }[] = []
  if (!quiet && !done) {
    if (remaining != null && n.contact_name) facts.push({ v: remaining > 0 ? formatCountdown(remaining) : 'now', k: `until water reaches ${n.contact_name}`, tone: remaining < 300 ? 'hot' : 'warm' })
    if (n.affected_if_nothing_done) facts.push({ v: String(n.affected_if_nothing_done), k: 'people affected if nobody acts', tone: 'warm' })
    facts.push({ v: String(leftBehind), k: leftBehind ? 'left behind by this plan' : 'left behind', tone: leftBehind ? 'hot' : 'ok' })
  }

  return (
    <div className="calm" data-buds="panel:story">
      <div className="lg lg-hover calm-card enter" data-dock>
        <div className="calm-eyebrow">
          <span className={`calm-dot ${quiet ? 'is-calm' : done ? 'is-ok' : approved ? 'is-acting' : 'is-hot'}`} />
          {quiet ? 'All quiet' : done ? 'Resolved' : approved ? 'HAVEN is acting' : 'Incident'}
          <span className="calm-time">{formatClock(clock.time_of_day)}</span>
        </div>

        <h1 key={n.headline} className="calm-headline fade-swap">
          {n.headline}
        </h1>
        {n.detail && <p className="calm-detail">{n.detail}</p>}

        {facts.length > 0 && (
          <div className="calm-facts">
            {facts.map((f) => (
              <div key={f.k} className={`calm-fact ${f.tone ? `is-${f.tone}` : ''}`}>
                <span className="calm-fact-v">{f.v}</span>
                <span className="calm-fact-k">{f.k}</span>
              </div>
            ))}
          </div>
        )}

        {!quiet && !done && n.next && (
          <div className="calm-reco">
            <span className="calm-reco-k">{approved ? 'Progress' : 'Recommendation'}</span>
            <p key={n.next} className="calm-reco-v fade-swap">
              {n.next.replace(/^The agents propose: /, '')}
            </p>
            {approved && steps > 0 && (
              <div className="progress mt-2">
                <span style={{ width: `${(doneSteps / steps) * 100}%` }} />
              </div>
            )}
          </div>
        )}
        {done && approved && (
          <div className="calm-reco">
            <span className="calm-reco-k">Outcome</span>
            <p className="calm-reco-v">
              {approved.metrics.relocated ?? 0} relocated, {approved.metrics.escorted ?? 0} escorted by lift, {approved.left_behind.length} left behind, {approved.metrics.violations ?? 0} rules broken.
            </p>
          </div>
        )}

        <div className="calm-actions">
          {quiet ? (
            <>
              <button className="btn-hero" disabled={replay} onClick={() => onDrill('flood')}>
                <Droplets className="h-4 w-4" /> Run a flood drill
              </button>
              <button className="btn-quiet" disabled={replay} onClick={() => onDrill('grid')} title="The grid feed fails; the generator carries the lifts">
                <Zap className="h-3.5 w-3.5" /> Grid outage
              </button>
              <button className="btn-quiet" disabled={replay} onClick={() => onDrill('generator')} title="The standby generator trips">
                <Fuel className="h-3.5 w-3.5" /> Generator trips
              </button>
            </>
          ) : done ? (
            <button className="btn-hero" disabled={replay || busy} onClick={act(api.reset)}>
              <Check className="h-4 w-4" /> Close the incident
            </button>
          ) : approved ? (
            <button className="btn-hero" onClick={onDetails}>
              Watch the steps <ArrowRight className="h-4 w-4" />
            </button>
          ) : (
            <button className="btn-hero" disabled={replay || busy || live.status !== 'draft'} onClick={approve} data-buds="panel:approve">
              {leftBehind ? `Approve anyway, ${leftBehind} left behind` : 'Approve the plan'} <ArrowRight className="h-4 w-4" />
            </button>
          )}
          <button className="btn-quiet ml-auto" onClick={onDetails} title="The plan step by step, every agent, the messages, the levers">
            <LayoutGrid className="h-3.5 w-3.5" /> Details
          </button>
        </div>
        {error && <p className="mt-2 text-[12px] text-haven-danger">{error}</p>}

        {!quiet && heroAgent && heroName && heroOn !== undefined && (
          <label className="calm-switch" title={heroOn ? `${heroName}'s own agent speaks in the negotiation. Switch it off and nobody speaks for ${heroName}.` : `Nobody is speaking for ${heroName}. Switch the agent back on.`} data-buds={`agent:${heroAgent}`}>
            <span className="switch">
              <input type="checkbox" checked={heroOn} disabled={replay} onChange={(e) => api.toggleAgent(heroAgent, e.target.checked).catch((er: Error) => setError(er.message))} />
              <span className="track" />
              <span className="knob" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-t1">{heroName}'s agent {heroOn ? 'is speaking for them' : 'is off'}</span>
              <span className="block text-[11.5px] text-t3">{heroOn ? `Switch it off to see what the plan does without ${heroName}'s voice.` : `Nobody speaks for ${heroName}. ${n.ask}`}</span>
            </span>
          </label>
        )}
        {quiet && (
          <button className="calm-link" onClick={onOps}>
            Energy, plant health and the resilience audit <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function formatClock(seconds: number): string {
  const s = Math.floor(seconds) % 86400
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`
}
