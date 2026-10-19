import { useEffect, useState } from 'react'

/**
 * The theme follows the device unless the viewer picks one. The choice ('system' | 'light' | 'dark') is a
 * per-viewer convenience in localStorage (`haven.theme`); `.dark` on <html> repaints every token. index.html
 * applies the same rule before the first paint so nothing flashes.
 */
export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'haven.theme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')

export function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function resolve(pref: ThemePref, systemDark: boolean): 'light' | 'dark' {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
}

function apply(pref: ThemePref) {
  document.documentElement.classList.toggle('dark', resolve(pref, media().matches) === 'dark')
}

/** Keeps <html> in step with the device while the preference is 'system'. Call once at startup. */
export function initTheme() {
  apply(readPref())
  media().addEventListener('change', () => apply(readPref()))
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref)
  useEffect(() => {
    apply(pref)
    try {
      if (pref === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, pref)
    } catch {
      /* private window: the choice lasts this visit */
    }
  }, [pref])
  const next: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' }
  return { pref, setPref, cycle: () => setPref((p) => next[p]) }
}
