import { useMemo, useState } from 'react'
import { formatTimeOfDay } from '../lib/api'
import type { Clock, Message, WorldState } from '../state/types'

interface Props {
  world: WorldState
  clock: Clock
}

const CHANNEL_GLYPH: Record<string, string> = {
  sms: 'SMS',
  call: '☎',
  app: 'APP',
  text_only: 'TXT',
  email: '@',
}

type Filter = 'all' | 'critical' | 'staff'

/** Every message the plan implies: one per person, in their language, marked sent once its step is done. */
export function MessagesPanel({ world, clock }: Props) {
  const plan = world.approved_plan ?? world.plan
  const [filter, setFilter] = useState<Filter>('all')

  const groups = useMemo(() => {
    const msgs = plan.messages ?? []
    const rank = (m: Message) => (m.to === 'maya' ? 0 : m.priority === 'critical' ? 1 : 2)
    const residents = msgs.filter((m) => m.role === 'resident').sort((a, b) => rank(a) - rank(b))
    const staff = msgs.filter((m) => m.role === 'staff')
    const external = msgs.filter((m) => m.role === 'external')
    return [
      ['Residents', residents],
      ['Staff', staff],
      ['External', external],
    ] as [string, Message[]][]
  }, [plan.messages])

  const sentAt = (m: Message): number | null => {
    for (const id of m.step_ids) {
      const a = world.actions[id]
      if (a && a.status === 'done') return a.step
    }
    return null
  }

  const visible = (m: Message) => (filter === 'all' ? true : filter === 'critical' ? m.priority === 'critical' : m.role !== 'resident')
  const total = plan.messages?.length ?? 0
  const critical = plan.messages?.filter((m) => m.priority === 'critical').length ?? 0

  if (plan.status === 'none' || total === 0) {
    return (
      <div className="flex h-full flex-col">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Messages</h2>
        <div className="mt-2 rounded border border-dashed border-ink-700 px-3 py-4 text-center text-xs text-slate-600">
          No plan yet. Each affected person gets their own message once the agents agree.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Messages <span className="font-mono normal-case tracking-normal text-slate-600">{total} · {critical} critical</span>
        </h2>
        <div className="flex gap-1 text-[10px]">
          {(['all', 'critical', 'staff'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-0.5 uppercase tracking-wider ${filter === f ? 'bg-slate-200 text-ink-900' : 'bg-ink-700 text-slate-400 hover:bg-ink-600'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {groups.map(([title, msgs]) => {
          const rows = msgs.filter(visible)
          if (rows.length === 0) return null
          return (
            <section key={title}>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                {title} · {rows.length}
              </h3>
              <ul className="space-y-1">
                {rows.map((m) => {
                  const at = sentAt(m)
                  const maya = m.to === 'maya'
                  return (
                    <li
                      key={m.id}
                      className={`rounded border px-2.5 py-1.5 text-xs ${
                        maya ? 'border-haven-safe/60 bg-haven-safe/5' : m.priority === 'critical' ? 'border-haven-danger/40 bg-ink-900' : 'border-ink-700 bg-ink-900'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={`rounded px-1 font-mono text-[9px] ${m.channel === 'call' ? 'bg-haven-power/20 text-haven-power' : 'bg-ink-700 text-slate-300'}`} title={m.channel}>
                          {CHANNEL_GLYPH[m.channel] ?? m.channel}
                        </span>
                        <span className="truncate font-medium text-white">{m.name}</span>
                        {m.lang !== 'en' && <span className="rounded border border-ink-600 px-1 text-[9px] uppercase text-slate-400">{m.lang}</span>}
                        {m.count > 1 && <span className="rounded bg-ink-700 px-1 text-[9px] text-slate-300">×{m.count}</span>}
                        {m.priority === 'critical' && <span className="rounded border border-haven-danger/50 px-1 text-[9px] uppercase text-haven-danger">critical</span>}
                        <span className="ml-auto shrink-0 font-mono text-[10px]">
                          {at != null ? (
                            <span className="text-haven-safe">✓ sent {formatTimeOfDay(clock.time_of_day - (clock.step - at) * clock.dt)}</span>
                          ) : world.approved_plan ? (
                            <span className="text-slate-500">queued</span>
                          ) : (
                            <span className="text-slate-600">draft</span>
                          )}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-[11px] leading-snug text-slate-300">{m.text}</p>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
