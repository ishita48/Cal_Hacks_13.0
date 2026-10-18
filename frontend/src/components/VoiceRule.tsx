import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { MemoryRule, RuleParse, WorldState } from '../state/types'

interface Props {
  world: WorldState
}

const EXAMPLES = ['Nobody gets moved off campus', 'No one moves after midnight', "Don't wake anyone", 'Everyone shelters in place']

// Minimal typing for the Web Speech API (not in the DOM lib for every TS target).
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((ev: { error?: string }) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function speechCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Governance by voice: the manager says a rule, it becomes a constraint every agent obeys. */
export function VoiceRule({ world }: Props) {
  const [text, setText] = useState('')
  const [interim, setInterim] = useState('')
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RuleParse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const supported = speechCtor() !== null
  const replay = world.mode === 'replay'

  // Cross-incident memory: rules spoken in earlier runs, offered back with one tap.
  const [memory, setMemory] = useState<MemoryRule[]>([])
  useEffect(() => {
    api.memory().then(setMemory).catch(() => {})
  }, [world.run_id, world.rules.length])
  const remembered = memory.filter((m) => !m.active)
  const applyMemory = (code: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    api
      .applyMemory(code)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  useEffect(() => () => recRef.current?.abort(), [])

  const submit = (phrase: string) => {
    const t = phrase.trim()
    if (!t || busy) return
    setBusy(true)
    setError(null)
    api
      .parseRule(t)
      .then((r) => {
        setResult(r)
        setText('')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const listen = () => {
    const Ctor = speechCtor()
    if (!Ctor) return
    if (listening) {
      recRef.current?.stop()
      return
    }
    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.interimResults = true
    rec.continuous = false
    let finalText = ''
    rec.onresult = (ev) => {
      let heard = ''
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i]
        heard += res[0].transcript
        if (res.isFinal) finalText = heard
      }
      setInterim(heard)
    }
    rec.onerror = (ev) => {
      setError(ev.error ? `speech: ${ev.error}` : 'speech recognition failed')
      setListening(false)
    }
    rec.onend = () => {
      setListening(false)
      setInterim('')
      if (finalText) submit(finalText)
    }
    recRef.current = rec
    setInterim('')
    setError(null)
    setListening(true)
    rec.start()
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Say a rule</span>
        <span className="label">manager</span>
      </div>

      <div className="relative">
        <input
          value={listening ? interim : text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(text)
          }}
          disabled={replay || listening}
          placeholder={listening ? 'Listening…' : supported ? 'Speak, or type a rule and press Return' : 'Type a rule and press Return'}
          className="input"
        />
        <button
          disabled={!supported || replay}
          onClick={listen}
          title={supported ? (listening ? 'Stop listening' : 'Speak a rule') : 'Speech recognition not available in this browser'}
          aria-label={listening ? 'Stop listening' : 'Speak a rule'}
          className={`absolute top-1/2 right-1.5 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-white transition-all disabled:opacity-35 ${
            listening ? 'bg-haven-danger haven-ring' : 'bg-haven-blue hover:brightness-110'
          }`}
        >
          {listening ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <rect width="10" height="10" rx="2" />
            </svg>
          ) : (
            <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
              <rect x="3.5" y="0" width="5" height="8" rx="2.5" />
              <path d="M1 6.5a5 5 0 0 0 10 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M6 11.5v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button key={ex} disabled={replay || busy} onClick={() => submit(ex)} className="pill transition-colors hover:border-white/25 hover:text-t1 disabled:opacity-35">
            “{ex}”
          </button>
        ))}
      </div>

      {remembered.length > 0 && !replay && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="label">last time you said</span>
          {remembered.slice(0, 3).map((m) => (
            <button key={m.code} disabled={busy} onClick={() => applyMemory(m.code)} className="pill pill-amber transition-colors hover:brightness-110 disabled:opacity-35" title={`${m.code} · used ${m.times}× before · tap to apply again`}>
              “{m.text}”{m.times > 1 ? ` ×${m.times}` : ''}
            </button>
          ))}
        </div>
      )}

      {result && (
        <div className={`glass-card px-3 py-2 ${result.confident ? 'tint-green' : 'tint-amber'}`}>
          <div className={`eyebrow ${result.confident ? 'text-haven-safe' : 'text-haven-amber'}`}>{result.confident ? 'Rule in force' : 'Not understood · not enforced'}</div>
          <div className="mt-0.5 text-[12px] text-t1">“{result.text}”</div>
          <div className="mono mt-0.5 text-[10px] text-t2">{result.confident ? `${result.code} · ${result.summary}` : result.summary}</div>
        </div>
      )}
      {error && <p className="text-[11px] text-haven-danger">{error}</p>}

      {world.rules.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {world.rules.map((r, i) => (
            <span key={`${r.code}-${i}`} className="pill pill-blue" title={r.code}>
              {r.rule}
              <span className="rounded-full bg-haven-blue/25 px-1.5 text-[9px] text-t1">{r.source}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
