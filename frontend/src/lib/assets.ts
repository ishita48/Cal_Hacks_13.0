// Set by vite.assets.ts: a content hash per heavy public file, and whether the build wrote gzipped GLBs.
declare const __HEAVY_ASSETS__: { versions: Record<string, string>; gz: boolean } | undefined

const HEAVY = typeof __HEAVY_ASSETS__ !== 'undefined' ? __HEAVY_ASSETS__ : { versions: {}, gz: false }

/**
 * The URL to fetch a heavy public file by: versioned by its content (so it can be cached forever) and, in a
 * production build, the precompressed `.glb.gz` the host serves with `Content-Encoding: gzip`.
 */
export function heavy(path: string): string {
  const v = HEAVY.versions[path]
  if (!v) return path
  return `${HEAVY.gz && path.endsWith('.glb') ? `${path}.gz` : path}?v=${v}`
}
