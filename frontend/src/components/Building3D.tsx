import { Html, Line, OrbitControls, OrthographicCamera, useGLTF } from '@react-three/drei'
import { Canvas, useFrame } from '@react-three/fiber'
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react'
import * as THREE from 'three'
import { STATUS_COLOR } from '../lib/labels'
import { useBuilding } from '../state/building'
import { useWorld } from '../state/world'
import type { Rect, ResidentImpact, Space, WorldState } from '../state/types'

/**
 * The building as another view of the one world store. Geometry comes from the GLBs the Blender
 * script exported from the same spec; every colour, label, halo and line below is read from
 * world state. Nothing here holds state of its own.
 *
 * glTF is y-up: a spec point (x, y, z) in metres lands at three.js (x, z, -y).
 */

const EXTERIOR_URL = '/models/blackwell.glb'
const INTERIOR_URL = '/models/blackwell_interior.glb'
// Optional third file: furniture split out so the shell and interior stream first. Missing = fine.
const FURNITURE_URL = '/models/blackwell_furniture.glb'
useGLTF.preload(EXTERIOR_URL)
useGLTF.preload(INTERIOR_URL)

const NAMED = new Set(['maya', 'dana', 'jordan', 'sam', 'lucia', 'theo', 'nora', 'ahmed', 'grace'])
const ROOF_INDEX = 99
const SENSOR_ID = 'basement_mech_1'

type Tint = { mode: 'dark' | 'soon' | 'none'; water: number }

interface Indexed {
  spaceMeshes: Map<string, THREE.Mesh[]>
  eqMeshes: Map<string, THREE.Mesh>
  levelMeshes: { mesh: THREE.Object3D; index: number }[]
}

interface Props {
  level: string // level id, or 'all'
}

export default function Building3D({ level }: Props) {
  return (
    <div className="relative h-full w-full">
      <Canvas
        orthographic
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        style={{ background: '#050507' }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping
          gl.toneMappingExposure = 1.05
        }}
      >
        <color attach="background" args={['#050507']} />
        <Suspense fallback={<LoadingLabel />}>
          <Scene level={level} />
        </Suspense>
      </Canvas>
    </div>
  )
}

function LoadingLabel() {
  return (
    <Html center>
      <div className="glass-card px-3 py-2 text-[11px] text-t2">streaming the building…</div>
    </Html>
  )
}

// ---- scene ---------------------------------------------------------------------------------

function Scene({ level }: Props) {
  const exterior = useGLTF(EXTERIOR_URL)
  const interior = useGLTF(INTERIOR_URL)
  const spec = useBuilding((b) => b.spec)
  const spaces = useBuilding((b) => b.spaces)
  const width = useBuilding((b) => b.width)
  const depth = useBuilding((b) => b.depth)

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
    const out: Indexed = { spaceMeshes: new Map(), eqMeshes: new Map(), levelMeshes: [] }
    const visit = (root: THREE.Object3D) => {
      root.traverse((o) => {
        const ud = o.userData ?? {}
        const li = typeof ud.level_index === 'number' ? ud.level_index : parseInt(String(ud.level_index ?? ''), 10)
        if (!Number.isNaN(li)) out.levelMeshes.push({ mesh: o, index: li })
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
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
          const list = out.spaceMeshes.get(sid) ?? []
          list.push(mesh)
          out.spaceMeshes.set(sid, list)
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
      if (li === ROOF_INDEX) mesh.visible = level === 'all' || level === 'L7'
      else mesh.visible = li <= focus
    }
  }, [level, levelIndex, index])

  const center = useMemo(() => new THREE.Vector3(width / 2, 6, -depth / 2), [width, depth])

  return (
    <>
      <OrthographicCamera makeDefault position={[center.x + 90, 95, center.z + 90]} zoom={7} near={-500} far={1000} />
      <OrbitControls
        target={center}
        enableDamping
        dampingFactor={0.08}
        minPolarAngle={0.25}
        maxPolarAngle={1.35}
        minZoom={3}
        maxZoom={30}
      />
      <hemisphereLight args={['#e8e8ed', '#0a0a0d', 0.95]} />
      <directionalLight position={[40, 90, 30]} intensity={1.5} color="#fff4e0" />
      <directionalLight position={[-60, 40, -80]} intensity={0.35} color="#8fb4ff" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center.x, -0.08, center.z]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#09090c" roughness={1} metalness={0} />
      </mesh>
      <gridHelper args={[400, 80, '#1f1f24', '#141418']} position={[center.x, -0.07, center.z]} />

      <primitive object={exterior.scene} />
      <primitive object={interior.scene} />
      <Optional>
        <Suspense fallback={null}>
          <Furniture level={level} levelIndex={levelIndex} />
        </Suspense>
      </Optional>

      <Tinter index={index} levelIndex={levelIndex} />
      <WaterPlanes level={level} levelIndex={levelIndex} levelElev={levelElev} spaces={spaces} />
      <Halos index={index} />
      <Routes level={level} levelIndex={levelIndex} levelElev={levelElev} spaces={spaces} />
      <People level={level} levelIndex={levelIndex} levelElev={levelElev} spaces={spaces} />
    </>
  )
}

// ---- tinting from state (no React re-render per frame) ----------------------------------------

const DARK = new THREE.Color('#3a0608')
const SOON = new THREE.Color('#ffb020')
const WATER = new THREE.Color('#3ba7ff')
const _tmp = new THREE.Color()

function Tinter({ index, levelIndex }: { index: Indexed; levelIndex: Record<string, number> }) {
  const seen = useRef(-1)
  const tints = useRef<Map<string, Tint>>(new Map())
  const eqStatus = useRef<Map<string, string>>(new Map())
  const spaceLevel = useBuilding((b) => b.spaces)
  const spacesRef = useRef(spaceLevel)
  spacesRef.current = spaceLevel

  useFrame(({ clock }) => {
    const world = useWorld.getState().world
    if (!world) return
    if (world.version !== seen.current) {
      seen.current = world.version
      rebuildTints(world, index, tints.current, spacesRef.current)
      for (const [eid, mesh] of index.eqMeshes) {
        const status = world.equipment[eid]?.status ?? 'online'
        eqStatus.current.set(eid, status)
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats as THREE.MeshStandardMaterial[]) {
          m.emissive.set(STATUS_COLOR[status as keyof typeof STATUS_COLOR] ?? '#64748b')
          m.emissiveIntensity = status === 'online' ? 0.12 : 0.9
          if (status === 'flooded') m.color.copy(m.userData.baseColor as THREE.Color).lerp(WATER, 0.5)
          else m.color.copy(m.userData.baseColor as THREE.Color)
        }
      }
    }
    const t = clock.getElapsedTime()
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.0)
    for (const [sid, tint] of tints.current) {
      const meshes = index.spaceMeshes.get(sid)
      if (!meshes) continue
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
    // Sensor flash while wet.
    const sensor = index.eqMeshes.get(SENSOR_ID)
    if (sensor && world.sensors[SENSOR_ID]?.wet) {
      const m = (Array.isArray(sensor.material) ? sensor.material[0] : sensor.material) as THREE.MeshStandardMaterial
      m.emissive.copy(WATER)
      m.emissiveIntensity = 0.4 + 1.6 * pulse
    }
  })
  void levelIndex
  return null
}

function rebuildTints(world: WorldState, index: Indexed, tints: Map<string, Tint>, spaces: Record<string, Space>) {
  const darkNow = new Set(world.impact.dark_levels)
  const darkSoon = new Set(world.forecast.impact.dark_levels)
  const next = new Map<string, Tint>()
  for (const sid of index.spaceMeshes.keys()) {
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

function WaterPlanes({
  level,
  levelIndex,
  levelElev,
  spaces,
}: {
  level: string
  levelIndex: Record<string, number>
  levelElev: Record<string, number>
  spaces: Record<string, Space>
}) {
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

// ---- routes and stranded rings -----------------------------------------------------------------

function Routes({
  level,
  levelIndex,
  levelElev,
  spaces,
}: {
  level: string
  levelIndex: Record<string, number>
  levelElev: Record<string, number>
  spaces: Record<string, Space>
}) {
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

function PulsingRing({ position }: { position: [number, number, number] }) {
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
      <meshBasicMaterial color="#ff4d4f" transparent opacity={0.8} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

// ---- people --------------------------------------------------------------------------------------

function People({
  level,
  levelIndex,
  levelElev,
  spaces,
}: {
  level: string
  levelIndex: Record<string, number>
  levelElev: Record<string, number>
  spaces: Record<string, Space>
}) {
  const residents = useWorld((s) => s.world?.impact.residents)
  const forecastResidents = useWorld((s) => s.world?.forecast.impact.residents)
  const moved = useWorld((s) => s.world?.moved)
  const roster = useBuilding((b) => b.residents)
  const focus = level === 'all' ? Infinity : (levelIndex[level] ?? Infinity)

  const marks = useMemo(() => {
    const out: { id: string; name: string; pos: [number, number, number]; color: string; label: boolean; faded: boolean }[] = []
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
      out.push({ id: rid, name: r?.name ?? rid, pos: p, color: '#2ecc8f', label: NAMED.has(rid), faded: false })
    }
    for (const r of src) {
      if (placed.has(r.id) || r.severity === 'info') continue
      const sp = spaces[r.room]
      if (!sp || (levelIndex[sp.level] ?? 0) > focus) continue
      out.push({
        id: r.id,
        name: r.name,
        pos: centerOf(sp.rect, (levelElev[sp.level] ?? 0) + 1.2),
        color: r.severity === 'critical' ? '#ff4d4f' : '#ffb020',
        label: NAMED.has(r.id),
        faded: predicted,
      })
    }
    return out
  }, [residents, forecastResidents, moved, roster, spaces, levelIndex, levelElev, focus])

  return (
    <>
      {marks.map((m) => (
        <group key={m.id} position={m.pos}>
          <mesh>
            <sphereGeometry args={[m.label ? 0.55 : 0.35, 16, 16]} />
            <meshStandardMaterial color={m.color} emissive={m.color} emissiveIntensity={0.9} transparent opacity={m.faded ? 0.55 : 1} />
          </mesh>
          {m.label && (
            <Html center position={[0, 1.4, 0]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
              <div
                className="rounded border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap"
                style={{ borderColor: m.color, color: '#fff', background: 'rgba(5,5,7,0.85)', opacity: m.faded ? 0.7 : 1 }}
              >
                {m.name.split(' ')[0]}
              </div>
            </Html>
          )}
        </group>
      ))}
    </>
  )
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

/** Renders nothing if the child throws (e.g. the optional GLB is absent or fails to parse). */
class Optional extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
