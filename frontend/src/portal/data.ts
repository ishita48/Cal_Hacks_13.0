import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { identity, request } from '../lib/api'
import type { Snapshot } from './types'

/**
 * The portal's one source of truth: GET /api/portal/snapshot once, then /ws/portal pushes a fresh projection
 * on every world change. The socket's credentials travel in its first frame, never in the URL.
 */
export function usePortal() {
  const [data, setData] = useState<Snapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => setData(await request<Snapshot>('GET', '/api/portal/snapshot')), [])

  useEffect(() => {
    let stopped = false
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    refresh().catch((e: Error) => setError(e.message))
    const open = async () => {
      try {
        const headers = await identity()
        if (stopped) return
        const configured = import.meta.env.VITE_HAVEN_WS as string | undefined
        const base = configured ? configured.replace(/\/ws\/?$/, '') : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
        ws = new WebSocket(`${base}/ws/portal`)
        ws.onopen = () => {
          if (stopped) return ws?.close()
          ws?.send(JSON.stringify({ token: headers.Authorization?.replace(/^Bearer /, ''), role: headers['X-Haven-Role'], person: headers['X-Haven-Person'] }))
        }
        ws.onmessage = (e) => {
          if (stopped) return
          setData(JSON.parse(e.data) as Snapshot)
          setConnected(true)
        }
        ws.onclose = () => {
          setConnected(false)
          if (!stopped) retry = setTimeout(open, 3000)
        }
      } catch {
        if (!stopped) retry = setTimeout(open, 3000)
      }
    }
    void open()
    return () => {
      stopped = true
      clearTimeout(retry)
      ws?.close()
    }
  }, [refresh])

  /** One write to /api/portal; the answer is the fresh snapshot. Returns whether it worked. */
  const mutate = useCallback(
    async (path: string, body?: unknown, method = 'POST', done = 'Saved.') => {
      setBusy(true)
      setError('')
      setNotice('')
      try {
        await request(method, `/api/portal${path}`, body)
        await refresh()
        setNotice(done)
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  return { data, connected, error, setError, notice, setNotice, busy, mutate }
}

export type Portal = ReturnType<typeof usePortal>

export const words = (s: string) => s.replaceAll('_', ' ')

export function when(iso: string) {
  if (!iso) return 'Now'
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const firstName = (name: string) => name.split(' ')[0]

/** Per-viewer conveniences in localStorage; a private window simply forgets them. */
export function readFlag(key: string) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function writeFlag(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    /* private window: the choice lasts this visit */
  }
}

export const AVATARS: Record<string, string> = { spark: '✦', leaf: '❧', moon: '☾', wave: '≋' }

/** FormData helpers: forms stay uncontrolled, the submit reads them once. */
export function formOf(e: FormEvent<HTMLFormElement>) {
  e.preventDefault()
  const data = new FormData(e.currentTarget)
  return (name: string) => String(data.get(name) ?? '')
}
