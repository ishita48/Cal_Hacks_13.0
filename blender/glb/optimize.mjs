// Web pass over the dashboard GLBs, after compress_glbs.py (cd blender/glb && npm install && node optimize.mjs):
//  - every file: a texture of one flat colour (about a quarter of them) is shrunk to 4x4. It draws the same and
//    stops costing 5.6 MB of GPU memory and an upload each;
//  - blackwell_site.glb only (scenery the frontend shows or hides whole, by no name): detail maps at 512, the
//    40k-triangle street tree simplified within a 1 % error, repeated meshes GPU-instanced, the rest flattened and
//    joined per material: 489 -> 66 draw calls, 4.2 -> 1.6 M triangles.
// The building, interior and furniture keep every node, name and extra (win_<space_id>, eq_<id>, level_index).
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, flatten, instance, join, meshopt, prune, simplifyPrimitive, weld } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const MODELS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'public', 'models')
const FILES = ['blackwell.glb', 'blackwell_interior.glb', 'blackwell_furniture.glb', 'blackwell_site.glb']
const SCENERY = new Set(['blackwell_site.glb'])

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready])
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })

async function reencode(t, w, h, opts) {
  t.setImage(await sharp(t.getImage()).resize(w, h).webp(opts).toBuffer())
  t.setMimeType('image/webp')
}

for (const name of FILES) {
  const file = path.join(MODELS, name)
  const doc = await io.read(file)
  const root = doc.getRoot()
  let flat = 0
  for (const t of root.listTextures()) {
    const [w] = t.getSize() ?? [0]
    if (!t.getImage() || w <= 4) continue
    const { channels } = await sharp(t.getImage()).stats()
    if (channels.every((c) => c.stdev < 1)) { await reencode(t, 4, 4, { lossless: true }); flat++ }
  }
  if (SCENERY.has(name)) {
    const detail = new Set()
    for (const m of root.listMaterials()) for (const t of [m.getNormalTexture(), m.getMetallicRoughnessTexture(), m.getOcclusionTexture()]) if (t) detail.add(t)
    for (const t of detail) { const [w, h] = t.getSize() ?? [0, 0]; if (w > 512 || h > 512) await reencode(t, Math.min(w, 512), Math.min(h, 512), { quality: 88 }) }
    for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives())
      if ((p.getIndices()?.getCount() ?? 0) / 3 > 8000) simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: 0.2, error: 0.01, lockBorder: false })
    await doc.transform(weld(), instance({ min: 2 }), flatten(), join({ keepNamed: false }))
  }
  await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }))
  await io.write(file, doc)
  console.log(`${name}: ${flat} flat textures shrunk${SCENERY.has(name) ? ', scenery instanced and joined' : ''}`)
}
