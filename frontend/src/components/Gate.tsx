import { SignIn } from '@clerk/clerk-react'
import { useEffect } from 'react'
import { useBuilding } from '../state/building'

/**
 * The door to the command centre when sign-in is on: the building's name, one line on what is inside,
 * and Clerk's sign-in card. Rendered only when VITE_CLERK_PUBLISHABLE_KEY is set and nobody is signed in.
 */
export function Gate() {
  const load = useBuilding((b) => b.load)
  const spec = useBuilding((b) => b.spec)
  useEffect(() => {
    load().catch(() => {})
  }, [load])
  return (
    <div className="app-shell flex min-h-screen items-center justify-center p-6">
      <div className="grid w-full max-w-[920px] gap-6 md:grid-cols-[1.1fr_1fr] md:items-center">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-black/[0.06] bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_24px_-8px_rgba(15,98,254,0.45)] dark:border-white/10 dark:bg-white/[0.06]">
              <span className="h-3 w-3 rounded-full bg-haven-blue" style={{ boxShadow: '0 0 0 4px rgba(15,98,254,0.18)' }} />
            </span>
            <span>
              <span className="block text-[15px] font-semibold tracking-[0.14em] text-t1">HAVEN</span>
              <span className="argus-eyebrow block">{spec?.name ?? 'command centre'}</span>
            </span>
          </div>
          <h1 className="mt-6 text-[30px] leading-tight font-semibold text-t1">A building fails as one system. The response shouldn’t come from four teams.</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-t2">
            Sign in to the command centre: the building’s energy and plant on an ordinary night, the resilience audit, and, when a sensor fires, the agents’ plan for every resident with a human gate before anything moves.
          </p>
          <a href="/story" className="mt-4 inline-block text-[13px] text-haven-blue hover:underline">
            Read how it works first
          </a>
        </div>
        <div className="flex justify-center">
          <SignIn routing="hash" />
        </div>
      </div>
    </div>
  )
}
