import { create } from 'zustand'

/** What the pointer is over in the twin: kept outside React state so a hover never re-renders the scene. */
export interface HoverInfo {
  title: string
  sub?: string
  kind: string
}

export const useHover = create<{ info: HoverInfo | null }>(() => ({ info: null }))

export function setHover(info: HoverInfo | null): void {
  const cur = useHover.getState().info
  if (cur === info || (cur && info && cur.title === info.title && cur.sub === info.sub)) return
  useHover.setState({ info })
}
