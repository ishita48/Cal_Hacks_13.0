import { create } from 'zustand'
import { api } from '../lib/api'
import type { BuildingSpec, Equipment, Resident, Space } from './types'

// The building spec and roster are static for the life of the backend process; they are
// fetched once and indexed here. Not world state (nothing in them changes), so caching is fine.
interface BuildingStore {
  spec: BuildingSpec | null
  residents: Record<string, Resident>
  spaces: Record<string, Space>
  equipment: Record<string, Equipment>
  byLevel: Record<string, Space[]>
  equipmentByLevel: Record<string, Equipment[]>
  width: number
  depth: number
  load: () => Promise<void>
}

export const useBuilding = create<BuildingStore>((set, get) => ({
  spec: null,
  residents: {},
  spaces: {},
  equipment: {},
  byLevel: {},
  equipmentByLevel: {},
  width: 46,
  depth: 84,
  load: async () => {
    if (get().spec) return
    const [spec, roster] = await Promise.all([api.building(), api.people()])
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
    set({
      spec,
      residents,
      spaces,
      equipment,
      byLevel,
      equipmentByLevel,
      width: Math.max(...spec.footprint.map((r) => r.x1)),
      depth: Math.max(...spec.footprint.map((r) => r.y1)),
    })
  },
}))
