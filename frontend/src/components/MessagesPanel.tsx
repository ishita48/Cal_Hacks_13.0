import { useMemo, useState } from 'react'
import { formatTimeOfDay } from '../lib/api'
import { speak } from '../lib/speak'
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
        <span className="eyebrow">Messages</span>
        <div className="glass-card mt-3 px-3 py-6 text-center text-[12px] text-t3">No plan yet. Each affected person gets their own message once the agents agree.</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-hidden">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="eyebrow">Messages</span>
          <span className="mono text-[10px] text-t3">
            {total} · {critical} critical
          </span>
        </div>
        <div className="seg seg-xs">
          {(['all', 'critical', 'staff'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`seg-item ${filter === f ? 'is-on' : ''}`}>
              {f === 'all' ? 'All' : f === 'critical' ? 'Critical' : 'Staff'}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {groups.map(([title, msgs]) => {
          const rows = msgs.filter(visible)
          if (rows.length === 0) return null
          return (
            <section key={title}>
              <div className="eyebrow mb-1.5">
                {title} · {rows.length}
              </div>
              <ul className="space-y-1.5">
                {rows.map((m) => {
                  const at = sentAt(m)
                  const maya = m.to === 'maya'
                  return (
                    <li key={m.id} className={`glass-card px-3 py-2.5 ${maya ? 'tint-blue' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span
                          className={`mono flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-[9px] font-semibold ${
                            m.channel === 'call' ? 'bg-haven-power/20 text-haven-power' : 'bg-white/8 text-t2'
                          }`}
                          title={m.channel}
                        >
                          {CHANNEL_GLYPH[m.channel] ?? m.channel}
                        </span>
                        <span className="truncate text-[13px] font-semibold text-t1">{m.name}</span>
                        {m.lang !== 'en' && <span className="pill mono">{m.lang}</span>}
                        {m.count > 1 && <span className="pill mono">×{m.count}</span>}
                        {m.priority === 'critical' && <span className="pill pill-red">critical</span>}
                        <span className="mono ml-auto shrink-0 text-[10px]">
                          {at != null ? (
                            <span className="text-haven-safe">sent {formatTimeOfDay(clock.time_of_day - (clock.step - at) * clock.dt)}</span>
                          ) : world.approved_plan ? (
                            <span className="text-t3">queued</span>
                          ) : (
                            <span className="text-t3">draft</span>
                          )}
                        </span>
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-t2">{m.text}</p>
                      {m.channel === 'call' && (
                        <button className="btn-secondary btn-sm mt-2" onClick={() => void speak(m.text, m.lang)} title="Place the call (Cartesia voice, or the browser's)">
                          ▶ {m.role === 'external' ? 'Place the call' : 'Play the call'}
                        </button>
                      )}
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
