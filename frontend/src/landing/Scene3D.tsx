import { ContactShadows, Environment, Lightformer, Line, useGLTF } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Suspense, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { moods, pointer, prefersReducedMotion, smooth, storyT, tags } from './progress'

/**
 * The landing page's building: the same GLBs the command centre streams (exported by
 * blender/build_blackwell.py), dressed as a pastel clay model with glass windows. Nothing here is
 * scripted on a timer; every frame reads `storyT` and draws what the building is going through at that
 * point of the story: lit windows on a quiet night, water rising in the glass basement, the equipment
 * glowing as the leak reaches it, two floors going dark, one window that matters, a mint route out.
 *
 * glTF is y-up: x east, z south, y up.
 */

const EXTERIOR_URL = '/models/blackwell.glb'
const INTERIOR_URL = '/models/blackwell_interior.glb'
useGLTF.preload(EXTERIOR_URL)
useGLTF.preload(INTERIOR_URL)

const DARK_LEVELS = new Set([3, 4]) // the floors that lose power first in the scenario
const PERSON_LEVEL = 4 // the hero resident's floor

// Camera keyframes: hero, then one per chapter. az 0 = from the south, 90 = from the east.
type Focus = 'center' | 'leak' | 'person'
const KEYS: { az: number; el: number; dist: number; focus: Focus }[] = [
  { az: 36, el: 22, dist: 0.95, focus: 'center' },
  { az: 26, el: 15, dist: 0.9, focus: 'center' },
  { az: 40, el: 16, dist: 0.82, focus: 'center' },
  { az: 58, el: 24, dist: 0.95, focus: 'center' },
  { az: 28, el: 9, dist: 0.42, focus: 'person' },
  { az: 16, el: 20, dist: 0.8, focus: 'center' },
  { az: -4, el: 26, dist: 1.0, focus: 'center' },
]

const C = {
  clay: '#eef0ff',
  peach: '#ffc3a3',
  apricot: '#ffd9b8',
  lavender: '#e2dcff',
  mint: '#b4f0d6',
  slab: '#d9ddf8',
  metal: '#c2c8ec',
  windowBase: '#1c2458',
  warm: '#ffad5c',
  personGlow: '#b49bff',
  safe: '#6ff0c4',
  danger: '#ff7a68',
  water: '#4f9dff',
}

function paletteFor(name: string): THREE.MeshStandardMaterial {
  const n = name.toLowerCase()
  let color = C.clay
  if (n.includes('ochre')) color = C.peach
  else if (n.includes('timber')) color = C.apricot
  else if (n.includes('lawn') || n.includes('soil') || n.includes('deck')) color = C.mint
  else if (n.includes('roof')) color = C.lavender
  else if (n.includes('concrete') || n.includes('paving')) color = C.slab
  else if (n.includes('metal') || n.includes('frame')) color = C.metal
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.02 })
}

interface WindowRec {
  mat: THREE.MeshStandardMaterial
  level: number
  lit: boolean
  seed: number
}
interface EqRec {
  mat: THREE.MeshStandardMaterial
  delay: number
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) % 1000) / 1000
}

export default function Scene3D({ active, onReady }: { active: boolean; onReady: () => void }) {
  return (
    <Canvas
      frameloop={active ? 'always' : 'never'}
      dpr={[1, 1.75]}
      camera={{ fov: 28, near: 1, far: 3000, position: [200, 120, 200] }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1.08
        gl.setClearColor(0x000000, 0)
      }}
      aria-hidden="true"
    >
      <Suspense fallback={null}>
        <Building onReady={onReady} />
      </Suspense>
    </Canvas>
  )
}

function radialTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  grd.addColorStop(0, 'rgba(170,160,255,0.55)')
  grd.addColorStop(0.45, 'rgba(120,150,255,0.22)')
  grd.addColorStop(1, 'rgba(120,150,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 256, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

type Rig = ReturnType<typeof dress>
const RIGS = new WeakMap<THREE.Object3D, Rig>()

/** Dress both scenes and measure what the story needs: the basement, the leak, one window. */
function dress(exteriorScene: THREE.Object3D, interiorScene: THREE.Object3D) {
  exteriorScene.updateMatrixWorld(true)
  interiorScene.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(exteriorScene)
  const center = bounds.getCenter(new THREE.Vector3())
  const size = bounds.getSize(new THREE.Vector3())

  const shared = new Map<string, THREE.MeshStandardMaterial>()
  const basementGlass = new THREE.MeshStandardMaterial({
    color: '#b8c4ff', roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.22, depthWrite: false,
  })
  const windows: WindowRec[] = []
  const windowMeshes: { mesh: THREE.Mesh; rec: WindowRec }[] = []
  const basement = new THREE.Box3()
  let minLevel = Infinity
  exteriorScene.traverse((o) => {
    const li = Number(o.userData?.level_index)
    if (o.name.startsWith('walls_ext_') && Number.isFinite(li)) minLevel = Math.min(minLevel, li)
  })

  exteriorScene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const li = Number(mesh.userData?.level_index ?? mesh.parent?.userData?.level_index)
    const owner = mesh.name.startsWith('win_') || mesh.parent?.name.startsWith('win_') ? 'win' : ''
    if (owner === 'win') {
      const key = mesh.name || mesh.parent?.name || ''
      const rec: WindowRec = {
        mat: new THREE.MeshStandardMaterial({ color: C.windowBase, roughness: 0.18, metalness: 0.35, emissive: C.warm, emissiveIntensity: 0 }),
        level: Number.isFinite(li) ? li : 0,
        lit: hash(key) < 0.68,
        seed: hash(key + '#'),
      }
      mesh.material = rec.mat
      windows.push(rec)
      windowMeshes.push({ mesh, rec })
      return
    }
    const isBasementWall = (mesh.name.startsWith('walls_ext_') || mesh.parent?.name.startsWith('walls_ext_')) && li === minLevel
    if (isBasementWall) {
      mesh.material = basementGlass
      basement.expandByObject(mesh)
      return
    }
    const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material
    const k = src?.name ?? ''
    if (!shared.has(k)) shared.set(k, paletteFor(k))
    mesh.material = shared.get(k)!
  })
  if (basement.isEmpty()) basement.set(new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z), new THREE.Vector3(bounds.max.x, bounds.min.y + 4, bounds.max.z))

  // The equipment is the only part of the interior the landing shows; it sits in the glass basement.
  const eqMeshes: { mesh: THREE.Mesh; pos: THREE.Vector3; name: string }[] = []
  interiorScene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    let cur: THREE.Object3D | null = mesh
    let eqName = ''
    while (cur) {
      if (cur.name.startsWith('eq_')) { eqName = cur.name; break }
      cur = cur.parent
    }
    if (!eqName) { mesh.visible = false; return }
    const pos = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3())
    if (pos.y > basement.max.y) { mesh.visible = false; return }
    eqMeshes.push({ mesh, pos, name: eqName })
  })
  const inBasement = eqMeshes.filter((e) => e.pos.y < basement.max.y)
  const riser = inBasement.filter((e) => e.name.includes('riser')).sort((a, b) => a.name.localeCompare(b.name))[0]
  const leak = riser ? riser.pos.clone() : basement.getCenter(new THREE.Vector3())
  leak.y = basement.min.y + 0.4
  const maxD = Math.max(1, ...inBasement.map((e) => e.pos.distanceTo(leak)))
  const eqs: EqRec[] = []
  for (const e of eqMeshes) {
    const mat = new THREE.MeshStandardMaterial({ color: '#d4daff', roughness: 0.5, metalness: 0.1, emissive: C.danger, emissiveIntensity: 0 })
    e.mesh.material = mat
    eqs.push({ mat, delay: Math.min(1, e.pos.distanceTo(leak) / maxD) })
  }
  // The chain of consequence: pipe-like runs from the leak to the electrical plant, then up the core.
  const byName = new Map<string, THREE.Vector3>()
  for (const e of inBasement) if (!byName.has(e.name)) byName.set(e.name, e.pos)
  const named = [...byName.entries()].filter(([n]) => /msb|ats|switch|lift|generator/.test(n))
  const pool = (named.length ? named : [...byName.entries()]).sort((a, b) => b[1].distanceTo(leak) - a[1].distanceTo(leak))
  const runY = leak.y + 0.35
  const chain: { curve: THREE.CurvePath<THREE.Vector3>; delay: number }[] = []
  const run = (pts: THREE.Vector3[], delay: number) => {
    const curve = new THREE.CurvePath<THREE.Vector3>()
    for (let i = 0; i < pts.length - 1; i++) curve.add(new THREE.LineCurve3(pts[i], pts[i + 1]))
    chain.push({ curve, delay })
  }
  pool.slice(0, 4).forEach(([, p], i) => {
    run([new THREE.Vector3(leak.x, runY, leak.z), new THREE.Vector3(p.x, runY, leak.z), new THREE.Vector3(p.x, runY, p.z), p.clone()], i * 0.12)
  })
  const lift = named.find(([n]) => n.includes('lift'))?.[1] ?? pool[0]?.[1] ?? leak

  // The window that matters: on the person's floor, the one that faces the camera most.
  const facing = new THREE.Vector3(Math.sin(0.55), 0, Math.cos(0.55))
  let best: { pos: THREE.Vector3; rec: WindowRec } | null = null
  let bestScore = -Infinity
  for (const { mesh, rec } of windowMeshes) {
    if (rec.level !== PERSON_LEVEL) continue
    const p = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3())
    const score = p.clone().sub(center).setY(0).dot(facing)
    if (score > bestScore) { bestScore = score; best = { pos: p, rec } }
  }
  const person = best?.pos ?? center.clone()
  if (best) best.rec.lit = true
  const outward = person.clone().sub(center).setY(0).normalize()
  const marker = person.clone().addScaledVector(outward, 1.6)

  const groundY = basement.max.y
  const exit = marker.clone().addScaledVector(outward, 14)
  exit.y = groundY + 0.3
  const route: [number, number, number][] = [
    [marker.x, marker.y, marker.z],
    [marker.x, groundY + 0.3, marker.z],
    [exit.x, exit.y, exit.z],
  ]
  run([lift.clone(), new THREE.Vector3(lift.x, person.y + 1.2, lift.z)], 0.5)

  const shell = [...shared.values()]
  return { center, size, basement, windows, eqs, shell, leak, person, marker, exit, route, chain, bestRec: best?.rec ?? null, minY: bounds.min.y }
}

function Building({ onReady }: { onReady: () => void }) {
  const exterior = useGLTF(EXTERIOR_URL)
  const interior = useGLTF(INTERIOR_URL)

  // Cached per scene: dressing swaps the meshes' materials, so it must happen exactly once (StrictMode
  // runs memos twice and keeps the first result).
  const rig = useMemo(() => {
    const cached = RIGS.get(exterior.scene)
    if (cached) return cached
    const made = dress(exterior.scene, interior.scene)
    RIGS.set(exterior.scene, made)
    return made
  }, [exterior.scene, interior.scene])


  useEffect(() => {
    const id = requestAnimationFrame(() => onReady())
    return () => cancelAnimationFrame(id)
  }, [onReady])

  const glowTex = useMemo(radialTexture, [])
  const L = Math.max(rig.size.x, rig.size.z)
  const bH = rig.basement.max.y - rig.basement.min.y
  const bw = rig.basement.max.x - rig.basement.min.x - 0.8
  const bd = rig.basement.max.z - rig.basement.min.z - 0.8
  const bc = rig.basement.getCenter(new THREE.Vector3())

  const water = useRef<THREE.Mesh>(null)
  const rings = useRef<(THREE.Mesh | null)[]>([])
  const marker = useRef<THREE.Mesh>(null)
  const halo = useRef<THREE.Mesh>(null)
  const shield = useRef<THREE.Mesh>(null)
  const beacon = useRef<THREE.Mesh>(null)
  const tubes = useMemo(() => rig.chain.map((c) => new THREE.TubeGeometry(c.curve, 96, 0.28, 8, false)), [rig])
  const tubeRefs = useRef<(THREE.Mesh | null)[]>([])
  const pulseRefs = useRef<(THREE.Mesh | null)[]>([])
  const routeRef = useRef<{ material: THREE.Material & { dashOffset: number; opacity: number }; visible: boolean } | null>(null)

  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const curPos = useRef(new THREE.Vector3(rig.center.x + L * 2, rig.center.y + L, rig.center.z + L * 2))
  const curTarget = useRef(rig.center.clone())
  const offset = useRef({ x: 0, y: 0 })
  const reduced = useMemo(prefersReducedMotion, [])
  const warm = useMemo(() => new THREE.Color(C.warm), [])
  const personCol = useMemo(() => new THREE.Color(C.personGlow), [])
  const safeCol = useMemo(() => new THREE.Color(C.safe), [])
  const tmpCol = useMemo(() => new THREE.Color(), [])

  useFrame((state, dt) => {
    const t = storyT.get()
    const m = moods(t)
    const time = state.clock.elapsedTime
    const d = Math.min(dt, 0.05)

    // ---- camera: blend the two keyframes either side of t, plus the pointer and a slow drift
    const k = Math.min(KEYS.length - 1, Math.max(0, t + 1))
    const i = Math.min(KEYS.length - 2, Math.floor(k))
    const f = smooth(0, 1, k - i)
    const a = KEYS[i], b = KEYS[i + 1]
    const focusOf = (fx: Focus) => (fx === 'leak' ? rig.leak : fx === 'person' ? rig.person : rig.center)
    const target = focusOf(a.focus).clone().lerp(focusOf(b.focus), f)
    const drift = reduced ? 0 : Math.sin(time * 0.12) * 2.5
    const az = THREE.MathUtils.degToRad(a.az + (b.az - a.az) * f + pointer.x * 5 + drift)
    const el = THREE.MathUtils.degToRad(a.el + (b.el - a.el) * f - pointer.y * 3)
    const aspect = state.size.width / state.size.height
    const fit = aspect < 1 ? Math.min(2.2, 0.95 / aspect) : 1 // portrait screens see less sideways
    const R = (a.dist + (b.dist - a.dist) * f) * L * 3.1 * fit
    const want = new THREE.Vector3(target.x + Math.sin(az) * Math.cos(el) * R, target.y + Math.sin(el) * R, target.z + Math.cos(az) * Math.cos(el) * R)
    const ease = 1 - Math.exp(-d * (reduced ? 12 : 3.2))
    curPos.current.lerp(want, ease)
    curTarget.current.lerp(target, ease)
    camera.position.copy(curPos.current)
    camera.lookAt(curTarget.current)

    // ---- frame the building beside the words: right of the copy on wide screens, above it on phones
    const { width: w, height: h } = state.size
    const wide = w / h > 1.05
    const wantX = wide ? -w * (t < 0 ? 0.2 : 0.19) : 0
    const wantY = wide ? 0 : h * (t < -0.5 ? 0.2 : 0.17)
    offset.current.x += (wantX - offset.current.x) * ease
    offset.current.y += (wantY - offset.current.y) * ease
    camera.setViewOffset(w, h, offset.current.x, offset.current.y, w, h)

    // ---- x-ray: while HAVEN looks inside, the shell turns to glass so the chain shows through
    const see = 1 - 0.82 * m.xray
    const solid = see > 0.985
    for (const mat of rig.shell) {
      if (mat.transparent === solid) { mat.transparent = !solid; mat.depthWrite = solid; mat.needsUpdate = true }
      mat.opacity = see
    }
    for (const wnd of rig.windows) {
      if (wnd.mat.transparent === solid) { wnd.mat.transparent = !solid; wnd.mat.depthWrite = solid; wnd.mat.needsUpdate = true }
      wnd.mat.opacity = 0.35 + 0.65 * see
    }

    // ---- windows: a lived-in night, two floors losing power, every light back on at the end
    for (const wnd of rig.windows) {
      const flicker = 0.88 + 0.12 * Math.sin(time * 0.6 + wnd.seed * 40)
      let v = wnd.lit ? 2.1 * flicker : 0
      if (DARK_LEVELS.has(wnd.level)) v *= 1 - smooth(wnd.seed * 0.5, wnd.seed * 0.5 + 0.5, m.dark)
      v = Math.max(v, m.together * 1.5 * (0.7 + 0.3 * wnd.seed))
      wnd.mat.emissive.copy(warm)
      wnd.mat.emissiveIntensity = v
    }
    if (rig.bestRec) {
      const pulse = 0.65 + 0.35 * Math.sin(time * 3.2)
      tmpCol.copy(warm).lerp(personCol, m.person).lerp(safeCol, m.protect)
      rig.bestRec.mat.emissive.copy(tmpCol)
      rig.bestRec.mat.emissiveIntensity = 2.1 + m.person * 2.5 * pulse
    }

    // ---- the equipment lights up in the order the water reaches it
    for (const e of rig.eqs) {
      const on = smooth(e.delay * 0.55, e.delay * 0.55 + 0.45, m.danger)
      e.mat.emissiveIntensity = on * (2.2 + 0.8 * Math.sin(time * 4 + e.delay * 9))
    }

    // ---- water and the leak's ripples
    if (water.current) {
      const hgt = Math.max(0.001, m.water * bH * 0.55)
      water.current.visible = m.water > 0.005
      water.current.scale.set(1, hgt, 1)
      water.current.position.y = rig.basement.min.y + 0.05 + hgt / 2
      const wm = water.current.material as THREE.MeshStandardMaterial
      wm.emissiveIntensity = 0.35 + 0.15 * Math.sin(time * 2)
    }
    rings.current.forEach((r, n) => {
      if (!r) return
      const ph = (time * 0.55 + n / 3) % 1
      r.visible = m.leak > 0.01
      const s = 0.4 + ph * 5
      r.scale.set(s, s, s)
      r.position.y = rig.basement.min.y + 0.12 + m.water * bH * 0.55
      ;(r.material as THREE.MeshBasicMaterial).opacity = (1 - ph) * 0.8 * m.leak
    })

    // ---- the chain of consequence
    rig.chain.forEach((c, n) => {
      const tube = tubeRefs.current[n]
      const pulse = pulseRefs.current[n]
      if (!tube || !pulse) return
      const grow = smooth(c.delay, c.delay + 0.5, m.danger)
      const geo = tube.geometry as THREE.BufferGeometry
      tube.visible = grow > 0.01
      geo.setDrawRange(0, Math.floor((geo.index?.count ?? 0) * grow / 6) * 6)
      ;(tube.material as THREE.MeshBasicMaterial).opacity = 0.85 * Math.min(1, m.danger * 1.4)
      pulse.visible = tube.visible
      pulse.position.copy(c.curve.getPointAt(((time * 0.45 + n * 0.21) % 1) * grow))
      ;(pulse.material as THREE.MeshBasicMaterial).opacity = m.danger
    })

    // ---- the person, then their way out, then everyone held
    if (marker.current && halo.current) {
      const show = Math.max(m.person, m.protect)
      marker.current.visible = halo.current.visible = show > 0.01
      tmpCol.copy(personCol).lerp(safeCol, m.protect)
      ;(marker.current.material as THREE.MeshBasicMaterial).color.copy(tmpCol)
      ;(halo.current.material as THREE.MeshBasicMaterial).color.copy(tmpCol)
      marker.current.scale.setScalar(show * (1 + 0.12 * Math.sin(time * 3.2)))
      const hp = (time * 0.7) % 1
      halo.current.scale.setScalar(show * (1 + hp * 2.4))
      ;(halo.current.material as THREE.MeshBasicMaterial).opacity = (1 - hp) * 0.55 * show
      halo.current.lookAt(camera.position)
    }
    const tag = tags.person
    if (tag) {
      const show = Math.max(m.person, m.protect) * (1 - m.together)
      camera.updateMatrixWorld()
      const p = rig.marker.clone().project(camera)
      const sx = Math.min(w - 250, ((p.x + 1) / 2) * w)
      const sy = ((1 - p.y) / 2) * h
      tag.style.opacity = String(p.z < 1 ? show : 0)
      tag.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`
    }
    if (routeRef.current) {
      routeRef.current.visible = m.protect > 0.01
      routeRef.current.material.opacity = m.protect
      routeRef.current.material.dashOffset -= d * 3
    }
    if (beacon.current) {
      beacon.current.visible = m.protect > 0.01
      beacon.current.scale.setScalar(m.protect * (1 + 0.15 * Math.sin(time * 2.5)))
    }
    if (shield.current) {
      const s = m.together
      shield.current.visible = s > 0.01
      shield.current.scale.setScalar(0.7 + 0.3 * s)
      shield.current.rotation.z = time * 0.15
      ;(shield.current.material as THREE.MeshBasicMaterial).opacity = s * 0.85
    }
  })

  const dashProps = { dashed: true, dashScale: 1, transparent: true, depthWrite: false } as const

  return (
    <>
      <hemisphereLight args={['#d6dcff', '#3b2c78', 1.15]} />
      <directionalLight position={[rig.center.x + L, rig.center.y + L * 1.4, rig.center.z + L * 1.2]} intensity={2.1} color="#ffe6d6" />
      <directionalLight position={[rig.center.x - L, rig.center.y + L * 0.6, rig.center.z - L]} intensity={1.4} color="#b8a6ff" />
      <Environment resolution={128}>
        <Lightformer intensity={2.2} color="#bcd0ff" position={[0, 6, -8]} scale={[12, 4, 1]} />
        <Lightformer intensity={1.6} color="#ffd6c2" position={[8, 2, 4]} scale={[6, 6, 1]} />
        <Lightformer intensity={1.4} color="#c8b6ff" position={[-8, 3, 4]} scale={[6, 6, 1]} />
      </Environment>

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[rig.center.x, rig.minY - 0.2, rig.center.z]}>
        <circleGeometry args={[L * 1.05, 64]} />
        <meshBasicMaterial map={glowTex} transparent depthWrite={false} />
      </mesh>
      <ContactShadows frames={1} position={[rig.center.x, rig.minY - 0.1, rig.center.z]} scale={L * 1.6} blur={2.6} opacity={0.45} far={30} color="#1b1650" />

      <primitive object={exterior.scene} />
      <primitive object={interior.scene} />

      <mesh ref={water} position={[bc.x, rig.basement.min.y, bc.z]} visible={false}>
        <boxGeometry args={[bw, 1, bd]} />
        <meshStandardMaterial color={C.water} emissive="#2f6bff" emissiveIntensity={0.35} roughness={0.12} metalness={0.1} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      {[0, 1, 2].map((n) => (
        <mesh key={n} ref={(el) => { rings.current[n] = el }} rotation={[-Math.PI / 2, 0, 0]} position={[rig.leak.x, rig.leak.y, rig.leak.z]} visible={false}>
          <ringGeometry args={[0.9, 1.1, 48]} />
          <meshBasicMaterial color="#bfe0ff" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}

      {tubes.map((g, n) => (
        <group key={n}>
          <mesh ref={(el) => { tubeRefs.current[n] = el }} geometry={g} renderOrder={10} visible={false}>
            <meshBasicMaterial color={n === tubes.length - 1 ? '#ffb38a' : C.danger} transparent opacity={0} depthTest={false} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh ref={(el) => { pulseRefs.current[n] = el }} renderOrder={11} visible={false}>
            <sphereGeometry args={[0.65, 16, 16]} />
            <meshBasicMaterial color="#fff1ea" transparent opacity={0} depthTest={false} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}

      <mesh ref={marker} position={rig.marker} visible={false}>
        <sphereGeometry args={[0.9, 24, 24]} />
        <meshBasicMaterial color={C.personGlow} toneMapped={false} />
      </mesh>
      <mesh ref={halo} position={rig.marker} visible={false}>
        <ringGeometry args={[1.2, 1.5, 48]} />
        <meshBasicMaterial color={C.personGlow} transparent opacity={0} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <Line
        ref={(el) => { routeRef.current = el as unknown as typeof routeRef.current }}
        points={rig.route}
        color={C.safe}
        lineWidth={3.5}
        dashSize={1.2}
        gapSize={0.7}
        opacity={0}
        {...dashProps}
      />
      <mesh ref={beacon} position={rig.exit} visible={false}>
        <sphereGeometry args={[0.9, 24, 24]} />
        <meshBasicMaterial color={C.safe} toneMapped={false} />
      </mesh>
      <mesh ref={shield} rotation={[-Math.PI / 2, 0, 0]} position={[rig.center.x, rig.basement.max.y + 0.15, rig.center.z]} visible={false}>
        <ringGeometry args={[L * 0.692, L * 0.7, 160]} />
        <meshBasicMaterial color={C.safe} transparent opacity={0} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </>
  )
}
