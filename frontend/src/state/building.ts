import { create } from 'zustand'
import { api } from '../lib/api'
import type { AgentInfo, BuildingSpec, Equipment, Graph, Level, Resident, Space } from './types'

// The building spec, the roster and the agent registry are static for the life of the backend
// process; they are fetched once and indexed here. Not world state (nothing in them changes), so
// caching is fine. Everything a screen needs to know about *which* building this is comes from here:
// no level id, room id, person or agent is named in the frontend code.
interface BuildingStore {
  spec: BuildingSpec | null
  residents: Record<string, Resident>
  spaces: Record<string, Space>
  equipment: Record<string, Equipment>
  graph: Graph | null
  byLevel: Record<string, Space[]>
  equipmentByLevel: Record<string, Equipment[]>
  levels: Record<string, Level>
  width: number
  depth: number
  /** Residents with a story to tell, in roster order (the named people of the demo): derived, not listed. */
  storyIds: string[]
  /** The first named resident: the one whose agent the demo toggles (the Maya moment). */
  heroId: string | null
  /** The level the demo looks at first: where the first named resident lives, else the ground floor. */
  heroLevel: string | null
  /** The ground floor and the top level (the roof sits on it), by index. */
  ground: string | null
  topLevel: string | null
  /** The first water sensor in the spec; the Simulate button and the charts read it. */
  sensorId: string | null
  /** Who the agents are, from the backend registry (label, kind, description); on/off lives in the world. */
  agents: Record<string, AgentInfo>
  load: () => Promise<void>
}

export const useBuilding = create<BuildingStore>((set, get) => ({
  spec: null,
  residents: {},
  spaces: {},
  equipment: {},
  graph: null,
  byLevel: {},
  equipmentByLevel: {},
  levels: {},
  width: 46,
  depth: 84,
  storyIds: [],
  heroId: null,
  heroLevel: null,
  ground: null,
  topLevel: null,
  sensorId: null,
  agents: {},
  load: async () => {
    if (get().spec) return
    const [spec, roster, graph, agentList] = await Promise.all([
      api.building(),
      api.people(),
      api.graph().catch(() => null),
      api.agents().catch(() => [] as AgentInfo[]),
    ])
    const residents: Record<string, Resident> = {}
    for (const r of roster.residents) residents[r.id] = r
    const spaces: Record<string, Space> = {}
    const byLevel: Record<string, Space[]> = {}
    for (const s of spec.spaces) {
      spaces[s.id] = s
      ;(byLevel[s.level] ??= []).push(s)
    }
    const equipment: Record<string, Equipment> = {}
    const equipmentByLevel: Record<string, Equipment[]> = {}
    for (const e of spec.equipment) {
      equipment[e.id] = e
      ;(equipmentByLevel[e.level] ??= []).push(e)
    }
    const levels: Record<string, Level> = {}
    for (const lv of spec.levels) levels[lv.id] = lv
    const sorted = [...spec.levels].sort((a, b) => a.index - b.index)
    const ground = sorted.find((lv) => lv.index >= 1) ?? sorted[0]
    const storyIds = roster.residents.filter((r) => r.story && r.role === 'resident').map((r) => r.id)
    const hero = storyIds[0] ? residents[storyIds[0]] : undefined
    const agents: Record<string, AgentInfo> = {}
    for (const a of agentList) agents[a.id] = a
    set({
      spec,
      graph,
      residents,
      spaces,
      equipment,
      byLevel,
      equipmentByLevel,
      levels,
      width: Math.max(...spec.footprint.map((r) => r.x1)),
      depth: Math.max(...spec.footprint.map((r) => r.y1)),
      storyIds,
      heroId: hero?.id ?? null,
      heroLevel: hero?.level ?? ground?.id ?? null,
      ground: ground?.id ?? null,
      topLevel: sorted[sorted.length - 1]?.id ?? null,
      sensorId: spec.equipment.find((e) => e.kind === 'sensor')?.id ?? null,
      agents,
    })
  },
}))

/** A level's spoken label ("4", "ground") with a fallback to its id. */
export function levelShort(levels: Record<string, Level>, id: string): string {
  return levels[id]?.short ?? id
}
