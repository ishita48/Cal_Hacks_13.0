import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initTheme } from './lib/theme'
import { workspaceFromPath } from './roles/workspaces'

// Each page is its own chunk, so the landing page does not download the command centre and vice versa.
const Portal = lazy(() => import('./portal/Portal.tsx'))
const Command = lazy(() => import('./App.tsx'))
const Phone = lazy(() => import('./components/Phone.tsx').then((m) => ({ default: m.Phone })))
const Story = lazy(() => import('./story/Story.tsx').then((m) => ({ default: m.Story })))
const Landing = lazy(() => import('./landing/Landing.tsx'))
const Picker = lazy(() => import('./roles/Picker.tsx'))
const Student = lazy(() => import('./student/Student.tsx'))
const Stub = lazy(() => import('./roles/Stub.tsx'))
const RA = lazy(() => import('./ra/RA.tsx'))
const Maintenance = lazy(() => import('./maintenance/Maintenance.tsx'))
const Security = lazy(() => import('./security/Security.tsx'))
// Clerk is its own chunk too, fetched only when a key is set and a guarded page is opened.
const Auth = lazy(() => import('./auth.tsx'))

// / is the landing page, /app the workspace picker everyone lands on after sign-in, /app/<role> that role's
// workspace (student, ra, maintenance and security are built; admin is a stub that opens the command centre; /app/workspace is the multi-role workspace),
// /command the admin's command centre (the live simulation, the agents and approval), /phone the responder's
// phone, /story the story page.
// The backend enforces who may use each; these routes only choose what to load.
const path = location.pathname.replace(/\/+$/, '')
const phone = path === '/phone' || location.hash === '#phone'
const story = path === '/story' || location.hash === '#story'
const command = path === '/command' || location.hash === '#command'
const app = path === '/app' || path.startsWith('/app/') || location.hash === '#app'
const landing = !phone && !story && !app && !command

// Sign-in is optional and key-gated like every other integration: with VITE_CLERK_PUBLISHABLE_KEY set,
// the workspace, the command centre and the phones sit behind Clerk and the landing and story pages stay public;
// without it the demo runs open, as it always has.
const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

initTheme()

const ws = workspaceFromPath(path)
const appPage = path === '/app/workspace' ? <Portal /> : ws?.slug === 'student' ? <Student /> : ws?.slug === 'ra' ? <RA /> : ws?.slug === 'maintenance' ? <Maintenance /> : ws?.slug === 'security' ? <Security /> : ws ? <Stub ws={ws} /> : <Picker />
const page = phone ? <Phone /> : story ? <Story /> : command ? <Command /> : landing ? <Landing /> : appPage
const guarded = clerkKey && !story && !landing
// The story page is public, but a signed-in admin's session rides along so the live parts can load.
const wrapped = guarded ? <Auth publishableKey={clerkKey}>{page}</Auth> : clerkKey && story ? <Auth publishableKey={clerkKey} optional>{page}</Auth> : page

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>{wrapped}</Suspense>
  </StrictMode>,
)
