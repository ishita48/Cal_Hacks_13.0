import { useMemo, useState } from 'react'
import { formatCountdown, formatTimeOfDay } from '../lib/api'
import { speak } from '../lib/speak'
import type { Clock, Message, PlanStep, WorldState } from '../state/types'

interface Props {
  world: WorldState
  clock: Clock
}

const CHANNEL: Record<string, { glyph: string; name: string }> = {
  sms: { glyph: 'SMS', name: 'text message' },
  call: { glyph: '☎', name: 'phone call' },
  app: { glyph: 'APP', name: 'app notification' },
  text_only: { glyph: 'TXT', name: 'text and light, never sound' },
  email: { glyph: '@', name: 'email' },
}
const LANG: Record<string, string> = { en: 'English', es: 'Spanish', zh: 'Chinese', ko: 'Korean', vi: 'Vietnamese', hi: 'Hindi' }

type Filter = 'all' | 'critical' | 'staff' | 'sent'
type Delivery = { state: 'draft' | 'queued' | 'sending' | 'sent' | 'failed'; when: string; why: string }

/**
 * The outbox: every message the plan implies, one per person in their own language, grouped by what
 * has happened to it. Nothing here is typed by hand: each message hangs off a plan step, goes out when
 * that step runs (on approval), and shows the time it went. Judges can read the exact words.
 */
export function MessagesPanel({ world, clock }: Props) {
  const plan = world.approved_plan ?? world.plan
  const [filter, setFilter] = useState<Filter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const steps = useMemo(() => new Map<string, PlanStep>(plan.steps.map((s) => [s.id, s])), [plan.steps])
  const base = plan.computed_step * clock.dt

  const delivery = (m: Message): Delivery => {
    const step = m.step_ids.map((id) => steps.get(id)).find((s): s is PlanStep => !!s)
    if (!world.approved_plan) return { state: 'draft', when: 'on approval', why: step ? `with: ${step.title}` : 'with the plan' }
    for (const id of m.step_ids) {
      const a = world.actions[id]
      if (a?.status === 'done') return { state: 'sent', when: formatTimeOfDay(clock.time_of_day - (clock.step - a.step) * clock.dt), why: a.detail || (step ? step.title : '') }
      if (a?.status === 'failed') return { state: 'failed', when: '', why: a.detail }
      if (a?.status === 'assigned') return { state: 'sending', when: 'now', why: step ? step.title : '' }
    }
    if (!step) return { state: 'queued', when: 'soon', why: '' }
    const at = base + step.at_s - clock.sim_time
    return { state: 'queued', when: at > 0 ? `in ${formatCountdown(at)}` : 'due', why: step.title }
  }

  const all = plan.messages ?? []
  const rows = useMemo(() => {
    const rank = (m: Message) => (m.to === 'maya' ? 0 : m.priority === 'critical' ? 1 : m.role === 'staff' ? 2 : m.role === 'external' ? 3 : 4)
    return [...all].sort((a, b) => rank(a) - rank(b)).map((m) => ({ m, d: delivery(m) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, world.actions, world.approved_plan, clock.step])

  const visible = rows.filter(({ m, d }) => (filter === 'all' ? true : filter === 'critical' ? m.priority === 'critical' : filter === 'staff' ? m.role !== 'resident' : d.state === 'sent'))
  const people = all.reduce((n, m) => n + m.count, 0)
  const sent = rows.filter((r) => r.d.state === 'sent').reduce((n, r) => n + r.m.count, 0)
  const critical = all.filter((m) => m.priority === 'critical').length
  const langs = [...new Set(all.map((m) => m.lang))]

  if (plan.status === 'none' || all.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <span className="eyebrow">Messages</span>
        <div className="glass-card mt-3 px-3 py-6 text-center text-[12px] text-t3">No plan yet. Once the agents agree, every affected person gets their own message, in their own language, timed to a step.</div>
      </div>
    )
  }

  const groups: [string, string, typeof visible][] = [
    ['Sending now', 'the step is running', visible.filter((r) => r.d.state === 'sending')],
    ['Sent', 'delivered when the step completed', visible.filter((r) => r.d.state === 'sent')],
    ['Queued', 'goes out when its step comes due', visible.filter((r) => r.d.state === 'queued')],
    ['Drafts', 'written; waiting for approval', visible.filter((r) => r.d.state === 'draft')],
    ['Failed', '', visible.filter((r) => r.d.state === 'failed')],
  ]

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="eyebrow">Messages</span>
          <span className="mono truncate text-[10px] text-t3">
            {all.length} messages · {people} people · {langs.map((l) => LANG[l] ?? l).join(', ')}
          </span>
        </div>
        <div className="seg seg-xs shrink-0">
          {(['all', 'critical', 'staff', 'sent'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`seg-item ${filter === f ? 'is-on' : ''}`}>
              {f === 'all' ? 'All' : f === 'critical' ? `Critical ${critical}` : f === 'staff' ? 'Staff' : 'Sent'}
            </button>
          ))}
        </div>
      </div>

      {/* delivery bar: how much of the building has been told */}
      <div className="glass-card px-3 py-2">
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="text-t2">{world.approved_plan ? `${sent} of ${people} people told` : `${people} people will be told on approval`}</span>
          <span className="mono text-t3">{people ? Math.round((sent / people) * 100) : 0}%</span>
        </div>
        <div className="progress">
          <span style={{ width: `${people ? (sent / people) * 100 : 0}%` }} />
        </div>
      </div>

      <div key={plan.version} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {groups.map(([title, sub, list]) =>
          list.length === 0 ? null : (
            <section key={title}>
              <div className="mb-1.5 flex items-baseline gap-2">
                <span className="eyebrow">
                  {title} · {list.length}
                </span>
                {sub && <span className="text-[10px] text-t3">{sub}</span>}
              </div>
              <ul className="space-y-1.5">
                {list.map(({ m, d }, i) => {
                  const ch = CHANNEL[m.channel] ?? { glyph: m.channel, name: m.channel }
                  const open = openId === m.id
                  const maya = m.to === 'maya'
                  return (
                    <li key={m.id} className={`glass-card enter px-3 py-2.5 ${maya ? 'tint-blue' : ''} ${d.state === 'failed' ? 'tint-red' : ''}`} style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }} data-buds={`message:${m.to}`}>
                      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpenId(open ? null : m.id)} title={ch.name}>
                        <span className={`mono flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-[9px] font-semibold ${m.channel === 'call' ? 'bg-haven-power/15 text-haven-power' : 'bg-haven-blue/10 text-haven-blue'}`}>{ch.glyph}</span>
                        <span className="truncate text-[13px] font-semibold text-t1">{m.name}</span>
                        {m.lang !== 'en' && <span className="pill mono">{LANG[m.lang] ?? m.lang}</span>}
                        {m.count > 1 && <span className="pill mono">×{m.count}</span>}
                        {m.priority === 'critical' && <span className="pill pill-red">critical</span>}
                        <span className="mono ml-auto shrink-0 text-[10px]">
                          {d.state === 'sent' ? (
                            <span key={d.when} className="pop-check inline-flex items-center gap-1 text-haven-safe">
                              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M1.5 5.5l2.5 2.5 4.5-5" />
                              </svg>
                              sent {d.when}
                            </span>
                          ) : d.state === 'sending' ? (
                            <span className="text-haven-power haven-pulse">sending</span>
                          ) : d.state === 'failed' ? (
                            <span className="text-haven-danger">failed</span>
                          ) : (
                            <span className="text-t3">{d.state === 'draft' ? 'on approval' : d.when}</span>
                          )}
                        </span>
                      </button>
                      <p className={`mt-1.5 text-[12px] leading-relaxed text-t2 ${open ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{m.text}</p>
                      {(open || maya) && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-t3">
                          <span>
                            {ch.name}
                            {d.why ? ` · ${d.why}` : ''}
                          </span>
                          {m.channel === 'call' && (
                            <button className="btn-secondary btn-sm ml-auto" onClick={(e) => { e.stopPropagation(); void speak(m.text, m.lang) }} title="Hear it (ElevenLabs, Cartesia, or the browser's voice)">
                              ▶ {m.role === 'external' ? 'Place the call' : 'Play the call'}
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ),
        )}
      </div>
    </div>
  )
}
