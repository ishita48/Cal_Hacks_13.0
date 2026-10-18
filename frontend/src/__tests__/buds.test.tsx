// Buds: renders, asks the backend, shows the answer, offers the action behind the human gate.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Buds, focusKey, point } from '../components/Buds'
import { useWorld } from '../state/world'
import { clock, world } from './fixture'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Buds', () => {
  it('opens from the orb, asks, shows the answer and offers an approval card', async () => {
    useWorld.setState({ world, clock, connection: 'open' })
    const reply = {
      speech: "I can switch Maya's agent off. That changes the plan.",
      focus: [{ kind: 'agent', id: 'resident:maya', label: "Maya's agent" }],
      actions: [{ kind: 'toggle_agent', label: "Switch Maya's agent off", payload: { agent: 'resident:maya', enabled: false } }],
      source: 'rules',
      intent: 'toggle',
    }
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url === '/api/buds/ask') return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (url === '/api/buds/act') return new Response(JSON.stringify({ seq: 1, step: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        return new Response('', { status: 503 })
      }),
    )
    render(<Buds />)
    fireEvent.click(screen.getByLabelText('Open Buds'))
    const input = screen.getByPlaceholderText(/Ask Buds anything/)
    fireEvent.change(input, { target: { value: "turn maya's agent off" } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(screen.getByText(/That changes the plan/)).toBeTruthy())
    expect(calls).toContain('POST /api/buds/ask')
    // Nothing acted yet: the human gate.
    expect(calls.filter((c) => c.includes('/api/buds/act'))).toHaveLength(0)
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(calls).toContain('POST /api/buds/act'))
    await waitFor(() => expect(screen.getByText('done')).toBeTruthy())
  })

  it('points at elements tagged with data-buds', async () => {
    const el = document.createElement('div')
    el.setAttribute('data-buds', 'agent:resident:maya')
    document.body.appendChild(el)
    const seen: Element[] = []
    window.addEventListener('buds:point', (e) => seen.push((e as CustomEvent<{ el: Element }>).detail.el))
    expect(focusKey({ kind: 'agent', id: 'resident:maya', label: '' })).toBe('agent:resident:maya')
    point([{ kind: 'agent', id: 'resident:maya', label: "Maya's agent" }])
    await waitFor(() => expect(seen[0]).toBe(el), { timeout: 2000 })
    el.remove()
  })
})
