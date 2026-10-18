import { useEffect, useMemo, useRef, useState } from 'react'
import { KIND_FILL, STATUS_COLOR } from '../lib/labels'
import { useBuilding } from '../state/building'
import type { Space, WorldState } from '../state/types'

interface Props {
  world: WorldState
  level: string
}

const NAMED = new Set(['maya', 'dana', 'jordan', 'sam', 'lucia', 'theo', 'nora', 'ahmed', 'grace'])

/**
 * One level of the building drawn straight from the spec: x east, y north (SVG y is
 * flipped inside the <g>). Everything that changes colour comes from the world state.
 * Motion is event-driven: overlays ease rather than switch, a space ripples once when it
 * first gets wet, a route draws itself on, a stranded person gets a pulsing ring.
 */
export function FloorPlan({ world, level }: Props) {
  const { byLevel, equipmentByLevel, spaces, spec, width, depth, residents } = useBuilding()
  const here = byLevel[level] ?? []
  const equipment = equipmentByLevel[level] ?? []
  const openings = useMemo(() => (spec?.openings ?? []).filter((o) => o.level === level), [spec, level])

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
      out.push({
        id: rid,
        name: residents[rid]?.name ?? rid,
        x: Math.min(x, s.rect.x1 - 0.5),
        y: Math.min(y, s.rect.y1 - 0.5),
        named: NAMED.has(rid),
      })
    }
    return out
  }, [world.moved, spaces, level, residents])

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
      out.push({
        id: a.actor,
        label: a.label,
        status: a.status,
        x,
        y,
        hx: onLevel ? (here.rect.x0 + here.rect.x1) / 2 : null,
        hy: onLevel ? (here.rect.y0 + here.rect.y1) / 2 : null,
      })
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

  if (!spec) return <div className="flex h-full items-center justify-center text-[12px] text-t3">loading building…</div>

  return (
    <svg viewBox={`-2 -2 ${width + 4} ${depth + 4}`} className="floorplan h-full w-full" style={{ maxHeight: '100%' }}>
      <defs>
        <pattern id="hatch" width="1.2" height="1.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="0.5" height="1.2" fill="#d97706" opacity="0.4" />
        </pattern>
        <filter id="routeGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.6" />
        </filter>
        <radialGradient id="vignette" cx="50%" cy="45%" r="70%">
          <stop offset="0%" stopColor="rgba(15,98,254,0.04)" />
          <stop offset="100%" stopColor="rgba(15,98,254,0)" />
        </radialGradient>
      </defs>
      <rect x={-2} y={-2} width={width + 4} height={depth + 4} fill="url(#vignette)" rx={3} />
      <g transform={`translate(0 ${depth}) scale(1 -1)`}>
        {spec.footprint.map((r, i) => (
          <rect key={i} x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill="rgba(15,23,42,0.015)" stroke="var(--fp-line)" strokeWidth={0.14} />
        ))}

        {here.map((s) => {
          const w = world.water[s.id]
          const waterOpacity = w ? Math.min(0.85, 0.22 + (w.depth / 0.3) * 0.6) : 0
          const overlay = s.kind !== 'courtyard'
          const rx = s.rect.x0
          const ry = s.rect.y0
          const rw = s.rect.x1 - s.rect.x0
          const rh = s.rect.y1 - s.rect.y0
          return (
            <g key={s.id}>
              <rect x={rx} y={ry} width={rw} height={rh} fill={KIND_FILL[s.kind] ?? 'rgba(15,23,42,0.04)'} stroke="var(--fp-line-soft)" strokeWidth={0.08}>
                <title>
                  {s.name} · {s.kind}
                  {w ? ` · water ${(w.depth * 100).toFixed(0)} cm` : ''}
                </title>
              </rect>
              {/* overlays are always present and ease in and out, instead of switching */}
              {overlay && <rect className="fp-fill" x={rx} y={ry} width={rw} height={rh} fill="#dc2626" opacity={darkNow ? 0.14 : 0} pointerEvents="none" />}
              {overlay && (
                <rect className={`fp-fill ${darkSoon ? 'haven-pulse' : ''}`} x={rx} y={ry} width={rw} height={rh} fill="url(#hatch)" opacity={darkSoon ? 1 : 0} pointerEvents="none" />
              )}
              {w && <rect className="fp-fill fp-fade-in" x={rx} y={ry} width={rw} height={rh} fill="#0ea5e9" opacity={waterOpacity} pointerEvents="none" />}
            </g>
          )
        })}

        {ripples.map((r) => (
          <circle key={r.key} className="fp-ripple" cx={r.cx} cy={r.cy} r={2.5} fill="none" stroke="#0ea5e9" strokeWidth={0.35} />
        ))}

        {openings.map((o) =>
          o.axis === 'x' ? (
            <line key={o.id} x1={o.x - o.width / 2} x2={o.x + o.width / 2} y1={o.y} y2={o.y} stroke={o.kind === 'exit' ? '#16a34a' : 'var(--fp-line)'} strokeWidth={0.22} />
          ) : (
            <line key={o.id} x1={o.x} x2={o.x} y1={o.y - o.width / 2} y2={o.y + o.width / 2} stroke={o.kind === 'exit' ? '#16a34a' : 'var(--fp-line)'} strokeWidth={0.22} />
          ),
        )}

        {/* keyed on the geometry, so a changed route redraws itself on */}
        {routes.map((r) => (
          <g key={`${r.id}:${r.points}`}>
            <polyline className="fp-draw" pathLength={1} points={r.points} fill="none" stroke="#22c55e" strokeWidth={1.1} strokeLinejoin="round" strokeLinecap="round" opacity={0.45} filter="url(#routeGlow)" />
            <polyline className="fp-draw-dash" points={r.points} fill="none" stroke="#16a34a" strokeWidth={0.45} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} strokeDasharray="1.2 0.6" />
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
              {a.hx != null && a.hy != null && (
                <line x1={a.hx} y1={a.hy} x2={a.x} y2={a.y} stroke={color} strokeWidth={0.18} strokeDasharray="0.5 0.4" opacity={0.7} />
              )}
              <rect className={`mark-in ${a.status === 'moving' ? 'haven-pulse' : ''}`} x={a.x - 0.6} y={a.y - 0.6} width={1.2} height={1.2} transform={`rotate(45 ${a.x} ${a.y})`} fill={color} stroke="var(--fp-mark-stroke)" strokeWidth={0.12}>
                <title>
                  {a.label} · {a.status}
                </title>
              </rect>
            </g>
          )
        })}

        {equipment.map((e) => {
          const st = world.equipment[e.id]?.status ?? 'online'
          const leaking = world.leaks[e.id]?.active
          return (
            <g key={e.id}>
              {leaking && <circle cx={e.x} cy={e.y} r={2.2} fill="#0ea5e9" opacity={0.3} className="haven-pulse" />}
              <circle className="fp-fill" cx={e.x} cy={e.y} r={e.kind === 'sensor' ? 0.55 : 0.7} fill={STATUS_COLOR[st]} stroke="var(--fp-mark-stroke)" strokeWidth={0.12}>
                <title>
                  {e.name} · {st}
                  {e.flood_height != null ? ` · fails at ${(e.flood_height * 100).toFixed(0)} cm` : ''}
                </title>
              </circle>
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
              <circle className="mark-in fp-fill" cx={cx} cy={cy} r={NAMED.has(r.id) ? 1.1 : 0.7} fill={color} opacity={predicted ? 0.55 : 1} stroke="var(--fp-mark-stroke)" strokeWidth={0.15}>
                <title>
                  {r.name} · {space.name} · {r.impacts.join(', ')}
                </title>
              </circle>
            </g>
          )
        })}
      </g>

      {/* Labels are drawn un-flipped so the text reads normally. */}
      <g fontFamily="Geist, sans-serif" fontSize={1.1} fill="var(--fp-text)" pointerEvents="none">
        {here
          .filter((s) => s.kind !== 'room' && s.kind !== 'bathroom' && s.rect.x1 - s.rect.x0 > 3 && s.rect.y1 - s.rect.y0 > 2.4)
          .map((s) => (
            <text
              key={s.id}
              x={(s.rect.x0 + s.rect.x1) / 2}
              y={depth - (s.rect.y0 + s.rect.y1) / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={s.kind === 'corridor' ? 0.95 : 1.15}
              fontWeight={500}
              opacity={0.7}
            >
              {short(s.name)}
            </text>
          ))}
        {marks
          .filter((m) => NAMED.has(m.r.id))
          .map(({ r, space }) => (
            <text key={r.id} className="fp-fade-in" x={(space.rect.x0 + space.rect.x1) / 2} y={depth - (space.rect.y0 + space.rect.y1) / 2 - 1.5} textAnchor="middle" fontSize={1.3} fill="var(--fp-text-strong)" fontWeight={600}>
              {r.name.split(' ')[0]}
            </text>
          ))}
        {movedMarks
          .filter((m) => m.named)
          .map((m) => (
            <text key={`moved-label-${m.id}`} className="fp-fade-in" x={m.x} y={depth - m.y - 1.2} textAnchor="middle" fontSize={1.3} fill="#16a34a" fontWeight={600}>
              {m.name.split(' ')[0]}
            </text>
          ))}
        {leftBehind.map(({ id, space }) => (
          <text key={`left-label-${id}`} className="fp-fade-in" x={(space.rect.x0 + space.rect.x1) / 2} y={depth - (space.rect.y0 + space.rect.y1) / 2 + 3.2} textAnchor="middle" fontSize={1.1} fill="#7c3aed" fontWeight={600}>
            left behind
          </text>
        ))}
        {actors
          .filter((a) => a.status !== 'idle')
          .map((a) => (
            <text key={`actor-label-${a.id}`} className="fp-fade-in" x={a.x} y={depth - a.y - 1.1} textAnchor="middle" fontSize={0.95} fill={a.status === 'moving' ? '#0284c7' : '#16a34a'} fontWeight={600}>
              {a.label.replace(/\s*\(.*\)/, '')}
            </text>
          ))}
      </g>
    </svg>
  )
}

function short(name: string): string {
  return name.replace(/\s*\(.*\)/, '').replace('Electrical riser', 'riser').slice(0, 22)
}
