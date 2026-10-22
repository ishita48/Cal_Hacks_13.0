import type { Me, Role } from '../state/me'

/**
 * The workspaces a person can sign in to, one per job. Each maps to the server role that may open it; the
 * server decides that role (Clerk public_metadata.role), so the picker only chooses among the doors the
 * account already holds (an admin holds them all). Security / Dispatch has no server role yet: only an admin opens it.
 */
export type Slug = 'student' | 'ra' | 'maintenance' | 'security' | 'admin'

export interface Workspace {
  slug: Slug
  label: string
  line: string
  role: Role | null
}

export const WORKSPACES: Workspace[] = [
  { slug: 'student', label: 'Student', line: 'Your safety status, your RA and your way out.', role: 'resident' },
  { slug: 'ra', label: 'RA', line: 'Your floors and who needs a check-in.', role: 'ra' },
  { slug: 'maintenance', label: 'Maintenance / Facilities', line: 'Work orders and the plant.', role: 'maintenance' },
  { slug: 'security', label: 'Security / Dispatch', line: 'Incidents, calls and responders.', role: null },
  { slug: 'admin', label: 'Admin', line: 'The whole building and the command centre.', role: 'admin' },
]

export const workspace = (slug: string) => WORKSPACES.find((w) => w.slug === slug) ?? null

/** /app/<slug> → the workspace, /app (or anything unknown) → null: the picker. */
export function workspaceFromPath(path: string): Workspace | null {
  const m = /^\/app\/([a-z]+)\/?$/.exec(path)
  return m ? workspace(m[1]) : null
}

/** Signed in, the server's role opens its own workspace and an admin opens all of them (another role's as a
 * read-only preview); the open demo opens every door. */
export function canOpen(ws: Workspace, me: Pick<Me, 'role' | 'source'>): boolean {
  if (me.source === 'demo' || me.role === 'admin') return true
  return ws.role === me.role
}

// The last workspace chosen, a per-viewer convenience (a private window simply forgets it). This is the one
// place the choice is kept, so moving it to a shared store changes this pair of functions and nothing else.
const CHOICE_KEY = 'haven.workspace'

export function readChoice(): Slug | null {
  try {
    const s = localStorage.getItem(CHOICE_KEY)
    return s && workspace(s) ? (s as Slug) : null
  } catch {
    return null
  }
}

export function writeChoice(slug: Slug) {
  try {
    localStorage.setItem(CHOICE_KEY, slug)
  } catch {
    /* private window: the choice lasts this visit */
  }
}
