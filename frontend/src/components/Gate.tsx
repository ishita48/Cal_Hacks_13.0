import { SignIn } from '@clerk/clerk-react'
import '../story/story.css'

/**
 * The door to the command centre when sign-in is on, in the story page's language (paper, ink, one blue):
 * the same nav pill, the same headline voice, and Clerk's sign-in card dressed to match. Rendered only when
 * VITE_CLERK_PUBLISHABLE_KEY is set and nobody is signed in. It fetches nothing: the API answers only after
 * sign-in, so the page cannot depend on it.
 */
const appearance = {
  variables: {
    colorPrimary: '#0f62fe',
    colorText: '#101114',
    colorTextSecondary: '#6b7079',
    colorBackground: '#ffffff',
    colorInputBackground: '#ffffff',
    colorInputText: '#101114',
    borderRadius: '14px',
    fontFamily: '"Geist", ui-sans-serif, system-ui, -apple-system, sans-serif',
  },
  elements: {
    cardBox: { boxShadow: '0 4px 10px rgba(16,17,20,.05), 0 30px 60px -20px rgba(0,29,108,.28)', border: '1px solid #e3e6ea' },
    formButtonPrimary: { borderRadius: '999px', boxShadow: '0 12px 40px -12px rgba(15,98,254,.55)' },
  },
}

export function Gate() {
  return (
    <div className="argus argus-page">
      <header className="nav">
        <div className="nav__shell lp-glass">
          <a href="/" className="nav__brand">
            <i aria-hidden="true" />
            HAVEN
          </a>
          <nav className="nav__links" aria-label="Primary">
            <a href="/story">How it works</a>
          </nav>
          <a href="/story" className="btn nav__cta">
            Read the story
          </a>
        </div>
      </header>
      <main className="hero" style={{ minHeight: 'calc(100svh - 72px)' }}>
        <div className="hero__grid" aria-hidden="true" />
        <div className="container hero__inner" style={{ display: 'grid', gap: 'clamp(32px, 5vw, 72px)', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', alignItems: 'center' }}>
          <div>
            <p className="eyebrow">
              <i>●</i> Command centre <b /> sign in
            </p>
            <h1 className="h2" style={{ marginTop: 22 }}>
              One building.
              <br />
              One response.
            </h1>
            <p className="serif" style={{ marginTop: 14, fontSize: 'clamp(1.5rem, 2.6vw, 2.4rem)', lineHeight: 1.05, color: 'var(--ink-2)' }}>
              Everyone sees what is theirs to see.
            </p>
            <p className="lead" style={{ marginTop: 26 }}>
              Residents, RAs, maintenance and housing staff sign in to the same live building. Your role decides what you see:
              your alerts, your contacts, and a plan with a human gate before anything moves.
            </p>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <SignIn routing="hash" appearance={appearance} />
          </div>
        </div>
      </main>
    </div>
  )
}
