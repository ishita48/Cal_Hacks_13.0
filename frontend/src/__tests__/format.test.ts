import { describe, expect, it } from 'vitest'
import { formatClockHM, formatCountdown, formatTimeOfDay } from '../lib/api'
import { IMPACT_LABEL, STATUS_COLOR } from '../lib/labels'

describe('time formatting', () => {
  it('renders the scenario clock', () => {
    expect(formatTimeOfDay(23 * 3600 + 41 * 60 + 30)).toBe('23:41:30')
    expect(formatClockHM(23 * 3600 + 41 * 60 + 30)).toBe('23:41')
    expect(formatTimeOfDay(86400 + 5)).toBe('00:00:05')
  })
  it('counts down in human units', () => {
    expect(formatCountdown(-1)).toBe('now')
    expect(formatCountdown(45)).toBe('45 s')
    expect(formatCountdown(750)).toBe('12 min 30 s')
    expect(formatCountdown(3700)).toBe('1 h 1 min')
  })
})

describe('labels', () => {
  it('has a label for every impact code the backend emits', () => {
    for (const code of ['stranded', 'medication_at_risk', 'device_power_lost', 'stairs_only_slow', 'needs_escort', 'needs_visual_alert', 'power_lost', 'away']) {
      expect(IMPACT_LABEL[code]).toBeTruthy()
    }
  })
  it('has a colour for every equipment status', () => {
    for (const s of ['online', 'offline', 'flooded', 'isolated', 'closing', 'closed'] as const) {
      expect(STATUS_COLOR[s]).toMatch(/^#/)
    }
  })
})
