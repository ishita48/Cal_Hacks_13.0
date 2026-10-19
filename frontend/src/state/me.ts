import type { ComponentType } from 'react'
import { create } from 'zustand'
import { api } from '../lib/api'

/** The viewer as the server sees them (GET /api/me). The role is the server's call, never this store's. */
export type Role = 'resident' | 'ra' | 'maintenance' | 'admin'

export const ROLE_LABEL: Record<Role, string> = {
  resident: 'Resident',
  ra: 'Resident Assistant',
  maintenance: 'Maintenance',
  admin: 'Housing Admin',
}

export interface Me {
  role: Role
  source: 'clerk' | 'demo'
  user_id: string | null
  name: string | null
  email: string | null
  person_id: string | null
  roles: Role[]
  person: { id: string; name: string; room: string; level: string; role: 'resident' | 'ra' } | null
  levels: string[]
}

interface MeStore {
  me: Me | null
  error: string | null
  /** Clerk's account button, registered by auth.tsx when sign-in is on (the app never imports Clerk itself). */
  AccountButton: ComponentType | null
  load: () => Promise<void>
}

export const useMe = create<MeStore>((set) => ({
  me: null,
  error: null,
  AccountButton: null,
  load: async () => {
    try {
      set({ me: await api.me(), error: null })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },
}))
