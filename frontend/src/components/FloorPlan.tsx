import { useEffect, useMemo, useRef, useState } from 'react'
import { KIND_FILL, STATUS_COLOR } from '../lib/labels'
import { useBuilding } from '../state/building'
import type { Equipment, Space, WorldState } from '../state/types'
import { select } from './Inspector'

interface Props {
  world: WorldState
  level: string
  connections?: boolean
}

const REL_COLOR: Record<string, string> = { powers: '#0f62fe', backs_up: '#7c3aed', controls: '#7c3aed', feeds_water: '#0284c7', monitors: '#64748b' }

// Equipment that gets a name on the plan (the plant the cascade runs through); everything else is a glyph.
const NAMED_KINDS = new Set(['switchboard', 'switchboard_section', 'transfer_switch', 'generator', 'valve', 'sensor', 'water_riser', 'water_main', 'sump_pump', 'pump', 'utility_feed', 'fridge'])
const WATER_KINDS = new Set(['valve', 'water_riser', 'water_main', 'sump_pump', 'pump', 'water_heater'])

/**
 * One level of the building drawn straight from the spec: x east, y north (SVG y is flipped inside
 * the <g>). The view fits the level's own extent (a partial basement fills the stage like a full floor).
 * Everything that changes colour comes from the world state: a room about to lose power gets a thin
 * amber wash and sparse hatching, a dark room a red wash, water a blue pool scaled by depth. Motion
 * is event-driven: overlays ease rather than switch, a space ripples once when it first gets wet,
 * a route draws itself on, a stranded person gets a pulsing ring.
 */
export function FloorPlan({ world, level, connections = false }: Props) {
  const { byLevel, equipmentByLevel, spaces, spec, width, depth, residents, graph, storyIds, levels, ground } = useBuilding()
  const NAMED = useMemo(() => new Set(storyIds), [storyIds])
  const live = new Set(world.power.live)
  const equipmentById = useBuilding((b) => b.equipment)
  const links = useMemo(() => {
    if (!connections || !graph) return []
    return graph.edges
      .map((e) => ({ e, a: equipmentById[e.src], b: equipmentById[e.dst] }))
      .filter(({ a, b }) => a && b && (a.level === level || b.level === level))
  }, [connections, graph, equipmentById, level])
  const here = byLevel[level] ?? []
  const equipment = equipmentByLevel[level] ?? []
  const openings = useMemo(() => (spec?.openings ?? []).filter((o) => o.level === level), [spec, level])
  const belowGrade = ground != null && levels[level] != null && levels[ground] != null && levels[level].index < levels[ground].index

  // The view fits what is on this level, with a little air around it.
  const box = useMemo(() => {
    if (here.length === 0) return { x: -2, y: -2, w: width + 4, h: depth + 4 }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const s of here) {
      x0 = Math.min(x0, s.rect.x0)
      y0 = Math.min(y0, s.rect.y0)
      x1 = Math.max(x1, s.rect.x1)
      y1 = Math.max(y1, s.rect.y1)
    }
    if (!belowGrade) {
      x0 = Math.min(x0, 0)
      y0 = Math.min(y0, 0)
      x1 = Math.max(x1, width)
      y1 = Math.max(y1, depth)
    }
    const pad = 2.5
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }
  }, [here, width, depth, belowGrade])
  // SVG y runs down; the plan's y runs north. Flip inside a group whose origin sits at the top of the box.
  const flipY = (y: number) => box.y + box.h - (y - box.y)

  const darkNow = world.impact.dark_levels.includes(level)
  const darkSoon = !darkNow && world.forecast.impact.dark_levels.includes(level)

  // One ripple per space the first time it is wet (keyed on wet_spaces growing).
  const seenWet = useRef<Set<string>>(new Set(world.wet_spaces))
  const [ripples, setRipples] = useState<{ key: string; cx: number; cy: number }[]>([])
  useEffect(() => {
    const fresh = world.wet_spaces.filter((sid) => !seenWet.current.has(sid))
    if (fresh.length === 0) return
    for (const sid of fresh) seenWet.current.add(sid)
    const added = fresh
      .map((sid) => spaces[sid])
      .filter((s): s is Space => !!s && s.level === level)
      .map((s) => ({ key: `${s.id}-${world.step}`, cx: (s.rect.x0 + s.rect.x1) / 2, cy: (s.rect.y0 + s.rect.y1) / 2 }))
    if (added.length === 0) return
    setRipples((r) => [...r, ...added])
    const t = setTimeout(() => setRipples((r) => r.filter((x) => !added.some((a) => a.key === x.key))), 950)
    return () => clearTimeout(t)
  }, [world.wet_spaces, world.step, spaces, level])

  // Residents to mark on this level: anyone affected (now, or predicted) with a story to tell.
  const marks = useMemo(() => {
    const src = world.impact.residents.length ? world.impact.residents : world.forecast.impact.residents
    const predicted = world.impact.residents.length === 0
    return src
      .filter((r) => r.level === level && r.severity !== 'info' && !world.moved[r.id])
      .map((r) => ({ r, predicted, space: spaces[r.room] }))
      .filter((m) => m.space)
  }, [world.impact.residents, world.forecast.impact.residents, world.moved, level, spaces])

  // Stranded right now, on this level, with no route left: a red ring pulses at their room.
  const stranded = useMemo(
    () =>
      world.impact.residents
        .filter((r) => r.level === level && r.impacts.includes('stranded') && !world.moved[r.id] && !world.impact.routes[r.id])
        .map((r) => ({ id: r.id, space: spaces[r.room] }))
        .filter((m) => m.space),
    [world.impact.residents, world.impact.routes, world.moved, level, spaces],
  )

  // People an executed step has moved: drawn where they are now, spread around the space.
  const movedMarks = useMemo(() => {
    const out: { id: string; name: string; x: number; y: number; named: boolean }[] = []
    const perSpace: Record<string, number> = {}
    for (const [rid, sid] of Object.entries(world.moved)) {
      const s = spaces[sid]
      if (!s || s.level !== level) continue
      const k = perSpace[sid] ?? 0
      perSpace[sid] = k + 1
      const w = s.rect.x1 - s.rect.x0
      const cols = Math.max(1, Math.floor(w / 1.2))
      const x = s.rect.x0 + 0.8 + (k % cols) * 1.2
      const y = s.rect.y0 + 0.8 + Math.floor(k / cols) * 1.2
      out.push({ id: rid, name: residents[rid]?.name ?? rid, x: Math.min(x, s.rect.x1 - 0.5), y: Math.min(y, s.rect.y1 - 0.5), named: NAMED.has(rid) })
    }
    return out
  }, [world.moved, spaces, level, residents, NAMED])

  // Responders on this level (derived by the backend from the approved plan): a diamond where they
  // are, a dashed line to where they are heading while a step is assigned.
  const actors = useMemo(() => {
    const out: { id: string; label: string; status: string; x: number; y: number; hx: number | null; hy: number | null }[] = []
    let k = 0
    for (const a of Object.values(world.actors ?? {})) {
      if (!a.at) continue
      const here = spaces[a.at]
      const there = a.heading ? spaces[a.heading] : undefined
      const shown = there ?? here
      if (!shown || shown.level !== level) continue
      const off = (k++ % 3) * 0.9 - 0.9
      const x = (shown.rect.x0 + shown.rect.x1) / 2 + 1.6 + off
      const y = (shown.rect.y0 + shown.rect.y1) / 2 + 0.6
      const onLevel = here && here.level === level && there
      out.push({ id: a.actor, label: a.label, status: a.status, x, y, hx: onLevel ? (here.rect.x0 + here.rect.x1) / 2 : null, hy: onLevel ? (here.rect.y0 + here.rect.y1) / 2 : null })
    }
    return out
  }, [world.actors, spaces, level])

  // The Maya moment on the plan: someone with a hard need nobody spoke for gets a violet ring.
  const leftBehind = useMemo(
    () =>
      (world.plan.left_behind ?? [])
        .map((id) => ({ id, space: spaces[residents[id]?.room ?? ''] }))
        .filter((m) => m.space && m.space.level === level && !world.moved[m.id]),
    [world.plan.left_behind, world.moved, spaces, residents, level],
  )

  const routes = useMemo(() => {
    const out: { id: string; points: string }[] = []
    for (const [rid, path] of Object.entries(world.impact.routes)) {
      if (!path) continue
      const pts = path
        .map((sid) => spaces[sid])
        .filter((s): s is Space => !!s && s.level === level)
        .map((s) => `${(s.rect.x0 + s.rect.x1) / 2},${(s.rect.y0 + s.rect.y1) / 2}`)
      if (pts.length > 1) out.push({ id: rid, points: pts.join(' ') })
    }
    return out
  }, [world.impact.routes, spaces, level])

  const deepest = useMemo(() => {
    let best: { s: Space; depth: number } | null = null
    for (const s of here) {
      const w = world.water[s.id]
      if (w && (!best || w.depth > best.depth)) best = { s, depth: w.depth }
    }
    return best
  }, [here, world.water])

  if (!spec) return <div className="flex h-full items-center justify-center text-[12px] text-t3">loading building…</div>

  const fs = Math.max(0.8, Math.min(1.3, box.w / 48)) // label size follows the zoom

  return (
    <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} className="floorplan h-full w-full" style={{ maxHeight: '100%' }}>
      <defs>
        <pattern id="hatch" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="0.32" height="2.4" fill="#d97706" opacity="0.55" />
        </pattern>
        <filter id="routeGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.5" />
        </filter>
      </defs>
      <g transform={`translate(0 ${box.y + box.h + box.y}) scale(1 -1)`}>
        {!belowGrade &&
          spec.footprint.map((r, i) => (
            <rect key={i} x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill="var(--fp-paper)" stroke="var(--fp-line)" strokeWidth={0.16} />
          ))}

        {here.map((s) => {
          const w = world.water[s.id]
          const waterOpacity = w ? Math.min(0.9, 0.28 + (w.depth / 0.3) * 0.6) : 0
          const overlay = s.kind !== 'courtyard'
          const rx = s.rect.x0
          const ry = s.rect.y0
          const rw = s.rect.x1 - s.rect.x0
          const rh = s.rect.y1 - s.rect.y0
          return (
            <g key={s.id}>
              <rect x={rx} y={ry} width={rw} height={rh} fill={KIND_FILL[s.kind] ?? 'rgba(15,23,42,0.04)'} stroke="var(--fp-line-soft)" strokeWidth={0.08} style={{ cursor: 'pointer' }} onClick={() => select({ kind: 'space', id: s.id })}>
                <title>
                  {s.name} · {s.kind}
                  {w ? ` · water ${(w.depth * 100).toFixed(0)} cm` : ''}
                </title>
              </rect>
              {/* overlays are always present and ease in and out, instead of switching */}
              {overlay && <rect className="fp-fill" x={rx} y={ry} width={rw} height={rh} fill="#dc2626" opacity={darkNow ? 0.13 : 0} pointerEvents="none" />}
              {/* the pulse lives on a group: a CSS animation on the rect itself would override its faint opacity */}
              {overlay && (
                <g className={darkSoon ? 'haven-pulse' : ''} pointerEvents="none">
                  <rect className="fp-fill" x={rx} y={ry} width={rw} height={rh} fill="#f59e0b" opacity={darkSoon ? 0.11 : 0} />
                  <rect className="fp-fill" x={rx} y={ry} width={rw} height={rh} fill="url(#hatch)" opacity={darkSoon ? 0.55 : 0} />
                </g>
              )}
              {w && <rect className="fp-fill fp-fade-in" x={rx + 0.08} y={ry + 0.08} width={Math.max(0, rw - 0.16)} height={Math.max(0, rh - 0.16)} fill="#0ea5e9" opacity={waterOpacity} stroke="#0369a1" strokeWidth={0.12} pointerEvents="none" />}
            </g>
          )
        })}

        {ripples.map((r) => (
          <circle key={r.key} className="fp-ripple" cx={r.cx} cy={r.cy} r={2.5} fill="none" stroke="#0ea5e9" strokeWidth={0.35} />
        ))}

        {openings.map((o) =>
          o.axis === 'x' ? (
            <line key={o.id} x1={o.x - o.width / 2} x2={o.x + o.width / 2} y1={o.y} y2={o.y} stroke={o.kind === 'exit' ? '#16a34a' : 'var(--fp-door)'} strokeWidth={o.kind === 'exit' ? 0.3 : 0.2} />
          ) : (
            <line key={o.id} x1={o.x} x2={o.x} y1={o.y - o.width / 2} y2={o.y + o.width / 2} stroke={o.kind === 'exit' ? '#16a34a' : 'var(--fp-door)'} strokeWidth={o.kind === 'exit' ? 0.3 : 0.2} />
          ),
        )}

        {/* keyed on the geometry, so a changed route redraws itself on */}
        {routes.map((r) => (
          <g key={`${r.id}:${r.points}`}>
            <polyline className="fp-draw" pathLength={1} points={r.points} fill="none" stroke="#22c55e" strokeWidth={0.7} strokeLinejoin="round" strokeLinecap="round" opacity={0.3} filter="url(#routeGlow)" />
            <polyline className="fp-draw-dash" points={r.points} fill="none" stroke="#16a34a" strokeWidth={0.32} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} strokeDasharray="1.1 0.6" />
          </g>
        ))}

        {stranded.map(({ id, space }) => (
          <circle key={`ring-${id}`} className="fp-ring" cx={(space.rect.x0 + space.rect.x1) / 2} cy={(space.rect.y0 + space.rect.y1) / 2} r={1.6} fill="none" stroke="#dc2626" strokeWidth={0.3} />
        ))}
        {leftBehind.map(({ id, space }) => (
          <circle key={`left-${id}`} className="fp-ring" cx={(space.rect.x0 + space.rect.x1) / 2} cy={(space.rect.y0 + space.rect.y1) / 2} r={2.2} fill="none" stroke="#7c3aed" strokeWidth={0.35} />
        ))}

        {actors.map((a) => {
          const color = a.status === 'moving' ? '#0284c7' : a.status === 'done' ? '#16a34a' : '#94a3b8'
          return (
            <g key={`actor-${a.id}`}>
              {a.hx != null && a.hy != null && <line x1={a.hx} y1={a.hy} x2={a.x} y2={a.y} stroke={color} strokeWidth={0.18} strokeDasharray="0.5 0.4" opacity={0.7} />}
              <rect className={`mark-in ${a.status === 'moving' ? 'haven-pulse' : ''}`} x={a.x - 0.6} y={a.y - 0.6} width={1.2} height={1.2} transform={`rotate(45 ${a.x} ${a.y})`} fill={color} stroke="var(--fp-mark-stroke)" strokeWidth={0.12}>
                <title>
                  {a.label} · {a.status}
                </title>
              </rect>
            </g>
          )
        })}

        {/* the dependency graph, drawn: what powers, controls and feeds what on this floor; dead edges go grey */}
        {links.map(({ e, a, b }) => {
          const dead = !live.has(e.src)
          const offFloor = a.level !== level ? a : b.level !== level ? b : null
          return (
            <g key={`${e.src}-${e.dst}-${e.rel}`} className="fp-fade-in">
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={dead ? '#94a3b8' : (REL_COLOR[e.rel] ?? '#64748b')} strokeWidth={dead ? 0.18 : 0.28} strokeDasharray={e.rel === 'feeds_water' ? '0.8 0.5' : offFloor ? '0.4 0.4' : undefined} opacity={dead ? 0.5 : 0.85} />
              <circle cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} r={0.3} fill={dead ? '#94a3b8' : (REL_COLOR[e.rel] ?? '#64748b')}>
                <title>
                  {a.name} {e.rel.replace('_', ' ')} {b.name}
                  {offFloor ? ` (${offFloor.name} is on ${offFloor.level})` : ''}
                  {dead ? ' · no power' : ''}
                </title>
              </circle>
            </g>
          )
        })}

        {equipment.map((e) => {
          const st = world.equipment[e.id]?.status ?? 'online'
          const leaking = world.leaks[e.id]?.active
          const wet = world.sensors[e.id]?.wet
          return (
            <g key={e.id} style={{ cursor: 'pointer' }} onClick={() => select({ kind: 'equipment', id: e.id })}>
              {leaking && (
                <g className="haven-pulse">
                  <circle cx={e.x} cy={e.y} r={2.4} fill="#0ea5e9" opacity={0.28} />
                </g>
              )}
              {wet && <circle cx={e.x} cy={e.y} r={1.4} fill="none" stroke="#0ea5e9" strokeWidth={0.2} className="fp-ring" />}
              <Glyph e={e} color={STATUS_COLOR[st]} />
              <title>
                {e.name} · {st}
                {e.flood_height != null ? ` · fails at ${(e.flood_height * 100).toFixed(0)} cm` : ''}
              </title>
            </g>
          )
        })}

        {movedMarks.map((m) => (
          <circle key={`moved-${m.id}`} className="mark-in" cx={m.x} cy={m.y} r={m.named ? 0.8 : 0.45} fill="#16a34a" stroke="var(--fp-mark-stroke)" strokeWidth={0.12}>
            <title>{m.name} · moved here</title>
          </circle>
        ))}

        {marks.map(({ r, predicted, space }) => {
          const cx = (space.rect.x0 + space.rect.x1) / 2
          const cy = (space.rect.y0 + space.rect.y1) / 2
          const color = r.severity === 'critical' ? '#dc2626' : '#d97706'
          return (
            <g key={r.id}>
              <circle className="mark-in fp-fill" cx={cx} cy={cy} r={NAMED.has(r.id) ? 1.05 : 0.65} fill={color} opacity={predicted ? 0.6 : 1} stroke="var(--fp-mark-stroke)" strokeWidth={0.15} style={{ cursor: 'pointer' }} onClick={() => select({ kind: 'resident', id: r.id })}>
                <title>
                  {r.name} · {space.name} · {r.impacts.join(', ')}
                </title>
              </circle>
            </g>
          )
        })}
      </g>

      {/* Labels are drawn un-flipped so the text reads normally; a halo keeps them legible over any fill,
          and a small layout pass nudges labels apart where two would print on top of each other. */}
      <g fontFamily="Geist, sans-serif" fill="var(--fp-text)" pointerEvents="none" paintOrder="stroke" stroke="var(--fp-halo)" strokeWidth={0.42} strokeLinejoin="round">
        {layoutLabels([
          ...here
            .filter((s) => s.kind !== 'room' && s.kind !== 'bathroom' && s.kind !== 'riser' && s.rect.x1 - s.rect.x0 > 3 && s.rect.y1 - s.rect.y0 > 2.4)
            .map<LabelSpec>((s) => ({ key: s.id, x: (s.rect.x0 + s.rect.x1) / 2, y: flipY((s.rect.y0 + s.rect.y1) / 2) + 0.35 * fs, text: short(s.name), size: (s.kind === 'corridor' ? 0.8 : 1.0) * fs, weight: 500, opacity: s.kind === 'corridor' ? 0.55 : 0.75, fill: 'var(--fp-text)', dir: 1, rank: 3 })),
          ...equipment
            .filter((e) => NAMED_KINDS.has(e.kind) && (belowGrade || e.kind === 'fridge' || e.kind === 'sensor'))
            .map<LabelSpec>((e) => ({ key: `eq-${e.id}`, x: e.x, y: flipY(e.y) + 1.55 * fs, text: short(e.name, 24), size: 0.72 * fs, weight: 500, opacity: 0.85, fill: WATER_KINDS.has(e.kind) || e.kind === 'sensor' ? '#0369a1' : 'var(--fp-text-strong)', dir: 1, rank: 2 })),
          ...(deepest && deepest.depth >= 0.005
            ? [{ key: 'depth', x: (deepest.s.rect.x0 + deepest.s.rect.x1) / 2, y: flipY((deepest.s.rect.y0 + deepest.s.rect.y1) / 2) - 1.2 * fs, text: `${(deepest.depth * 100).toFixed(0)} cm of water`, size: 1.0 * fs, weight: 600, opacity: 1, fill: '#0369a1', dir: -1, rank: 1 } satisfies LabelSpec]
            : []),
          ...marks
            .filter((m) => NAMED.has(m.r.id))
            .map<LabelSpec>(({ r, space }) => ({ key: `p-${r.id}`, x: (space.rect.x0 + space.rect.x1) / 2, y: flipY((space.rect.y0 + space.rect.y1) / 2) - 1.6, text: r.name.split(' ')[0], size: 1.25 * fs, weight: 600, opacity: 1, fill: 'var(--fp-text-strong)', dir: -1, rank: 0, cls: 'fp-fade-in' })),
          ...movedMarks
            .filter((m) => m.named)
            .map<LabelSpec>((m) => ({ key: `moved-${m.id}`, x: m.x, y: flipY(m.y) - 1.2, text: m.name.split(' ')[0], size: 1.25 * fs, weight: 600, opacity: 1, fill: '#16a34a', dir: -1, rank: 0, cls: 'fp-fade-in' })),
          ...leftBehind.map<LabelSpec>(({ id, space }) => ({ key: `left-${id}`, x: (space.rect.x0 + space.rect.x1) / 2, y: flipY((space.rect.y0 + space.rect.y1) / 2) + 3.2, text: 'left behind', size: 1.05 * fs, weight: 600, opacity: 1, fill: '#7c3aed', dir: 1, rank: 0, cls: 'fp-fade-in' })),
          ...actors
            .filter((a) => a.status !== 'idle')
            .map<LabelSpec>((a) => ({ key: `actor-${a.id}`, x: a.x, y: flipY(a.y) - 1.1, text: a.label.replace(/\s*\(.*\)/, ''), size: 0.9 * fs, weight: 600, opacity: 1, fill: a.status === 'moving' ? '#0284c7' : '#16a34a', dir: -1, rank: 1, cls: 'fp-fade-in' })),
        ]).map((l) => (
          <text key={l.key} className={l.cls} x={l.x} y={l.y} textAnchor="middle" fontSize={l.size} fontWeight={l.weight} opacity={l.opacity} fill={l.fill}>
            {l.text}
          </text>
        ))}
      </g>
    </svg>
  )
}

type LabelSpec = { key: string; x: number; y: number; text: string; size: number; weight: number; opacity: number; fill: string; dir: 1 | -1; rank: number; cls?: string }

/** Keep labels off each other: most important first; a label that would overlap one already placed
 *  slides along its preferred direction (down for rooms and plant, up for people) a line at a time. */
function layoutLabels(items: LabelSpec[]): LabelSpec[] {
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
  const out: LabelSpec[] = []
  for (const l of [...items].sort((a, b) => a.rank - b.rank || a.y - b.y)) {
    const w = l.text.length * 0.62 * l.size + 0.4 // capitals and digits run wide; keep a little air between neighbours
    const h = 1.15 * l.size
    let y = l.y
    for (let k = 0; k < 4; k++) {
      const box = { x0: l.x - w / 2, y0: y - h, x1: l.x + w / 2, y1: y + 0.25 * l.size }
      const hit = placed.some((p) => box.x0 < p.x1 && p.x0 < box.x1 && box.y0 < p.y1 && p.y0 < box.y1)
      if (!hit) {
        placed.push(box)
        break
      }
      y += l.dir * h
    }
    out.push({ ...l, y })
  }
  return out
}

/** A small symbol per equipment kind, coloured by its live status (drawn in plan coordinates, symmetric so the flip is harmless). */
function Glyph({ e, color }: { e: Equipment; color: string }) {
  const stroke = 'var(--fp-mark-stroke)'
  const k = e.kind
  if (k === 'sensor')
    return (
      <>
        <circle className="fp-fill" cx={e.x} cy={e.y} r={0.6} fill={color} stroke={stroke} strokeWidth={0.12} />
        <circle cx={e.x} cy={e.y} r={0.2} fill="#fff" />
      </>
    )
  if (k === 'valve') return <polygon className="fp-fill" points={`${e.x - 0.8},${e.y - 0.6} ${e.x},${e.y} ${e.x - 0.8},${e.y + 0.6} ${e.x + 0.8},${e.y - 0.6} ${e.x},${e.y} ${e.x + 0.8},${e.y + 0.6}`} fill={color} stroke={stroke} strokeWidth={0.1} strokeLinejoin="round" />
  if (k === 'water_riser') return <polygon className="fp-fill" points={`${e.x},${e.y - 0.85} ${e.x + 0.85},${e.y} ${e.x},${e.y + 0.85} ${e.x - 0.85},${e.y}`} fill={color} stroke={stroke} strokeWidth={0.12} />
  if (k === 'fridge') return <rect className="fp-fill" x={e.x - 0.5} y={e.y - 0.65} width={1.0} height={1.3} rx={0.2} fill={color} stroke={stroke} strokeWidth={0.12} />
  if (k === 'switchboard' || k === 'switchboard_section' || k === 'transfer_switch' || k === 'generator' || k === 'utility_feed' || k === 'panel') {
    const w = k === 'switchboard' || k === 'generator' ? 1.8 : 1.2
    return (
      <>
        <rect className="fp-fill" x={e.x - w / 2} y={e.y - 0.55} width={w} height={1.1} rx={0.12} fill={color} stroke={stroke} strokeWidth={0.12} />
        <polyline points={`${e.x + 0.18},${e.y - 0.38} ${e.x - 0.12},${e.y + 0.02} ${e.x + 0.1},${e.y + 0.02} ${e.x - 0.18},${e.y + 0.4}`} fill="none" stroke="#fff" strokeWidth={0.12} strokeLinejoin="round" strokeLinecap="round" />
      </>
    )
  }
  if (k === 'lift' || k === 'elevator_controller') return <rect className="fp-fill" x={e.x - 0.55} y={e.y - 0.55} width={1.1} height={1.1} fill={color} stroke={stroke} strokeWidth={0.12} />
  return <circle className="fp-fill" cx={e.x} cy={e.y} r={k === 'fire_alarm' || k === 'emergency_lighting' ? 0.4 : 0.6} fill={color} stroke={stroke} strokeWidth={0.12} />
}

function short(name: string, max = 22): string {
  return name.replace(/\s*\(.*\)/, '').replace('Electrical riser', 'riser').slice(0, max)
}
