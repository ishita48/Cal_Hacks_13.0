import { api } from './api'

/**
 * Approve & dispatch, at most once per plan version. The idempotency key is the run and the plan version the
 * person saw: the backend refuses a version that is no longer on the table (409), and this refuses to send the
 * same version twice, whether from a double click, a second card, or a second tab in this browser session.
 */
export type ApproveResult = 'sent' | 'already'

const inFlight = new Map<string, Promise<ApproveResult>>()
const KEY = (runId: string, version: number) => `haven.approved.${runId}.v${version}`

function sent(key: string) {
  try {
    return sessionStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function approveOnce(runId: string, version: number, approvedVersion: number | null, actor = 'manager'): Promise<ApproveResult> {
  const key = KEY(runId, version)
  if (approvedVersion === version || sent(key)) return Promise.resolve('already')
  const pending = inFlight.get(key)
  if (pending) return pending
  const p = api
    .decidePlan(version, 'approve', actor)
    .then(() => {
      try {
        sessionStorage.setItem(key, '1')
      } catch {
        /* the in-flight guard still holds for this page */
      }
      return 'sent' as const
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}
