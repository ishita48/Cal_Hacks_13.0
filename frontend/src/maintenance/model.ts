import type { IncidentTask, Snapshot } from '../portal/types'
import type { BuildingSpec } from '../state/types'

/**
 * Everything the facilities dashboard shows, as a pure function of the maintenance projection (GET
 * /api/portal/snapshot, pushed again on /ws/portal) and the public building spec. The server says which plant
 * is down and which plan steps are facilities' own; this file ranks the faults, words them, draws the way to
 * the worst one, and keeps the S4 rule visible: a shutdown is verified only when a person confirmed it.
 */

export type Severity = 'hazard' | 'isolated' | 'offline'

export interface Fault {
  id: string
  name: string
  kind: string
  severity: Severity
  /** Room and floor, e.g. "Main electrical room · Basement". */
  where: string
  level: string
  /** The plan step that acts on it, if facilities own one. */
  task: IncidentTask | null
}

export interface Hero {
  fault: Fault
  /** The one safety sentence: the step's own reason when there is one. */
  note: string
  /** Why "Confirm shutdown" cannot be pressed, or '' when it can. */
  confirmBlocked: string
  route: Route | null
}

export interface Route {
  /** Side elevation: x along the building, z height; floors as bands. */
  floors: { id: string; label: string; z0: number; z1: number; hot: boolean }[]
  risers: { x: number; z0: number; z1: number; hot: boolean }[]
  path: { x: number; z: number }[]
  from: { x: number; z: number; label: string }
  to: { x: number; z: number; label: string }
  span: { x0: number; x1: number; z0: number; z1: number }
  steps: string[]
}

export interface WorkOrder {
  id: string
  kind: string
  title: string
  where: string
  status: 'urgent' | 'open' | 'done'
}

export interface Shutdown {
  id: string
  name: string
  state: 'verified' | 'confirm' | 'waiting'
  /** "Isolated — confirm on site", "Verified", … */
  text: string
}

export interface MaintenanceView {
  name: string
  building: string
  urgent: number
  incident: boolean
  approved: boolean
  hero: Hero | null
  orders: WorkOrder[]
  shutdowns: Shutdown[]
}

export const severityOf = (status: string): Severity | null =>
  status === 'flooded' ? 'hazard' : status === 'isolated' || status === 'closing' || status === 'closed' ? 'isolated' : status === 'offline' ? 'offline' : null

const RANK: Record<Severity, number> = { hazard: 0, isolated: 1, offline: 2 }

const ELECTRICAL = new Set(['utility_feed', 'switchboard', 'switchboard_section', 'transfer_switch', 'generator', 'panel', 'elevator_controller'])

function safetyNote(f: Fault): string {
  if (f.task?.reason) return f.task.reason
  if (f.kind === 'valve') return 'Closed to stop the water. Do not reopen it until the leak is repaired.'
  if (f.severity === 'hazard')
    return ELECTRICAL.has(f.kind) || f.kind === 'lift' || f.kind === 'pump' || f.kind === 'sump_pump'
      ? 'Water has reached it. Do not energize until it is dry and inspected.'
      : 'Water has reached it. Keep clear until it is inspected.'
  if (f.severity === 'isolated') return 'Isolated. Do not re-energize until a person confirms it is safe on site.'
  return 'Without power. Check it before power returns.'
}

export function maintenanceView(snap: Snapshot, spec: BuildingSpec | null): MaintenanceView {
  const { incident, building, viewer } = snap
  const kinds = new Map((spec?.equipment ?? []).map((e) => [e.id, e.kind]))
  const levelName = new Map(building.levels.map((l) => [l.id, l.name]))
  const levelOf = new Map(building.equipment.map((e) => [e.id, e.level]))
  const byTarget = new Map(incident.tasks.filter((t) => t.target).map((t) => [t.target, t]))

  const faults: Fault[] = incident.equipment
    .map((e) => {
      const severity = severityOf(e.status)
      if (!severity) return null
      const level = levelOf.get(e.id) ?? spec?.equipment.find((x) => x.id === e.id)?.level ?? ''
      return {
        id: e.id,
        name: e.name,
        kind: kinds.get(e.id) ?? '',
        severity,
        where: [e.place, levelName.get(level)].filter(Boolean).join(' · '),
        level,
        task: byTarget.get(e.id) ?? null,
      } satisfies Fault
    })
    .filter((f): f is Fault => f !== null)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || Number(!a.task) - Number(!b.task) || a.name.localeCompare(b.name))

  const top = faults.find((f) => f.severity !== 'offline') ?? null
  const hero: Hero | null = top
    ? {
        fault: top,
        note: safetyNote(top),
        confirmBlocked: !top.task
          ? 'No plan step covers this asset yet.'
          : !incident.approved
            ? 'The plan is waiting for approval.'
            : top.task.verified
              ? 'Verified on site.'
              : '',
        route: spec ? routeTo(spec, top.id) : null,
      }
    : null

  const orders: WorkOrder[] = [
    ...faults.map((f) => ({
      id: `fault:${f.id}`,
      kind: f.kind,
      title:
        f.severity === 'hazard'
          ? `${f.name} — isolate & inspect`
          : f.kind === 'valve'
            ? `${f.name} — closed`
            : f.severity === 'isolated'
              ? `${f.name} — locked out`
              : `${f.name} — power loss`,
      where: f.where,
      status: (f.severity === 'hazard' ? 'urgent' : 'open') as WorkOrder['status'],
    })),
    ...snap.requests.map((r) => ({
      id: `req:${r.id}`,
      kind: r.category,
      title: r.title,
      where: [building.spaces.find((s) => s.id === r.room)?.name ?? r.room, levelName.get(r.level)].filter(Boolean).join(' · '),
      status: (r.status === 'resolved' ? 'done' : r.urgency === 'urgent' ? 'urgent' : 'open') as WorkOrder['status'],
    })),
    ...incident.tasks
      .filter((t) => t.verified)
      .map((t) => ({ id: `task:${t.id}`, kind: kinds.get(t.target) ?? '', title: t.title, where: t.target_name, status: 'done' as const })),
  ].sort((a, b) => ['urgent', 'open', 'done'].indexOf(a.status) - ['urgent', 'open', 'done'].indexOf(b.status))

  // Every facilities step that shuts something: verified only when a person confirmed it on site (S4).
  const shutdowns: Shutdown[] = incident.tasks
    .filter((t) => t.target && kinds.has(t.target))
    .map((t) => {
      const name = t.target_name || t.title
      if (t.verified) return { id: t.id, name, state: 'verified' as const, text: 'Confirmed on site' }
      if (!incident.approved || t.status === 'proposed') return { id: t.id, name, state: 'waiting' as const, text: 'Waiting for plan approval' }
      if (t.status === 'done') return { id: t.id, name, state: 'confirm' as const, text: 'Isolated by HAVEN — confirm on site' }
      return { id: t.id, name, state: 'confirm' as const, text: 'Isolate, then confirm on site' }
    })

  return {
    name: viewer.name,
    building: building.name,
    urgent: faults.filter((f) => f.severity !== 'offline').length,
    incident: incident.active,
    approved: incident.approved,
    hero,
    orders,
    shutdowns,
  }
}

/** Facilities' way to an asset: from their office (or the main entrance) along the floor, by the nearest stair
 * that serves both floors, then along the asset's floor. Staff take the stairs; the lifts may be down. */
export function routeTo(spec: BuildingSpec, equipmentId: string): Route | null {
  const asset = spec.equipment.find((e) => e.id === equipmentId)
  if (!asset) return null
  const start =
    spec.spaces.find((s) => /facilit/i.test(s.name) && s.kind !== 'room') ?? spec.spaces.find((s) => s.tags.includes('main_entrance'))
  if (!start) return null
  const level = new Map(spec.levels.map((l) => [l.id, l]))
  const space = new Map(spec.spaces.map((s) => [s.id, s]))
  const cx = (id: string) => {
    const r = space.get(id)?.rect
    return r ? (r.x0 + r.x1) / 2 : 0
  }
  const z = (lv: string) => level.get(lv)?.elevation ?? 0
  const sx = cx(start.id)
  const stairs = (spec.verticals ?? []).filter((v) => v.kind === 'stair' && v.spaces[start.level] && v.spaces[asset.level])
  const stair = stairs.sort((a, b) => Math.abs(cx(a.spaces[start.level]) - sx) + Math.abs(cx(a.spaces[asset.level]) - asset.x) - (Math.abs(cx(b.spaces[start.level]) - sx) + Math.abs(cx(b.spaces[asset.level]) - asset.x)))[0]
  const zs = z(start.level)
  const za = z(asset.level)
  const path = stair && start.level !== asset.level
    ? [{ x: sx, z: zs }, { x: cx(stair.spaces[start.level]), z: zs }, { x: cx(stair.spaces[asset.level]), z: za }, { x: asset.x, z: za }]
    : [{ x: sx, z: zs }, { x: asset.x, z: za }]
  const room = space.get(asset.space)
  const assetSpaceKind = room?.kind
  const levels = [...spec.levels].sort((a, b) => a.elevation - b.elevation)
  const xs = spec.footprint.flatMap((r) => [r.x0, r.x1])
  const risers = spec.spaces
    .filter((s) => s.kind === 'riser')
    .reduce<Route['risers']>((acc, s) => {
      const x = (s.rect.x0 + s.rect.x1) / 2
      const lv = level.get(s.level)
      if (!lv) return acc
      const hot = assetSpaceKind === 'riser' ? Math.abs(cx(asset.space) - x) < 0.5 : false
      const near = acc.find((r) => Math.abs(r.x - x) < 0.5)
      if (near) {
        near.z0 = Math.min(near.z0, lv.elevation)
        near.z1 = Math.max(near.z1, lv.elevation + lv.height)
        near.hot ||= hot
      } else acc.push({ x, z0: lv.elevation, z1: lv.elevation + lv.height, hot })
      return acc
    }, [])
  const levelLabel = (id: string) => level.get(id)?.name ?? id
  return {
    floors: levels.map((l) => ({ id: l.id, label: l.short.length <= 2 ? `L${l.short}` : l.id, z0: l.elevation, z1: l.elevation + l.height, hot: l.id === asset.level })),
    risers,
    path,
    from: { ...path[0], label: start.name },
    to: { x: asset.x, z: za, label: asset.name },
    span: { x0: Math.min(...xs), x1: Math.max(...xs), z0: levels[0]?.elevation ?? 0, z1: (levels.at(-1)?.elevation ?? 0) + (levels.at(-1)?.height ?? 3) },
    steps: [
      `Leave ${start.name} (${levelLabel(start.level)})`,
      ...(stair && start.level !== asset.level ? [`Take ${stair.name} ${za < zs ? 'down' : 'up'} to ${levelLabel(asset.level)}`] : []),
      `Go to ${room?.name ?? 'the asset'}: ${asset.name}`,
    ],
  }
}

