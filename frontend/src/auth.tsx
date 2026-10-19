import { ClerkProvider, SignedIn, SignedOut } from '@clerk/clerk-react'
import type { ReactNode } from 'react'
import { Gate } from './components/Gate.tsx'

/** Clerk, loaded only when a publishable key is set: the command centre and the phones sit behind it. */
export default function Auth({ publishableKey, children }: { publishableKey: string; children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <Gate />
      </SignedOut>
    </ClerkProvider>
  )
}
