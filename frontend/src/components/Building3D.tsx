import { Environment, Lightformer, Line, OrbitControls, OrthographicCamera, useGLTF, useProgress } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import * as THREE from 'three'
import { STATUS_COLOR } from '../lib/labels'
import { useBuilding } from '../state/building'
import { useWorld } from '../state/world'
import type { ActorState, Rect, ResidentImpact, Space, WorldState } from '../state/types'
import { select } from './Inspector'

/**
 * The building as another view of the one world store. Geometry comes from the GLBs the Blender
 * script exported from the same spec (meshopt-compressed; drei registers the decoder); every
 * colour, label, halo and line below is read from world state. Nothing here holds state of its own.
 *
 * Night and day follow the world's clock: the scenario runs at 23:41, so the twin is a night scene
 * where every window shows whether its room has power (lit, amber "about to go dark", or black) and
 * who is awake. Labels are plain DOM nodes projected over the canvas each frame (no React roots
 * inside the canvas, which React 19 unmounts unhappily), stacked apart when they would overlap.
 *
 * glTF is y-up: a spec point (x, y, z) in metres lands at three.js (x, z, -y).
 */

const EXTERIOR_URL = '/models/blackwell.glb'
const INTERIOR_URL = '/models/blackwell_interior.glb'
// Optional files: furniture split out so the shell and interior stream first; the site (streets,
// neighbours, trees, props, people) exported by blender/build_blackwell.py --glb-site. Missing = fine.
const FURNITURE_URL = '/models/blackwell_furniture.glb'
const SITE_URL = '/models/blackwell_site.glb'
// The exact HDRI the Blender scene uses (blender/build_blackwell.py); light formers stand in when it is absent.
const SKY_URL = '/env/sky_2k.hdr'

/**
 * The sun as Blender has it, so daytime shadows and highlights fall where the renders put them. Spec
 * frame: azimuth clockwise from north (+y), elevation above the horizon; the HDRI is rotated about up
 * by `envRotation` (Blender rotates it about +z; three.js about +y, same sign). From the build log.
 */
const SUN = { azimuthDeg: 220, elevationDeg: 48, envRotationRad: 1.6722 }
function sunPosition(distance = 160, azimuthDeg = SUN.azimuthDeg, elevationDeg = SUN.elevationDeg): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180
  const el = (elevationDeg * Math.PI) / 180
  // spec (x east, y north, z up) -> three (x, z, -y)
  return [Math.sin(az) * Math.cos(el) * distance, Math.sin(el) * distance, -Math.cos(az) * Math.cos(el) * distance]
}
useGLTF.preload(EXTERIOR_URL)
useGLTF.preload(INTERIOR_URL)

/** Night between 19:00 and 06:30 (seconds after midnight). */
export function isNight(timeOfDay: number | undefined): boolean {
  if (timeOfDay == null) return true
  const t = timeOfDay % 86400
  return t < 6.5 * 3600 || t >= 19 * 3600
}

const ROOF_INDEX = 99

type Tint = { mode: 'dark' | 'soon' | 'none'; water: number }

interface Indexed {
  spaceMeshes: Map<string, THREE.Mesh[]>
  windowMeshes: Map<string, THREE.Mesh[]>
  eqMeshes: Map<string, THREE.Mesh>
  levelMeshes: { mesh: THREE.Object3D; index: number }[]
}

interface Props {
  level: string // level id, or 'all'
  connections?: boolean
}

/** A DOM label over the canvas: where it is in the world, what it says, how it looks. */
export interface Label {
  id: string
  pos: [number, number, number]
  text: string
  tag?: string
  color: string
  kind: 'person' | 'actor' | 'equipment'
  priority: number // lower = placed first (keeps its spot in a crowd)
  buds?: string
  select?: { kind: 'resident' | 'equipment' | 'space'; id: string }
}

/** Walk up from a clicked mesh to the first object that names a space or a piece of equipment. */
function pick(o: THREE.Object3D | null): void {
  let cur: THREE.Object3D | null = o
  while (cur) {
    const ud = cur.userData ?? {}
    if (typeof ud.equipment_id === 'string') return select({ kind: 'equipment', id: ud.equipment_id })
    if (typeof ud.space_id === 'string') return select({ kind: 'space', id: ud.space_id })
    cur = cur.parent
  }
}

export default function Building3D({ level, connections = false }: Props) {
  const overlay = useRef<HTMLDivElement>(null)
  const night = useWorld((s) => isNight(s.clock?.time_of_day))
  return (
    <div className={`twin relative h-full w-full ${night ? 'is-night' : 'is-day'}`}>
      <Canvas
        orthographic
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        shadows
        style={{ background: 'transparent' }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping
          gl.shadowMap.enabled = true
          gl.shadowMap.type = THREE.PCFShadowMap
        }}
      >
        <Suspense fallback={null}>
          <Scene level={level} connections={connections} overlay={overlay} night={night} />
        </Suspense>
      </Canvas>
      <div ref={overlay} className="twin-overlay" aria-hidden="true" />
      <Loading />
    </div>
  )
}

/** Streaming progress, outside the canvas so it never fights the renderer. */
function Loading() {
  const { active, progress, loaded, total } = useProgress()
  if (!active && progress >= 100) return null
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="glass-card px-4 py-3 text-center">
        <div className="text-[12px] font-medium text-t1">Streaming the building</div>
        <div className="progress mt-2 w-44">
          <span style={{ width: `${Math.max(4, progress)}%`, background: 'var(--argus-blue)' }} />
        </div>
        <div className="mono mt-1 text-[10px] text-t3">
          {Math.round(progress)}% · {loaded}/{total || '…'} files
        </div>
      </div>
    </div>
  )
}

/** The building fills the stage whatever its size: zoom follows the canvas, like a Blender viewport. */
function FitCamera() {
  const size = useThree((s) => s.size)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera
    if (!('isOrthographicCamera' in cam)) return
    cam.zoom = Math.max(4, Math.min(size.width / 112, size.height / 74))
    cam.updateProjectionMatrix()
  }, [size, camera])
  return null
}

/** Tone mapping follows the scene: a touch brighter at night so lit windows carry the picture. */
function Exposure({ night }: { night: boolean }) {
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    gl.toneMappingExposure = night ? 1.15 : 0.95
  }, [gl, night])
  return null
}

// ---- scene ---------------------------------------------------------------------------------

function Scene({ level, connections = false, overlay, night }: Props & { overlay: RefObject<HTMLDivElement | null>; night: boolean }) {
  const exterior = useGLTF(EXTERIOR_URL)
  const interior = useGLTF(INTERIOR_URL)
  const spec = useBuilding((b) => b.spec)
  const spaces = useBuilding((b) => b.spaces)
  const width = useBuilding((b) => b.width)
  const depth = useBuilding((b) => b.depth)
  const topLevel = useBuilding((b) => b.topLevel)

  const levelIndex = useMemo(() => {
    const m: Record<string, number> = {}
    for (const lv of spec?.levels ?? []) m[lv.id] = lv.index
    return m
  }, [spec])
  const levelElev = useMemo(() => {
    const m: Record<string, number> = {}
    for (const lv of spec?.levels ?? []) m[lv.id] = lv.elevation
    return m
  }, [spec])

  // Walk both scenes once: clone materials for anything we will tint so shared GLB materials don't bleed.
  const index = useMemo<Indexed>(() => {
    const out: Indexed = { spaceMeshes: new Map(), windowMeshes: new Map(), eqMeshes: new Map(), levelMeshes: [] }
    const visit = (root: THREE.Object3D) => {
      root.traverse((o) => {
        const ud = o.userData ?? {}
        const li = typeof ud.level_index === 'number' ? ud.level_index : parseInt(String(ud.level_index ?? ''), 10)
        if (!Number.isNaN(li)) out.levelMeshes.push({ mesh: o, index: li })
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = true
        mesh.receiveShadow = true
        const sid = typeof ud.space_id === 'string' ? ud.space_id : undefined
        const eid = typeof ud.equipment_id === 'string' ? ud.equipment_id : undefined
        if (sid || eid) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          const cloned = mats.map((m) => {
            const c = m.clone() as THREE.MeshStandardMaterial
            c.userData.baseColor = (m as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color('#888')
            c.userData.baseEmissive = (m as THREE.MeshStandardMaterial).emissive?.clone() ?? new THREE.Color('#000')
            c.userData.baseEmissiveIntensity = (m as THREE.MeshStandardMaterial).emissiveIntensity ?? 0
            return c
          })
          mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]
        }
        if (sid) {
          const isWindow = /^win_/.test(mesh.name)
          const map = isWindow ? out.windowMeshes : out.spaceMeshes
          const list = map.get(sid) ?? []
          list.push(mesh)
          map.set(sid, list)
        }
        if (eid) out.eqMeshes.set(eid, mesh)
      })
    }
    visit(exterior.scene)
    visit(interior.scene)
    return out
  }, [exterior.scene, interior.scene])

  // Level focus: hide everything above the floor in focus so the user looks down into it.
  useEffect(() => {
    const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)
    for (const { mesh, index: li } of index.levelMeshes) {
      if (li === ROOF_INDEX) mesh.visible = level === 'all' || level === topLevel
      else mesh.visible = li <= focus
    }
  }, [level, levelIndex, index, topLevel])

  const center = useMemo(() => new THREE.Vector3(width / 2, 6, -depth / 2), [width, depth])

  return (
    <>
      <OrthographicCamera makeDefault position={[center.x + 90, 95, center.z + 90]} zoom={7} near={-500} far={1000} />
      <FitCamera />
      <Exposure night={night} />
      <OrbitControls target={center} enableDamping dampingFactor={0.08} minPolarAngle={0.25} maxPolarAngle={1.35} minZoom={3} maxZoom={60} />
      {night ? <NightRig center={center} /> : <DayRig />}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center.x, -0.08, center.z]} receiveShadow>
        <planeGeometry args={[700, 700]} />
        <meshStandardMaterial color={night ? '#0f131c' : '#d9dee6'} roughness={1} metalness={0} />
      </mesh>

      <primitive object={exterior.scene} onClick={(e: { stopPropagation: () => void; object: THREE.Object3D }) => { e.stopPropagation(); pick(e.object) }} />
      <primitive object={interior.scene} onClick={(e: { stopPropagation: () => void; object: THREE.Object3D }) => { e.stopPropagation(); pick(e.object) }} />
      {connections && <Connections index={index} level={level} levelIndex={levelIndex} />}
      <Optional>
        <Suspense fallback={null}>
          <Furniture level={level} levelIndex={levelIndex} />
        </Suspense>
      </Optional>
      <Optional>
        <Suspense fallback={null}>
          <Site level={level} levelIndex={levelIndex} night={night} />
        </Suspense>
      </Optional>

      <Tinter index={index} night={night} />
      <WaterPlanes level={level} levelIndex={levelIndex} levelElev={levelElev} spaces={spaces} />
      <Halos index={index} />
      <Routes level={level} levelIndex={levelIndex} levelElev={levelElev} spaces={spaces} />
      <People level={level} levelIndex={levelIndex} levelElev={levelElev} spaces={spaces} />
      <Actors level={level} levelIndex={levelIndex} levelElev={levelElev} spaces={spaces} />
      <LabelLayer overlay={overlay} level={level} levelIndex={levelIndex} levelElev={levelElev} spaces={spaces} index={index} />
    </>
  )
}

// ---- light rigs -------------------------------------------------------------------------------

/** Daylight as Blender has it: the HDRI for sky light and reflections, the sun in the same place. */
function DayRig() {
  return (
    <>
      <directionalLight position={sunPosition()} intensity={3.2} color="#fff5e6" castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.02}>
        <orthographicCamera attach="shadow-camera" args={[-130, 130, 130, -130, 1, 500]} />
      </directionalLight>
      <Optional fallback={<StudioLight />}>
        <Suspense fallback={<StudioLight />}>
          <Environment files={SKY_URL} background backgroundBlurriness={0.15} backgroundIntensity={1.0} environmentIntensity={1.0} environmentRotation={[0, SUN.envRotationRad, 0]} backgroundRotation={[0, SUN.envRotationRad, 0]} />
        </Suspense>
      </Optional>
    </>
  )
}

/** A Tuesday at 23:41: a dark sky, a low moon for shadows, the building lit from its own windows. */
function NightRig({ center }: { center: THREE.Vector3 }) {
  return (
    <>
      <color attach="background" args={['#0a0e17']} />
      <fog attach="fog" args={['#0a0e17', 260, 520]} />
      <hemisphereLight args={['#2a3a5c', '#07080c', 0.55]} />
      <directionalLight position={sunPosition(160, 70, 38)} intensity={0.55} color="#b9c8ff" castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.02}>
        <orthographicCamera attach="shadow-camera" args={[-130, 130, 130, -130, 1, 500]} />
      </directionalLight>
      {/* a little warm spill from the street onto the ground floor */}
      <pointLight position={[center.x - 30, 9, center.z + 40]} intensity={180} distance={120} decay={2} color="#ffd9a3" />
      <pointLight position={[center.x + 40, 9, center.z - 50]} intensity={140} distance={110} decay={2} color="#ffd9a3" />
      <Optional fallback={null}>
        <Suspense fallback={null}>
          <Environment files={SKY_URL} background={false} environmentIntensity={0.08} environmentRotation={[0, SUN.envRotationRad, 0]} />
        </Suspense>
      </Optional>
    </>
  )
}

// ---- tinting from state (no React re-render per frame) ----------------------------------------

const DARK = new THREE.Color('#3a0608')
const SOON = new THREE.Color('#ffb020')
const WATER = new THREE.Color('#3ba7ff')
const WARM = new THREE.Color('#ffd08a')
const COOL = new THREE.Color('#9fc4ff')
const _tmp = new THREE.Color()

function Tinter({ index, night }: { index: Indexed; night: boolean }) {
  const seen = useRef(-1)
  const nightSeen = useRef<boolean | null>(null)
  const tints = useRef<Map<string, Tint>>(new Map())
  const spaceLevel = useBuilding((b) => b.spaces)
  const residents = useBuilding((b) => b.residents)
  const spacesRef = useRef(spaceLevel)
  spacesRef.current = spaceLevel

  // How lit each window is at night, from who is in the room and what the room is: a data fact, not noise.
  const litLevel = useMemo(() => {
    const awake = new Map<string, boolean>()
    for (const r of Object.values(residents)) {
      if (r.presence === 'in_room') awake.set(r.room, true)
      else if (!awake.has(r.room)) awake.set(r.room, false)
    }
    const out = new Map<string, number>()
    for (const sid of index.windowMeshes.keys()) {
      const sp = spaceLevel[sid]
      const kind = sp?.kind ?? 'room'
      if (kind === 'room') out.set(sid, awake.get(sid) === true ? 1.0 : awake.has(sid) ? 0.12 : 0.05)
      else if (kind === 'corridor' || kind === 'lobby' || kind === 'stair' || kind === 'lift') out.set(sid, 0.85)
      else if (kind === 'retail' || kind === 'storage' || kind === 'service' || kind === 'office') out.set(sid, 0.15)
      else out.set(sid, 0.7)
    }
    return out
  }, [index, residents, spaceLevel])

  useFrame(({ clock }) => {
    const world = useWorld.getState().world
    if (!world) return
    if (world.version !== seen.current || nightSeen.current !== night) {
      seen.current = world.version
      nightSeen.current = night
      rebuildTints(world, index, tints.current, spacesRef.current)
      for (const [eid, mesh] of index.eqMeshes) {
        const status = world.equipment[eid]?.status ?? 'online'
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats as THREE.MeshStandardMaterial[]) {
          m.emissive.set(STATUS_COLOR[status as keyof typeof STATUS_COLOR] ?? '#64748b')
          m.emissiveIntensity = status === 'online' ? 0.12 : 0.9
          if (status === 'flooded') m.color.copy(m.userData.baseColor as THREE.Color).lerp(WATER, 0.5)
          else m.color.copy(m.userData.baseColor as THREE.Color)
        }
      }
      // Windows: every one is driven, so a change of theme or power repaints the whole facade once.
      for (const [sid, meshes] of index.windowMeshes) {
        const tint = tints.current.get(sid)
        const mode = tint?.mode ?? 'none'
        const lit = litLevel.get(sid) ?? 0.5
        for (const mesh of meshes) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats as THREE.MeshStandardMaterial[]) {
            const base = m.userData.baseColor as THREE.Color
            if (!night) {
              m.color.copy(base)
              m.emissive.copy(m.userData.baseEmissive as THREE.Color)
              m.emissiveIntensity = m.userData.baseEmissiveIntensity as number
              if (mode === 'dark') {
                m.color.multiplyScalar(0.35)
                m.emissive.copy(DARK)
                m.emissiveIntensity = 0.7
              }
              continue
            }
            if (mode === 'dark') {
              m.color.copy(base).multiplyScalar(0.25)
              m.emissive.set('#000000')
              m.emissiveIntensity = 0
            } else {
              m.color.copy(base).multiplyScalar(0.6)
              m.emissive.copy(WARM)
              m.emissiveIntensity = 0.25 + 1.35 * lit
            }
          }
        }
      }
    }
    const t = clock.getElapsedTime()
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.0)
    // Floors and rooms (interior meshes): dark, about to go dark, under water.
    for (const [sid, tint] of tints.current) {
      const meshes = index.spaceMeshes.get(sid)
      if (meshes) {
        for (const mesh of meshes) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats as THREE.MeshStandardMaterial[]) {
            const base = m.userData.baseColor as THREE.Color
            if (tint.mode === 'dark') {
              m.color.copy(base).multiplyScalar(0.35)
              m.emissive.copy(DARK)
              m.emissiveIntensity = 0.7
            } else if (tint.mode === 'soon') {
              m.color.copy(base)
              m.emissive.copy(SOON)
              m.emissiveIntensity = 0.15 + 0.35 * pulse
            } else {
              m.color.copy(base)
              m.emissive.copy(m.userData.baseEmissive as THREE.Color)
              m.emissiveIntensity = m.userData.baseEmissiveIntensity as number
            }
            if (tint.water > 0) {
              const k = Math.min(1, tint.water / 0.3)
              m.color.lerp(WATER, 0.35 + 0.45 * k)
              _tmp.copy(WATER)
              m.emissive.lerp(_tmp, 0.6)
              m.emissiveIntensity = Math.max(m.emissiveIntensity, 0.2 + 0.8 * k)
            }
          }
        }
      }
      // Windows of a floor about to go dark breathe amber: the forecast, visible from the street.
      if (tint.mode === 'soon') {
        const wins = index.windowMeshes.get(sid)
        if (!wins) continue
        const lit = litLevel.get(sid) ?? 0.5
        for (const mesh of wins) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats as THREE.MeshStandardMaterial[]) {
            if (night) {
              m.emissive.copy(WARM).lerp(SOON, 0.55 + 0.45 * pulse)
              m.emissiveIntensity = 0.35 + 1.2 * Math.max(0.35, lit) * (0.75 + 0.25 * pulse)
            } else {
              m.emissive.copy(SOON)
              m.emissiveIntensity = 0.2 + 0.5 * pulse
            }
          }
        }
      }
    }
    // Every wet sensor flashes; the cool blue of the water marks it from across the room.
    for (const [sid, st] of Object.entries(world.sensors)) {
      const sensor = index.eqMeshes.get(sid)
      if (!sensor || !st.wet) continue
      const m = (Array.isArray(sensor.material) ? sensor.material[0] : sensor.material) as THREE.MeshStandardMaterial
      m.emissive.copy(COOL).lerp(WATER, pulse)
      m.emissiveIntensity = 0.4 + 1.6 * pulse
    }
  })
  return null
}

function rebuildTints(world: WorldState, index: Indexed, tints: Map<string, Tint>, spaces: Record<string, Space>) {
  const darkNow = new Set(world.impact.dark_levels)
  const darkSoon = new Set(world.forecast.impact.dark_levels)
  const next = new Map<string, Tint>()
  const ids = new Set([...index.spaceMeshes.keys(), ...index.windowMeshes.keys()])
  for (const sid of ids) {
    const lv = spaces[sid]?.level ?? sid.split('-')[0]
    const water = world.water[sid]?.depth ?? 0
    const mode: Tint['mode'] = darkNow.has(lv) ? 'dark' : darkSoon.has(lv) ? 'soon' : 'none'
    if (mode !== 'none' || water > 0) next.set(sid, { mode, water })
  }
  // Anything that was tinted before and is not now must be reset once: keep it one more pass as 'none'.
  for (const sid of tints.keys()) if (!next.has(sid)) next.set(sid, { mode: 'none', water: 0 })
  tints.clear()
  for (const [k, v] of next) tints.set(k, v)
}

// ---- water surfaces ----------------------------------------------------------------------------

function WaterPlanes({ level, levelIndex, levelElev, spaces }: { level: string; levelIndex: Record<string, number>; levelElev: Record<string, number>; spaces: Record<string, Space> }) {
  const water = useWorld((s) => s.world?.water)
  if (!water) return null
  const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)
  return (
    <>
      {Object.entries(water).map(([sid, w]) => {
        const sp = spaces[sid]
        if (!sp || (levelIndex[sp.level] ?? 0) > focus) return null
        const r = sp.rect
        const y = (levelElev[sp.level] ?? 0) + Math.max(0.01, w.depth)
        const k = Math.min(1, w.depth / 0.3)
        return (
          <mesh key={sid} position={[(r.x0 + r.x1) / 2, y, -(r.y0 + r.y1) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[r.x1 - r.x0 - 0.1, r.y1 - r.y0 - 0.1]} />
            <meshStandardMaterial color="#3ba7ff" emissive="#1b6fb8" emissiveIntensity={0.3 + 0.5 * k} transparent opacity={0.45 + 0.35 * k} roughness={0.15} metalness={0.2} depthWrite={false} />
          </mesh>
        )
      })}
    </>
  )
}

// ---- halos on leaking equipment --------------------------------------------------------------

function Halos({ index }: { index: Indexed }) {
  const leaks = useWorld((s) => s.world?.leaks)
  const group = useRef<THREE.Group>(null)
  const active = useMemo(() => {
    const out: { id: string; pos: THREE.Vector3 }[] = []
    for (const [eid, leak] of Object.entries(leaks ?? {})) {
      if (!leak.active) continue
      const mesh = index.eqMeshes.get(eid)
      if (!mesh) continue
      const pos = new THREE.Vector3()
      mesh.getWorldPosition(pos)
      out.push({ id: eid, pos })
    }
    return out
  }, [leaks, index])
  useFrame(({ clock }) => {
    const g = group.current
    if (!g) return
    const s = 1 + 0.6 * (0.5 + 0.5 * Math.sin(clock.getElapsedTime() * 2.5))
    for (const child of g.children) {
      child.scale.setScalar(s)
      const m = (child as THREE.Mesh).material as THREE.MeshBasicMaterial
      m.opacity = 0.45 - 0.25 * (s - 1)
    }
  })
  return (
    <group ref={group}>
      {active.map((h) => (
        <mesh key={h.id} position={h.pos}>
          <sphereGeometry args={[1.6, 20, 20]} />
          <meshBasicMaterial color="#3ba7ff" transparent opacity={0.4} depthWrite={false} />
        </mesh>
      ))}
    </group>
  )
}

// ---- the dependency graph in 3D: what powers, controls and feeds what -------------------------------

const REL_COLOR_3D: Record<string, string> = { powers: '#2f7bff', backs_up: '#a78bfa', controls: '#a78bfa', feeds_water: '#38bdf8', monitors: '#94a3b8' }

function Connections({ index, level, levelIndex }: { index: Indexed; level: string; levelIndex: Record<string, number> }) {
  const graph = useBuilding((b) => b.graph)
  const equipment = useBuilding((b) => b.equipment)
  const live = useWorld((s) => s.world?.power.live)
  const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)
  const liveSet = useMemo(() => new Set(live ?? []), [live])
  const lines = useMemo(() => {
    const out: { key: string; a: THREE.Vector3; b: THREE.Vector3; color: string; dead: boolean; water: boolean }[] = []
    if (!graph) return out
    const pos = (id: string): THREE.Vector3 | null => {
      const mesh = index.eqMeshes.get(id)
      if (mesh) {
        const v = new THREE.Vector3()
        mesh.getWorldPosition(v)
        v.y += 0.6
        return v
      }
      const e = equipment[id]
      return e ? new THREE.Vector3(e.x, 0.6, -e.y) : null
    }
    for (const e of graph.edges) {
      const ea = equipment[e.src]
      const eb = equipment[e.dst]
      if (!ea || !eb) continue
      if ((levelIndex[ea.level] ?? 0) > focus && (levelIndex[eb.level] ?? 0) > focus) continue
      const a = pos(e.src)
      const b = pos(e.dst)
      if (!a || !b) continue
      out.push({ key: `${e.src}-${e.dst}-${e.rel}`, a, b, color: REL_COLOR_3D[e.rel] ?? '#64748b', dead: !liveSet.has(e.src), water: e.rel === 'feeds_water' })
    }
    return out
  }, [graph, equipment, index, levelIndex, focus, liveSet])
  return (
    <>
      {lines.map((l) => (
        <FlowLine key={l.key} a={l.a} b={l.b} color={l.dead ? '#94a3b8' : l.color} dead={l.dead} water={l.water} />
      ))}
    </>
  )
}

/** A dependency edge: live power flows (the dashes travel from source to load); a dead edge sits still and grey. */
function FlowLine({ a, b, color, dead, water }: { a: THREE.Vector3; b: THREE.Vector3; color: string; dead: boolean; water: boolean }) {
  const ref = useRef<THREE.Object3D & { material?: { dashOffset: number } }>(null)
  useFrame((_, dt) => {
    const m = ref.current?.material
    if (m && !dead) m.dashOffset -= dt * (water ? 1.6 : 2.6)
  })
  return <Line ref={ref as never} points={[a, b]} color={color} lineWidth={dead ? 1.2 : 2.2} transparent opacity={dead ? 0.45 : 0.9} dashed dashSize={dead ? 0.6 : water ? 0.9 : 1.2} gapSize={dead ? 0.4 : 0.5} />
}

// ---- routes and stranded rings -----------------------------------------------------------------

function Routes({ level, levelIndex, levelElev, spaces }: { level: string; levelIndex: Record<string, number>; levelElev: Record<string, number>; spaces: Record<string, Space> }) {
  const routes = useWorld((s) => s.world?.impact.routes)
  const residents = useWorld((s) => s.world?.impact.residents)
  const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)

  const segments = useMemo(() => {
    const out: { key: string; points: [number, number, number][] }[] = []
    for (const [rid, path] of Object.entries(routes ?? {})) {
      if (!path) continue
      let cur: [number, number, number][] = []
      let curLevel: string | null = null
      const flush = () => {
        if (cur.length > 1 && curLevel && (levelIndex[curLevel] ?? 0) <= focus) out.push({ key: `${rid}-${out.length}`, points: cur })
        cur = []
      }
      for (const sid of path) {
        const sp = spaces[sid]
        if (!sp) {
          flush()
          continue
        }
        if (curLevel !== sp.level) {
          // Keep continuity through the lift: end this level's polyline at the shaft, start the next there.
          flush()
          curLevel = sp.level
        }
        cur.push(centerOf(sp.rect, (levelElev[sp.level] ?? 0) + 0.3))
      }
      flush()
    }
    return out
  }, [routes, spaces, levelIndex, levelElev, focus])

  const stranded = useMemo(() => {
    const out: { id: string; pos: [number, number, number] }[] = []
    for (const r of residents ?? []) {
      if (!r.impacts.includes('stranded')) continue
      const sp = spaces[r.room]
      if (!sp || (levelIndex[sp.level] ?? 0) > focus) continue
      out.push({ id: r.id, pos: centerOf(sp.rect, (levelElev[sp.level] ?? 0) + 0.15) })
    }
    return out
  }, [residents, spaces, levelIndex, levelElev, focus])

  return (
    <>
      {segments.map((s) => (
        <Line key={s.key} points={s.points} color="#2ecc8f" lineWidth={3} transparent opacity={0.95} dashed={false} />
      ))}
      {stranded.map((s) => (
        <PulsingRing key={s.id} position={s.pos} />
      ))}
    </>
  )
}

function PulsingRing({ position, color = '#ff4d4f' }: { position: [number, number, number]; color?: string }) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    const m = ref.current
    if (!m) return
    const k = 0.5 + 0.5 * Math.sin(clock.getElapsedTime() * 4)
    m.scale.setScalar(1 + 0.5 * k)
    ;(m.material as THREE.MeshBasicMaterial).opacity = 0.9 - 0.5 * k
  })
  return (
    <mesh ref={ref} position={position} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.4, 2.0, 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.8} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

// ---- people --------------------------------------------------------------------------------------

type Mark = { id: string; name: string; pos: [number, number, number]; color: string; label: boolean; faded: boolean; tag: string | null; left: boolean }

/** Where the people the world flags are drawn (named residents, the critical ones, anyone moved), per level focus. */
function usePeopleMarks(level: string, levelIndex: Record<string, number>, levelElev: Record<string, number>, spaces: Record<string, Space>): Mark[] {
  const residents = useWorld((s) => s.world?.impact.residents)
  const forecastResidents = useWorld((s) => s.world?.forecast.impact.residents)
  const moved = useWorld((s) => s.world?.moved)
  const leftBehind = useWorld((s) => s.world?.plan.left_behind)
  const agents = useWorld((s) => s.world?.agents)
  const roster = useBuilding((b) => b.residents)
  const storyIds = useBuilding((b) => b.storyIds)
  const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)
  return useMemo(() => {
    const NAMED = new Set(storyIds)
    const out: Mark[] = []
    const behind = new Set(leftBehind ?? [])
    const src: ResidentImpact[] = residents && residents.length ? residents : (forecastResidents ?? [])
    const predicted = !(residents && residents.length)
    const placed = new Set<string>()
    for (const [rid, where] of Object.entries(moved ?? {})) {
      const sp = spaces[where]
      if (!sp || (levelIndex[sp.level] ?? 0) > focus) {
        placed.add(rid)
        continue
      }
      const n = placed.size
      placed.add(rid)
      const r = roster[rid]
      const p = centerOf(sp.rect, (levelElev[sp.level] ?? 0) + 1.2)
      p[0] += ((n % 6) - 2.5) * 0.9
      p[2] += (Math.floor(n / 6) % 6) * 0.9 - 2
      out.push({ id: rid, name: r?.name ?? rid, pos: p, color: '#2ecc8f', label: NAMED.has(rid), faded: false, tag: 'safe', left: false })
    }
    for (const r of src) {
      if (placed.has(r.id) || r.severity === 'info') continue
      const sp = spaces[r.room]
      if (!sp || (levelIndex[sp.level] ?? 0) > focus) continue
      // The Maya moment, in 3D: a person with a hard need nobody spoke for is drawn in violet with a
      // hollow ring and labelled. An agent that is off while its person is still covered is just noted.
      const left = behind.has(r.id)
      const agentOff = agents?.[`resident:${r.id}`] === false
      out.push({
        id: r.id,
        name: r.name,
        pos: centerOf(sp.rect, (levelElev[sp.level] ?? 0) + 1.2),
        color: left ? '#bf5af2' : r.severity === 'critical' ? '#ff4d4f' : '#ffb020',
        label: NAMED.has(r.id) || left,
        faded: predicted,
        tag: left ? 'left behind' : agentOff ? 'agent off' : null,
        left,
      })
    }
    return out
  }, [residents, forecastResidents, moved, leftBehind, agents, roster, storyIds, spaces, levelIndex, levelElev, focus])
}

function People(props: { level: string; levelIndex: Record<string, number>; levelElev: Record<string, number>; spaces: Record<string, Space> }) {
  const marks = usePeopleMarks(props.level, props.levelIndex, props.levelElev, props.spaces)
  return (
    <>
      {marks.map((m) => (
        <group key={m.id} position={m.pos}>
          <mesh>
            <sphereGeometry args={[m.label ? 0.55 : 0.35, 16, 16]} />
            <meshStandardMaterial color={m.color} emissive={m.color} emissiveIntensity={0.9} transparent opacity={m.faded ? 0.55 : 1} />
          </mesh>
          {m.left && <PulsingRing position={[0, -1.05, 0]} color="#bf5af2" />}
        </group>
      ))}
    </>
  )
}

// ---- responders (RAs, facilities, desk staff, the plumber) ---------------------------------------
//
// `world.actors` is derived by the backend from the approved plan and the logged action reports:
// where each responder is, where they are heading, which step they are on. The figure glides
// toward its heading while a step is assigned and settles where the step leaves it when done.

const ACTOR_COLOR: Record<ActorState['status'], string> = {
  idle: '#8e8e93',
  moving: '#64d2ff',
  done: '#30d158',
  offsite: '#8e8e93',
}

type Figure = { id: string; label: string; task: string | null; from: [number, number, number]; to: [number, number, number]; status: ActorState['status'] }

function useFigures(level: string, levelIndex: Record<string, number>, levelElev: Record<string, number>, spaces: Record<string, Space>): Figure[] {
  const actors = useWorld((s) => s.world?.actors)
  const steps = useWorld((s) => s.world?.approved_plan?.steps)
  const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)
  return useMemo(() => {
    const out: Figure[] = []
    let slot = 0
    for (const a of Object.values(actors ?? {})) {
      if (!a.at) continue
      const here = spaces[a.at]
      const there = a.heading ? spaces[a.heading] : undefined
      const shown = there ?? here
      if (!here || !shown || (levelIndex[shown.level] ?? 0) > focus) continue
      const off = (slot++ % 3) * 0.8 - 0.8
      const from = centerOf(here.rect, (levelElev[here.level] ?? 0) + 0.9)
      const to = centerOf(shown.rect, (levelElev[shown.level] ?? 0) + 0.9)
      from[0] += 1.4 + off
      to[0] += 1.4 + off
      const step = steps?.find((st) => st.id === a.step_id)
      if (a.status === 'idle' && level === 'all') continue // idle RAs stack on one spot across floors: dots only
      out.push({ id: a.actor, label: a.label, task: step?.title ?? null, from, to, status: a.status })
    }
    return out
  }, [actors, steps, spaces, levelIndex, levelElev, focus, level])
}

function Actors(props: { level: string; levelIndex: Record<string, number>; levelElev: Record<string, number>; spaces: Record<string, Space> }) {
  const figures = useFigures(props.level, props.levelIndex, props.levelElev, props.spaces)
  return (
    <>
      {figures.map((f) => (
        <ActorFigure key={f.id} {...f} />
      ))}
    </>
  )
}

function ActorFigure({ from, to, status }: Figure) {
  const group = useRef<THREE.Group>(null)
  const body = useRef<THREE.Mesh>(null)
  const target = useMemo(() => new THREE.Vector3(...to), [to])
  const start = useMemo(() => new THREE.Vector3(...from), [from])
  const color = ACTOR_COLOR[status]
  useFrame(({ clock }, dt) => {
    const g = group.current
    if (!g) return
    // Ease toward the heading: a walk across the building reads as motion, not a jump.
    g.position.lerp(target, Math.min(1, dt * 1.6))
    if (status === 'moving') {
      const t = clock.getElapsedTime()
      g.position.y = target.y + 0.08 * Math.abs(Math.sin(t * 6))
      const m = body.current?.material as THREE.MeshStandardMaterial | undefined
      if (m) m.emissiveIntensity = 0.6 + 0.6 * (0.5 + 0.5 * Math.sin(t * 4))
    }
  })
  return (
    <group ref={group} position={start}>
      <mesh ref={body}>
        <capsuleGeometry args={[0.28, 0.9, 4, 10]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
      </mesh>
      <mesh position={[0, 0.95, 0]}>
        <sphereGeometry args={[0.24, 12, 12]} />
        <meshStandardMaterial color="#f5f5f7" emissive={color} emissiveIntensity={0.3} />
      </mesh>
    </group>
  )
}

// ---- labels: DOM nodes projected over the canvas ---------------------------------------------------

function LabelLayer({ overlay, level, levelIndex, levelElev, spaces, index }: { overlay: RefObject<HTMLDivElement | null>; level: string; levelIndex: Record<string, number>; levelElev: Record<string, number>; spaces: Record<string, Space>; index: Indexed }) {
  const marks = usePeopleMarks(level, levelIndex, levelElev, spaces)
  const figures = useFigures(level, levelIndex, levelElev, spaces)
  const leaks = useWorld((s) => s.world?.leaks)
  const contactName = useWorld((s) => s.world?.narrative.contact_name)
  const contactIn = useWorld((s) => s.world?.narrative.contact_in_s)
  const equipment = useBuilding((b) => b.equipment)
  const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)

  const labels = useMemo<Label[]>(() => {
    const out: Label[] = []
    for (const m of marks) {
      if (!m.label) continue
      out.push({ id: `p:${m.id}`, pos: [m.pos[0], m.pos[1] + 0.9, m.pos[2]], text: m.name.split(' ')[0], tag: m.tag ?? undefined, color: m.color, kind: 'person', priority: m.left ? 0 : 1, buds: `resident:${m.id}`, select: { kind: 'resident', id: m.id } })
    }
    for (const f of figures) {
      if (f.status === 'idle') continue
      const task = f.task ? (f.task.length > 34 ? f.task.slice(0, 32) + '…' : f.task) : null
      out.push({ id: `a:${f.id}`, pos: [f.to[0], f.to[1] + 1.5, f.to[2]], text: f.label.replace(/\s*\(.*\)/, ''), tag: task ? `${f.status === 'moving' ? 'on it' : 'done'}: ${task}` : undefined, color: ACTOR_COLOR[f.status], kind: 'actor', priority: 2, buds: `actor:${f.id}` })
    }
    // The physical story: where the water comes in, and the switchgear it is heading for.
    for (const [eid, leak] of Object.entries(leaks ?? {})) {
      const e = equipment[eid]
      if (!e || !leak.active || (levelIndex[e.level] ?? 0) > focus) continue
      out.push({ id: `e:${eid}`, pos: [e.x, (levelElev[e.level] ?? 0) + 2.4, -e.y], text: e.name.replace(/\s*\(.*\)/, ''), tag: `${leak.flow_lps.toFixed(0)} L/s`, color: '#38bdf8', kind: 'equipment', priority: 0, select: { kind: 'equipment', id: eid } })
    }
    if (contactName && contactIn != null) {
      const e = Object.values(equipment).find((x) => x.name === contactName)
      if (e && (levelIndex[e.level] ?? 0) <= focus) {
        out.push({ id: `e:${e.id}`, pos: [e.x, (levelElev[e.level] ?? 0) + 2.2, -e.y], text: e.name, tag: `water in ${Math.max(1, Math.round(contactIn / 60))} min`, color: '#ffb020', kind: 'equipment', priority: 0, select: { kind: 'equipment', id: e.id } })
      }
    }
    return out
  }, [marks, figures, leaks, contactName, contactIn, equipment, levelIndex, levelElev, focus])

  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const v = useMemo(() => new THREE.Vector3(), [])

  // Keep one DOM node per label, created and removed outside React.
  useEffect(() => {
    const root = overlay.current
    if (!root) return
    const seen = new Set<string>()
    for (const l of labels) {
      seen.add(l.id)
      let el = nodes.current.get(l.id)
      if (!el) {
        el = document.createElement('div')
        el.className = 'twin-label'
        root.appendChild(el)
        nodes.current.set(l.id, el)
      }
      el.dataset.kind = l.kind
      if (l.buds) el.setAttribute('data-buds', l.buds)
      else el.removeAttribute('data-buds')
      el.style.setProperty('--c', l.color)
      el.textContent = ''
      const name = document.createElement('span')
      name.className = 'twin-label__name'
      name.textContent = l.text
      el.appendChild(name)
      if (l.tag) {
        const tag = document.createElement('span')
        tag.className = 'twin-label__tag'
        tag.textContent = l.tag
        el.appendChild(tag)
      }
      const sel = l.select
      el.onclick = sel ? () => select(sel) : null
      el.style.pointerEvents = sel ? 'auto' : 'none'
    }
    for (const [id, el] of nodes.current) {
      if (!seen.has(id)) {
        el.remove()
        nodes.current.delete(id)
      }
    }
  }, [labels, overlay])
  useEffect(
    () => () => {
      for (const el of nodes.current.values()) el.remove()
      nodes.current.clear()
    },
    [],
  )

  useFrame(() => {
    const placed: { x: number; y: number; w: number; h: number }[] = []
    const order = [...labels].sort((a, b) => a.priority - b.priority)
    for (const l of order) {
      const el = nodes.current.get(l.id)
      if (!el) continue
      v.set(l.pos[0], l.pos[1], l.pos[2]).project(camera)
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) {
        el.style.display = 'none'
        continue
      }
      const w = el.offsetWidth || 60
      const h = el.offsetHeight || 18
      const box = { x: ((v.x + 1) / 2) * size.width - w / 2, y: ((1 - v.y) / 2) * size.height - h - 4, w, h }
      box.x = Math.max(2, Math.min(size.width - w - 2, box.x))
      for (let k = 0; k < 8; k++) {
        const hit = placed.find((p) => box.x < p.x + p.w + 4 && p.x < box.x + box.w + 4 && box.y < p.y + p.h + 2 && p.y < box.y + box.h + 2)
        if (!hit) break
        box.y = hit.y + hit.h + 3
      }
      placed.push(box)
      el.style.display = ''
      el.style.transform = `translate(${box.x.toFixed(0)}px, ${box.y.toFixed(0)}px)`
    }
  })
  void index
  return null
}

function centerOf(r: Rect, y: number): [number, number, number] {
  return [(r.x0 + r.x1) / 2, y, -(r.y0 + r.y1) / 2]
}

// ---- optional furniture file ----------------------------------------------------------------

function Furniture({ level, levelIndex }: { level: string; levelIndex: Record<string, number> }) {
  const furniture = useGLTF(FURNITURE_URL)
  const meshes = useMemo(() => {
    const out: { mesh: THREE.Object3D; index: number }[] = []
    furniture.scene.traverse((o) => {
      const li = Number(o.userData?.level_index)
      if (!Number.isNaN(li) && o.userData?.level_index !== undefined) out.push({ mesh: o, index: li })
    })
    return out
  }, [furniture.scene])
  useEffect(() => {
    const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)
    for (const { mesh, index: li } of meshes) mesh.visible = li <= focus
  }, [level, levelIndex, meshes])
  return <primitive object={furniture.scene} />
}

/** The light rig used when the HDRI is missing: a soft sky panel and two rim panels, no network fetch. */
function StudioLight() {
  return (
    <>
      <hemisphereLight args={['#dfe8ff', '#3a3330', 0.55]} />
      <Environment resolution={64} frames={1}>
        <Lightformer intensity={2.2} rotation-x={Math.PI / 2} position={[0, 5, -9]} scale={[14, 14, 1]} color="#dbe7ff" />
        <Lightformer intensity={0.8} rotation-y={Math.PI / 2} position={[-5, 1, -1]} scale={[12, 3, 1]} color="#ffe9c8" />
        <Lightformer intensity={0.6} rotation-y={-Math.PI / 2} position={[10, 1, 0]} scale={[12, 3, 1]} color="#cfe0ff" />
      </Environment>
    </>
  )
}

/** The street, neighbours, trees, props and people from the Blender scene (optional file). Hidden when
 *  looking into the basement, like the cutaway renders; alpha-masked leaves keep their transparency.
 *  At night the neighbours' windows glow a little so the block reads as a city, not a model. */
function Site({ level, levelIndex, night }: { level: string; levelIndex: Record<string, number>; night: boolean }) {
  const site = useGLTF(SITE_URL)
  useEffect(() => {
    site.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats as THREE.MeshStandardMaterial[]) {
        if (m.transparent || m.alphaTest > 0) m.side = THREE.DoubleSide
        if (m.userData.baseEmissiveIntensity === undefined) {
          m.userData.baseEmissive = m.emissive?.clone() ?? new THREE.Color('#000')
          m.userData.baseEmissiveIntensity = m.emissiveIntensity ?? 0
        }
        const glassy = /glass|window|win/i.test(m.name) || (m.transparent && !(m.alphaTest > 0))
        if (night && glassy) {
          m.emissive.set('#ffd8a0')
          m.emissiveIntensity = 0.35
        } else if (m.userData.baseEmissive) {
          m.emissive.copy(m.userData.baseEmissive as THREE.Color)
          m.emissiveIntensity = m.userData.baseEmissiveIntensity as number
        }
      }
    })
  }, [site.scene, night])
  useEffect(() => {
    const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)
    site.scene.visible = focus >= 1
  }, [level, levelIndex, site.scene])
  return <primitive object={site.scene} />
}

/** Renders the fallback (nothing, by default) if the child throws, e.g. an optional file is absent. */
class Optional extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children
  }
}
