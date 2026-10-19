import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider, SignedIn, SignedOut } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import { Phone } from './components/Phone.tsx'
import { Gate } from './components/Gate.tsx'
import { Story } from './story/Story.tsx'

// The manager's phone view lives at /phone (or #phone), the story page at /story (or #story);
// everything else is the command centre.
const path = location.pathname.replace(/\/+$/, '')
const phone = path === '/phone' || location.hash === '#phone'
const story = path === '/story' || location.hash === '#story'

// Sign-in is optional and key-gated like every other integration: with VITE_CLERK_PUBLISHABLE_KEY set,
// the command centre and the phones sit behind Clerk and the story page stays public; without it the
// demo runs open, as it always has.
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

const page = phone ? <Phone /> : story ? <Story /> : <App />
const tree = story ? page : <Guarded>{page}</Guarded>

createRoot(document.getElementById('root')!).render(
  <StrictMode>{clerkKey ? <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/story">{tree}</ClerkProvider> : tree}</StrictMode>,
)
