import { motionValue } from 'motion/react'

/**
 * The one number the landing page tells its story with. `storyT` runs from -1 (top of the hero) through
 * 0 (the first chapter) to 5 (the last); the DOM chapters and the 3D building both read it, so the words
 * and the picture can never drift apart. The pointer is kept outside React for the same reason.
 */
export const CHAPTER_COUNT = 6
export const storyT = motionValue(-1)
export const pointer = { x: 0, y: 0 }
/** DOM labels the 3D scene positions over the canvas each frame (no React render per frame). */
export const tags: { person: HTMLElement | null } = { person: null }

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
export const smooth = (a: number, b: number, v: number) => {
  const u = clamp01((v - a) / (b - a))
  return u * u * (3 - 2 * u)
}

/** Each chapter holds still in its middle so it can be read, and glides between neighbours. */
export function dwell(c: number): number {
  const i = Math.floor(c)
  return i + smooth(0.28, 0.72, c - i)
}

/** What the building is going through at story time t (all 0..1). */
export function moods(t: number) {
  return {
    water: smooth(0.35, 1.15, t) * (1 - smooth(3.9, 4.8, t)),
    leak: smooth(0.25, 0.7, t) * (1 - smooth(3.6, 4.3, t)),
    xray: smooth(0.55, 1.1, t) * (1 - smooth(2.4, 2.9, t)),
    danger: smooth(1.3, 2.0, t) * (1 - smooth(3.7, 4.5, t)),
    dark: smooth(1.6, 2.2, t) * (1 - smooth(4.2, 4.9, t)),
    person: smooth(2.35, 2.95, t),
    protect: smooth(3.4, 4.2, t),
    together: smooth(4.4, 5, t),
  }
}

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
