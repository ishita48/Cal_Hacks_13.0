import { Component, Suspense, useMemo, useState, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bounds, OrbitControls, useGLTF } from '@react-three/drei'
import { outlineLoops, roundedShapes } from '../twin/geometry'
import { heavy } from '../lib/assets'
import type { Scene } from './types'

/**
 * The building as this viewer may see it. The backend already filtered `data`: a resident's scene holds
 * their room and the shared spaces, an RA's their floors, maintenance its job rooms and plant, the admin
 * everything. This view only draws what arrived. The Blender exterior loads on request, for the admin only.
 */

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <div className="hp-building is-loading">The 3D view is not available on this device. Everything else works as usual.</div> : this.props.children
  }
}

const COLOR = { shell: '#c9d6ec', floor: '#e3eaf7', floorOn: '#a9c2f2', room: '#c7d3e6', authorized: '#7c9ef0', mine: '#5b7cfa', wet: '#f2a07b', kit: '#9b87f5', kitDown: '#ef6b5b' }

function Photoreal() {
  const { scene } = useGLTF(heavy('/models/blackwell.glb'))
  const copy = useMemo(() => scene.clone(true), [scene])
  return <primitive object={copy} />
}

function Massing({ data, floor, mine, choose }: { data: Scene; floor: string; mine: Set<string>; choose: (id: string) => void }) {
  const shapes = useMemo(() => roundedShapes(outlineLoops(data.footprint), 0.7, 0, 0), [data.footprint])
  const levels = data.levels.filter((l) => l.index >= 0)
  const level = data.levels.find((l) => l.id === floor)
  return (
    <group>
      {levels.map((l) => {
        const on = floor === l.id
        const above = level ? l.index > level.index : false
        return (
          <group key={l.id} position={[0, l.elevation, 0]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} onClick={(e) => (e.stopPropagation(), choose(l.id))}>
              <extrudeGeometry args={[shapes, { depth: 0.4, bevelEnabled: false }]} />
              <meshStandardMaterial color={on ? COLOR.floorOn : COLOR.floor} roughness={0.7} transparent opacity={above ? 0.12 : 1} depthWrite={!above} />
            </mesh>
            {!above &&
              data.footprint.map((r, i) => (
                <mesh key={i} position={[(r.x0 + r.x1) / 2, l.height / 2, -(r.y0 + r.y1) / 2]}>
                  <boxGeometry args={[r.x1 - r.x0, l.height - 0.5, r.y1 - r.y0]} />
                  <meshStandardMaterial color={COLOR.shell} transparent opacity={on ? 0.08 : 0.18} depthWrite={false} />
                </mesh>
              ))}
          </group>
        )
      })}
      {level &&
        data.spaces
          .filter((s) => s.level === floor)
          .map((s) => {
            const r = s.rect
            const color = s.wet ? COLOR.wet : mine.has(s.id) ? COLOR.mine : s.authorized ? COLOR.authorized : COLOR.room
            return (
              <mesh key={s.id} position={[(r.x0 + r.x1) / 2, level.elevation + 0.75, -(r.y0 + r.y1) / 2]}>
                <boxGeometry args={[Math.max(0.2, r.x1 - r.x0 - 0.3), mine.has(s.id) || s.wet ? 1.2 : 0.5, Math.max(0.2, r.y1 - r.y0 - 0.3)]} />
                <meshStandardMaterial color={color} roughness={0.55} />
              </mesh>
            )
          })}
      {level &&
        data.equipment
          .filter((e) => e.level === floor)
          .map((e) => (
            <mesh key={e.id} position={[e.x, level.elevation + 1.6, -e.y]}>
              <sphereGeometry args={[0.6, 16, 12]} />
              <meshStandardMaterial color={e.status === 'online' ? COLOR.kit : COLOR.kitDown} emissive={e.status === 'online' ? '#000000' : COLOR.kitDown} emissiveIntensity={0.4} />
            </mesh>
          ))}
    </group>
  )
}

/** `own` is the resident's room, `mine` the rooms of their requests or jobs, `focus` the floor to open on. */
export default function Building({ data, own, mine = [], focus = 'all' }: { data: Scene; own?: string; mine?: string[]; focus?: string }) {
  const [floor, setFloor] = useState(focus)
  const [photo, setPhoto] = useState(false)
  const mineSet = useMemo(() => new Set([...mine, ...(own ? [own] : [])]), [mine, own])
  const wet = data.spaces.some((s) => s.wet)
  const shown = data.levels.filter((l) => l.index >= 0 || data.spaces.some((s) => s.level === l.id))

  return (
    <div className="hp-building">
      <div className="hp-building-bar">
        <div className="hp-floors" role="radiogroup" aria-label="Floor">
          <button role="radio" aria-checked={floor === 'all'} className={floor === 'all' ? 'is-on' : ''} onClick={() => (setFloor('all'), setPhoto(false))}>
            All
          </button>
          {shown.map((l) => (
            <button key={l.id} role="radio" aria-checked={floor === l.id} className={floor === l.id ? 'is-on' : ''} onClick={() => (setFloor(l.id), setPhoto(false))} title={l.name}>
              {l.short ?? l.name}
            </button>
          ))}
        </div>
        {data.photoreal && (
          <button className="hp-btn is-small" onClick={() => setPhoto((p) => !p)}>
            {photo ? 'Simple view' : 'Photoreal'}
          </button>
        )}
      </div>
      <Boundary>
        <Suspense fallback={<div className="hp-building is-loading">Loading the building…</div>}>
          <Canvas frameloop="demand" dpr={[1, 1.5]} camera={{ position: [110, 85, 100], fov: 36 }} aria-label="Your view of the building">
            <ambientLight intensity={1.6} />
            <directionalLight position={[70, 110, 60]} intensity={2.6} />
            <Bounds fit clip observe margin={1.15}>
              {photo ? <Photoreal /> : <Massing data={data} floor={floor} mine={mineSet} choose={setFloor} />}
            </Bounds>
            <OrbitControls makeDefault minPolarAngle={0.2} maxPolarAngle={Math.PI / 2.1} />
          </Canvas>
        </Suspense>
      </Boundary>
      <div className="hp-building-key">
        {mineSet.size > 0 && (
          <span>
            <i style={{ background: COLOR.mine }} /> {own ? 'Your room' : 'Open requests'}
          </span>
        )}
        <span>
          <i style={{ background: COLOR.authorized }} /> {data.scope}
        </span>
        {wet && (
          <span>
            <i style={{ background: COLOR.wet }} /> Water
          </span>
        )}
      </div>
    </div>
  )
}
