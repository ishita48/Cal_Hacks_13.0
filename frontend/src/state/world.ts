import { create } from 'zustand'
import type { Clock, StateMessage, WorldState } from './types'

type Connection = 'connecting' | 'open' | 'closed'

interface WorldStore {
  connection: Connection
  clock: Clock | null
  world: WorldState | null
  lastMessageAt: number
}

// Read-only mirror of the backend world. Components never write to it; they call the
// API, the backend mutates the one authoritative state, and the change arrives here.
export const useWorld = create<WorldStore>(() => ({
  connection: 'connecting',
  clock: null,
  world: null,
  lastMessageAt: 0,
}))

let retry = 0

export function connectWorld(): () => void {
  let stopped = false
  let mine: WebSocket | null = null

  const open = () => {
    if (stopped) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = import.meta.env.VITE_HAVEN_WS ?? `${proto}://${location.host}/ws`
    useWorld.setState({ connection: 'connecting' })
    const ws = new WebSocket(url)
    mine = ws
    ws.onopen = () => {
      // Closed before it opened (React StrictMode mounts twice): let it open, then let it go quietly.
      if (stopped) {
        ws.close()
        return
      }
      retry = 0
      useWorld.setState({ connection: 'open' })
    }
    ws.onmessage = (ev) => {
      if (stopped) return
      const msg = JSON.parse(ev.data) as StateMessage
      if (msg.type === 'state') {
        useWorld.setState({ clock: msg.clock, world: msg.state, lastMessageAt: performance.now() })
      }
    }
    ws.onclose = () => {
      if (stopped) return
      useWorld.setState({ connection: 'closed' })
      setTimeout(open, Math.min(5000, 300 * 2 ** retry++))
    }
  }

  open()
  return () => {
    stopped = true
    // A socket still connecting cannot be closed without a console warning; onopen closes it instead.
    if (mine && mine.readyState === WebSocket.OPEN) mine.close()
  }
}
