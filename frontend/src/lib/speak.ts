// Spoken lines: ElevenLabs through the backend when a key is configured, Cartesia next, otherwise
// the browser's own speech synthesis. Audio is a rendering of a message the plan already contains;
// it never changes state. Playback is interruptible (Buds stops talking the moment you do).

let current: HTMLAudioElement | null = null
let onEnd: (() => void) | null = null

export type SpeakSource = 'elevenlabs' | 'cartesia' | 'browser' | 'none'

export function isSpeaking(): boolean {
  if (current && !current.paused && !current.ended) return true
  return 'speechSynthesis' in window && window.speechSynthesis.speaking
}

export async function speak(text: string, lang = 'en', opts: { onEnd?: () => void } = {}): Promise<SpeakSource> {
  stopSpeaking()
  onEnd = opts.onEnd ?? null
  const finish = () => {
    const cb = onEnd
    onEnd = null
    cb?.()
  }
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang }),
    })
    if (res.ok) {
      const provider = (res.headers.get('X-Voice-Provider') as SpeakSource | null) ?? 'cartesia'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      current = new Audio(url)
      current.onended = () => {
        URL.revokeObjectURL(url)
        finish()
      }
      await current.play()
      return provider
    }
  } catch {
    // fall through to the browser voice
  }
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = { en: 'en-US', es: 'es-ES', zh: 'zh-CN', ko: 'ko-KR', vi: 'vi-VN', hi: 'hi-IN' }[lang] ?? 'en-US'
    u.rate = 1.0
    u.onend = finish
    window.speechSynthesis.speak(u)
    return 'browser'
  }
  finish()
  return 'none'
}

export function stopSpeaking(): void {
  if (current) {
    current.pause()
    current = null
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  onEnd = null
}
