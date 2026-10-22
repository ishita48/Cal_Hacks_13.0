import { ClerkProvider, SignedIn, SignedOut, UserButton, useAuth } from '@clerk/clerk-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Gate } from './components/Gate.tsx'
import { setTokenGetter } from './lib/api'
import { useMe } from './state/me'

/**
 * Clerk, loaded only when a publishable key is set. Guarded pages (the workspace, the command centre, the phones)
 * show the sign-in gate to anyone signed out; an `optional` page (the story) renders for everyone and only
 * carries the session when there is one.
 */
export default function Auth({ publishableKey, optional, children }: { publishableKey: string; optional?: boolean; children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/" signInFallbackRedirectUrl="/app" signUpFallbackRedirectUrl="/app">
      <SignedIn>
        <Session>{children}</Session>
      </SignedIn>
      <SignedOut>{optional ? children : <Gate />}</SignedOut>
    </ClerkProvider>
  )
}

/** Hands the session token to every API call before the app renders, so the server can decide the role. */
function Session({ children }: { children: ReactNode }) {
  const { getToken } = useAuth()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setTokenGetter(() => getToken())
    useMe.setState({ AccountButton: UserButton })
    setReady(true)
    void useMe.getState().load()
    return () => {
      setTokenGetter(null)
      useMe.setState({ AccountButton: null, me: null })
    }
  }, [getToken])
  return ready ? children : null
}
