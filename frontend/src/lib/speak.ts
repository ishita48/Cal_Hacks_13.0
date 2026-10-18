// Spoken alerts: Cartesia through the backend when a key is configured, otherwise the browser's
// own speech synthesis. Audio is a rendering of a message the plan already contains; it never
// changes state.

let current: HTMLAudioElement | null = null

export type SpeakSource = 'cartesia' | 'browser' | 'none'

export async function speak(text: string, lang = 'en'): Promise<SpeakSource> {
  stopSpeaking()
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang }),
    })
    if (res.ok) {
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      current = new Audio(url)
      current.onended = () => URL.revokeObjectURL(url)
      await current.play()
      return 'cartesia'
    }
  } catch {
    // fall through to the browser voice
  }
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = { en: 'en-US', es: 'es-ES', zh: 'zh-CN', ko: 'ko-KR', vi: 'vi-VN', hi: 'hi-IN' }[lang] ?? 'en-US'
    u.rate = 1.0
    window.speechSynthesis.speak(u)
    return 'browser'
  }
  return 'none'
}

export function stopSpeaking(): void {
  if (current) {
    current.pause()
    current = null
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}
