import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { Constraints, Transcript } from './Negotiation'
import { useBuilding } from '../state/building'
import type { AgentInfo, FetchAgent, FetchStatus, NegotiationStatus, Stance, StanceKind, WorldState } from '../state/types'

interface Props {
  world: WorldState
}

const STANCE_PILL: Record<StanceKind, string> = {
  propose: 'pill-blue',
  support: 'pill-green',
  critique: 'pill-amber',
  veto: 'pill-red',
}
const STANCE_WORD: Record<StanceKind, string> = { propose: 'proposes', support: 'supports the plan', critique: 'wants a change', veto: 'vetoes' }

/**
 * The society: who is in the negotiation and what each one says about the plan on the table.
 * The first named resident's agent comes first and large, because switching it off is the proof
 * that the structure matters (the Maya moment). Then the specialists, the other residents with a
 * need, everyone else folded into one line, and the two agents that are always on. Who the agents
 * are (label, description, kind) comes from the backend registry; what they say comes from the plan.
 */
export function AgentConsole({ world }: Props) {
  const roster = useBuilding((b) => b.residents)
  const registry = useBuilding((b) => b.agents)
  const storyIds = useBuilding((b) => b.storyIds)
  const heroId = useBuilding((b) => b.heroId)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'cards' | 'transcript' | 'constraints'>('cards')

  const stances = new Map<string, Stance>()
  for (const s of world.plan.stances) stances.set(s.agent, s)
  const round1 = new Map<string, Stance>()
  for (const s of world.plan.rounds[0]?.stances ?? []) round1.set(s.agent, s)

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
  const modelInLoop = negotiation?.mode === 'claude'

  const info = (id: string): AgentInfo => {
    const reg = registry[id]
    if (reg) return reg
    const rid = id.startsWith('resident:') ? id.slice('resident:'.length) : null
    const r = rid ? roster[rid] : undefined
    return {
      id,
      label: r ? `${r.name.split(' ')[0]}'s agent` : id,
      kind: rid ? 'resident' : id === 'checker' ? 'checker' : id === 'redteam' ? 'redteam' : 'specialist',
      description: r?.story ?? '',
      enabled: world.agents[id] ?? false,
      resident: rid,
      name: r?.name ?? null,
      level: r?.level ?? null,
      needs: r?.needs ?? [],
      named: !!rid && storyIds.includes(rid),
      fixed: id === 'checker' || id === 'redteam',
    }
  }

  const ids = Object.keys(world.agents)
  const heroAgent = heroId ? `resident:${heroId}` : null
  const specialists = ids.filter((id) => info(id).kind === 'specialist')
  const fixed = ids.filter((id) => info(id).fixed)
  const named = storyIds.map((rid) => `resident:${rid}`).filter((id) => id in world.agents && id !== heroAgent)
  const rest = ids.filter((id) => info(id).kind === 'resident' && !info(id).named && id !== heroAgent)
  const restOn = rest.filter((id) => world.agents[id])
  const restVerdict = (() => {
    const kinds = new Set(restOn.map((id) => stances.get(id)?.stance).filter(Boolean))
    if (kinds.size === 0) return 'listening'
    if (kinds.size === 1 && kinds.has('support')) return 'all support the plan'
    const vetoes = restOn.filter((id) => stances.get(id)?.stance === 'veto').length
    return vetoes ? `${vetoes} veto` : 'mixed'
  })()

  const toggle = (agent: string, enabled: boolean) => {
    setError(null)
    api.toggleAgent(agent, enabled).catch((e: Error) => setError(e.message))
  }
  const replay = world.mode === 'replay'
  const quiet = world.plan.status === 'none'

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="seg seg-xs">
          {(['cards', 'transcript', 'constraints'] as const).map((v) => (
            <button key={v} onClick={() => setMode(v)} className={`seg-item ${mode === v ? 'is-on' : ''}`} title={v === 'cards' ? 'Every agent and its stance; switch one off to silence it' : v === 'transcript' ? 'The negotiation as it happened, round by round' : 'The hard rules the agents demanded and whether the plan holds them'}>
              {v === 'cards' ? 'Who speaks' : v === 'transcript' ? 'How they argued' : 'Hard rules'}
            </button>
          ))}
        </div>
        <span className="truncate text-[10.5px] text-t3" title={modelInLoop ? 'Every enabled agent reasons with Claude; each answer is logged as an input event' : 'No model key set: each agent is its rule function (same codes, same shape)'}>
          {world.plan.enabled_agents.length} of {ids.length} agents on
          {modelInLoop ? ` · reasoning with Claude${thinking.size ? ` · ${thinking.size} thinking` : ''}` : ' · rule-based'}
          {fetchStatus?.running ? ` · ${fetchStatus.agreeing}/${fetchStatus.received} signed on Fetch.ai` : ''}
        </span>
      </div>
      {error && <p className="text-[11px] text-haven-danger">{error}</p>}
      {mode !== 'cards' && <div className="min-h-0 flex-1 overflow-y-auto pr-1">{mode === 'transcript' ? <Transcript world={world} /> : <Constraints world={world} />}</div>}
      <div className={`min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 ${mode !== 'cards' ? 'hidden' : ''}`}>
        {quiet && <p className="text-[11.5px] text-t3">Every agent is listening. The moment the chain is forecast, the specialists table a plan and every resident's own agent judges it against that person's needs.</p>}

        {heroAgent && heroAgent in world.agents && (
          <HeroCard
            id={heroAgent}
            info={info(heroAgent)}
            enabled={world.agents[heroAgent]}
            stance={stances.get(heroAgent)}
            first={round1.get(heroAgent)}
            version={world.plan.version}
            replay={replay}
            quiet={quiet}
            leftBehind={!!info(heroAgent).resident && world.plan.left_behind.includes(info(heroAgent).resident!)}
            onToggle={(on) => toggle(heroAgent, on)}
            hosted={fetchStatus?.running ? fetchAgents.get(heroAgent) : undefined}
            thinking={thinking.has(heroAgent)}
            modelInLoop={!!modelInLoop}
          />
        )}

        <div className="eyebrow pt-1">Specialists</div>
        {specialists.map((id) => (
          <AgentRow key={id} id={id} info={info(id)} enabled={world.agents[id]} stance={stances.get(id)} replay={replay} onToggle={(on) => toggle(id, on)} thinking={thinking.has(id)} modelInLoop={!!modelInLoop} />
        ))}

        {named.length > 0 && <div className="eyebrow pt-1">Residents with a need, each with their own agent</div>}
        {named.map((id) => (
          <AgentRow key={id} id={id} info={info(id)} enabled={world.agents[id]} stance={stances.get(id)} replay={replay} onToggle={(on) => toggle(id, on)} hosted={fetchStatus?.running ? fetchAgents.get(id) : undefined} thinking={thinking.has(id)} modelInLoop={!!modelInLoop} />
        ))}

        {rest.length > 0 && (
          <button onClick={() => setShowAll((v) => !v)} className="glass-card flex w-full items-center gap-2 px-3 py-2 text-left" title="Every other resident with a specific need has an agent too; they rarely need to object">
            <span className={`h-2 w-2 shrink-0 rounded-full ${restOn.length ? 'bg-haven-safe' : 'bg-t3'}`} />
            <span className="text-[12px] font-medium text-t1">
              {rest.length} more residents' agents
            </span>
            <span className="text-[11px] text-t3">· {quiet ? 'listening' : restVerdict}</span>
            <span className="mono ml-auto text-[10px] text-t3">{showAll ? 'hide' : 'show'}</span>
          </button>
        )}
        {showAll && rest.map((id) => <AgentRow key={id} id={id} info={info(id)} enabled={world.agents[id]} stance={stances.get(id)} replay={replay} onToggle={(on) => toggle(id, on)} thinking={thinking.has(id)} modelInLoop={!!modelInLoop} compact />)}

        {fixed.length > 0 && <div className="eyebrow pt-1">Always on</div>}
        {fixed.map((id) => (
          <AgentRow key={id} id={id} info={info(id)} enabled stance={stances.get(id)} replay={replay} onToggle={() => {}} modelInLoop={false} />
        ))}
      </div>
    </div>
  )
}

/** The first named resident's agent, large: the switch the demo turns, with what it says and what happens when it is off. */
function HeroCard({ id, info, enabled, stance, first, version, replay, quiet, leftBehind, onToggle, hosted, thinking, modelInLoop }: { id: string; info: AgentInfo; enabled: boolean; stance?: Stance; first?: Stance; version: number; replay: boolean; quiet: boolean; leftBehind: boolean; onToggle: (on: boolean) => void; hosted?: FetchAgent; thinking?: boolean; modelInLoop: boolean }) {
  const firstName = info.name?.split(' ')[0] ?? info.label
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
  const veto = enabled && stance?.stance === 'veto'
  return (
    <div data-buds={`agent:${id}`} className={`agent-card glass-card relative p-3.5 ${shake ? 'haven-shake veto-glow' : ''} ${veto || leftBehind ? 'tint-red' : ''}`} style={{ boxShadow: enabled ? 'inset 3px 0 0 var(--argus-blue), 0 10px 30px rgba(15,98,254,0.10)' : 'inset 3px 0 0 #7c3aed' }}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold text-t1">{info.label}</span>
            <span className="pill pill-blue">the Maya moment</span>
          </div>
          <p className="mt-1 text-[12px] text-t2">
            {info.name}
            {info.level ? ` · ${info.level}` : ''}
            {info.description ? ` · ${info.description}` : ''}
          </p>
        </div>
        <label className="flex shrink-0 flex-col items-center gap-1" title={enabled ? `Switch ${firstName}'s agent off: nobody speaks for ${firstName}` : `Switch ${firstName}'s agent back on`}>
          <span className="switch">
            <input type="checkbox" checked={enabled} disabled={replay} onChange={(e) => onToggle(e.target.checked)} />
            <span className="track" />
            <span className="knob" />
          </span>
          <span className={`text-[10px] font-semibold ${enabled ? 'text-haven-safe' : 'text-haven-purple'}`}>{enabled ? 'speaking' : 'silenced'}</span>
        </label>
      </div>
      {!enabled ? (
        <div className="fade-swap mt-2.5 rounded-[10px] border border-dashed border-purple-400/50 px-3 py-2 text-[12px] text-t1">
          Nobody speaks for {firstName}. {leftBehind ? `The plan has no step for ${firstName}: left behind.` : `Their needs are not on the table; the checker still watches the facts.`}
        </div>
      ) : quiet ? (
        <p className="mt-2 text-[11.5px] text-t3">Listening. Nothing to object to yet.</p>
      ) : (
        <div className="mt-2.5 space-y-1.5">
          {first && first.stance !== stance?.stance && (
            <div className="flex items-start gap-2 text-[11.5px]">
              <span className={`pill ${STANCE_PILL[first.stance]} shrink-0`}>round 1 · {first.stance}</span>
              <span className="text-t2">{first.reason}</span>
            </div>
          )}
          {stance && (
            <div className="flex items-start gap-2">
              <span className={`pill ${STANCE_PILL[stance.stance]} shrink-0`}>{first && first.stance !== stance.stance ? `round 2 · ${stance.stance}` : STANCE_WORD[stance.stance]}</span>
              <span className="text-[12px] leading-snug text-t1">{stance.reason}</span>
            </div>
          )}
          {stance?.constraint && (
            <div className="flex items-start gap-1.5 text-[10.5px] text-t3">
              <span className={`pill ${stance.constraint.type === 'hard' ? 'pill-red' : ''} shrink-0`}>{stance.constraint.type} rule</span>
              <span className="pt-px">{stance.constraint.rule}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {stance && <Source stance={stance} modelInLoop={modelInLoop} thinking={thinking} />}
            {hosted && <FetchBadge agent={hosted} />}
            {stance && <Explain agent={id} version={version} />}
          </div>
        </div>
      )}
    </div>
  )
}

function AgentRow({ id, info, enabled, stance, replay, onToggle, hosted, thinking, modelInLoop, compact }: { id: string; info: AgentInfo; enabled: boolean; stance?: Stance; replay: boolean; onToggle: (on: boolean) => void; hosted?: FetchAgent; thinking?: boolean; modelInLoop: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const veto = enabled && stance?.stance === 'veto'
  return (
    <div data-buds={`agent:${id}`} className={`agent-card glass-card px-3 py-2 ${!enabled ? 'opacity-55' : ''} ${veto ? 'tint-red' : ''}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${enabled ? 'bg-haven-safe' : 'bg-t3'}`} />
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((v) => !v)}>
          <span className="text-[12.5px] font-semibold text-t1">{info.label}</span>
          {!compact && info.description && <span className="ml-2 text-[11px] text-t3">{info.description.length > 80 && !open ? info.description.slice(0, 78) + '…' : info.description}</span>}
        </button>
        {enabled && stance && <span className={`pill ${STANCE_PILL[stance.stance]} shrink-0`}>{stance.stance}</span>}
        {!enabled && <span className="pill shrink-0">off</span>}
        {!info.fixed && (
          <label className="switch ml-1 shrink-0" style={{ transform: 'scale(0.78)', transformOrigin: 'right center' }} title={`${info.label}: ${enabled ? 'in' : 'out of'} the negotiation`}>
            <input type="checkbox" checked={enabled} disabled={replay} onChange={(e) => onToggle(e.target.checked)} />
            <span className="track" />
            <span className="knob" />
          </label>
        )}
      </div>
      {enabled && stance && (
        <p className={`mt-1 pl-4 text-[11.5px] leading-snug text-t2 ${open ? '' : 'line-clamp-2'}`}>{stance.reason}</p>
      )}
      {enabled && !stance && !compact && <p className="mt-1 pl-4 text-[11px] text-t3">Listening · nothing to say yet</p>}
      {!enabled && <p className="mt-1 pl-4 text-[11px] text-t3">Out of the negotiation: nobody speaks for this constraint.</p>}
      {open && enabled && stance && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-4">
          {stance.constraint && (
            <span className="text-[10.5px] text-t3">
              <span className={`pill ${stance.constraint.type === 'hard' ? 'pill-red' : ''} mr-1`}>{stance.constraint.type} rule</span>
              {stance.constraint.rule}
            </span>
          )}
          <Source stance={stance} modelInLoop={modelInLoop} thinking={thinking} />
          {hosted && <FetchBadge agent={hosted} />}
          <Explain agent={id} version={0} />
        </div>
      )}
    </div>
  )
}

/** Where a stance came from. Shown only when a model is in the loop; the rule function is the silent default. */
function Source({ stance, modelInLoop, thinking }: { stance: Stance; modelInLoop: boolean; thinking?: boolean }) {
  const src = stance.source ?? 'rules'
  if (!modelInLoop && src === 'rules') return null
  return (
    <span className="mono flex items-center gap-1.5 text-[9.5px] text-t3">
      <span className={`pill ${src !== 'rules' ? 'pill-purple' : ''}`} title={src === 'fetch:claude' ? "Reasoned with Claude inside this resident's Fetch.ai agent; signed; logged as an input event" : src === 'claude' ? 'Reasoned with Claude; logged as an input event' : 'The deterministic rule function (the model has not answered yet)'}>
        {src === 'fetch:claude' ? 'Claude via Fetch.ai' : src === 'claude' ? 'Claude' : 'rule-based'}
      </span>
      {thinking && <span className="text-haven-purple haven-pulse">reasoning…</span>}
    </span>
  )
}

/** This resident's agent on Fetch.ai: its address, and whether what it said on the network matches the plan. */
function FetchBadge({ agent }: { agent: FetchAgent }) {
  const r2 = agent.receipts['2'] ?? agent.receipts['1']
  const short = `${agent.address.slice(0, 8)}…${agent.address.slice(-4)}`
  return (
    <span className="mono flex items-center gap-1.5 text-[9.5px] text-t3" title={`${agent.address} · hosted ${agent.hosted}`}>
      <span className="pill pill-blue">fetch.ai</span>
      <span>{short}</span>
      {r2 ? <span className={r2.verified && r2.agrees ? 'text-haven-safe' : 'text-haven-amber'}>{r2.verified && r2.agrees ? `✓ signed ${r2.stance}` : `said ${r2.stance}${r2.verified ? '' : ' (unverified)'}`}</span> : <span>awaiting its reply…</span>}
    </span>
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
      <div className="enter w-full rounded-[10px] bg-black/[0.03] px-2.5 py-2 text-[11.5px] leading-snug text-t1 dark:bg-white/[0.04]">
        <span className="text-t2">“</span>
        {text}
        <span className="text-t2">”</span>
        <span className="mono ml-2 text-[9px] text-t3">{source === 'llm' ? 'Claude' : 'template'}</span>
      </div>
    )
  }
  return (
    <button className="text-[10.5px] text-haven-blue hover:underline disabled:opacity-40" onClick={ask} disabled={busy}>
      {busy ? '…' : 'In its own words'}
    </button>
  )
}
