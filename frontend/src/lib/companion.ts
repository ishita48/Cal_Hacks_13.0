/**
 * The companion cursor: a soft arrow that rides next to the person's mouse, bobs, wears a mood ring
 * (listening / thinking / speaking / pointing), carries a speech bubble, and flies to whatever Buds is
 * talking about before coming back. DOM only, one rAF loop, nothing React needs to re-render.
 *
 * Modelled on StudyO's Clicky engine: goal = pointing target > mouse + offset; eased flight; the loop
 * stops ticking once idle and restarts on the next mouse move.
 */

type Pt = { x: number; y: number }
export type Mood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'pointing'

const OFFSET: Pt = { x: 16, y: 18 }

const CURSOR_SVG = `<div class="buds-bob"><svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="buds-cg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>
<path d="M4 3 L29 15 L17.5 18 L12.5 30 Z" fill="url(#buds-cg)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
</svg></div>`

export class Companion {
  private cursor: HTMLDivElement | null = null
  private sayEl: HTMLDivElement | null = null
  private ringEl: HTMLDivElement | null = null
  private pos: Pt | null = null
  private mouse: Pt | null = null
  private following = false
  private target: { el: Element; until: number } | null = null
  private raf = 0
  private ringTimer: ReturnType<typeof setTimeout> | undefined
  private onMouse = (e: PointerEvent) => {
    this.mouse = { x: e.clientX, y: e.clientY }
    if (this.following) this.kick()
  }

  private mount(): void {
    if (this.cursor || typeof document === 'undefined') return
    const c = document.createElement('div')
    c.className = 'buds-cursor'
    c.setAttribute('data-buds-ui', '')
    c.setAttribute('aria-hidden', 'true')
    c.innerHTML = CURSOR_SVG
    document.body.appendChild(c)
    this.cursor = c
  }

  destroy(): void {
    window.removeEventListener('pointermove', this.onMouse)
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.cursor?.remove()
    this.sayEl?.remove()
    this.ringEl?.remove()
    this.cursor = this.sayEl = this.ringEl = null
  }

  /** Companion mode: the cursor rides next to the mouse. */
  follow(on: boolean): void {
    this.mount()
    if (on === this.following) return
    this.following = on
    if (on) {
      window.addEventListener('pointermove', this.onMouse, { passive: true })
      if (!this.pos) this.pos = this.mouse ?? { x: innerWidth - 120, y: innerHeight - 140 }
      this.cursor?.classList.add('is-in')
      this.kick()
    } else {
      window.removeEventListener('pointermove', this.onMouse)
      if (!this.target) this.cursor?.classList.remove('is-in')
      this.say(null)
      this.setMood('idle')
    }
  }

  get isFollowing(): boolean {
    return this.following
  }

  setMood(mood: Mood): void {
    this.cursor?.setAttribute('data-mood', mood)
  }

  /** A speech bubble that travels with the cursor (null hides it). */
  say(text: string | null): void {
    if (!text) {
      const el = this.sayEl
      this.sayEl = null
      el?.classList.remove('is-in')
      if (el) setTimeout(() => el.remove(), 220)
      return
    }
    this.mount()
    if (!this.sayEl) {
      const el = document.createElement('div')
      el.className = 'buds-say'
      el.setAttribute('data-buds-ui', '')
      el.setAttribute('role', 'status')
      document.body.appendChild(el)
      this.sayEl = el
      requestAnimationFrame(() => el.classList.add('is-in'))
    }
    this.sayEl.textContent = text
    this.kick()
  }

  /** Fly to an element, ring it, then drift back to the mouse. */
  pointAt(el: Element, ms = 3200): void {
    this.mount()
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return
    this.target = { el, until: performance.now() + ms }
    this.cursor?.classList.add('is-in')
    this.setMood('pointing')
    if (!this.ringEl) {
      const ring = document.createElement('div')
      ring.className = 'buds-ring'
      ring.setAttribute('data-buds-ui', '')
      document.body.appendChild(ring)
      this.ringEl = ring
    }
    Object.assign(this.ringEl.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` })
    clearTimeout(this.ringTimer)
    this.ringTimer = setTimeout(() => {
      this.ringEl?.remove()
      this.ringEl = null
    }, ms)
    this.kick()
  }

  private kick(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick)
  }

  private tick = (): void => {
    this.raf = 0
    if (!this.cursor) return
    const now = performance.now()
    if (this.target && now > this.target.until) {
      this.target = null
      this.setMood('idle')
      if (!this.following) this.cursor.classList.remove('is-in')
    }
    let goal: Pt | null = null
    if (this.target) {
      const r = this.target.el.getBoundingClientRect()
      goal = { x: r.left + Math.min(r.width * 0.5, 160), y: r.top + Math.min(r.height * 0.5, 22) }
    } else if (this.following && this.mouse) {
      goal = { x: this.mouse.x + OFFSET.x, y: this.mouse.y + OFFSET.y }
    }
    if (!goal) return
    if (!this.pos) this.pos = { ...goal }
    const k = this.target ? 0.12 : 0.22
    const dx = goal.x - this.pos.x
    const dy = goal.y - this.pos.y
    this.pos = { x: this.pos.x + dx * k, y: this.pos.y + dy * k }
    this.cursor.style.transform = `translate(${this.pos.x.toFixed(1)}px, ${this.pos.y.toFixed(1)}px)`
    if (this.sayEl) {
      const bw = this.sayEl.offsetWidth || 200
      const bh = this.sayEl.offsetHeight || 40
      let x = this.pos.x + 30
      let y = this.pos.y + 26
      if (x + bw > innerWidth - 12) x = this.pos.x - bw - 8
      if (y + bh > innerHeight - 12) y = this.pos.y - bh - 8
      this.sayEl.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`
    }
    const moving = Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4
    if (moving || this.target) this.raf = requestAnimationFrame(this.tick)
  }
}
