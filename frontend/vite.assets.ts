import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { Plugin } from 'vite'

/**
 * The heavy public files (the GLBs, the HDRI, the landing renders) are not fingerprinted by Vite, so they were
 * served `no-cache` and revalidated on every visit. This plugin:
 *  - hashes every file under public/{models,landing,env} and hands the app `__HEAVY_ASSETS__`, so
 *    `heavy('/models/x.glb')` returns `/models/x.glb?v=<hash>`: a new file is a new URL, and the old one can be
 *    cached forever (vercel.json, preview);
 *  - at build, writes `x.glb.gz` beside each GLB. meshopt geometry is built to be gzipped (a GLB shrinks to
 *    30-70 %), but CDNs only compress text types, so the app asks for the `.gz` and the host answers with
 *    `Content-Encoding: gzip`; the browser inflates it before the loader sees a byte.
 */
const DIRS = ['models', 'landing', 'env']
const GZ = /\.glb$/

function walk(dir: string, base: string, out: Record<string, string>) {
  if (!fs.existsSync(dir)) return
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, `${base}/${name}`, out)
    else if (!name.endsWith('.gz')) out[`${base}/${name}`] = createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 10)
  }
}

export function heavyAssets(): Plugin {
  let outDir = 'dist'
  return {
    name: 'haven-heavy-assets',
    config(cfg, { command }) {
      const pub = path.resolve(cfg.root ?? process.cwd(), 'public')
      const versions: Record<string, string> = {}
      for (const d of DIRS) walk(path.join(pub, d), `/${d}`, versions)
      return { define: { __HEAVY_ASSETS__: JSON.stringify({ versions, gz: command === 'build' }) } }
    },
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir)
    },
    closeBundle() {
      for (const d of DIRS) {
        const dir = path.join(outDir, d)
        if (!fs.existsSync(dir)) continue
        for (const name of fs.readdirSync(dir)) {
          if (!GZ.test(name)) continue
          const file = path.join(dir, name)
          fs.writeFileSync(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file), { level: 9 }))
        }
      }
    },
    // `vite preview` behaves like the deployed host: .gz served with Content-Encoding, versioned and hashed
    // files cached for a year.
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const versioned = url.searchParams.has('v') || url.pathname.startsWith('/assets/')
        if (versioned) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          const set = res.setHeader.bind(res)
          res.setHeader = (k: string, v: number | string | readonly string[]) => (k.toLowerCase() === 'cache-control' ? res : set(k, v))
        }
        if (url.pathname.endsWith('.glb.gz')) {
          const file = path.join(outDir, decodeURIComponent(url.pathname))
          if (!fs.existsSync(file)) return next()
          res.setHeader('Content-Type', 'model/gltf-binary')
          res.setHeader('Content-Encoding', 'gzip')
          res.setHeader('Content-Length', fs.statSync(file).size)
          fs.createReadStream(file).pipe(res)
          return
        }
        next()
      })
    },
  }
}
