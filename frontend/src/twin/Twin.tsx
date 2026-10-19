import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { select, useSelection } from '../components/Inspector'
import { useBuilding } from '../state/building'
import type { BudsFocus } from '../state/types'
import { useWorld } from '../state/world'
import { PeopleCard, SelectionCard, ViewLegend, type Derived } from './Cards'
import { useHover } from './hover'
import { actorMarks, atRiskIds, isNight, levelStatus, liftShafts, peopleMarks, routeLines, sceneMode, stepBeacons, upcoming, type Tab } from './model'
import { PLATE_TOP, TwinScene, buildLevels, placeBeacons } from './Scene'
import './twin.css'

/**
 * The live animation: a realistic 3D building generated from the spec (no model files) with the world's
 * facts animated on it. It follows the story by itself (the building at rest, the live status in an incident,
 * the response once approved); "Show everyone" puts every resident in their room with the step-free routes.
 * Clicking selects the same records the workstation shows; nothing here approves or changes anything.
 * The photoreal Blender model is the other tab, one level up (App.tsx).
 */

const EVERYONE_KEY = 'haven.twin.everyone'

function loadEveryone(): boolean {
  try {
    return localStorage.getItem(EVERYONE_KEY) === '1'
  } catch {
    return false
  }
}

interface Label {
  key: string
  p?: [number, number, number]
  follow?: string
  lift?: number
  interactive?: boolean
  node: ReactNode
}

/** The words in the scene for this tab: shared rooms on an open floor, the leak and the lifts, the named people, responders and steps. */
function sceneLabels({ data, tab, level, d, actors, leaks, byLevel, onStep }: {
  data: NonNullable<ReturnType<typeof buildLevels>>
  tab: Tab
  level: string
  d: Derived
  actors: ReturnType<typeof actorMarks>
  leaks: { id: string; x: number; y: number; level: string; flow: number; name: string }[]
  byLevel: Record<string, import('../state/types').Space[]>
  onStep: (id: string) => void
}): Label[] {
  const idx = Object.fromEntries(data.levels.map((g) => [g.level.id, g]))
  const at = (x: number, y: number, lv: string, lift = 0): [number, number, number] => [x - data.cx, (idx[lv]?.level.elevation ?? 0) + PLATE_TOP + lift, data.cy - y]
  const shows = (lv: string) => (level === 'all' ? tab !== 'building' || !idx[lv]?.below : lv === level)
  const out: Label[] = []
  if (tab === 'building' && level !== 'all') {
    for (const s of (byLevel[level] ?? []).filter((x) => !['room', 'corridor', 'bathroom', 'stair', 'riser', 'lift'].includes(x.kind) && (x.rect.x1 - x.rect.x0) * (x.rect.y1 - x.rect.y0) > 22).slice(0, 12))
      out.push({ key: `room:${s.id}`, p: at((s.rect.x0 + s.rect.x1) / 2, (s.rect.y0 + s.rect.y1) / 2, s.level, 1.5), node: <span className="tw-tag">{s.name.replace(/\s*\(.*\)/, '')}</span> })
  }
  if (tab === 'status') {
    for (const l of leaks.filter((x) => shows(x.level))) out.push({ key: `leak:${l.id}`, p: at(l.x, l.y, l.level, 3.6), node: <span className="tw-label is-water">{l.name} · {l.flow.toFixed(0)} L/s</span> })
    const focus = level !== 'all' ? idx[level] : undefined
    for (const l of d.lifts) {
      const top = focus ? Math.min(l.to, focus.level.elevation + focus.level.height) : l.to
      out.push({ key: `lift:${l.id}`, p: [(l.rect.x0 + l.rect.x1) / 2 - data.cx, top + 1.6, data.cy - (l.rect.y0 + l.rect.y1) / 2], node: <span className={`tw-label ${l.running ? 'is-safe' : 'is-critical'}`}>{l.name} {l.running ? 'running' : 'down'}</span> })
    }
  }
  if (tab === 'status') {
    for (const n of d.people.filter((m) => m.tone === 'left' && shows(m.level)))
      out.push({
        key: `person:${n.id}`,
        p: at(n.x, n.y, n.level, 2.5),
        node: (
          <span className="tw-label is-left" data-buds={`resident:${n.id}`}>
            <b>{n.name.split(' ')[0]}</b>
            <span>{n.status}</span>
          </span>
        ),
      })
  }
  if (tab === 'people') {
    const rank: Record<string, number> = { left: 0, critical: 1, warning: 2, moved: 3, calm: 4, safe: 4 }
    for (const n of d.people.filter((m) => m.named && shows(m.level)).sort((a, b) => rank[a.tone] - rank[b.tone]))
      out.push({
        key: `person:${n.id}`,
        p: at(n.x, n.y, n.level, 2.5),
        node: (
          <span className={`tw-label is-${n.tone}`} data-buds={`resident:${n.id}`}>
            <b>{n.name.split(' ')[0]}</b>
            {n.status !== 'fine' && <span>{n.status}</span>}
          </span>
        ),
      })
  }
  if (tab === 'response') {
    for (const a of actors.filter((x) => x.status !== 'idle' && ((x.to && shows(x.to.level)) || (x.from && shows(x.from.level)))))
      out.push({
        key: `actor:${a.id}`,
        follow: `actor:${a.id}`,
        lift: 2.6,
        node: (
          <span className={`tw-label is-actor is-${a.status}`} data-buds={`actor:${a.id}`}>
            <b>{a.label}</b>
            {a.status !== 'idle' && <span>{a.status === 'moving' ? 'on the way' : a.status === 'done' ? 'done' : a.status}</span>}
          </span>
        ),
      })
    for (const { b, pos } of placeBeacons(d.beacons.filter((x) => x.where && shows(x.where.level) && x.state !== 'pending' && x.state !== 'proposed'), at))
      out.push({
        key: `step:${b.id}`,
        p: [pos[0], pos[1] + 4.6, pos[2]],
        interactive: true,
        node: (
          <button className={`tw-beacon is-${b.state}`} onClick={() => onStep(b.id)} title={`${b.order}. ${b.title}`} data-buds={`step:${b.id}`}>
            {b.state === 'done' ? '✓' : b.order}
          </button>
        ),
      })
  }
  return out
}

export default function Twin({ level, setLevel, connections }: { level: string; setLevel: (l: string) => void; connections: boolean }) {
  const spec = useBuilding((b) => b.spec)
  const byLevel = useBuilding((b) => b.byLevel)
  const spaces = useBuilding((b) => b.spaces)
  const equipment = useBuilding((b) => b.equipment)
  const residents = useBuilding((b) => b.residents)
  const levels = useBuilding((b) => b.levels)
  const ground = useBuilding((b) => b.ground)
  const storyIds = useBuilding((b) => b.storyIds)
  const graph = useBuilding((b) => b.graph)
  const world = useWorld((s) => s.world)
  const clock = useWorld((s) => s.clock)
  const night = useWorld((s) => isNight(s.clock?.time_of_day))
  const [everyone, setEveryoneState] = useState<boolean>(loadEveryone)
  const setEveryone = useCallback((on: boolean) => {
    setEveryoneState(on)
    try {
      localStorage.setItem(EVERYONE_KEY, on ? '1' : '0')
    } catch {
      /* the choice lasts this visit */
    }
  }, [])
  const tab = everyone ? 'people' : 'building'
  const [selection] = useSelection()

  const data = useMemo(() => (spec ? buildLevels(spec.levels, byLevel, spec.footprint, ground) : null), [spec, byLevel, ground])
  useEffect(
    () => () => {
      for (const g of data?.levels ?? []) {
        g.storey.dispose()
        g.plate.dispose()
      }
    },
    [data],
  )

  // Everything the tabs draw, derived from the frame that just arrived.
  const levelList = spec?.levels
  const derived = useMemo(() => {
    if (!world || !clock || !levelList) return null
    return {
      status: levelStatus(world, levelList, spaces),
      people: peopleMarks(world, residents, spaces, storyIds),
      routes: routeLines(world, spaces, residents),
      actors: actorMarks(world, spaces),
      beacons: stepBeacons(world, spaces, equipment, residents),
      lifts: liftShafts(world, equipment, spaces, levels),
      upcoming: upcoming(world, clock),
      atRisk: atRiskIds(world, equipment),
    }
  }, [world, clock, levelList, spaces, residents, storyIds, equipment, levels])

  const scene = useMemo(() => {
    if (!world) return null
    const lit: Record<string, boolean> = { ...world.power.levels }
    const equipmentStatus: Record<string, string> = {}
    for (const [id, st] of Object.entries(world.equipment)) equipmentStatus[id] = st.status
    const leaks = Object.entries(world.leaks)
      .filter(([, l]) => l.active)
      .map(([id, l]) => ({ id, flow: l.flow_lps, x: equipment[id]?.x ?? 0, y: equipment[id]?.y ?? 0, level: equipment[id]?.level ?? spaces[l.space]?.level ?? '', name: (equipment[id]?.name ?? id).replace(/\s*\(.*\)/, '') }))
      .filter((l) => l.level)
    const water = Object.entries(world.water)
      .filter(([sid, w]) => w.depth >= 0.005 && spaces[sid])
      .map(([sid, w]) => ({ id: sid, level: spaces[sid].level, depth: w.depth }))
    return { lit, equipmentStatus, leaks, water, liveFeeds: new Set(world.power.live) }
  }, [world, equipment, spaces])

  const stage = world?.narrative.stage ?? 'quiet'

  // Buds pointing at a person brings the People tab; a responder or a step, the building (which shows the response).
  useEffect(() => {
    const onFocus = (e: Event) => {
      for (const f of (e as CustomEvent<BudsFocus[]>).detail ?? []) {
        if (f.kind === 'resident') setEveryone(true)
        if (f.kind === 'actor' || f.kind === 'step') setEveryone(false)
      }
    }
    window.addEventListener('haven:focus', onFocus)
    return () => window.removeEventListener('haven:focus', onFocus)
  }, [setEveryone])

  // The tooltip rides the pointer without re-rendering anything.
  const stageRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const hover = useHover((h) => h.info)
  const onMove = (e: React.PointerEvent) => {
    const r = stageRef.current?.getBoundingClientRect()
    if (r && tipRef.current) tipRef.current.style.transform = `translate(${e.clientX - r.left + 14}px, ${e.clientY - r.top + 14}px)`
  }

  const labelsRef = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 720))
    ro.observe(el)
    return () => ro.disconnect()
  }, [spec])

  const onSelect = useCallback((kind: 'space' | 'equipment' | 'resident', id: string) => select({ kind, id }), [])
  const focusPlan = useCallback((detail: BudsFocus[]) => window.dispatchEvent(new CustomEvent('haven:focus', { detail })), [])
  const onStep = useCallback((id: string) => focusPlan([{ kind: 'step', id, label: id }]), [focusPlan])

  if (!spec || !data || !world || !clock || !derived || !scene) {
    return <div className="tw-stage flex items-center justify-center text-xs text-t3">drawing the building…</div>
  }

  const d: Derived = derived
  const mode: Tab = sceneMode(tab, world)
  const labels = sceneLabels({ data, tab: mode, level, d, actors: derived.actors, leaks: scene.leaks, byLevel, onStep })
  const quiet = stage === 'quiet'
  const done = world.approved_plan?.status === 'done'
  const visibleLeak = scene.leaks.some((l) => (level === 'all' ? mode !== 'building' : l.level === level))
  const ambient = (!quiet && !done && mode !== 'building') || visibleLeak || (mode === 'response' && Object.values(world.actors).some((a) => a.status === 'moving'))

  return (
    <div ref={stageRef} className={`tw-stage ${night ? 'is-night' : ''} ${hover ? 'is-pointing' : ''}`} onPointerMove={onMove} onPointerLeave={() => useHover.setState({ info: null })}>
      <Canvas frameloop="demand" shadows dpr={[1, 1.75]} camera={{ fov: 30, near: 0.5, far: 4000, position: [-90, 110, 160] }} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}>
        <TwinScene
          data={data}
          tab={mode}
          focus={level}
          night={night}
          status={d.status}
          lit={scene.lit}
          spaces={spaces}
          byLevel={byLevel}
          equipment={equipment}
          openings={spec.openings}
          graph={graph}
          liveFeeds={scene.liveFeeds}
          equipmentStatus={scene.equipmentStatus}
          leaks={scene.leaks}
          water={scene.water}
          atRisk={derived.atRisk}
          lifts={d.lifts}
          people={d.people}
          routes={d.routes}
          actors={derived.actors}
          beacons={d.beacons}
          connections={connections}
          selected={selection}
          ambient={ambient}
          onLevel={setLevel}
          onSelect={onSelect}
          onStep={onStep}
          labels={labelsRef}
          inset={wide && everyone ? 354 : 0}
        />
      </Canvas>

      <div ref={labelsRef} className="tw-labels" aria-hidden={false}>
        {labels.map((l) => (
          <div key={l.key} className={`tw-anchor ${l.interactive ? 'is-interactive' : ''}`} data-p={l.p?.map((n) => n.toFixed(2)).join(',')} data-follow={l.follow} data-lift={l.lift}>
            {l.node}
          </div>
        ))}
      </div>


      <div className="tw-left" key={mode}>
        <button className={`tw-everyone ${everyone ? 'is-on' : ''}`} onClick={() => setEveryone(!everyone)} aria-pressed={everyone} title="Every resident in their room, who needs help, and the step-free routes">
          <span className="tw-everyone-track"><span /></span>
          Show everyone
        </button>
        {mode === 'people' ? <PeopleCard world={world} d={d} setLevel={setLevel} onPerson={(id) => onSelect('resident', id)} /> : <ViewLegend mode={mode} level={level} />}
      </div>

      {selection && (
        <div className="tw-right" key={`${selection.kind}:${selection.id}`}>
          <SelectionCard selection={selection} world={world} people={d.people} onClose={() => select(null)} />
        </div>
      )}

      <div ref={tipRef} className={`tw-tip ${hover ? 'is-on' : ''}`} aria-hidden="true">
        {hover && (
          <>
            <b>{hover.title}</b>
            {hover.sub && <span>{hover.sub}</span>}
          </>
        )}
      </div>
    </div>
  )
}
