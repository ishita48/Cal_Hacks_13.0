import { ClerkProvider, SignedIn, SignedOut, UserButton, useAuth } from '@clerk/clerk-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Gate } from './components/Gate.tsx'
import { setTokenGetter } from './lib/api'
import { useMe } from './state/me'

/** Clerk, loaded only when a publishable key is set: the command centre and the phones sit behind it. */
export default function Auth({ publishableKey, children }: { publishableKey: string; children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
      <SignedIn>
        <Session>{children}</Session>
      </SignedIn>
      <SignedOut>
        <Gate />
      </SignedOut>
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
