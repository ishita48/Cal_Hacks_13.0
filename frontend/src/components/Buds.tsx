import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { isSpeaking, speak, stopSpeaking } from '../lib/speak'
import { listen, soundsLikeEcho, voiceSupported, type Listener } from '../lib/voice'
import { useWorld } from '../state/world'
import type { BudsAction, BudsFocus, BudsReply } from '../state/types'

/**
 * Buds: the on-screen companion. An orb in the corner you can type to or talk to, hands-free.
 * It answers from the one world state (the backend router, Claude only as a fallback), points at
 * the thing it is talking about, and offers actions that only run once you approve them: Buds
 * proposes, the human gates, the world changes through the same input events a button sends.
 *
 * Pointing: every panel, agent card, plan step, floor button and tab carries data-buds="kind:id".
 * Buds raises `haven:focus` (App switches tab or floor), waits a frame, then flies its cursor
 * to the element and rings it. Speaking: ElevenLabs → Cartesia → browser; interruptible.
 */

const NAME = 'Buds'
const ECHO_TAIL_MS = 1500

interface Msg {
  id: number
  role: 'me' | 'bud' | 'hint'
  text: string
  reply?: BudsReply
  acted?: Record<number, 'done' | 'dismissed' | 'error'>
}

const SUGGESTIONS = ['Where is Maya?', 'Why are the lifts held?', 'What happens if nobody acts?', 'Who is left behind?']

let nextId = 1

export function focusKey(f: BudsFocus): string {
  return `${f.kind}:${f.id}`
}

export function Buds() {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [handsFree, setHandsFree] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [muted, setMuted] = useState(false)
  const [partial, setPartial] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [nudge, setNudge] = useState<string | null>(null)
  const listener = useRef<Listener | null>(null)
  const spoken = useRef({ text: '', endedAt: 0 })
  const list = useRef<HTMLDivElement>(null)
  const supported = voiceSupported()
  const world = useWorld((s) => s.world)
  const replay = world?.mode === 'replay'

  // A gentle nudge the first time there is a plan to talk about.
  const nudged = useRef(false)
  useEffect(() => {
    if (!world || nudged.current || open) return
    if (world.plan.status !== 'none') {
      nudged.current = true
      setNudge('There is a plan. Ask me why the lifts are held, or who is left behind.')
      const t = setTimeout(() => setNudge(null), 9000)
      return () => clearTimeout(t)
    }
  }, [world, open])

  useEffect(() => {
    list.current?.scrollTo?.({ top: list.current.scrollHeight, behavior: 'smooth' })
  }, [msgs, partial])

  const say = useCallback(
    (line: string) => {
      if (muted) return
      spoken.current = { text: line, endedAt: 0 }
      setSpeaking(true)
      void speak(line, 'en', {
        onEnd: () => {
          spoken.current.endedAt = Date.now()
          setSpeaking(false)
        },
      })
    },
    [muted],
  )

  const hush = useCallback(() => {
    if (isSpeaking()) {
      stopSpeaking()
      spoken.current.endedAt = Date.now()
      setSpeaking(false)
    }
  }, [])

  const ask = useCallback(
    async (phrase: string) => {
      const q = phrase.trim()
      if (!q || busy) return
      hush()
      setError(null)
      setBusy(true)
      setMsgs((m) => [...m, { id: nextId++, role: 'me', text: q }])
      try {
        const reply = await api.budsAsk(q)
        setMsgs((m) => [...m, { id: nextId++, role: 'bud', text: reply.speech, reply }])
        say(reply.speech)
        if (reply.focus.length) point(reply.focus)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [busy, hush, say],
  )

  // ---- voice in --------------------------------------------------------------------------------
  const stopListening = useCallback(() => {
    listener.current?.cancel()
    listener.current = null
    setListening(false)
    setPartial('')
  }, [])

  const startListening = useCallback(
    (continuous: boolean) => {
      stopListening()
      const l = listen({
        continuous,
        onPartial: (t) => {
          // Barge-in: the person is talking over Buds. Unless it is just Buds hearing itself.
          const echo = (isSpeaking() || Date.now() - spoken.current.endedAt < ECHO_TAIL_MS) && soundsLikeEcho(t, spoken.current.text)
          if (echo) return
          hush()
          setPartial(t)
        },
        onFinal: (t) => {
          const echo = Date.now() - spoken.current.endedAt < ECHO_TAIL_MS && soundsLikeEcho(t, spoken.current.text)
          setPartial('')
          if (echo) return
          if (/^(stop|quiet|shush|be quiet|hush)\.?$/i.test(t)) {
            hush()
            return
          }
          void ask(t)
          if (!continuous) stopListening()
        },
        onError: (m) => {
          setError(m)
          setListening(false)
          setHandsFree(false)
        },
        onEnd: () => {
          setListening(false)
          if (continuous) setHandsFree(false)
        },
      })
      listener.current = l
      setListening(!!l)
      if (!l) setHandsFree(false)
    },
    [ask, hush, stopListening],
  )

  useEffect(() => () => stopListening(), [stopListening])

  const toggleHandsFree = () => {
    if (handsFree) {
      setHandsFree(false)
      stopListening()
    } else {
      setHandsFree(true)
      setOpen(true)
      startListening(true)
    }
  }

  // Alt+B opens Buds; Alt+Shift+V toggles hands-free; Escape stops it talking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        toggleHandsFree()
      } else if (e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 'Escape') hush()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- actions: the human gate ------------------------------------------------------------------
  const act = async (msg: Msg, i: number, a: BudsAction) => {
    if (replay) return
    try {
      await api.budsAct(a.kind, a.payload)
      setMsgs((m) => m.map((x) => (x.id === msg.id ? { ...x, acted: { ...(x.acted ?? {}), [i]: 'done' } } : x)))
      say(`Done: ${a.label}.`)
    } catch (e) {
      setError((e as Error).message)
      setMsgs((m) => m.map((x) => (x.id === msg.id ? { ...x, acted: { ...(x.acted ?? {}), [i]: 'error' } } : x)))
    }
  }
  const dismiss = (msg: Msg, i: number) =>
    setMsgs((m) => m.map((x) => (x.id === msg.id ? { ...x, acted: { ...(x.acted ?? {}), [i]: 'dismissed' } } : x)))

  const status = speaking ? 'speaking' : listening ? 'listening' : busy ? 'thinking' : 'idle'

  return (
    <div data-buds-ui="">
      <Pointer />
      {nudge && !open && (
        <button className="buds-nudge glass-card" onClick={() => setOpen(true)}>
          {nudge}
        </button>
      )}
      {open && (
        <div className="buds-panel glass" role="dialog" aria-label={NAME}>
          <div className="buds-head">
            <span className={`buds-dot is-${status}`} />
            <span className="text-[12px] font-semibold text-t1">{NAME}</span>
            <span className="label ml-1">{status === 'idle' ? 'reads the same world as every panel' : status}</span>
            <div className="ml-auto flex items-center gap-1">
              <button className={`buds-ib ${handsFree ? 'is-on' : ''}`} onClick={toggleHandsFree} disabled={!supported} title={supported ? 'Hands-free conversation (Alt+Shift+V): talk, interrupt any time' : 'No speech recognition in this browser'}>
                🎧
              </button>
              <button className={`buds-ib ${muted ? 'is-on' : ''}`} onClick={() => { if (!muted) hush(); setMuted((m) => !m) }} title={muted ? 'Unmute Buds' : 'Mute Buds'}>
                {muted ? '🔇' : '🔊'}
              </button>
              <button className="buds-ib" onClick={() => setOpen(false)} title="Hide (Alt+B)">
                ×
              </button>
            </div>
          </div>

          <div className="buds-list" ref={list}>
            {msgs.length === 0 && (
              <div className="buds-msg bud">
                I'm {NAME}. Ask me anything about what's on screen and I'll point at it. I can also switch an agent, impose a rule or approve the plan, but only after you approve.
              </div>
            )}
            {msgs.map((m) => (
              <div key={m.id} className={`buds-msg ${m.role}`}>
                {m.text}
                {m.reply && m.reply.source === 'llm' && <span className="mono ml-1.5 text-[9px] text-t3">claude</span>}
                {m.reply && m.reply.focus.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {m.reply.focus.map((f) => (
                      <button key={focusKey(f)} className="pill pill-blue" onClick={() => point([f])} title={`Point at ${focusKey(f)}`}>
                        ↗ {f.label || f.id}
                      </button>
                    ))}
                  </div>
                )}
                {m.reply && m.reply.actions.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {m.reply.actions.map((a, i) => {
                      const state = m.acted?.[i]
                      return (
                        <div key={i} className="buds-action">
                          <span className="min-w-0 flex-1 truncate text-[11px] text-t1">{a.label}</span>
                          {state === 'done' ? (
                            <span className="pill pill-green">done</span>
                          ) : state === 'dismissed' ? (
                            <span className="pill">dismissed</span>
                          ) : state === 'error' ? (
                            <span className="pill pill-red">failed</span>
                          ) : (
                            <>
                              <button className="btn-primary btn-sm" disabled={replay} onClick={() => void act(m, i, a)} title={replay ? 'Replaying: inputs are locked' : 'Approve: this becomes an input event'}>
                                Approve
                              </button>
                              <button className="btn-secondary btn-sm" onClick={() => dismiss(m, i)}>
                                No
                              </button>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
            {partial && <div className="buds-msg me opacity-60">{partial}…</div>}
            {busy && <div className="buds-msg bud opacity-60">…</div>}
            {error && <div className="buds-msg hint text-haven-danger">{error}</div>}
          </div>

          {msgs.length < 2 && (
            <div className="flex flex-wrap gap-1 px-3 pb-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="pill transition-colors hover:border-white/25 hover:text-t1" onClick={() => void ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <form
            className="buds-form"
            onSubmit={(e) => {
              e.preventDefault()
              const q = text
              setText('')
              void ask(q)
            }}
          >
            <button
              type="button"
              className={`buds-mic ${listening ? 'is-on' : ''}`}
              disabled={!supported}
              onClick={() => (listening ? stopListening() : startListening(false))}
              title={supported ? (listening ? 'Stop listening' : 'Talk to Buds (push-to-talk)') : 'No speech recognition in this browser'}
            >
              {listening ? '■' : '🎤'}
            </button>
            <input className="input flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder={handsFree ? 'Listening hands-free… just talk' : `Ask ${NAME} anything on screen…`} />
          </form>
        </div>
      )}
      <button className={`buds-orb is-${status} ${open ? 'is-open' : ''}`} onClick={() => setOpen((o) => !o)} title={`${NAME} · click to chat · Alt+Shift+V to talk hands-free`} aria-label={`Open ${NAME}`}>
        <BudsGlyph />
        <span className="buds-orb-ring" />
      </button>
    </div>
  )
}

function BudsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="11" r="1.4" fill="currentColor" />
      <circle cx="15" cy="11" r="1.4" fill="currentColor" />
      <path d="M8.5 15.2c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// ---- pointing --------------------------------------------------------------------------------------

/** Ask the app to show the right tab / floor, then fly the cursor to the element and ring it. */
export function point(focus: BudsFocus[]): void {
  window.dispatchEvent(new CustomEvent('haven:focus', { detail: focus }))
  let tries = 0
  const go = () => {
    const f = focus.find((x) => document.querySelector(`[data-buds="${CSS.escape(focusKey(x))}"]`)) ?? focus[0]
    const el = document.querySelector<HTMLElement>(`[data-buds="${CSS.escape(focusKey(f))}"]`)
    if (!el) {
      if (tries++ < 6) setTimeout(go, 120)
      return
    }
    el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    setTimeout(() => window.dispatchEvent(new CustomEvent('buds:point', { detail: { el } })), 260)
  }
  requestAnimationFrame(go)
}

/** The cursor and ring that fly to whatever Buds is talking about. */
function Pointer() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [ring, setRing] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    let hide: ReturnType<typeof setTimeout> | undefined
    const onPoint = (e: Event) => {
      const el = (e as CustomEvent<{ el: HTMLElement }>).detail.el
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      setVisible(true)
      setPos({ x: r.left + r.width * 0.5, y: r.top + Math.min(r.height * 0.5, 22) })
      setRing({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 })
      clearTimeout(hide)
      hide = setTimeout(() => {
        setRing(null)
        setVisible(false)
      }, 3200)
    }
    window.addEventListener('buds:point', onPoint)
    return () => {
      window.removeEventListener('buds:point', onPoint)
      clearTimeout(hide)
    }
  }, [])
  return (
    <>
      {ring && <div className="buds-ring" style={{ left: ring.x, top: ring.y, width: ring.w, height: ring.h }} />}
      {pos && (
        <div className={`buds-cursor ${visible ? 'is-on' : ''}`} style={{ left: pos.x, top: pos.y }} aria-hidden="true">
          <svg viewBox="0 0 16 20" width="18" height="22">
            <path d="M1 1 L15 11 L8.5 12 L5 19 Z" fill="#0a84ff" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          <span className="buds-cursor-tag">{NAME}</span>
        </div>
      )}
    </>
  )
}
