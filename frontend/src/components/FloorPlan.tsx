import { useMemo } from 'react'
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
 */
export function FloorPlan({ world, level }: Props) {
  const { byLevel, equipmentByLevel, spaces, spec, width, depth } = useBuilding()
  const here = byLevel[level] ?? []
  const equipment = equipmentByLevel[level] ?? []
  const openings = useMemo(() => (spec?.openings ?? []).filter((o) => o.level === level), [spec, level])

  const darkNow = world.impact.dark_levels.includes(level)
  const darkSoon = !darkNow && world.forecast.impact.dark_levels.includes(level)

  // Residents to mark on this level: anyone affected (now, or predicted) with a story to tell.
  const marks = useMemo(() => {
    const src = world.impact.residents.length ? world.impact.residents : world.forecast.impact.residents
    const predicted = world.impact.residents.length === 0
    return src
      .filter((r) => r.level === level && r.severity !== 'info')
      .map((r) => ({ r, predicted, space: spaces[r.room] }))
      .filter((m) => m.space)
  }, [world.impact.residents, world.forecast.impact.residents, level, spaces])

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

  if (!spec) return <div className="flex h-full items-center justify-center text-slate-500">loading building…</div>

  return (
    <svg viewBox={`-1 -1 ${width + 2} ${depth + 2}`} className="h-full w-full" style={{ maxHeight: '100%' }}>
      <defs>
        <pattern id="hatch" width="1.2" height="1.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="0.5" height="1.2" fill="#ffb020" opacity="0.45" />
        </pattern>
      </defs>
      <g transform={`translate(0 ${depth}) scale(1 -1)`}>
        {spec.footprint.map((r, i) => (
          <rect key={i} x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill="#0d1117" stroke="#2a3442" strokeWidth={0.15} />
        ))}

        {here.map((s) => {
          const w = world.water[s.id]
          const waterOpacity = w ? Math.min(0.9, 0.25 + (w.depth / 0.3) * 0.65) : 0
          return (
            <g key={s.id}>
              <rect
                x={s.rect.x0}
                y={s.rect.y0}
                width={s.rect.x1 - s.rect.x0}
                height={s.rect.y1 - s.rect.y0}
                fill={KIND_FILL[s.kind] ?? '#1a2330'}
                stroke="#3a4656"
                strokeWidth={0.08}
              >
                <title>
                  {s.name} · {s.kind}
                  {w ? ` · water ${(w.depth * 100).toFixed(0)} cm` : ''}
                </title>
              </rect>
              {darkNow && s.kind !== 'courtyard' && (
                <rect x={s.rect.x0} y={s.rect.y0} width={s.rect.x1 - s.rect.x0} height={s.rect.y1 - s.rect.y0} fill="#ff4d4f" opacity={0.18} pointerEvents="none" />
              )}
              {darkSoon && s.kind !== 'courtyard' && (
                <rect x={s.rect.x0} y={s.rect.y0} width={s.rect.x1 - s.rect.x0} height={s.rect.y1 - s.rect.y0} fill="url(#hatch)" className="haven-pulse" pointerEvents="none" />
              )}
              {w && (
                <rect x={s.rect.x0} y={s.rect.y0} width={s.rect.x1 - s.rect.x0} height={s.rect.y1 - s.rect.y0} fill="#3ba7ff" opacity={waterOpacity} pointerEvents="none" />
              )}
            </g>
          )
        })}

        {openings.map((o) =>
          o.axis === 'x' ? (
            <line key={o.id} x1={o.x - o.width / 2} x2={o.x + o.width / 2} y1={o.y} y2={o.y} stroke={o.kind === 'exit' ? '#2ecc8f' : '#6b7a90'} strokeWidth={0.25} />
          ) : (
            <line key={o.id} x1={o.x} x2={o.x} y1={o.y - o.width / 2} y2={o.y + o.width / 2} stroke={o.kind === 'exit' ? '#2ecc8f' : '#6b7a90'} strokeWidth={0.25} />
          ),
        )}

        {routes.map((r) => (
          <polyline key={r.id} points={r.points} fill="none" stroke="#2ecc8f" strokeWidth={0.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} strokeDasharray="1.2 0.6" />
        ))}

        {equipment.map((e) => {
          const st = world.equipment[e.id]?.status ?? 'online'
          const leaking = world.leaks[e.id]?.active
          return (
            <g key={e.id}>
              {leaking && <circle cx={e.x} cy={e.y} r={2.2} fill="#3ba7ff" opacity={0.35} className="haven-pulse" />}
              <circle cx={e.x} cy={e.y} r={e.kind === 'sensor' ? 0.55 : 0.7} fill={STATUS_COLOR[st]} stroke="#07090c" strokeWidth={0.12}>
                <title>
                  {e.name} · {st}
                  {e.flood_height != null ? ` · fails at ${(e.flood_height * 100).toFixed(0)} cm` : ''}
                </title>
              </circle>
            </g>
          )
        })}

        {marks.map(({ r, predicted, space }) => {
          const cx = (space.rect.x0 + space.rect.x1) / 2
          const cy = (space.rect.y0 + space.rect.y1) / 2
          const color = r.severity === 'critical' ? '#ff4d4f' : '#ffb020'
          return (
            <g key={r.id}>
              <circle cx={cx} cy={cy} r={NAMED.has(r.id) ? 1.1 : 0.7} fill={color} opacity={predicted ? 0.55 : 1} stroke="#07090c" strokeWidth={0.15}>
                <title>
                  {r.name} · {space.name} · {r.impacts.join(', ')}
                </title>
              </circle>
            </g>
          )
        })}
      </g>

      {/* Labels are drawn un-flipped so the text reads normally. */}
      <g fontFamily="Inter, sans-serif" fontSize={1.1} fill="#94a3b8" pointerEvents="none">
        {here
          .filter((s) => s.kind !== 'room' && s.kind !== 'bathroom' && s.rect.x1 - s.rect.x0 > 3 && s.rect.y1 - s.rect.y0 > 2.4)
          .map((s) => (
            <text key={s.id} x={(s.rect.x0 + s.rect.x1) / 2} y={depth - (s.rect.y0 + s.rect.y1) / 2} textAnchor="middle" dominantBaseline="middle" fontSize={s.kind === 'corridor' ? 0.9 : 1.1} opacity={0.8}>
              {short(s.name)}
            </text>
          ))}
        {marks
          .filter((m) => NAMED.has(m.r.id))
          .map(({ r, space }) => (
            <text key={r.id} x={(space.rect.x0 + space.rect.x1) / 2} y={depth - (space.rect.y0 + space.rect.y1) / 2 - 1.5} textAnchor="middle" fontSize={1.3} fill="#fff" fontWeight={600}>
              {r.name.split(' ')[0]}
            </text>
          ))}
      </g>
    </svg>
  )
}

function short(name: string): string {
  return name.replace(/\s*\(.*\)/, '').replace('Electrical riser', 'riser').slice(0, 22)
}
