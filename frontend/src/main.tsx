import { StrictMode, Suspense, lazy, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider, SignedIn, SignedOut } from '@clerk/clerk-react'
import './index.css'
import { Gate } from './components/Gate.tsx'

// Each page is its own chunk, so the landing page does not download the command centre and vice versa.
const App = lazy(() => import('./App.tsx'))
const Phone = lazy(() => import('./components/Phone.tsx').then((m) => ({ default: m.Phone })))
const Story = lazy(() => import('./story/Story.tsx').then((m) => ({ default: m.Story })))
const Landing = lazy(() => import('./landing/Landing.tsx'))

// / is the landing page, the command centre lives at /app (or #app), the manager's phone view at
// /phone (or #phone), the story page at /story (or #story).
const path = location.pathname.replace(/\/+$/, '')
const phone = path === '/phone' || location.hash === '#phone'
const story = path === '/story' || location.hash === '#story'
const app = path === '/app' || location.hash === '#app'
const landing = !phone && !story && !app

// Sign-in is optional and key-gated like every other integration: with VITE_CLERK_PUBLISHABLE_KEY set,
// the command centre and the phones sit behind Clerk and the landing and story pages stay public;
// without it the demo runs open, as it always has.
const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

function Guarded({ children }: { children: ReactNode }) {
  if (!clerkKey) return <>{children}</>
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <Gate />
      </SignedOut>
    </>
  )
}

const page = phone ? <Phone /> : story ? <Story /> : landing ? <Landing /> : <App />
const tree = <Suspense fallback={null}>{story || landing ? page : <Guarded>{page}</Guarded>}</Suspense>

createRoot(document.getElementById('root')!).render(
  <StrictMode>{clerkKey ? <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/">{tree}</ClerkProvider> : tree}</StrictMode>,
)
