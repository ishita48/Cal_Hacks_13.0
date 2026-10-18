import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useBuilding } from '../state/building'
import type { Stance, StanceKind, WorldState } from '../state/types'

interface Props {
  world: WorldState
}

const SPECIALISTS = ['safety', 'housing', 'capacity']
const STORY = ['maya', 'dana', 'jordan', 'sam', 'lucia', 'theo', 'nora', 'ahmed', 'grace']
const SPECIALIST_LABEL: Record<string, string> = {
  safety: 'Safety agent',
  housing: 'Housing agent',
  capacity: 'Capacity agent',
}
const SPECIALIST_BLURB: Record<string, string> = {
  safety: 'Hard veto. De-energise before water contact; nobody in the basement.',
  housing: 'Who is affected and where they sleep tonight.',
  capacity: 'Does the overflow space actually fit the people sent to it?',
}

const STANCE_STYLE: Record<StanceKind, string> = {
  propose: 'border-haven-water/60 text-haven-water',
  support: 'border-haven-safe/60 text-haven-safe',
  critique: 'border-amber-400/60 text-amber-400',
  veto: 'border-haven-danger bg-haven-danger/15 text-haven-danger',
}

/** One card per agent in the negotiation. Toggling a card is an input event to the world. */
export function AgentConsole({ world }: Props) {
  const roster = useBuilding((b) => b.residents)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stances = new Map<string, Stance>()
  for (const s of world.plan.stances) stances.set(s.agent, s)

  const agentIds = Object.keys(world.agents)
  const storyIds = STORY.map((id) => `resident:${id}`).filter((id) => id in world.agents)
  const rest = agentIds.filter((id) => !SPECIALISTS.includes(id) && !storyIds.includes(id))

  const toggle = (agent: string, enabled: boolean) => {
    setError(null)
    api.toggleAgent(agent, enabled).catch((e: Error) => setError(e.message))
  }

  const labelFor = (id: string) => {
    if (SPECIALIST_LABEL[id]) return SPECIALIST_LABEL[id]
    const r = roster[id.replace('resident:', '')]
    return r ? `${r.name.split(' ')[0]}'s agent` : id
  }
  const storyFor = (id: string) => {
    if (SPECIALIST_BLURB[id]) return SPECIALIST_BLURB[id]
    const r = roster[id.replace('resident:', '')]
    if (!r) return null
    return r.story ?? `${r.name} · ${r.room} · ${r.presence.replace('_', ' ')}`
  }

  const card = (id: string, prominent = false) => (
    <AgentCard
      key={id}
      id={id}
      label={labelFor(id)}
      blurb={storyFor(id)}
      enabled={world.agents[id] ?? false}
      stance={stances.get(id)}
      prominent={prominent}
      replay={world.mode === 'replay'}
      onToggle={(on) => toggle(id, on)}
    />
  )

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Agents · who speaks in the negotiation</h2>
        <span className="font-mono text-[10px] text-slate-600">
          {world.plan.enabled_agents.length}/{agentIds.length} on
        </span>
      </div>
      {error && <p className="text-xs text-haven-danger">{error}</p>}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {SPECIALISTS.filter((id) => id in world.agents).map((id) => card(id))}
        <div className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Personal agents</div>
        {storyIds.map((id) => card(id, id === 'resident:maya'))}
        {rest.length > 0 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="w-full rounded border border-dashed border-ink-700 px-3 py-1.5 text-center text-[11px] text-slate-500 hover:bg-ink-800"
          >
            {showAll ? 'hide' : 'show'} {rest.length} more personal agents
          </button>
        )}
        {showAll && rest.map((id) => card(id))}
      </div>
    </div>
  )
}

function AgentCard({
  id,
  label,
  blurb,
  enabled,
  stance,
  prominent,
  replay,
  onToggle,
}: {
  id: string
  label: string
  blurb: string | null
  enabled: boolean
  stance: Stance | undefined
  prominent: boolean
  replay: boolean
  onToggle: (on: boolean) => void
}) {
  // Shake the card the first time a veto appears on it.
  const prevStance = useRef<StanceKind | null>(null)
  const [shake, setShake] = useState(false)
  useEffect(() => {
    const now = stance?.stance ?? null
    if (now === 'veto' && prevStance.current !== 'veto') {
      setShake(true)
      const t = setTimeout(() => setShake(false), 1100)
      return () => clearTimeout(t)
    }
    prevStance.current = now
  }, [stance?.stance])
  useEffect(() => {
    prevStance.current = stance?.stance ?? null
  })

  const border = !enabled
    ? 'border-ink-700'
    : stance?.stance === 'veto'
      ? 'border-haven-danger'
      : prominent
        ? 'border-slate-300/70'
        : 'border-ink-600'

  return (
    <div
      className={`rounded-lg border bg-ink-900 ${border} ${prominent ? 'p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_0_24px_rgba(59,167,255,0.12)]' : 'p-2.5'} ${!enabled ? 'opacity-55' : ''} ${shake ? 'haven-shake' : ''} transition-opacity`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${enabled ? 'bg-haven-safe' : 'bg-slate-600'}`} />
        <span className={`font-medium ${prominent ? 'text-base text-white' : 'text-sm text-slate-100'}`}>{label}</span>
        {prominent && <span className="rounded bg-haven-water/20 px-1.5 text-[9px] uppercase tracking-wider text-haven-water">the Maya moment</span>}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-400" title={`${id}: ${enabled ? 'in' : 'out of'} the negotiation`}>
          <span>{enabled ? 'on' : 'off'}</span>
          <span className={`relative inline-block h-4 w-7 rounded-full transition-colors ${enabled ? 'bg-haven-safe' : 'bg-ink-600'} ${replay ? 'opacity-40' : ''}`}>
            <input type="checkbox" className="peer sr-only" checked={enabled} disabled={replay} onChange={(e) => onToggle(e.target.checked)} />
            <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${enabled ? 'left-3.5' : 'left-0.5'}`} />
          </span>
        </label>
      </div>
      {blurb && <p className={`mt-1 ${prominent ? 'text-xs text-slate-300' : 'text-[11px] text-slate-500'}`}>{blurb}</p>}
      {!enabled ? (
        <p className="mt-1.5 text-[11px] italic text-slate-500">not in the negotiation — nobody speaks for this constraint</p>
      ) : stance ? (
        <div className="mt-1.5">
          <div className="flex items-start gap-2">
            <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${STANCE_STYLE[stance.stance]}`}>{stance.stance}</span>
            <span className="text-[11px] text-slate-300">{stance.reason}</span>
          </div>
          {stance.constraint && (
            <div className="mt-1 text-[10px] text-slate-500">
              <span className={`mr-1 rounded px-1 uppercase ${stance.constraint.type === 'hard' ? 'bg-haven-danger/20 text-haven-danger' : 'bg-ink-700 text-slate-400'}`}>{stance.constraint.type}</span>
              {stance.constraint.rule}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-slate-600">listening · nothing to say yet</p>
      )}
    </div>
  )
}
