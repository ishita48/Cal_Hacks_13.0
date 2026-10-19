import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initTheme } from './lib/theme'

// Each page is its own chunk, so the landing page does not download the command centre and vice versa.
const App = lazy(() => import('./App.tsx'))
const Phone = lazy(() => import('./components/Phone.tsx').then((m) => ({ default: m.Phone })))
const Story = lazy(() => import('./story/Story.tsx').then((m) => ({ default: m.Story })))
const Landing = lazy(() => import('./landing/Landing.tsx'))
// Clerk is its own chunk too, fetched only when a key is set and a guarded page is opened.
const Auth = lazy(() => import('./auth.tsx'))

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

initTheme()

const page = phone ? <Phone /> : story ? <Story /> : landing ? <Landing /> : <App />
const guarded = clerkKey && !story && !landing

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>{guarded ? <Auth publishableKey={clerkKey}>{page}</Auth> : page}</Suspense>
  </StrictMode>,
)
