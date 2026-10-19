import { useState } from 'react'
import { Send } from 'lucide-react'
import { request } from '../lib/api'
import type { Role } from '../state/me'
import type { Snapshot } from './types'
import { AVATARS } from './data'
import { Card, PageTitle } from './ui'

const STARTERS: Record<Role, string[]> = {
  resident: ['Is anything happening in my building?', 'When is my maintenance visit?', 'Who is my RA?'],
  ra: ['Who on my floors needs a check-in?', 'What is still unresolved?', 'Who can I contact?'],
  maintenance: ['What needs my attention?', 'Any visits scheduled?', 'What equipment is down?'],
  admin: ['What needs my attention?', 'Which requests are unassigned?', 'Who can I contact?'],
}

/** Ask HAVEN: answered by the backend from this viewer's own projection (rules first, Claude when keyed). */
export function Ask({ data }: { data: Snapshot }) {
  const [messages, setMessages] = useState<{ who: 'you' | 'agent'; text: string; source?: string }[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const name = data.profile.agent_name

  const ask = async (q: string) => {
    if (!q.trim() || busy) return
    setMessages((m) => [...m, { who: 'you', text: q }])
    setText('')
    setBusy(true)
    try {
      const a = await request<{ text: string; source: string }>('POST', '/api/portal/ask', { text: q })
      setMessages((m) => [...m, { who: 'agent', text: a.text, source: a.source }])
    } catch (e) {
      setMessages((m) => [...m, { who: 'agent', text: e instanceof Error ? e.message : 'Could not reach HAVEN. Try again.' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageTitle eyebrow="Ask HAVEN" title={`Ask ${name}.`} subtitle="Answers come only from what you are allowed to see. Decisions stay with people." />
      <Card className="hp-chat">
        <div className="hp-chat-log" aria-live="polite">
          {!messages.length && (
            <div className="hp-chat-hello">
              <span className="hp-orb">{AVATARS[data.profile.avatar] ?? '✦'}</span>
              <h2>What can I help with?</h2>
              <div className="hp-actions is-center">
                {STARTERS[data.viewer.role].map((q) => (
                  <button key={q} className="hp-btn" disabled={busy} onClick={() => void ask(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <article className={`hp-bubble is-${m.who}`} key={i}>
              <p>{m.text}</p>
              {m.source && <small>{m.source === 'claude' ? 'Claude, from your view' : 'From your workspace'}</small>}
            </article>
          ))}
          {busy && <p className="hp-muted">Looking…</p>}
        </div>
        <form
          className="hp-compose"
          onSubmit={(e) => {
            e.preventDefault()
            void ask(text)
          }}
        >
          <input aria-label={`Ask ${name}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about your building, requests or team…" maxLength={2000} />
          <button className="hp-btn is-primary" disabled={busy || !text.trim()} aria-label="Send">
            <Send size={15} />
          </button>
        </form>
      </Card>
    </>
  )
}
