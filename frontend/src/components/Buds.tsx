import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { api } from '../lib/api'
import { Companion, type Mood } from '../lib/companion'
import { isSpeaking, speak, stopSpeaking } from '../lib/speak'
import { listen, soundsLikeEcho, voiceSupported, type Listener } from '../lib/voice'
import { useBuilding } from '../state/building'
import { useWorld } from '../state/world'
import type { BudsAction, BudsFocus, BudsReply } from '../state/types'

/**
 * Buds: the companion on the screen, in the spirit of StudyO's Clicky. When it is on, a soft cursor
 * rides next to your mouse. Hold Ctrl+Alt (Cmd+Alt on a Mac) and talk; release to send. It answers
 * from the one world state, says the answer out loud in a bubble by the cursor, flies to the agent
 * card, plan step, floor or panel it is talking about, and offers actions that only run after you
 * approve them: Buds proposes, the human gates, the world changes through the same input events a
 * button sends.
 *
 * Keys: Alt+B on/off · hold Ctrl+Alt to talk · Alt+C chat panel · Alt+Shift+V hands-free · Esc hush.
 * Off by default: off, nothing of Buds is on screen, it never listens or speaks, and only Alt+B or the
 * switch in the top bar / System health (`useBudsOn`) turns it on.
 */

const NAME = 'Buds'
const ECHO_TAIL_MS = 1500
const HOLD_MS = 180
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const HOLD_LABEL = IS_MAC ? '⌘+⌥' : 'Ctrl+Alt'
// A new key, so a browser that had Buds on under the old default starts with it off too.
const ON_KEY = 'haven.buds.enabled'

/** Whether Buds is on: a per-viewer preference shared by the companion and the switches that drive it. */
export const useBudsOn = create<{ on: boolean; setOn: (on: boolean) => void; toggle: () => void }>((set, get) => ({
  on: (() => {
    try {
      return localStorage.getItem(ON_KEY) === '1'
    } catch {
      return false
    }
  })(),
  setOn: (on) => {
    try {
      localStorage.setItem(ON_KEY, on ? '1' : '0')
    } catch {
      /* a private window: the choice lasts this visit */
    }
    set({ on })
  },
  toggle: () => get().setOn(!get().on),
}))

interface Msg {
  id: number
  role: 'me' | 'bud' | 'hint'
  text: string
  reply?: BudsReply
  acted?: Record<number, 'done' | 'dismissed' | 'error'>
}

const SUGGESTIONS = (first: string | undefined) => [first ? `Where is ${first}?` : 'Who is affected?', 'Why are the lifts held?', 'What happens if nobody acts?', 'Who is left behind?']

let nextId = 1

export function focusKey(f: BudsFocus): string {
  return `${f.kind}:${f.id}`
}

export function Buds() {
  const active = useBudsOn((b) => b.on)
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [holding, setHolding] = useState(false)
  const [handsFree, setHandsFree] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [muted, setMuted] = useState(false)
  const [partial, setPartial] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [nudge, setNudge] = useState<string | null>(null)
  const companion = useRef<Companion | null>(null)
  const listener = useRef<Listener | null>(null)
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; listening: boolean } | null>(null)
  const spoken = useRef({ text: '', endedAt: 0 })
  const sayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const supported = voiceSupported()
  const world = useWorld((s) => s.world)
  const replay = world?.mode === 'replay'
  const storyIds = useBuilding((b) => b.storyIds)
  const residents = useBuilding((b) => b.residents)
  const firstName = storyIds[0] ? residents[storyIds[0]]?.name.split(' ')[0] : undefined
  const openRef = useRef(open)
  openRef.current = open
  const activeRef = useRef(active)
  activeRef.current = active

  // The companion lives in the DOM for the life of the app; following is on while Buds is on.
  useEffect(() => {
    const c = new Companion()
    companion.current = c
    return () => c.destroy()
  }, [])
  useEffect(() => {
    companion.current?.follow(active)
  }, [active])

  const status: Mood = speaking ? 'speaking' : listening ? 'listening' : busy ? 'thinking' : 'idle'
  useEffect(() => {
    companion.current?.setMood(status)
  }, [status])

  // A gentle nudge the first time there is a plan to talk about.
  const nudged = useRef(false)
  useEffect(() => {
    if (!world || nudged.current || open || !active) return
    if (world.plan.status !== 'none') {
      nudged.current = true
      setNudge(`There is a plan. Hold ${HOLD_LABEL} and ask me why the lifts are held.`)
      const t = setTimeout(() => setNudge(null), 9000)
      return () => clearTimeout(t)
    }
  }, [world, open, active])

  useEffect(() => {
    list.current?.scrollTo?.({ top: list.current.scrollHeight, behavior: 'smooth' })
  }, [msgs, partial])

  /** Show a line in the bubble by the cursor (when the panel is closed). */
  const bubble = useCallback((line: string | null, holdMs = 0) => {
    if (sayTimer.current) clearTimeout(sayTimer.current)
    sayTimer.current = null
    const c = companion.current
    if (!c) return
    if (!line || openRef.current || !activeRef.current) {
      c.say(null)
      return
    }
    c.say(line)
    if (holdMs) sayTimer.current = setTimeout(() => c.say(null), holdMs)
  }, [])

  const say = useCallback(
    (line: string) => {
      if (muted) {
        bubble(line, 6000)
        return
      }
      bubble(line)
      spoken.current = { text: line, endedAt: 0 }
      setSpeaking(true)
      void speak(line, 'en', {
        onEnd: () => {
          spoken.current.endedAt = Date.now()
          setSpeaking(false)
          bubble(line, 2500)
        },
      })
    },
    [bubble, muted],
  )

  const hush = useCallback(() => {
    if (isSpeaking()) {
      stopSpeaking()
      spoken.current.endedAt = Date.now()
      setSpeaking(false)
    }
    bubble(null)
  }, [bubble])

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
  const askRef = useRef(ask)
  askRef.current = ask

  // ---- voice in --------------------------------------------------------------------------------
  const stopListening = useCallback(() => {
    listener.current?.cancel()
    listener.current = null
    setListening(false)
    setPartial('')
  }, [])

  const startListening = useCallback(
    (mode: 'tap' | 'hold' | 'converse') => {
      stopListening()
      let heard = ''
      const l = listen({
        continuous: mode !== 'tap',
        onPartial: (t) => {
          const echo = (isSpeaking() || Date.now() - spoken.current.endedAt < ECHO_TAIL_MS) && soundsLikeEcho(t, spoken.current.text)
          if (echo) return
          hush()
          setPartial(t)
          if (mode === 'hold') bubble(`${t}…`)
        },
        onFinal: (t) => {
          const echo = Date.now() - spoken.current.endedAt < ECHO_TAIL_MS && soundsLikeEcho(t, spoken.current.text)
          setPartial('')
          if (echo) return
          if (/^(stop|quiet|shush|be quiet|hush)\.?$/i.test(t)) {
            hush()
            return
          }
          if (mode === 'hold') {
            heard = `${heard} ${t}`.trim()
            return // sent on release
          }
          void askRef.current(t)
          if (mode === 'tap') stopListening()
        },
        onError: (m) => {
          setError(m)
          bubble(m, 4000)
          setListening(false)
          setHandsFree(false)
        },
        onEnd: () => {
          setListening(false)
          if (mode === 'converse') setHandsFree(false)
        },
      })
      listener.current = l
      if (l && mode === 'hold') {
        const base = l.stop
        l.stop = () => {
          base()
          const q = heard.trim()
          heard = ''
          if (q) void askRef.current(q)
        }
      }
      setListening(!!l)
      if (!l) setHandsFree(false)
    },
    [bubble, hush, stopListening],
  )
  const startRef = useRef(startListening)
  startRef.current = startListening

  useEffect(() => () => stopListening(), [stopListening])

  const toggleHandsFree = useCallback(() => {
    if (handsFree) {
      setHandsFree(false)
      stopListening()
    } else {
      setHandsFree(true)
      startListening('converse')
    }
  }, [handsFree, startListening, stopListening])

  // Switched off: stop listening and talking, fold the chat, put the cursor away.
  useEffect(() => {
    if (active) return
    stopListening()
    setHandsFree(false)
    setOpen(false)
    setNudge(null)
    hush()
  }, [active, hush, stopListening])

  // ---- keys: Alt+B on/off · hold Ctrl+Alt to talk · Alt+C panel · Alt+Shift+V hands-free · Esc --
  useEffect(() => {
    const isHold = (e: KeyboardEvent) => (IS_MAC ? e.metaKey : e.ctrlKey) && e.altKey
    const endHold = (send: boolean) => {
      const h = hold.current
      if (!h) return
      if (h.timer) clearTimeout(h.timer)
      hold.current = null
      setHolding(false)
      if (h.listening) {
        const l = listener.current
        listener.current = null
        setListening(false)
        setPartial('')
        if (send) l?.stop()
        else l?.cancel()
      }
    }
    const onDown = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        toggleHandsFree()
        return
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        useBudsOn.getState().toggle()
        return
      }
      // Off, Buds hears no other key: Ctrl+Alt stays an ordinary chord.
      if (!activeRef.current) return
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        setOpen((o) => {
          if (!o) setTimeout(() => input.current?.focus(), 50)
          return !o
        })
        return
      }
      // Hold-to-talk: only the two modifiers, held briefly, so real chords and AltGr typing stay untouched.
      if (isHold(e) && ['Control', 'Alt', 'Meta'].includes(e.key)) {
        if (!hold.current && !e.repeat && supported) {
          hold.current = {
            listening: false,
            timer: setTimeout(() => {
              if (!hold.current) return
              hold.current.listening = true
              setHolding(true)
              startRef.current('hold')
            }, HOLD_MS),
          }
        }
        return
      }
      if (hold.current && !['Control', 'Alt', 'Meta'].includes(e.key)) endHold(false)
      if (e.key === 'Escape') hush()
    }
    const onUp = (e: KeyboardEvent) => {
      if (hold.current && !isHold(e)) endHold(true)
    }
    const onBlur = () => endHold(true)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [hush, supported, toggleHandsFree])

  // Pointing requests (from answers, or any panel) fly the companion cursor there.
  useEffect(() => {
    const onPoint = (e: Event) => {
      const el = (e as CustomEvent<{ el: HTMLElement }>).detail.el
      if (activeRef.current) companion.current?.pointAt(el)
    }
    window.addEventListener('buds:point', onPoint)
    return () => window.removeEventListener('buds:point', onPoint)
  }, [])

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

  const lastOffer = [...msgs].reverse().find((m) => m.reply?.actions.length && !m.acted)
  const pendingOffer = !open && lastOffer?.reply?.actions[0]

  if (!active) return null

  return (
    <div data-buds-ui="">
      {holding && <div className="buds-hold">Listening… release {HOLD_LABEL} to send{partial ? `: “${partial}”` : ''}</div>}
      {nudge && !open && !pendingOffer && (
        <button className="buds-nudge glass-card" onClick={() => setOpen(true)}>
          {nudge}
        </button>
      )}
      {pendingOffer && lastOffer && (
        <div className="buds-nudge glass-card flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{pendingOffer.label}</span>
          <button className="btn-primary btn-sm" disabled={replay} onClick={() => void act(lastOffer, 0, pendingOffer)}>
            Approve
          </button>
          <button className="btn-secondary btn-sm" onClick={() => dismiss(lastOffer, 0)}>
            No
          </button>
        </div>
      )}
      {open && (
        <div className="buds-panel glass" role="dialog" aria-label={NAME}>
          <div className="buds-head">
            <span className={`buds-dot is-${status}`} />
            <span className="text-[12px] font-semibold text-t1">{NAME}</span>
            <span className="label ml-1">{status === 'idle' ? `hold ${HOLD_LABEL} to talk` : status}</span>
            <div className="ml-auto flex items-center gap-1">
              <button className={`buds-ib ${handsFree ? 'is-on' : ''}`} onClick={toggleHandsFree} disabled={!supported} title={supported ? 'Hands-free conversation (Alt+Shift+V): talk, interrupt any time' : 'No speech recognition in this browser'}>
                🎧
              </button>
              <button className={`buds-ib ${muted ? 'is-on' : ''}`} onClick={() => { if (!muted) hush(); setMuted((m) => !m) }} title={muted ? 'Unmute Buds' : 'Mute Buds'}>
                {muted ? '🔇' : '🔊'}
              </button>
              <button className="buds-ib" onClick={() => useBudsOn.getState().setOn(false)} title="Turn Buds off (Alt+B)" aria-label="Turn Buds off">
                ⏻
              </button>
              <button className="buds-ib" onClick={() => setOpen(false)} title="Hide chat (Alt+C)">
                ×
              </button>
            </div>
          </div>

          <div className="buds-list" ref={list}>
            {msgs.length === 0 && (
              <div className="buds-msg bud">
                I'm {NAME}. I follow your cursor; hold {HOLD_LABEL} and ask me anything on screen and I'll point at it. I can switch an agent, impose a rule or approve the plan, but only after you approve.
              </div>
            )}
            {msgs.map((m) => (
              <div key={m.id} className={`buds-msg ${m.role}`}>
                {m.text}
                {m.reply && m.reply.source === 'llm' && <span className="mono ml-1.5 text-[9px] opacity-70">claude</span>}
                {m.reply && m.reply.focus.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {m.reply.focus.map((f) => (
                      <button key={focusKey(f)} className="pill pill-purple" onClick={() => point([f])} title={`Point at ${focusKey(f)}`}>
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
              {SUGGESTIONS(firstName).map((s) => (
                <button key={s} className="pill transition-colors hover:text-t1" onClick={() => void ask(s)}>
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
              onClick={() => (listening ? stopListening() : startListening('tap'))}
              title={supported ? (listening ? 'Stop listening' : `Talk to Buds (or hold ${HOLD_LABEL})`) : 'No speech recognition in this browser'}
            >
              {listening ? '■' : '🎤'}
            </button>
            <input ref={input} className="input flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder={handsFree ? 'Listening hands-free… just talk' : `Ask ${NAME} anything on screen…`} />
          </form>
        </div>
      )}
      <button className="buds-chat-toggle" onClick={() => setOpen((o) => !o)} title={open ? 'Hide chat (Alt+C)' : 'Chat with Buds (Alt+C)'} aria-label={open ? 'Hide chat' : 'Chat with Buds'}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 3 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 9 8.4z" />
        </svg>
      </button>
      <button
        className={`buds-orb is-${status}`}
        onClick={() => setOpen((o) => !o)}
        title={`${NAME} · hold ${HOLD_LABEL} to talk · Alt+C chat · Alt+B off`}
        aria-label={`Open ${NAME}`}
      >
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

/** Ask the app to show the right tab / floor, then fly the companion to the element and ring it. */
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
