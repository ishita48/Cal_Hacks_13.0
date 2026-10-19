import { describe, expect, it } from 'vitest'
import { resolve } from '../lib/theme'

describe('theme', () => {
  it('follows the device unless the viewer chose one', () => {
    expect(resolve('system', true)).toBe('dark')
    expect(resolve('system', false)).toBe('light')
    expect(resolve('light', true)).toBe('light')
    expect(resolve('dark', false)).toBe('dark')
  })
})
