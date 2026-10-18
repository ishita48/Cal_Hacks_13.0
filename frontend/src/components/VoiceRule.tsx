import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { RuleParse, WorldState } from '../state/types'

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
    <div className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Say a rule · manager</h2>
      <div className="flex gap-2">
        <button
          disabled={!supported || replay}
          onClick={listen}
          title={supported ? (listening ? 'Stop listening' : 'Speak a rule') : 'Speech recognition not available in this browser'}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-base ${
            listening ? 'border-haven-danger bg-haven-danger/20 text-haven-danger haven-pulse' : 'border-ink-600 bg-ink-800 text-slate-200 hover:bg-ink-700'
          } disabled:opacity-30`}
        >
          {listening ? '■' : '🎤'}
        </button>
        <input
          value={listening ? interim : text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(text)
          }}
          disabled={replay || listening}
          placeholder={listening ? 'listening…' : supported ? 'or type a rule and press Enter' : 'type a rule and press Enter'}
          className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-950 px-2 py-1.5 text-sm text-white placeholder:text-slate-600 focus:border-slate-400 focus:outline-none disabled:opacity-50"
        />
      </div>

      <div className="flex flex-wrap gap-1">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            disabled={replay || busy}
            onClick={() => submit(ex)}
            className="rounded border border-ink-600 px-1.5 py-px text-[10px] text-slate-400 hover:border-slate-400 hover:text-slate-200 disabled:opacity-40"
          >
            “{ex}”
          </button>
        ))}
      </div>

      {result && (
        <div
          className={`rounded border px-2.5 py-1.5 text-xs ${
            result.confident ? 'border-haven-safe/50 bg-haven-safe/10 text-haven-safe' : 'border-amber-400/50 bg-amber-400/10 text-amber-400'
          }`}
        >
          <div className="text-[10px] uppercase tracking-wider opacity-80">{result.confident ? 'rule in force' : 'not understood, not enforced'}</div>
          <div className="text-slate-100">“{result.text}”</div>
          <div className="font-mono text-[10px] opacity-90">
            {result.confident ? `${result.code} · ${result.summary}` : result.summary}
          </div>
        </div>
      )}
      {error && <p className="text-xs text-haven-danger">{error}</p>}

      {world.rules.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {world.rules.map((r, i) => (
            <span key={`${r.code}-${i}`} className="rounded border border-amber-400/50 bg-amber-400/10 px-1.5 py-px text-[10px] text-amber-300" title={r.code}>
              {r.rule} <span className="text-amber-400/60">· {r.source}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
