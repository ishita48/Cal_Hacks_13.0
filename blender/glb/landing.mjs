// The landing page's cuts of the dashboard GLBs (frontend/src/landing/Scene3D.tsx):
//   frontend/public/landing/landing_exterior.glb   the shell: geometry, node names, extras, material names
//   frontend/public/landing/landing_equipment.glb  only the eq_* nodes of the interior
// Scene3D replaces every material with its own palette (chosen by material name), so textures, UVs and
// tangents are dead weight: 7.7 MB becomes 1.4 MB (0.4 MB gzipped). Run after compress_glbs.py:
//   cd blender/glb && npm install && node landing.mjs
import { NodeIO, PropertyType } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, meshopt, prune } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODELS = path.join(ROOT, 'frontend', 'public', 'models')
const OUT = path.join(ROOT, 'frontend', 'public', 'landing')

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready])
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })

async function lite(src, dst, keepPrefix) {
  const doc = await io.read(path.join(MODELS, src))
  const root = doc.getRoot()
  for (const t of root.listTextures()) t.dispose()
  for (const m of root.listMaterials()) for (const e of m.listExtensions()) e.dispose()
  for (const mesh of root.listMeshes())
    for (const p of mesh.listPrimitives()) for (const a of p.listSemantics()) if (/^(TEXCOORD|TANGENT)/.test(a)) p.setAttribute(a, null)
  if (keepPrefix) {
    const kept = (n) => { for (let p = n; p; p = p.getParentNode()) if (p.getName().startsWith(keepPrefix)) return true; return false }
    const leads = (n) => kept(n) || n.listChildren().some(leads)
    for (const n of root.listNodes()) if (!leads(n)) n.dispose()
  }
  // Materials stay distinct even when they now look identical: the landing colours them by name.
  await doc.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH] }), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }))
  await io.write(path.join(OUT, dst), doc)
  console.log(`${dst}: ${root.listNodes().length} nodes, ${root.listMaterials().length} materials`)
}

await lite('blackwell.glb', 'landing_exterior.glb')
await lite('blackwell_interior.glb', 'landing_equipment.glb', 'eq_')
