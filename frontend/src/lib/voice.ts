// Voice input for Buds (browser only): push-to-talk and a hands-free conversation mode on the
// Web Speech API. Everything here is a thin, interruptible wrapper; nothing touches world state.

interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((ev: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function ctor(): (new () => RecognitionLike) | null {
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const voiceSupported = () => ctor() !== null

export function micError(code?: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked; allow it in the browser, or type instead.'
    case 'audio-capture':
      return 'No microphone found; type to Buds instead.'
    case 'network':
      return 'Speech recognition needs a network connection.'
    case 'no-speech':
      return "I didn't catch anything."
    default:
      return 'Voice input stopped; try again or type instead.'
  }
}

export interface Listener {
  stop: () => void
  cancel: () => void
}

/**
 * Listen until the speaker pauses (push-to-talk) or, when `continuous`, keep listening and emit a
 * final phrase at every pause (hands-free). `onPartial` fires with live text, which Buds uses to
 * stop talking the moment the person starts (barge-in).
 */
export function listen(cb: {
  continuous?: boolean
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError: (message: string) => void
  onEnd?: () => void
}): Listener | null {
  const C = ctor()
  if (!C) {
    cb.onError('Speech recognition is not available in this browser.')
    return null
  }
  const rec = new C()
  rec.lang = navigator.language || 'en-US'
  rec.continuous = !!cb.continuous
  rec.interimResults = true
  let cancelled = false
  let stopped = false
  rec.onresult = (ev) => {
    let interim = ''
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i]
      const t = r[0].transcript
      if (r.isFinal) {
        const phrase = t.trim()
        if (phrase) cb.onFinal(phrase)
      } else interim += t
    }
    if (interim.trim()) cb.onPartial(interim.trim())
  }
  rec.onerror = (ev) => {
    if (cancelled || ev.error === 'aborted') return
    cb.onError(micError(ev.error))
  }
  rec.onend = () => {
    if (cancelled) return
    if (cb.continuous && !stopped) {
      try {
        rec.start() // Chrome ends continuous sessions after a while; pick up where we were.
        return
      } catch {
        /* fall through */
      }
    }
    cb.onEnd?.()
  }
  try {
    rec.start()
  } catch {
    cb.onError(micError())
    return null
  }
  return {
    stop: () => {
      stopped = true
      rec.stop()
    },
    cancel: () => {
      cancelled = true
      stopped = true
      rec.abort()
    },
  }
}

/** Is this transcript just Buds hearing itself through the speakers? */
export function soundsLikeEcho(heard: string, spoken: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const h = norm(heard)
  const s = norm(spoken)
  if (!h || !s) return false
  if (s.includes(h)) return true
  const words = h.split(' ')
  const hit = words.filter((w) => w.length > 3 && s.includes(w)).length
  return words.length >= 3 && hit / words.length > 0.7
}
