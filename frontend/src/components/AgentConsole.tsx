import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useBuilding } from '../state/building'
import type { FetchAgent, FetchStatus, NegotiationStatus, Stance, StanceKind, WorldState } from '../state/types'

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

const STANCE_PILL: Record<StanceKind, string> = {
  propose: 'pill-blue',
  support: 'pill-green',
  critique: 'pill-amber',
  veto: 'pill-red',
}

/** One card per agent in the negotiation. Toggling a card is an input event to the world. */
export function AgentConsole({ world }: Props) {
  const roster = useBuilding((b) => b.residents)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stances = new Map<string, Stance>()
  for (const s of world.plan.stances) stances.set(s.agent, s)

  // The residents' agents hosted on Fetch.ai: polled when the plan version changes (their replies
  // arrive a moment after the plan does), never part of the world state.
  const [fetchStatus, setFetchStatus] = useState<FetchStatus | null>(null)
  useEffect(() => {
    let alive = true
    let tries = 0
    const poll = () => {
      api
        .fetchStatus()
        .then((s) => {
          if (!alive) return
          setFetchStatus(s)
          const hosted = s.agents.filter((a) => a.enabled).length
          if (s.running && s.received < 2 * hosted && tries++ < 8) setTimeout(poll, 700)
        })
        .catch(() => {})
    }
    poll()
    return () => {
      alive = false
    }
  }, [world.plan.version])
  const fetchAgents = new Map<string, FetchAgent>()
  for (const a of fetchStatus?.agents ?? []) fetchAgents.set(a.id, a)

  // Who is still reasoning (a model in the loop) for the current situation; the rule function speaks meanwhile.
  const [negotiation, setNegotiation] = useState<NegotiationStatus | null>(null)
  useEffect(() => {
    let alive = true
    let tries = 0
    const poll = () => {
      api
        .negotiation()
        .then((n) => {
          if (!alive) return
          setNegotiation(n)
          if (n.mode === 'claude' && n.pending.length > 0 && tries++ < 40) setTimeout(poll, 800)
        })
        .catch(() => {})
    }
    poll()
    return () => {
      alive = false
    }
  }, [world.plan.version, world.plan.situation])
  const thinking = new Set((negotiation?.pending ?? []).map((p) => p.split('#')[0]))

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

  // Display order drives the stagger when a new plan version lands.
  let order = 0
  const card = (id: string, prominent = false) => (
    <AgentCard
      key={id}
      id={id}
      index={order++}
      version={world.plan.version}
      label={labelFor(id)}
      blurb={storyFor(id)}
      enabled={world.agents[id] ?? false}
      stance={stances.get(id)}
      prominent={prominent}
      replay={world.mode === 'replay'}
      onToggle={(on) => toggle(id, on)}
      hosted={fetchStatus?.running ? fetchAgents.get(id) : undefined}
      hostedOn={fetchStatus?.hosted}
      thinking={thinking.has(id)}
    />
  )

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-hidden">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Agents · who speaks in the negotiation</span>
        <span className="mono text-[10px] text-t3">
          {negotiation && (
            <span className={`mr-2 ${negotiation.mode === 'claude' ? 'text-haven-purple' : 'text-t3'}`} title={negotiation.mode === 'claude' ? 'Agents reason with Claude; every stance is a logged input event' : 'No model key: the rule functions speak (set ANTHROPIC_API_KEY)'}>
              {negotiation.mode === 'claude' ? `claude · ${negotiation.answered} spoke` : 'rules'}
              {negotiation.pending.length > 0 ? ` · ${negotiation.pending.length} thinking` : ''}
            </span>
          )}
          {fetchStatus?.running && (
            <span className="mr-2 text-haven-blue" title={`HAVEN's table on Fetch.ai: ${fetchStatus.table ?? ''}`}>
              fetch.ai {fetchStatus.hosted} · {fetchStatus.agreeing}/{fetchStatus.received} confirmed
            </span>
          )}
          {world.plan.enabled_agents.length}/{agentIds.length} on
        </span>
      </div>
      {error && <p className="text-[11px] text-haven-danger">{error}</p>}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {SPECIALISTS.filter((id) => id in world.agents).map((id) => card(id))}
        <div className="eyebrow pt-2">Personal agents</div>
        {storyIds.map((id) => card(id, id === 'resident:maya'))}
        {rest.length > 0 && (
          <button onClick={() => setShowAll((v) => !v)} className="btn-secondary btn-sm w-full">
            {showAll ? 'Hide' : 'Show'} {rest.length} more personal agents
          </button>
        )}
        {showAll && rest.map((id) => card(id))}
      </div>
    </div>
  )
}

function AgentCard({
  id,
  index,
  version,
  label,
  blurb,
  enabled,
  stance,
  prominent,
  replay,
  onToggle,
  hosted,
  hostedOn,
  thinking,
}: {
  id: string
  index: number
  version: number
  label: string
  blurb: string | null
  enabled: boolean
  stance: Stance | undefined
  prominent: boolean
  replay: boolean
  onToggle: (on: boolean) => void
  hosted?: FetchAgent
  hostedOn?: 'local' | 'agentverse'
  thinking?: boolean
}) {
  // Shake and glow the card the first time a veto appears on it.
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

  // A new plan version pops every stance pill in display order (60 ms stagger).
  const [popKey, setPopKey] = useState(0)
  const prevVersion = useRef(version)
  useEffect(() => {
    if (version !== prevVersion.current) {
      prevVersion.current = version
      setPopKey((k) => k + 1)
    }
  }, [version])

  const veto = enabled && stance?.stance === 'veto'
  const edge = prominent
    ? enabled
      ? 'inset 3px 0 0 #0a84ff, 0 10px 30px rgba(10,132,255,0.10)'
      : 'inset 3px 0 0 #6e6e73, 0 0 0 rgba(0,0,0,0)'
    : undefined

  return (
    <div
      data-buds={`agent:${id}`}
      className={`agent-card glass-card relative ${prominent ? 'p-3.5' : 'p-3'} ${!enabled ? 'opacity-45' : ''} ${shake ? 'haven-shake veto-glow' : ''} ${veto ? 'tint-red' : ''}`}
      style={edge ? { boxShadow: edge } : undefined}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full transition-colors duration-300 ${enabled ? 'bg-haven-safe' : 'bg-t3'}`}
          style={enabled ? { boxShadow: '0 0 8px rgba(48,209,88,0.5)' } : undefined}
        />
        <span className={`font-semibold ${prominent ? 'text-[15px] text-t1' : 'text-[13px] text-t1'}`}>{label}</span>
        {prominent && (enabled ? <span className="pill pill-blue">the Maya moment</span> : <span className="pill fade-swap">silenced</span>)}
        <label className="switch ml-auto" title={`${id}: ${enabled ? 'in' : 'out of'} the negotiation`}>
          <input type="checkbox" checked={enabled} disabled={replay} onChange={(e) => onToggle(e.target.checked)} />
          <span className="track" />
          <span className="knob" />
        </label>
      </div>
      {blurb && <p className={`mt-1.5 ${prominent ? 'text-[12px] text-t2' : 'text-[11px] text-t3'}`}>{blurb}</p>}
      {!enabled ? (
        <p className="fade-swap mt-2 text-[11px] text-t3">Not in the negotiation · nobody speaks for this constraint</p>
      ) : stance ? (
        <div className="mt-2">
          <div className="flex items-start gap-2">
            <span key={popKey} className={`pill ${STANCE_PILL[stance.stance]} pop shrink-0`} style={{ animationDelay: `${index * 60}ms` }}>
              {stance.stance}
            </span>
            <span className="text-[11px] leading-snug text-t1">{stance.reason}</span>
          </div>
          <div className="mono mt-1 flex items-center gap-1.5 text-[9px] text-t3">
            <span className={`pill ${stance.source && stance.source !== 'rules' ? 'pill-purple' : ''}`} title={stance.source === 'fetch:claude' ? 'Reasoned with Claude inside this resident\'s Fetch.ai agent; signed; logged as an input event' : stance.source === 'claude' ? 'Reasoned with Claude; logged as an input event' : 'The deterministic rule function (no model, or the model has not answered yet)'}>
              {stance.source === 'fetch:claude' ? 'claude via fetch.ai' : stance.source === 'claude' ? 'claude' : 'rules'}
            </span>
            {thinking && <span className="text-haven-purple haven-pulse">reasoning…</span>}
          </div>
          {stance.constraint && (
            <div className="mt-1.5 flex items-start gap-1.5 text-[10px] text-t3">
              <span className={`pill ${stance.constraint.type === 'hard' ? 'pill-red' : ''} shrink-0`}>{stance.constraint.type}</span>
              <span className="pt-px">{stance.constraint.rule}</span>
            </div>
          )}
          <Explain agent={id} version={version} />
          {hosted && <FetchBadge agent={hosted} hostedOn={hostedOn} />}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-t3">Listening · nothing to say yet</p>
      )}
    </div>
  )
}


/** This resident's agent on Fetch.ai: its address, and whether what it said on the network matches the plan. */
function FetchBadge({ agent, hostedOn }: { agent: FetchAgent; hostedOn?: 'local' | 'agentverse' }) {
  const r2 = agent.receipts['2'] ?? agent.receipts['1']
  const short = `${agent.address.slice(0, 10)}…${agent.address.slice(-4)}`
  return (
    <div className="mono mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px] text-t3" title={agent.address}>
      <span className="pill pill-blue">fetch.ai</span>
      <span>{short}</span>
      {r2 ? (
        <span className={r2.verified && r2.agrees ? 'text-haven-safe' : 'text-haven-amber'}>
          {r2.verified && r2.agrees ? `✓ said ${r2.stance} on the network` : `said ${r2.stance}${r2.verified ? '' : ' (unverified)'}`}
        </span>
      ) : (
        <span>awaiting its reply…</span>
      )}
      {hostedOn === 'agentverse' && <span className="text-t3">· agentverse</span>}
    </div>
  )
}

/** The agent in its own words: Claude paraphrases the stance when a key is set, a template otherwise. */
function Explain({ agent, version }: { agent: string; version: number }) {
  const [text, setText] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const seen = useRef(version)
  useEffect(() => {
    if (seen.current !== version) {
      seen.current = version
      setText(null)
      setSource(null)
    }
  }, [version])
  const ask = async () => {
    setBusy(true)
    try {
      const r = await api.explain(agent)
      setText(r.text)
      setSource(r.source)
    } catch {
      setText(null)
    } finally {
      setBusy(false)
    }
  }
  if (text) {
    return (
      <div className="enter mt-2 rounded-[10px] bg-white/[0.04] px-2.5 py-2 text-[11px] leading-snug text-t1">
        <span className="text-t2">“</span>
        {text}
        <span className="text-t2">”</span>
        <span className="mono ml-2 text-[9px] text-t3">{source === 'llm' ? 'claude' : 'template'}</span>
      </div>
    )
  }
  return (
    <button className="mt-1.5 text-[10px] text-haven-blue hover:underline disabled:opacity-40" onClick={ask} disabled={busy}>
      {busy ? '…' : 'Explain'}
    </button>
  )
}
