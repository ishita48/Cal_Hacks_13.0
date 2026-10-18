import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { IMPACT_LABEL, NEED_LABEL, PRESENCE_LABEL, STATUS_COLOR } from '../lib/labels'
import { useBuilding } from '../state/building'
import type { WorldState } from '../state/types'
import { point } from './Buds'

/**
 * Click a room, a piece of equipment or a person on the plan or the twin and this is their record:
 * what the spec says, what the world says right now, and what connects to what in the dependency
 * graph. Nothing here is a copy of the world; it reads the store and the static spec.
 */

export type Selection = { kind: 'space' | 'equipment' | 'resident'; id: string }

export function select(sel: Selection | null): void {
  window.dispatchEvent(new CustomEvent('haven:select', { detail: sel }))
}

export function useSelection(): [Selection | null, (s: Selection | null) => void] {
  const [sel, setSel] = useState<Selection | null>(null)
  useEffect(() => {
    const on = (e: Event) => setSel((e as CustomEvent<Selection | null>).detail)
    window.addEventListener('haven:select', on)
    return () => window.removeEventListener('haven:select', on)
  }, [])
  return [sel, setSel]
}

const REL_WORD: Record<string, string> = { powers: 'powers', backs_up: 'backs up', controls: 'controls', feeds_water: 'feeds water to', monitors: 'monitors' }

export function Inspector({ world, selection }: { world: WorldState; selection: Selection | null }) {
  const spaces = useBuilding((b) => b.spaces)
  const equipment = useBuilding((b) => b.equipment)
  const residents = useBuilding((b) => b.residents)
  const graph = useBuilding((b) => b.graph)
  if (!selection) {
    return (
      <div className="glass-card px-3 py-6 text-center text-[12px] text-t3">
        Click a room, a switchboard, a lift or a person on the plan or the twin to see its record: what the spec says, what is true right now, and what it is connected to.
      </div>
    )
  }
  const live = new Set(world.power.live)
  const Row = ({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) => (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[12px]">
      <span className="text-t3">{k}</span>
      <span className={`text-right ${tone ?? 'text-t1'}`}>{v}</span>
    </div>
  )

  if (selection.kind === 'space') {
    const s = spaces[selection.id]
    if (!s) return null
    const water = world.water[s.id]
    const dark = world.impact.dark_levels.includes(s.level)
    const soon = !dark && world.forecast.impact.dark_levels.includes(s.level)
    const here = Object.values(residents).filter((r) => r.room === s.id && !world.moved[r.id])
    const movedIn = Object.entries(world.moved).filter(([, sp]) => sp === s.id).map(([id]) => residents[id]).filter(Boolean)
    const eq = Object.values(equipment).filter((e) => e.space === s.id)
    return (
      <div className="space-y-3">
        <div>
          <div className="eyebrow">{s.kind} · {s.level}</div>
          <div className="text-[16px] font-semibold text-t1">{s.name}</div>
          <div className="mono text-[10px] text-t3">{s.id}</div>
        </div>
        <div className="glass-card px-3 py-1">
          <Row k="Power" v={dark ? 'dark' : soon ? 'dark if nothing is done' : 'on'} tone={dark ? 'text-haven-danger' : soon ? 'text-haven-amber' : 'text-haven-safe'} />
          <Row k="Water" v={water ? `${Math.round(water.depth * 100)} cm · ${Math.round(water.volume)} L` : 'dry'} tone={water ? 'text-haven-water' : undefined} />
          <Row k="Capacity" v={s.capacity ? `${s.capacity} people` : 'n/a'} />
          <Row k="Step-free" v={s.accessible ? 'yes' : 'no'} />
          {s.tags.length > 0 && <Row k="Tags" v={s.tags.join(', ')} />}
        </div>
        {(here.length > 0 || movedIn.length > 0) && (
          <div>
            <div className="eyebrow mb-1">People here · {here.length + movedIn.length}</div>
            <ul className="space-y-1">
              {[...here, ...movedIn].map((r) => (
                <li key={r.id}>
                  <button className="glass-card flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => select({ kind: 'resident', id: r.id })}>
                    <span className="text-[12px] font-medium text-t1">{r.name}</span>
                    <span className="label">{PRESENCE_LABEL[r.presence] ?? r.presence}{world.moved[r.id] ? ' · moved here' : ''}</span>
                    {r.needs.length > 0 && <span className="pill ml-auto">{r.needs.map((n) => NEED_LABEL[n] ?? n).join(', ')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {eq.length > 0 && (
          <div>
            <div className="eyebrow mb-1">Equipment in this room</div>
            <ul className="space-y-1">
              {eq.map((e) => (
                <li key={e.id}>
                  <button className="glass-card flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => select({ kind: 'equipment', id: e.id })}>
                    <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[world.equipment[e.id]?.status ?? 'online'] }} />
                    <span className="text-[12px] text-t1">{e.name}</span>
                    <span className="label ml-auto">{world.equipment[e.id]?.status ?? 'online'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button className="btn-secondary btn-sm" onClick={() => point([{ kind: 'level', id: s.level, label: s.level }])}>Show this floor</button>
      </div>
    )
  }

  if (selection.kind === 'equipment') {
    const e = equipment[selection.id]
    if (!e) return null
    const st = world.equipment[e.id]?.status ?? 'online'
    const water = world.water[e.space]
    const outs = (graph?.edges ?? []).filter((x) => x.src === e.id)
    const ins = (graph?.edges ?? []).filter((x) => x.dst === e.id)
    const isValve = e.kind === 'valve'
    const isBreaker = ['switchboard', 'switchgear', 'transfer_switch', 'panel', 'section'].includes(e.kind)
    const lever = (command: 'close' | 'open' | 'off' | 'on', label: string) => (
      <button className="btn-secondary btn-sm" disabled={world.mode === 'replay'} onClick={() => api.command(e.id, command).catch(() => {})}>
        {label}
      </button>
    )
    return (
      <div className="space-y-3">
        <div>
          <div className="eyebrow">{e.kind.replace(/_/g, ' ')} · {spaces[e.space]?.name ?? e.space}</div>
          <div className="text-[16px] font-semibold text-t1">{e.name}</div>
          <div className="mono text-[10px] text-t3">{e.id}</div>
        </div>
        <div className="glass-card px-3 py-1">
          <Row k="Status" v={<span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[st] }} />{st}</span>} />
          <Row k="Powered" v={live.has(e.id) ? 'yes' : 'no'} tone={live.has(e.id) ? 'text-haven-safe' : 'text-haven-danger'} />
          {e.flood_height != null && <Row k="Fails at" v={`${Math.round(e.flood_height * 100)} cm of water`} />}
          <Row k="Water in its room" v={water ? `${Math.round(water.depth * 100)} cm` : 'dry'} tone={water && e.flood_height != null && water.depth >= e.flood_height ? 'text-haven-danger' : water ? 'text-haven-water' : undefined} />
          {world.leaks[e.id] && <Row k="Leak" v={`${world.leaks[e.id].flow_lps} L/s · ${world.leaks[e.id].active ? 'active' : 'stopped'}`} tone="text-haven-water" />}
        </div>
        {(ins.length > 0 || outs.length > 0) && (
          <div>
            <div className="eyebrow mb-1">Connections</div>
            <ul className="space-y-1 text-[12px]">
              {ins.map((x) => (
                <li key={`in-${x.src}-${x.rel}`}>
                  <button className="text-left hover:underline" onClick={() => select({ kind: 'equipment', id: x.src })}>
                    <span className={live.has(x.src) ? 'text-haven-safe' : 'text-haven-danger'}>●</span> <span className="text-t1">{equipment[x.src]?.name ?? x.src}</span> <span className="text-t3">{REL_WORD[x.rel] ?? x.rel} this</span>
                  </button>
                </li>
              ))}
              {outs.map((x) => (
                <li key={`out-${x.dst}-${x.rel}`}>
                  <button className="text-left hover:underline" onClick={() => select({ kind: 'equipment', id: x.dst })}>
                    <span className="text-t3">this {REL_WORD[x.rel] ?? x.rel}</span> <span className="text-t1">{equipment[x.dst]?.name ?? x.dst}</span> <span className={live.has(x.dst) ? 'text-haven-safe' : 'text-haven-danger'}>●</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {isValve && (st === 'closed' ? lever('open', 'Open valve') : lever('close', 'Close valve'))}
          {isBreaker && (st === 'isolated' ? lever('on', 'Switch on') : lever('off', 'Isolate'))}
          <button className="btn-secondary btn-sm" onClick={() => point([{ kind: 'level', id: e.level, label: e.level }])}>Show this floor</button>
        </div>
      </div>
    )
  }

  const r = residents[selection.id]
  if (!r) return null
  const impact = [...world.impact.residents, ...world.forecast.impact.residents].find((x) => x.id === r.id)
  const where = world.moved[r.id] ? (world.moved[r.id] === 'outside' ? 'another building' : spaces[world.moved[r.id]]?.name) : spaces[r.room]?.name
  const agent = `resident:${r.id}`
  const stance = world.plan.stances.find((s) => s.agent === agent)
  const steps = world.plan.steps.filter((s) => s.people.includes(r.id))
  return (
    <div className="space-y-3">
      <div>
        <div className="eyebrow">{r.role === 'ra' ? 'resident assistant' : 'resident'} · {r.level}</div>
        <div className="text-[16px] font-semibold text-t1">{r.name}</div>
        {r.story && <p className="mt-1 text-[12px] text-t2">{r.story}</p>}
      </div>
      <div className="glass-card px-3 py-1">
        <Row k="Where now" v={where ?? r.room} />
        <Row k="Presence" v={PRESENCE_LABEL[r.presence] ?? r.presence} />
        <Row k="Needs" v={r.needs.length ? r.needs.map((n) => NEED_LABEL[n] ?? n).join(', ') : 'none'} />
        <Row k="Contact" v={`${r.contact.channel} · ${r.contact.lang}`} />
        {impact && <Row k="Impact" v={impact.impacts.map((i) => IMPACT_LABEL[i] ?? i).join(', ') || 'none'} tone={impact.severity === 'critical' ? 'text-haven-danger' : impact.severity === 'warning' ? 'text-haven-amber' : undefined} />}
        {agent in world.agents && <Row k="Their agent" v={world.agents[agent] ? (stance ? `${stance.stance}: ${stance.reason}` : 'on, listening') : 'switched off'} tone={world.agents[agent] ? undefined : 'text-haven-danger'} />}
        {world.plan.left_behind.includes(r.id) && <Row k="Plan" v="left behind" tone="text-haven-purple" />}
      </div>
      {steps.length > 0 && (
        <div>
          <div className="eyebrow mb-1">Steps for them</div>
          <ul className="space-y-1 text-[12px]">
            {steps.map((s) => (
              <li key={s.id} className="glass-card px-2.5 py-1.5">
                <span className="text-t1">{s.title}</span>
                <span className="label ml-2">+{Math.round(s.at_s / 60)} min · {s.actor}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {agent in world.agents && (
          <button className="btn-secondary btn-sm" disabled={world.mode === 'replay'} onClick={() => api.toggleAgent(agent, !world.agents[agent]).catch(() => {})}>
            {world.agents[agent] ? 'Switch their agent off' : 'Switch their agent on'}
          </button>
        )}
        <button className="btn-secondary btn-sm" onClick={() => point([{ kind: 'resident', id: r.id, label: r.name }, { kind: 'level', id: r.level, label: r.level }])}>Point at them</button>
      </div>
    </div>
  )
}
