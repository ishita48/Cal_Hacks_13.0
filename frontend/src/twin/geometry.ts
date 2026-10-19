import * as THREE from 'three'
import type { Level, Rect, Space } from '../state/types'

/**
 * The stylized twin's geometry, all derived from the building spec: no model files. A level's outline is
 * the union of its rectangles (the footprint above grade, its own rooms below), traced off a half-metre
 * raster into closed loops (outer rings counter-clockwise, courtyards clockwise), then drawn with rounded
 * corners and extruded into one soft slab per storey.
 *
 * Coordinates: the spec is x east, y north, z up, in metres. The scene is three's y-up, centred on the
 * building: X = x - cx, Y = z, Z = cy - y.
 */

export type Pt = [number, number]

export function toScene(x: number, y: number, z: number, cx: number, cy: number): [number, number, number] {
  return [x - cx, z, cy - y]
}

/** Closed loops around the union of the rectangles, on a `cell`-metre raster. */
export function outlineLoops(rects: Rect[], cell = 0.5): Pt[][] {
  if (rects.length === 0) return []
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x0)
    y0 = Math.min(y0, r.y0)
    x1 = Math.max(x1, r.x1)
    y1 = Math.max(y1, r.y1)
  }
  x0 = Math.floor(x0 / cell) * cell
  y0 = Math.floor(y0 / cell) * cell
  const nx = Math.ceil((x1 - x0) / cell)
  const ny = Math.ceil((y1 - y0) / cell)
  const filled = new Uint8Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    const cy = y0 + (j + 0.5) * cell
    for (let i = 0; i < nx; i++) {
      const cx = x0 + (i + 0.5) * cell
      for (const r of rects) {
        if (cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1) {
          filled[j * nx + i] = 1
          break
        }
      }
    }
  }
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && filled[j * nx + i] === 1
  // Directed boundary edges with the filled cell on the left, keyed by their start corner.
  const edges = new Map<string, Pt[]>()
  const key = (p: Pt) => `${p[0]},${p[1]}`
  const push = (a: Pt, b: Pt) => {
    const k = key(a)
    const list = edges.get(k)
    if (list) list.push(b)
    else edges.set(k, [b])
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!at(i, j)) continue
      const a: Pt = [i, j], b: Pt = [i + 1, j], c: Pt = [i + 1, j + 1], d: Pt = [i, j + 1]
      if (!at(i, j - 1)) push(a, b)
      if (!at(i + 1, j)) push(b, c)
      if (!at(i, j + 1)) push(c, d)
      if (!at(i - 1, j)) push(d, a)
    }
  }
  const loops: Pt[][] = []
  for (const [startKey, ends] of edges) {
    while (ends.length) {
      const start = startKey.split(',').map(Number) as Pt
      const loop: Pt[] = [start]
      let next = ends.pop()!
      let guard = 0
      while (key(next) !== startKey && guard++ < 100000) {
        loop.push(next)
        const outs = edges.get(key(next))
        if (!outs || outs.length === 0) break
        next = outs.pop()!
      }
      loops.push(simplify(loop).map(([i, j]) => [x0 + i * cell, y0 + j * cell] as Pt))
    }
  }
  return loops.filter((l) => l.length >= 3)
}

/** Drop the points in the middle of straight runs. */
function simplify(loop: Pt[]): Pt[] {
  const out: Pt[] = []
  const n = loop.length
  for (let k = 0; k < n; k++) {
    const p = loop[(k - 1 + n) % n], c = loop[k], q = loop[(k + 1) % n]
    const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0])
    if (cross !== 0) out.push(c)
  }
  return out
}

export function signedArea(loop: Pt[]): number {
  let a = 0
  for (let k = 0; k < loop.length; k++) {
    const p = loop[k], q = loop[(k + 1) % loop.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

function inside(pt: Pt, loop: Pt[]): boolean {
  let hit = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j]
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** A loop as a path with every corner rounded (radius clamped so short walls stay walls). */
function roundedPath<T extends THREE.Path>(path: T, loop: Pt[], radius: number, cx: number, cy: number): T {
  const n = loop.length
  const corner = (k: number) => {
    const v = loop[k], p = loop[(k - 1 + n) % n], q = loop[(k + 1) % n]
    const lp = Math.hypot(p[0] - v[0], p[1] - v[1]), lq = Math.hypot(q[0] - v[0], q[1] - v[1])
    const r = Math.min(radius, lp / 2, lq / 2)
    const a: Pt = [v[0] + ((p[0] - v[0]) / lp) * r, v[1] + ((p[1] - v[1]) / lp) * r]
    const b: Pt = [v[0] + ((q[0] - v[0]) / lq) * r, v[1] + ((q[1] - v[1]) / lq) * r]
    return { v, a, b }
  }
  const first = corner(0)
  path.moveTo(first.a[0] - cx, first.a[1] - cy)
  for (let k = 0; k < n; k++) {
    const c = k === 0 ? first : corner(k)
    if (k > 0) path.lineTo(c.a[0] - cx, c.a[1] - cy)
    path.quadraticCurveTo(c.v[0] - cx, c.v[1] - cy, c.b[0] - cx, c.b[1] - cy)
  }
  path.closePath()
  return path
}

/** Outer loops become shapes, courtyards their holes. */
export function roundedShapes(loops: Pt[][], radius: number, cx: number, cy: number): THREE.Shape[] {
  const outers = loops.filter((l) => signedArea(l) > 0)
  const holes = loops.filter((l) => signedArea(l) < 0)
  return outers.map((o) => {
    const shape = roundedPath(new THREE.Shape(), o, radius, cx, cy)
    for (const h of holes) if (inside(h[0], o) || inside([(h[0][0] + h[1][0]) / 2, (h[0][1] + h[1][1]) / 2], o)) shape.holes.push(roundedPath(new THREE.Path(), h, radius * 0.6, cx, cy))
    return shape
  })
}

/** The rectangles a level is made of: the footprint at and above grade, its own indoor spaces below. */
export function levelRects(level: Level, ground: Level | undefined, footprint: Rect[], spaces: Space[]): Rect[] {
  if (ground && level.index < ground.index) return spaces.filter((s) => !s.outdoor).map((s) => s.rect)
  return footprint
}

export const SLAB_GAP = 0.08
export const BEVEL = 0.04

/** One storey as a slab: depth leaves a hairline between floors so the storeys read. */
export function storeyGeometry(shapes: THREE.Shape[], height: number): THREE.ExtrudeGeometry {
  const depth = Math.max(0.2, height - SLAB_GAP - 2 * BEVEL)
  const g = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelSegments: 2, curveSegments: 5 })
  g.rotateX(-Math.PI / 2)
  g.translate(0, BEVEL + SLAB_GAP / 2, 0)
  return g
}

/** A thin rounded plate the same shape as the storey: what a level looks like with its walls cut away. */
export function plateGeometry(shapes: THREE.Shape[], thickness = 0.18): THREE.ExtrudeGeometry {
  const g = new THREE.ExtrudeGeometry(shapes, { depth: thickness, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.08, bevelSegments: 1, curveSegments: 5 })
  g.rotateX(-Math.PI / 2)
  g.translate(0, 0.06, 0)
  return g
}

/**
 * One bay of facade, drawn once and tiled (one bay = 3.2 m wide, one storey high): warm stone with faint
 * coursing, a darker spandrel band at the slab, a light frame and a tinted glass pane with a sky reflection.
 * `map` is the colour, `rough` the roughness (stone matte, glass glossy, so the sun and the sky glint off the
 * panes), `glow` the pane as a light mask for the windows of a lit floor at night.
 */
export function windowTextures(): { map: THREE.CanvasTexture; glow: THREE.CanvasTexture; rough: THREE.CanvasTexture } | null {
  if (typeof document === 'undefined') return null
  const S = 128
  const make = (paint: (g: CanvasRenderingContext2D) => void, srgb = true) => {
    const c = document.createElement('canvas')
    c.width = S
    c.height = S
    const g = c.getContext('2d')
    if (!g) return null
    paint(g)
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    return t
  }
  // the canvas's y runs down while the wall's v runs up: the spandrel sits at the bottom of the bay
  const frame = { x: 22, y: 14, w: 84, h: 82 }
  const glass = { x: 28, y: 20, w: 72, h: 70 }
  const map = make((g) => {
    g.fillStyle = '#d6cdbd'
    g.fillRect(0, 0, S, S)
    g.fillStyle = 'rgba(120, 104, 84, 0.08)'
    for (let y = 6; y < S; y += 12) g.fillRect(0, y, S, 1)
    g.fillStyle = '#b9ae9c'
    g.fillRect(0, S - 18, S, 18)
    g.fillStyle = '#ece8e1'
    g.fillRect(frame.x, frame.y, frame.w, frame.h)
    const sky = g.createLinearGradient(0, glass.y, 0, glass.y + glass.h)
    sky.addColorStop(0, '#8fa6bb')
    sky.addColorStop(0.55, '#4e6478')
    sky.addColorStop(1, '#34475a')
    g.fillStyle = sky
    g.fillRect(glass.x, glass.y, glass.w, glass.h)
    g.fillStyle = '#ece8e1'
    g.fillRect(glass.x + glass.w / 2 - 2, glass.y, 4, glass.h)
    g.fillStyle = 'rgba(255, 255, 255, 0.16)'
    g.beginPath()
    g.moveTo(glass.x, glass.y + 26)
    g.lineTo(glass.x + 30, glass.y)
    g.lineTo(glass.x + 44, glass.y)
    g.lineTo(glass.x, glass.y + 40)
    g.fill()
  })
  const rough = make((g) => {
    g.fillStyle = '#e6e6e6'
    g.fillRect(0, 0, S, S)
    g.fillStyle = '#7a7a7a'
    g.fillRect(frame.x, frame.y, frame.w, frame.h)
    g.fillStyle = '#1e1e1e'
    g.fillRect(glass.x, glass.y, glass.w, glass.h)
  }, false)
  const glow = make((g) => {
    g.fillStyle = '#000000'
    g.fillRect(0, 0, S, S)
    const warm = g.createLinearGradient(0, glass.y, 0, glass.y + glass.h)
    warm.addColorStop(0, '#fff3d6')
    warm.addColorStop(1, '#ffd08a')
    g.fillStyle = warm
    g.fillRect(glass.x, glass.y, glass.w, glass.h)
  })
  return map && glow && rough ? { map, glow, rough } : null
}

/** A soft shadow in the shape of the footprint, blurred once on a canvas: Apple Maps' contact shadow without a shadow map. */
export function shadowTexture(rects: Rect[], bounds: { x0: number; y0: number; x1: number; y1: number }): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  const scale = 4
  c.width = Math.ceil((bounds.x1 - bounds.x0) * scale)
  c.height = Math.ceil((bounds.y1 - bounds.y0) * scale)
  const g = c.getContext('2d')
  if (!g) return null
  g.filter = 'blur(18px)'
  g.fillStyle = 'rgba(70, 70, 140, 0.55)'
  for (const r of rects) g.fillRect((r.x0 - bounds.x0) * scale, (bounds.y1 - r.y1) * scale, (r.x1 - r.x0) * scale, (r.y1 - r.y0) * scale)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
