import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { CameraControls, Environment, Lightformer, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { Equipment, Graph, Level, Opening, Space } from '../state/types'
import { BEVEL, SLAB_GAP, plateGeometry, storeyGeometry, windowTextures, roundedShapes, outlineLoops, levelRects } from './geometry'
import { PALETTE, TONE, kindTint, type ActorMark, type LevelStatus, type PersonMark, type RouteLine, type StepBeacon, type Tab, type Tone } from './model'
import { setHover, type HoverInfo } from './hover'

/**
 * The stylized twin: every storey a soft rounded slab extruded from the spec's outline, rooms as pastel
 * tiles with low Sims-style walls when a floor is opened, and the world's facts laid over it per tab.
 * Rendering is on demand: a frame is drawn when the world, the camera or a transition changes, and a
 * 30 fps heartbeat runs only while something on screen is meant to move (water, a pulse, a responder).
 * One material per storey, instanced rooms, people and plant: a few dozen draw calls, no model files.
 */

const noRaycast = () => null
export const PLATE_TOP = 0.3 // where a storey's floor tiles, water and people sit, above its elevation
const damp = THREE.MathUtils.damp
const WHITE = new THREE.Color('#ffffff')
const PLATE = new THREE.Color(PALETTE.plate)

export interface LevelGeo {
  level: Level
  storey: THREE.ExtrudeGeometry
  plate: THREE.ExtrudeGeometry
  box: THREE.Box3
  below: boolean
}

export interface SceneData {
  levels: LevelGeo[]
  cx: number
  cy: number
  footprintBounds: { x0: number; y0: number; x1: number; y1: number }
  footprint: { x0: number; y0: number; x1: number; y1: number }[]
}

/** Build the storeys once per spec. */
export function buildLevels(levels: Level[], byLevel: Record<string, Space[]>, footprint: SceneData['footprint'], groundId: string | null): SceneData {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of footprint) {
    x0 = Math.min(x0, r.x0)
    y0 = Math.min(y0, r.y0)
    x1 = Math.max(x1, r.x1)
    y1 = Math.max(y1, r.y1)
  }
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const ground = levels.find((l) => l.id === groundId)
  const cache = new Map<string, THREE.Shape[]>()
  const out: LevelGeo[] = []
  for (const lv of [...levels].sort((a, b) => a.index - b.index)) {
    const rects = levelRects(lv, ground, footprint, byLevel[lv.id] ?? [])
    if (rects.length === 0) continue
    const key = rects.map((r) => `${r.x0},${r.y0},${r.x1},${r.y1}`).join('|')
    let shapes = cache.get(key)
    if (!shapes) {
      shapes = roundedShapes(outlineLoops(rects), 0.35, cx, cy)
      cache.set(key, shapes)
    }
    const storey = storeyGeometry(shapes, lv.height)
    const plate = plateGeometry(shapes)
    storey.computeBoundingBox()
    const box = storey.boundingBox!.clone()
    box.min.y += lv.elevation
    box.max.y += lv.elevation
    out.push({ level: lv, storey, plate, box, below: !!ground && lv.index < ground.index })
  }
  return { levels: out, cx, cy, footprintBounds: { x0, y0, x1, y1 }, footprint }
}

export interface SceneProps {
  data: SceneData
  tab: Tab
  focus: string // a level id or 'all'
  night: boolean
  status: Record<string, LevelStatus>
  lit: Record<string, boolean>
  spaces: Record<string, Space>
  byLevel: Record<string, Space[]>
  equipment: Record<string, Equipment>
  openings: Opening[]
  graph: Graph | null
  liveFeeds: Set<string>
  equipmentStatus: Record<string, string>
  leaks: { id: string; x: number; y: number; level: string; flow: number; name: string }[]
  water: { id: string; level: string; depth: number }[]
  atRisk: Set<string>
  lifts: { id: string; name: string; running: boolean; rect: Space['rect']; from: number; to: number }[]
  people: PersonMark[]
  routes: RouteLine[]
  actors: ActorMark[]
  beacons: StepBeacon[]
  connections: boolean
  selected: { kind: string; id: string } | null
  ambient: boolean
  onLevel: (id: string) => void
  onSelect: (kind: 'space' | 'equipment' | 'resident', id: string) => void
  onStep: (id: string) => void
  /** The DOM layer whose children carry data-p (a scene position) or data-follow (an object name): positioned every frame. */
  labels: RefObject<HTMLDivElement | null>
  /** Pixels the floating card covers on the left: the camera frames the building in the space beside it. */
  inset: number
}

export const TwinScene = memo(function TwinScene(p: SceneProps) {
  const levelIndex = useMemo(() => Object.fromEntries(p.data.levels.map((g) => [g.level.id, g])), [p.data])
  const focusGeo = p.focus !== 'all' ? levelIndex[p.focus] : undefined
  const xray = p.tab !== 'building'
  // A level's data shows when the whole building is in view (x-ray tabs) or when it is the open floor.
  const shows = useCallback((levelId: string) => (p.focus === 'all' ? xray || !levelIndex[levelId]?.below : levelId === p.focus), [p.focus, xray, levelIndex])
  const { cx, cy } = p.data
  const at = useCallback((x: number, y: number, levelId: string, lift = 0): [number, number, number] => [x - cx, (levelIndex[levelId]?.level.elevation ?? 0) + PLATE_TOP + lift, cy - y], [levelIndex, cx, cy])
  const textures = useMemo(() => windowTextures(), [])

  return (
    <>
      <Lights night={p.night} />
      <Heartbeat on={p.ambient} />
      <Projector container={p.labels} />
      <CameraRig data={p.data} tab={p.tab} focus={focusGeo} inset={p.inset} />
      <Ground data={p.data} night={p.night} xray={xray || (focusGeo?.below ?? false)} below={focusGeo?.below ?? false} spaces={p.byLevel} />

      {p.data.levels.map((g) => {
        const above = focusGeo && g.level.index > focusGeo.level.index
        const isFocus = focusGeo?.level.id === g.level.id
        const mode: ShellMode = isFocus ? 'cut' : above ? 'gone' : g.below && p.focus === 'all' && !xray ? 'hidden' : xray ? 'xray' : 'solid'
        const st = p.status[g.level.id]
        return (
          <LevelShell
            key={g.level.id}
            g={g}
            mode={mode}
            tint={p.tab === 'status' && st ? (st.dark ? 'dark' : st.soon ? 'soon' : 'ok') : 'none'}
            lit={!!p.lit[g.level.id]}
            night={p.night}
            textures={textures}
            interactive={p.tab === 'building' && mode === 'solid'}
            onLevel={p.onLevel}
          />
        )
      })}

      {focusGeo && <Interior g={focusGeo} spaces={p.byLevel[focusGeo.level.id] ?? []} tab={p.tab} dark={!!p.status[focusGeo.level.id]?.dark} cx={p.data.cx} cy={p.data.cy} selected={p.selected} onSelect={p.onSelect} />}

      <Water items={p.water.filter((w) => shows(w.level))} spaces={p.spaces} at={at} />
      {p.leaks.filter((l) => shows(l.level)).map((l) => (
        <Leak key={l.id} position={at(l.x, l.y, l.level)} />
      ))}

      {p.tab === 'status' && (
        <>
          <PlantMarks equipment={Object.values(p.equipment).filter((e) => shows(e.level) && ((p.equipmentStatus[e.id] ?? 'online') !== 'online' || p.atRisk.has(e.id)))} status={p.equipmentStatus} atRisk={p.atRisk} at={at} onSelect={p.onSelect} />
          <LiftShafts lifts={p.lifts} cx={p.data.cx} cy={p.data.cy} focus={focusGeo} />
        </>
      )}

      {p.tab === 'status' && <People marks={p.people.filter((m) => m.tone === 'left' && shows(m.level))} at={at} hoverable selected={p.selected} onSelect={p.onSelect} />}
      {(p.tab === 'people' || p.tab === 'response') && <People marks={p.people.filter((m) => shows(m.level) && (p.tab === 'people' || m.tone === 'moved' || m.tone === 'left'))} at={at} hoverable={p.tab === 'people'} selected={p.selected} onSelect={p.onSelect} />}
      {p.tab === 'people' && (
        <>
          <Routes routes={p.routes} at={at} focus={p.focus} />
          <Exits openings={p.openings.filter((o) => o.kind === 'exit' && shows(o.level))} at={at} />
        </>
      )}

      {p.tab === 'response' && (
        <>
          <Actors actors={p.actors.filter((a) => (a.to && shows(a.to.level)) || (a.from && shows(a.from.level)))} at={at} />
          <Beacons beacons={p.beacons.filter((b) => b.where && shows(b.where.level) && b.state !== 'pending' && b.state !== 'proposed')} at={at} />
        </>
      )}

      {p.connections && p.graph && <Connections graph={p.graph} equipment={p.equipment} live={p.liveFeeds} at={at} shows={shows} />}
    </>
  )
})

/* ---- frame scheduling ------------------------------------------------------------------------- */

/** While something on screen is meant to move, ask for frames at 30 fps; otherwise draw only on change. */
function Heartbeat({ on }: { on: boolean }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    if (!on) return
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) return
    const t = setInterval(() => invalidate(), 1000 / 30)
    return () => clearInterval(t)
  }, [on, invalidate])
  return null
}

/* ---- light, sky, ground, trees ----------------------------------------------------------------------- */

/**
 * Daylight or night from the world's clock: a sun (or a cool moon) that casts real shadows, a sky light,
 * and a small procedural environment (no HDRI download) so the glass catches the sky. Fog fades the far
 * ground into the horizon.
 */
function Lights({ night }: { night: boolean }) {
  return (
    <>
      <fog attach="fog" args={[night ? '#2b3a5c' : '#dfe8f2', 280, 680]} />
      <hemisphereLight args={night ? ['#9fb2e6', '#3a3a44', 1.25] : ['#dbe8ff', '#8d8577', 0.85]} />
      <directionalLight
        castShadow
        position={night ? [60, 120, -40] : [-70, 110, 60]}
        intensity={night ? 1.5 : 2.6}
        color={night ? '#c4d0ff' : '#fff1dc'}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-90}
        shadow-camera-right={90}
        shadow-camera-top={90}
        shadow-camera-bottom={-90}
        shadow-camera-near={10}
        shadow-camera-far={420}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
      />
      <directionalLight position={[80, 40, -70]} intensity={night ? 0.45 : 0.35} color={night ? '#ffc98f' : '#cfe0ff'} />
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={night ? 0.6 : 1.6} color={night ? '#6f82b8' : '#eaf2ff'} position={[0, 60, 0]} rotation-x={Math.PI / 2} scale={[200, 200, 1]} />
        <Lightformer form="rect" intensity={night ? 0.1 : 0.6} color={night ? '#2a3354' : '#ffffff'} position={[-80, 20, 40]} rotation-y={Math.PI / 2} scale={[120, 30, 1]} />
        <Lightformer form="rect" intensity={night ? 0.3 : 0.4} color={night ? '#ffcf8a' : '#ffe9cc'} position={[80, 10, -40]} rotation-y={-Math.PI / 2} scale={[120, 20, 1]} />
      </Environment>
    </>
  )
}

/** The site: asphalt streets, a paved plaza round the building, lawn in the courtyards, lane markings. */
function Ground({ data, night, xray, below, spaces }: { data: SceneData; night: boolean; xray: boolean; below: boolean; spaces: Record<string, Space[]> }) {
  const b = data.footprintBounds
  const asphalt = useRef<THREE.MeshStandardMaterial>(null)
  const paving = useRef<THREE.MeshStandardMaterial>(null)
  const lawn = useRef<THREE.MeshStandardMaterial>(null)
  const opacity = useRef(1)
  useFrame((s, dt) => {
    const target = xray ? 0.28 : 1
    opacity.current = damp(opacity.current, target, 6, dt)
    for (const m of [asphalt.current, paving.current, lawn.current]) {
      if (!m) continue
      m.opacity = opacity.current
      m.depthWrite = opacity.current > 0.98
    }
    if (Math.abs(opacity.current - target) > 0.004) s.invalidate()
  })
  const mid = (b.x0 + b.x1) / 2 - data.cx
  const midZ = data.cy - (b.y0 + b.y1) / 2
  const plazaPad = 7
  // Streets run along the two sides the spec's origin sits on (x = 0 and y = 0), just past the plaza.
  const southZ = data.cy - (b.y0 - plazaPad - 6)
  const westX = b.x0 - plazaPad - 6 - data.cx
  const dashes = useMemo(() => {
    const out: { p: [number, number, number]; along: 'x' | 'z' }[] = []
    for (let x = b.x0 - 60; x < b.x1 + 60; x += 6) if (x - data.cx > westX + 4 || x - data.cx < westX - 4) out.push({ p: [x - data.cx, 0.03, southZ], along: 'x' })
    for (let y = b.y0 - 60; y < b.y1 + 60; y += 6) if (data.cy - y < southZ - 4 || data.cy - y > southZ + 4) out.push({ p: [westX, 0.03, data.cy - y], along: 'z' })
    return out
  }, [b.x0, b.x1, b.y0, b.y1, data.cx, data.cy, westX, southZ])
  const courtyards = useMemo(() => Object.values(spaces).flat().filter((s) => s.kind === 'courtyard' || (s.outdoor && s.rect.x1 - s.rect.x0 > 6)), [spaces])
  // Trees: along the streets and in the courtyards, off the footprint and the plaza.
  const trees = useMemo(() => {
    const out: [number, number, number][] = []
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let x = b.x0 - 4; x < b.x1 + 10; x += 9) out.push([x + rnd() * 2, b.y0 - plazaPad + 1.5, 0.9 + rnd() * 0.35])
    for (let y = b.y0 + 4; y < b.y1 + 4; y += 9) out.push([b.x0 - plazaPad + 1.5, y + rnd() * 2, 0.9 + rnd() * 0.35])
    for (let y = b.y0; y < b.y1; y += 12) out.push([b.x1 + plazaPad + 4 + rnd() * 6, y, 0.95 + rnd() * 0.4])
    for (const s of courtyards) {
      out.push([s.rect.x0 + (s.rect.x1 - s.rect.x0) * 0.3, s.rect.y0 + (s.rect.y1 - s.rect.y0) * 0.35, 1])
      out.push([s.rect.x0 + (s.rect.x1 - s.rect.x0) * 0.7, s.rect.y0 + (s.rect.y1 - s.rect.y0) * 0.68, 0.85])
    }
    return out
  }, [courtyards, b.x0, b.x1, b.y0, b.y1])
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[mid, -0.02, midZ]} receiveShadow raycast={noRaycast}>
        <planeGeometry args={[900, 900]} />
        <meshStandardMaterial ref={asphalt} color={night ? '#474c57' : '#7a7f86'} roughness={0.95} transparent />
      </mesh>
      <mesh position={[mid, 0.0, midZ]} receiveShadow raycast={noRaycast}>
        <boxGeometry args={[b.x1 - b.x0 + plazaPad * 2, 0.06, b.y1 - b.y0 + plazaPad * 2]} />
        <meshStandardMaterial ref={paving} color={night ? '#8a8790' : '#cbc5b9'} roughness={0.9} transparent />
      </mesh>
      {courtyards.map((s) => (
        <mesh key={s.id} position={[(s.rect.x0 + s.rect.x1) / 2 - data.cx, 0.05, data.cy - (s.rect.y0 + s.rect.y1) / 2]} receiveShadow raycast={noRaycast}>
          <boxGeometry args={[s.rect.x1 - s.rect.x0 - 1, 0.06, s.rect.y1 - s.rect.y0 - 1]} />
          <meshStandardMaterial ref={lawn} color={night ? '#3d5634' : '#6f9a57'} roughness={1} transparent />
        </mesh>
      ))}
      {!xray &&
        dashes.map((d, i) => (
          <mesh key={i} position={d.p} raycast={noRaycast}>
            <boxGeometry args={d.along === 'x' ? [2.4, 0.02, 0.18] : [0.18, 0.02, 2.4]} />
            <meshBasicMaterial color={night ? '#a9a596' : '#ece8dc'} />
          </mesh>
        ))}
      {!below && <Trees trees={trees} cx={data.cx} cy={data.cy} night={night} />}
    </group>
  )
}

function Trees({ trees, cx, cy, night }: { trees: [number, number, number][]; cx: number; cy: number; night: boolean }) {
  const trunks = useRef<THREE.InstancedMesh>(null)
  const crowns = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const c = new THREE.Color()
    const greens = night ? ['#3e5e34', '#4a6b3d', '#365530'] : ['#4d7a3a', '#5b8a45', '#3f6b33', '#6a9150']
    trees.forEach(([x, y, s], i) => {
      m.compose(new THREE.Vector3(x - cx, 1.4 * s, cy - y), new THREE.Quaternion(), new THREE.Vector3(s, s, s))
      trunks.current?.setMatrixAt(i, m)
      m.compose(new THREE.Vector3(x - cx, 4.1 * s, cy - y), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, i, 0)), new THREE.Vector3(s * 1.15, s * 1.3, s * 1.15))
      crowns.current?.setMatrixAt(i, m)
      crowns.current?.setColorAt(i, c.set(greens[i % greens.length]))
    })
    if (trunks.current) trunks.current.instanceMatrix.needsUpdate = true
    if (crowns.current) {
      crowns.current.instanceMatrix.needsUpdate = true
      if (crowns.current.instanceColor) crowns.current.instanceColor.needsUpdate = true
    }
  }, [trees, cx, cy, night])
  return (
    <group>
      <instancedMesh ref={trunks} args={[undefined, undefined, trees.length]} raycast={noRaycast} key={`t${trees.length}`} castShadow>
        <cylinderGeometry args={[0.16, 0.24, 2.8, 7]} />
        <meshStandardMaterial color={night ? '#4a3a30' : '#5e4636'} roughness={1} />
      </instancedMesh>
      <instancedMesh ref={crowns} args={[undefined, undefined, trees.length]} raycast={noRaycast} key={`c${trees.length}`} castShadow>
        <icosahedronGeometry args={[2, 2]} />
        <meshStandardMaterial color="#ffffff" roughness={0.95} />
      </instancedMesh>
    </group>
  )
}

/* ---- the storeys ------------------------------------------------------------------------------- */

type ShellMode = 'solid' | 'xray' | 'gone' | 'cut' | 'hidden'

function LevelShell({ g, mode, tint, lit, night, textures, interactive, onLevel }: { g: LevelGeo; mode: ShellMode; tint: 'none' | 'ok' | 'dark' | 'soon'; lit: boolean; night: boolean; textures: ReturnType<typeof windowTextures>; interactive: boolean; onLevel: (id: string) => void }) {
  const group = useRef<THREE.Group>(null)
  const [hovered, setHovered] = useState(false)
  const { side, cap } = useMemo(() => {
    // One bay per 3.2 m across, one storey high; the wall's v runs from the slab up (see windowTextures).
    const tile = (t: THREE.Texture | undefined) => {
      if (!t) return null
      const c = t.clone()
      c.repeat.set(1 / 3.2, -1 / g.level.height)
      c.offset.set(0, 1 / g.level.height)
      return c
    }
    const side = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      map: tile(textures?.map),
      roughnessMap: tile(textures?.rough),
      emissiveMap: tile(textures?.glow),
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 0,
      roughness: 1,
      metalness: 0.05,
      envMapIntensity: 0.9,
      transparent: true,
    })
    const cap = new THREE.MeshStandardMaterial({ color: PALETTE.plate, roughness: 0.95, transparent: true })
    return { side, cap }
  }, [textures, g.level.height])
  useEffect(
    () => () => {
      side.map?.dispose()
      side.roughnessMap?.dispose()
      side.emissiveMap?.dispose()
      side.dispose()
      cap.dispose()
    },
    [side, cap],
  )
  const cur = useRef({ side: mode === 'hidden' || mode === 'gone' || mode === 'cut' ? 0 : 1, cap: 1, lift: 0, glow: 0, flicker: 0 })
  const target = useRef(new THREE.Color())
  const wasLit = useRef(lit)
  useEffect(() => {
    // Lights going out: a short flicker before the windows go dark.
    if (wasLit.current && !lit) cur.current.flicker = 1.4
    wasLit.current = lit
  }, [lit])
  const flagged = tint === 'dark' || tint === 'soon'
  const sideTarget = mode === 'solid' ? 1 : mode === 'xray' ? (flagged ? 0.32 : 0.07) : 0
  const capTarget = mode === 'solid' ? 1 : mode === 'xray' ? (flagged ? 0.34 : 0.12) : 0
  const liftTarget = mode === 'gone' ? 9 : 0
  const glowTarget = lit && night && mode !== 'gone' && mode !== 'cut' ? (mode === 'xray' ? 0.5 : 0.85) : 0
  const colour = hovered && interactive ? '#d6deff' : tint === 'dark' ? PALETTE.dark : tint === 'soon' ? PALETTE.soon : '#ffffff'
  useFrame((s, dt) => {
    const c = cur.current
    c.side = damp(c.side, sideTarget, 5, dt)
    c.cap = damp(c.cap, capTarget, 5, dt)
    c.lift = damp(c.lift, liftTarget, 4, dt)
    let glow = (c.glow = damp(c.glow, glowTarget, 3, dt))
    if (c.flicker > 0) {
      c.flicker = Math.max(0, c.flicker - dt)
      glow = Math.random() > 0.5 ? 1.2 : 0.1
    }
    side.opacity = c.side
    side.depthWrite = c.side > 0.98
    cap.opacity = c.cap
    cap.depthWrite = c.cap > 0.98
    side.emissiveIntensity = glow
    const t = target.current.set(colour)
    if (tint === 'soon') t.lerp(WHITE, 0.5 + 0.5 * Math.sin(s.clock.elapsedTime * 3))
    side.color.lerp(t, 1 - Math.exp(-6 * dt))
    cap.color.lerp(flagged ? t : PLATE, 1 - Math.exp(-6 * dt))
    const settled = Math.abs(side.color.r - t.r) + Math.abs(side.color.g - t.g) + Math.abs(side.color.b - t.b) < 0.004
    if (settled) side.color.copy(t)
    if (group.current) {
      group.current.position.y = g.level.elevation + c.lift
      group.current.visible = c.side > 0.01 || c.cap > 0.01
    }
    const moving = Math.abs(c.side - sideTarget) > 0.004 || Math.abs(c.cap - capTarget) > 0.004 || Math.abs(c.lift - liftTarget) > 0.01 || Math.abs(c.glow - glowTarget) > 0.01 || c.flicker > 0 || !settled
    if (moving) s.invalidate()
  })
  return (
    <group ref={group} position={[0, g.level.elevation, 0]}>
      <mesh
        geometry={g.storey}
        material={[cap, side]}
        castShadow={mode === 'solid'}
        receiveShadow={mode === 'solid'}
        raycast={interactive ? undefined : noRaycast}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          if (!interactive) return
          e.stopPropagation()
          setHovered(true)
          setHover({ title: g.level.name, sub: 'Click to look inside', kind: 'level' })
        }}
        onPointerOut={() => {
          setHovered(false)
          setHover(null)
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          if (!interactive) return
          e.stopPropagation()
          setHover(null)
          onLevel(g.level.id)
        }}
      />
    </group>
  )
}

/** An opened floor: its plate, every space as a pastel tile, low walls round the rooms, labels on the shared spaces. */
function Interior({ g, spaces, tab, dark, cx, cy, selected, onSelect }: { g: LevelGeo; spaces: Space[]; tab: Tab; dark: boolean; cx: number; cy: number; selected: { kind: string; id: string } | null; onSelect: SceneProps['onSelect'] }) {
  const tiles = useRef<THREE.InstancedMesh>(null)
  const walls = useRef<THREE.InstancedMesh>(null)
  const y = g.level.elevation
  const walled = useMemo(() => spaces.filter((s) => !s.outdoor && s.kind !== 'corridor' && s.kind !== 'lobby'), [spaces])
  const [hover, setHov] = useState<number | null>(null)
  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const c = new THREE.Color()
    const q = new THREE.Quaternion()
    spaces.forEach((s, i) => {
      const w = s.rect.x1 - s.rect.x0, d = s.rect.y1 - s.rect.y0
      m.compose(new THREE.Vector3((s.rect.x0 + s.rect.x1) / 2 - cx, y + PLATE_TOP - 0.02, cy - (s.rect.y0 + s.rect.y1) / 2), q, new THREE.Vector3(Math.max(0.1, w - 0.14), 0.08, Math.max(0.1, d - 0.14)))
      tiles.current?.setMatrixAt(i, m)
      c.set(kindTint(s.kind))
      if (tab === 'status' && dark && !s.outdoor) c.lerp(new THREE.Color(PALETTE.dark), 0.35)
      if (selected?.kind === 'space' && selected.id === s.id) c.set('#c8b8ff')
      else if (hover === i) c.lerp(new THREE.Color('#c9bfff'), 0.6)
      tiles.current?.setColorAt(i, c)
    })
    let k = 0
    const H = 1.05, T = 0.12
    for (const s of walled) {
      const { x0, y0, x1, y1 } = s.rect
      const edges: [number, number, number, number][] = [
        [(x0 + x1) / 2, y0, x1 - x0, T],
        [(x0 + x1) / 2, y1, x1 - x0, T],
        [x0, (y0 + y1) / 2, T, y1 - y0],
        [x1, (y0 + y1) / 2, T, y1 - y0],
      ]
      for (const [ex, ey, ew, ed] of edges) {
        m.compose(new THREE.Vector3(ex - cx, y + PLATE_TOP + H / 2, cy - ey), q, new THREE.Vector3(ew, H, ed))
        walls.current?.setMatrixAt(k++, m)
      }
    }
    for (const mesh of [tiles.current, walls.current]) {
      if (!mesh) continue
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
    }
  }, [spaces, walled, y, cx, cy, tab, dark, selected, hover])
  return (
    <group>
      <mesh geometry={g.plate} position={[0, y, 0]} raycast={noRaycast} receiveShadow>
        <meshStandardMaterial color={PALETTE.plate} roughness={0.95} />
      </mesh>
      <instancedMesh
        ref={tiles}
        key={`tiles-${g.level.id}-${spaces.length}`}
        args={[undefined, undefined, spaces.length]}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          const i = e.instanceId ?? null
          if (i == null || i === hover) return
          setHov(i)
          const s = spaces[i]
          setHover({ title: s.name, sub: s.kind === 'room' ? `Room · ${s.tags.includes('accessible') ? 'accessible' : s.tags.includes('single') ? 'single' : 'double'}` : s.kind, kind: 'space' })
        }}
        onPointerOut={() => {
          setHov(null)
          setHover(null)
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          if (e.instanceId != null) onSelect('space', spaces[e.instanceId].id)
        }}
      >
        <boxGeometry />
        <meshStandardMaterial color="#ffffff" roughness={0.85} />
      </instancedMesh>
      <instancedMesh ref={walls} key={`walls-${g.level.id}-${walled.length}`} args={[undefined, undefined, walled.length * 4]} raycast={noRaycast} castShadow receiveShadow>
        <boxGeometry />
        <meshStandardMaterial color={PALETTE.wall} roughness={0.9} />
      </instancedMesh>
    </group>
  )
}

/* ---- the world's facts ------------------------------------------------------------------------- */

type At = (x: number, y: number, level: string, lift?: number) => [number, number, number]

/** Water as a pool per wet space, its height the depth the physics computed, rising smoothly to it. */
function Water({ items, spaces, at }: { items: SceneProps['water']; spaces: Record<string, Space>; at: At }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const mat = useRef<THREE.MeshStandardMaterial>(null)
  const shown = useRef<Record<string, number>>({})
  useFrame((s, dt) => {
    const m = mesh.current
    if (!m) return
    const mx = new THREE.Matrix4()
    let moving = false
    items.forEach((w, i) => {
      const sp = spaces[w.id]
      if (!sp) return
      const prev = shown.current[w.id] ?? 0
      const d = damp(prev, w.depth, 2.5, dt)
      shown.current[w.id] = d
      if (Math.abs(d - w.depth) > 0.002) moving = true
      const h = Math.max(0.03, d)
      const [x, y, z] = at((sp.rect.x0 + sp.rect.x1) / 2, (sp.rect.y0 + sp.rect.y1) / 2, sp.level)
      mx.compose(new THREE.Vector3(x, y - 0.02 + h / 2, z), new THREE.Quaternion(), new THREE.Vector3(sp.rect.x1 - sp.rect.x0 - 0.1, h, sp.rect.y1 - sp.rect.y0 - 0.1))
      m.setMatrixAt(i, mx)
    })
    m.count = items.length
    m.instanceMatrix.needsUpdate = true
    if (mat.current) mat.current.emissiveIntensity = 0.22 + 0.08 * Math.sin(s.clock.elapsedTime * 2.2)
    if (moving) s.invalidate()
  })
  if (items.length === 0) return null
  return (
    <instancedMesh ref={mesh} key={`water-${Math.ceil(items.length / 8)}`} args={[undefined, undefined, Math.ceil(items.length / 8) * 8]} raycast={noRaycast} renderOrder={2}>
      <boxGeometry />
      <meshStandardMaterial ref={mat} color={PALETTE.water} emissive="#1d5d96" emissiveIntensity={0.3} roughness={0.06} metalness={0.15} envMapIntensity={1.4} transparent opacity={0.8} />
    </instancedMesh>
  )
}

/** A burst: a column of falling water and rings spreading on the pool. */
function Leak({ position }: { position: [number, number, number] }) {
  const rings = useRef<THREE.Group>(null)
  const jet = useRef<THREE.Mesh>(null)
  useFrame((s) => {
    const t = s.clock.elapsedTime
    rings.current?.children.forEach((child, i) => {
      const k = (t * 0.6 + i / 3) % 1
      child.scale.setScalar(0.4 + k * 3.2)
      const m = (child as THREE.Mesh).material as THREE.MeshBasicMaterial
      m.opacity = 0.75 * (1 - k)
    })
    if (jet.current) jet.current.scale.x = jet.current.scale.z = 1 + 0.15 * Math.sin(t * 9)
  })
  return (
    <group position={position}>
      <mesh ref={jet} position={[0, 1.4, 0]} raycast={noRaycast}>
        <cylinderGeometry args={[0.22, 0.42, 2.8, 12, 1, true]} />
        <meshBasicMaterial color="#9fdcff" transparent opacity={0.6} depthWrite={false} />
      </mesh>
      <group ref={rings} position={[0, 0.6, 0]}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} rotation-x={-Math.PI / 2} raycast={noRaycast}>
            <ringGeometry args={[0.8, 1, 32]} />
            <meshBasicMaterial color="#e8f6ff" transparent opacity={0.6} depthWrite={false} />
          </mesh>
        ))}
      </group>
    </group>
  )
}

const PLANT_TONE: Record<string, string> = { flooded: '#ff7a6b', offline: '#ff9f93', isolated: '#b9b4f0', closing: '#b49bff', closed: '#5fd4a0', online: '#5fd4a0' }

function PlantMarks({ equipment, status, atRisk, at, onSelect }: { equipment: Equipment[]; status: Record<string, string>; atRisk: Set<string>; at: At; onSelect: SceneProps['onSelect'] }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const risky = useRef<THREE.Group>(null)
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    const mx = new THREE.Matrix4()
    const c = new THREE.Color()
    equipment.forEach((e, i) => {
      mx.makeTranslation(...at(e.x, e.y, e.level, 0.45))
      m.setMatrixAt(i, mx)
      const st = status[e.id] ?? 'online'
      m.setColorAt(i, c.set(st === 'online' && atRisk.has(e.id) ? '#ffb84d' : (PLANT_TONE[st] ?? '#ff9f93')))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
  }, [equipment, status, atRisk, at])
  useFrame((s) => {
    risky.current?.children.forEach((child) => child.scale.setScalar(1 + 0.35 * (0.5 + 0.5 * Math.sin(s.clock.elapsedTime * 4))))
  })
  if (equipment.length === 0) return null
  return (
    <group>
      <instancedMesh
        ref={mesh}
        key={`plant-${equipment.length}`}
        args={[undefined, undefined, equipment.length]}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          if (e.instanceId == null) return
          const eq = equipment[e.instanceId]
          const st = status[eq.id] ?? 'online'
          setHover({ title: eq.name, sub: st === 'online' && atRisk.has(eq.id) ? 'running · water will reach it' : st, kind: 'equipment' })
        }}
        onPointerOut={() => setHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          if (e.instanceId != null) onSelect('equipment', equipment[e.instanceId].id)
        }}
      >
        <cylinderGeometry args={[0.55, 0.55, 0.5, 18]} />
        <meshLambertMaterial color="#ffffff" />
      </instancedMesh>
      <group ref={risky}>
        {equipment
          .filter((e) => (status[e.id] ?? 'online') === 'online' && atRisk.has(e.id))
          .map((e) => (
            <mesh key={e.id} position={at(e.x, e.y, e.level, 0.25)} rotation-x={-Math.PI / 2} raycast={noRaycast}>
              <ringGeometry args={[0.8, 1.05, 28]} />
              <meshBasicMaterial color="#ffb84d" transparent opacity={0.8} depthWrite={false} />
            </mesh>
          ))}
      </group>
    </group>
  )
}

function LiftShafts({ lifts, cx, cy, focus }: { lifts: SceneProps['lifts']; cx: number; cy: number; focus: LevelGeo | undefined }) {
  return (
    <group>
      {lifts.map((l) => {
        const top = focus ? Math.min(l.to, focus.level.elevation + focus.level.height) : l.to
        const h = Math.max(0.5, top - l.from)
        const x = (l.rect.x0 + l.rect.x1) / 2 - cx
        const z = cy - (l.rect.y0 + l.rect.y1) / 2
        return (
          <group key={l.id}>
            <mesh position={[x, l.from + h / 2, z]} raycast={noRaycast} renderOrder={3}>
              <boxGeometry args={[l.rect.x1 - l.rect.x0 - 0.2, h, l.rect.y1 - l.rect.y0 - 0.2]} />
              <meshBasicMaterial color={l.running ? '#5fd4a0' : '#ff7a6b'} transparent opacity={0.34} depthWrite={false} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

/** Everyone in the building as a soft dot in their room; the named residents as figures with a card. */
function People({ marks, at, hoverable, selected, onSelect }: { marks: PersonMark[]; at: At; hoverable: boolean; selected: SceneProps['selected']; onSelect: SceneProps['onSelect'] }) {
  const dots = useMemo(() => marks.filter((m) => !m.named), [marks])
  const named = useMemo(() => marks.filter((m) => m.named), [marks])
  const mesh = useRef<THREE.InstancedMesh>(null)
  const cap = Math.max(16, Math.ceil(dots.length / 64) * 64)
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    const mx = new THREE.Matrix4()
    const c = new THREE.Color()
    dots.forEach((d, i) => {
      const big = d.tone === 'critical' || d.tone === 'left' ? 1.25 : d.tone === 'warning' ? 1.1 : 1
      mx.compose(new THREE.Vector3(...at(d.x, d.y, d.level, 0.42)), new THREE.Quaternion(), new THREE.Vector3(big, big, big))
      m.setMatrixAt(i, mx)
      m.setColorAt(i, c.set(TONE[d.tone]))
    })
    m.count = dots.length
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
  }, [dots, at])
  const rings = marks.filter((m) => m.tone === 'left' || (m.tone === 'critical' && m.status === 'no step-free way out'))
  return (
    <group>
      <instancedMesh
        ref={mesh}
        key={`people-${cap}`}
        args={[undefined, undefined, cap]}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          if (e.instanceId == null) return
          const d = dots[e.instanceId]
          if (d) setHover({ title: d.name, sub: d.needs.length ? `${d.status} · ${d.needs.map((n) => n.replace(/_/g, ' ')).join(', ')}` : d.status, kind: 'resident' })
        }}
        onPointerOut={() => setHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          if (e.instanceId != null && dots[e.instanceId]) onSelect('resident', dots[e.instanceId].id)
        }}
      >
        <sphereGeometry args={[0.32, 10, 8]} />
        <meshLambertMaterial color="#ffffff" />
      </instancedMesh>
      {named.map((n) => (
        <Figure key={n.id} position={at(n.x, n.y, n.level)} color={TONE[n.tone]} selected={selected?.kind === 'resident' && selected.id === n.id} onClick={() => onSelect('resident', n.id)} label={hoverable ? n : null} />
      ))}
      <PulseRings items={rings.map((r) => ({ id: r.id, position: at(r.x, r.y, r.level, 0.05), color: TONE[r.tone] }))} />
    </group>
  )
}

function Figure({ position, color, selected, onClick, label }: { position: [number, number, number]; color: string; selected: boolean; onClick: () => void; label: PersonMark | null }) {
  const [hover, setHov] = useState(false)
  const s = hover || selected ? 1.18 : 1
  return (
    <group position={position}>
      <group
        scale={s}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          setHov(true)
          if (label) setHover({ title: label.name, sub: label.status, kind: 'resident' })
        }}
        onPointerOut={() => {
          setHov(false)
          setHover(null)
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          onClick()
        }}
      >
        <mesh position={[0, 0.62, 0]}>
          <capsuleGeometry args={[0.36, 0.55, 4, 10]} />
          <meshLambertMaterial color={color} />
        </mesh>
        <mesh position={[0, 1.42, 0]}>
          <sphereGeometry args={[0.3, 14, 10]} />
          <meshLambertMaterial color="#fff6ee" />
        </mesh>
      </group>
    </group>
  )
}

function PulseRings({ items }: { items: { id: string; position: [number, number, number]; color: string }[] }) {
  const group = useRef<THREE.Group>(null)
  useFrame((s) => {
    group.current?.children.forEach((child, i) => {
      const k = (s.clock.elapsedTime * 0.7 + i * 0.37) % 1
      child.scale.setScalar(0.6 + k * 1.8)
      ;((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k)
    })
  })
  return (
    <group ref={group}>
      {items.map((r) => (
        <mesh key={r.id} position={r.position} rotation-x={-Math.PI / 2} raycast={noRaycast}>
          <ringGeometry args={[0.9, 1.15, 32]} />
          <meshBasicMaterial color={r.color} transparent opacity={0.8} depthWrite={false} />
        </mesh>
      ))}
    </group>
  )
}

/** The step-free routes the world found, as mint ribbons with a flowing dash; a change of level drops straight down the shaft. */
function Routes({ routes, at, focus }: { routes: RouteLine[]; at: At; focus: string }) {
  const lines = useMemo(() => {
    return routes.map((r) => {
      const pts: [number, number, number][] = []
      let prev: (typeof r.points)[number] | null = null
      for (const p of r.points) {
        if (focus !== 'all' && p.level !== focus) {
          prev = null
          continue
        }
        if (prev && prev.level !== p.level) pts.push(at(p.x, p.y, prev.level, 0.25))
        pts.push(at(p.x, p.y, p.level, 0.25))
        prev = p
      }
      return { id: r.id, pts }
    })
  }, [routes, at, focus])
  const refs = useRef<(THREE.Object3D | null)[]>([])
  useFrame((_, dt) => {
    for (const l of refs.current) {
      const m = (l as unknown as { material?: { dashOffset: number } } | null)?.material
      if (m) m.dashOffset -= dt * 1.6
    }
  })
  return (
    <group>
      {lines
        .filter((l) => l.pts.length > 1)
        .map((l, i) => (
          <group key={l.id}>
            <Line points={l.pts} color={PALETTE.route} lineWidth={7} transparent opacity={0.28} />
            <Line ref={(el) => void (refs.current[i] = el as unknown as THREE.Object3D)} points={l.pts} color={PALETTE.route} lineWidth={3} dashed dashSize={0.9} gapSize={0.55} />
          </group>
        ))}
    </group>
  )
}

function Exits({ openings, at }: { openings: Opening[]; at: At }) {
  return (
    <group>
      {openings.map((o) => (
        <group key={o.id} position={at(o.x, o.y, o.level, -0.2)}>
          <mesh
            position={[0, 0.9, 0]}
            onPointerOver={(e: ThreeEvent<PointerEvent>) => {
              e.stopPropagation()
              setHover({ title: 'Exit', sub: o.step_free ? 'step-free' : 'has steps', kind: 'exit' })
            }}
            onPointerOut={() => setHover(null)}
          >
            <boxGeometry args={[o.axis === 'x' ? Math.max(0.9, o.width) : 0.5, 1.8, o.axis === 'x' ? 0.5 : Math.max(0.9, o.width)]} />
            <meshLambertMaterial color={o.step_free ? '#5fd4a0' : '#a8e6c8'} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/** Responders where the approved plan has them: a figure at their post, gliding along the dashed line to where they are heading. */
function Actors({ actors, at }: { actors: ActorMark[]; at: At }) {
  return (
    <group>
      {actors.map((a, i) => (
        <Responder key={a.id} a={a} at={at} phase={i * 0.37} />
      ))}
    </group>
  )
}

const ACTOR_TONE: Record<string, string> = { moving: '#5aa8ff', done: '#5fd4a0', idle: '#b9b4f0', offsite: '#b9b4f0' }

function Responder({ a, at, phase }: { a: ActorMark; at: At; phase: number }) {
  const body = useRef<THREE.Group>(null)
  const from = a.from ? at(a.from.x + 1.2, a.from.y + 0.6, a.from.level) : null
  const to = a.to ? at(a.to.x + 1.2, a.to.y + 0.6, a.to.level) : null
  const moving = a.status === 'moving' && from && to
  useFrame((s) => {
    if (!body.current) return
    if (moving) {
      const k = ((s.clock.elapsedTime * 0.25 + phase) % 1)
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
      body.current.position.set(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, from[2] + (to[2] - from[2]) * e)
    } else {
      const p = (a.status === 'done' && to) || from || to
      if (p) body.current.position.set(p[0], p[1], p[2])
    }
  })
  const color = ACTOR_TONE[a.status] ?? '#b9b4f0'
  return (
    <group>
      {moving && <Line points={[from, to]} color={color} lineWidth={2} dashed dashSize={0.6} gapSize={0.4} transparent opacity={0.8} />}
      <group
        ref={body}
        name={`actor:${a.id}`}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          setHover({ title: a.label, sub: a.status === 'moving' ? 'on the way' : a.status === 'done' ? 'step done' : 'at their post', kind: 'actor' })
        }}
        onPointerOut={() => setHover(null)}
      >
        <mesh position={[0, 0.7, 0]}>
          <capsuleGeometry args={[0.38, 0.6, 4, 10]} />
          <meshLambertMaterial color={color} />
        </mesh>
        <mesh position={[0, 1.55, 0]} raycast={noRaycast}>
          <sphereGeometry args={[0.3, 14, 10]} />
          <meshLambertMaterial color="#fff6ee" />
        </mesh>
        <mesh position={[0, 0.04, 0]} rotation-x={-Math.PI / 2} raycast={noRaycast}>
          <circleGeometry args={[0.75, 24]} />
          <meshBasicMaterial color={color} transparent opacity={0.35} depthWrite={false} />
        </mesh>
      </group>
    </group>
  )
}

const BEACON_TONE: Record<string, string> = { proposed: '#b49bff', pending: '#b9b4f0', assigned: '#5aa8ff', done: '#5fd4a0', failed: '#ff7a6b' }

/** Each step with a place on the map: a soft column of light and its number, coloured by where it stands. */
function Beacons({ beacons, at }: { beacons: StepBeacon[]; at: At }) {
  const group = useRef<THREE.Group>(null)
  useFrame((s) => {
    group.current?.children.forEach((child) => {
      const b = beacons.find((x) => x.id === child.name)
      if (b?.state === 'assigned') ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.2 * (0.5 + 0.5 * Math.sin(s.clock.elapsedTime * 4))
    })
  })
  const placed = useMemo(() => placeBeacons(beacons, at), [beacons, at])
  return (
    <group>
      <group ref={group}>
        {placed.map(({ b, pos }) => (
          <mesh key={b.id} name={b.id} position={[pos[0], pos[1] + 2, pos[2]]} raycast={noRaycast}>
            <cylinderGeometry args={[0.32, 0.6, 4, 16, 1, true]} />
            <meshBasicMaterial color={BEACON_TONE[b.state]} transparent opacity={0.35} depthWrite={false} side={THREE.FrontSide} />
          </mesh>
        ))}
      </group>
    </group>
  )
}

const REL_COLOR: Record<string, string> = { powers: '#7c8cff', backs_up: '#b49bff', controls: '#b49bff', feeds_water: '#6cc3ff', monitors: '#9aa3c7' }

/** The dependency graph in the air: what powers, controls and feeds what; a dead feed's edges go grey. */
function Connections({ graph, equipment, live, at, shows }: { graph: Graph; equipment: Record<string, Equipment>; live: Set<string>; at: At; shows: (l: string) => boolean }) {
  const geo = useMemo(() => {
    const pos: number[] = []
    const col: number[] = []
    const c = new THREE.Color()
    for (const e of graph.edges) {
      const a = equipment[e.src], b = equipment[e.dst]
      if (!a || !b || (!shows(a.level) && !shows(b.level))) continue
      pos.push(...at(a.x, a.y, a.level, 0.6), ...at(b.x, b.y, b.level, 0.6))
      c.set(live.has(e.src) ? (REL_COLOR[e.rel] ?? '#9aa3c7') : '#c4c7d6')
      col.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    return g
  }, [graph, equipment, live, at, shows])
  useEffect(() => () => geo.dispose(), [geo])
  return (
    <lineSegments geometry={geo} renderOrder={10} raycast={noRaycast}>
      <lineBasicMaterial vertexColors transparent opacity={0.9} depthTest={false} />
    </lineSegments>
  )
}

/** Steps that share a spot stand side by side. */
export function placeBeacons(beacons: StepBeacon[], at: At): { b: StepBeacon; pos: [number, number, number] }[] {
  const seen: Record<string, number> = {}
  return beacons.map((b) => {
    const k = `${b.where!.level}:${Math.round(b.where!.x)}:${Math.round(b.where!.y)}`
    const n = (seen[k] = (seen[k] ?? -1) + 1)
    return { b, pos: at(b.where!.x + n * 1.3, b.where!.y, b.where!.level) }
  })
}

/** Labels are plain DOM in the twin's overlay; each rendered frame moves them to where their anchor projects. */
function Projector({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size, scene }) => {
    const root = container.current
    if (!root) return
    camera.updateMatrixWorld()
    // Read every label first (one layout pass), then place them in the layer's order, which is their priority:
    // a label that would cover one already placed climbs a line at a time.
    const items: { el: HTMLElement; x: number; y: number; w: number; h: number }[] = []
    for (const el of Array.from(root.children) as HTMLElement[]) {
      const follow = el.dataset.follow
      if (follow) {
        const o = scene.getObjectByName(follow)
        if (!o) {
          el.style.visibility = 'hidden'
          continue
        }
        o.getWorldPosition(v)
        v.y += Number(el.dataset.lift ?? 0)
      } else if (el.dataset.p) {
        const [x, y, z] = el.dataset.p.split(',').map(Number)
        v.set(x, y, z)
      } else continue
      v.project(camera)
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) {
        el.style.visibility = 'hidden'
        continue
      }
      items.push({ el, x: (v.x * 0.5 + 0.5) * size.width, y: (-v.y * 0.5 + 0.5) * size.height, w: el.offsetWidth, h: el.offsetHeight })
    }
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
    for (const it of items) {
      let y = it.y
      for (let k = 0; k < 6; k++) {
        const r = { x0: it.x - it.w / 2 - 2, y0: y - it.h / 2 - 2, x1: it.x + it.w / 2 + 2, y1: y + it.h / 2 + 2 }
        if (!placed.some((p) => r.x0 < p.x1 && p.x0 < r.x1 && r.y0 < p.y1 && p.y0 < r.y1)) {
          placed.push(r)
          break
        }
        y -= it.h + 4
      }
      it.el.style.visibility = 'visible'
      it.el.style.transform = `translate3d(${it.x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`
    }
  })
  return null
}

/* ---- the camera ------------------------------------------------------------------------------- */

const VIEW: Record<Tab, { az: number; polar: number }> = {
  building: { az: -0.62, polar: 0.98 },
  status: { az: -0.3, polar: 1.04 },
  people: { az: -0.82, polar: 0.92 },
  response: { az: -0.48, polar: 0.95 },
}

/** Glide to the whole building or the open floor whenever the tab or the floor changes; the person can orbit freely in between. */
function CameraRig({ data, tab, focus, inset }: { data: SceneData; tab: Tab; focus: LevelGeo | undefined; inset: number }) {
  const ref = useRef<CameraControls>(null)
  const first = useRef(true)
  const size = useThree((s) => s.size)
  useEffect(() => {
    const c = ref.current
    if (!c || data.levels.length === 0 || size.width < 10 || size.height < 10) return
    const box = new THREE.Box3()
    if (focus) {
      box.copy(focus.box)
      box.max.y = focus.box.min.y + 3
    } else for (const g of data.levels) if (tab !== 'building' || !g.below) box.union(g.box)
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const v = VIEW[tab]
    const polar = focus ? 0.74 : v.polar
    // Fit the building into the part of the canvas the glass leaves free: below the tabs, above the floor
    // pill, beside the card. The sphere is generous, so a little under 1 still keeps every corner in view.
    const cam = c.camera as THREE.PerspectiveCamera
    const left = size.width > 720 ? inset : 0
    const fracH = Math.max(0.4, (size.height - 76 - 66) / size.height)
    const fracW = Math.max(0.4, (size.width - left - 20) / size.width)
    const vfov = THREE.MathUtils.degToRad(cam.fov)
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (size.width / size.height))
    const half = Math.min(vfov * fracH, hfov * fracW) / 2
    const dist = (sphere.radius / Math.sin(half)) * (focus ? 0.95 : 1.08)
    const dir = new THREE.Vector3(Math.sin(polar) * Math.sin(v.az), Math.cos(polar), Math.sin(polar) * Math.cos(v.az))
    const pos = sphere.center.clone().addScaledVector(dir, dist)
    c.smoothTime = first.current ? 0 : 0.7
    void c.setLookAt(pos.x, pos.y, pos.z, sphere.center.x, sphere.center.y, sphere.center.z, !first.current)
    // Then slide the view so the building sits in the middle of that free space.
    const visibleH = 2 * dist * Math.tan(vfov / 2)
    const visibleW = visibleH * (size.width / size.height)
    void c.setFocalOffset(-(left / 2 / size.width) * visibleW, -((76 - 66) / 2 / size.height) * visibleH, 0, !first.current)
    first.current = false
  }, [data, tab, focus, inset, size.width, size.height])
  return <CameraControls ref={ref} makeDefault minPolarAngle={0.12} maxPolarAngle={1.45} minDistance={10} maxDistance={420} dollyToCursor smoothTime={0.7} />
}

export type { HoverInfo, Tone }
export { BEVEL, SLAB_GAP }
