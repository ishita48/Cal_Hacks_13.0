import Lenis from 'lenis'
import {
  Accessibility, ArrowRight, ArrowUpRight, BellRing, Building2, Check, Droplets, HeartHandshake, Mic, Phone,
  ShieldCheck, Sparkles, Waves, Zap, ArrowDown, UserRound, Radio, CircleDot,
} from 'lucide-react'
import {
  AnimatePresence, motion, useInView, useMotionValue, useMotionValueEvent, useReducedMotion, useScroll, useSpring,
  useTransform, type MotionValue,
} from 'motion/react'
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { heavy } from '../lib/assets'
import { CountUp, EASE, Glass, Magnetic, Reveal, ScrubText, SplitWords } from './parts'
import { CHAPTER_COUNT, clamp01, dwell, moods, pointer, prefersReducedMotion, storyT, tags } from './progress'
import './landing.css'

const Scene3D = lazy(() => import('./Scene3D'))

/**
 * The public landing page. One night in one building, told in six chapters: calm, a leak, the ripple,
 * the person it matters to, the plan, and the people who say yes. The command centre lives at /app,
 * the phone at /phone, the long read at /story.
 */

const APP_URL = '/app'

type Tone = 'blue' | 'water' | 'coral' | 'lavender' | 'mint' | 'peach'
interface Chapter {
  key: string
  label: string
  tone: Tone
  kicker: string
  title: string
  body: string
  chips: { icon: ReactNode; text: string; tone?: Tone }[]
}

const CHAPTERS: Chapter[] = [
  {
    key: 'calm', label: 'Calm', tone: 'blue', kicker: 'Tuesday, 11:41 pm',
    title: 'A quiet night at home.',
    body: '250 people live here. Most are asleep. The building hums along, the way it always does.',
    chips: [{ icon: <ShieldCheck size={14} />, text: 'All systems normal', tone: 'mint' }, { icon: <UserRound size={14} />, text: '214 people home' }],
  },
  {
    key: 'leak', label: 'Leak', tone: 'water', kicker: 'Then, without a sound',
    title: 'A pipe gives way.',
    body: 'Deep in the basement, water starts to rise. Nobody is awake to notice. HAVEN is.',
    chips: [{ icon: <Droplets size={14} />, text: 'Leak found in 4 seconds', tone: 'water' }, { icon: <Radio size={14} />, text: 'Basement sensor' }],
  },
  {
    key: 'ripple', label: 'Ripple', tone: 'coral', kicker: 'One problem becomes many',
    title: 'Everything is connected.',
    body: 'In twelve minutes the water reaches the power. The lifts would stop. Two floors would go dark.',
    chips: [{ icon: <Zap size={14} />, text: 'Power at risk in 12 min', tone: 'coral' }, { icon: <Building2 size={14} />, text: 'Lifts and floors 3–4', tone: 'peach' }],
  },
  {
    key: 'people', label: 'People', tone: 'lavender', kicker: 'Behind every window, someone',
    title: 'Maya can’t take the stairs.',
    body: 'She lives on the fourth floor and uses a wheelchair. Her own agent speaks up for her, so she is never an afterthought.',
    chips: [{ icon: <Accessibility size={14} />, text: 'Needs the lift', tone: 'lavender' }, { icon: <Sparkles size={14} />, text: 'Her agent is on' }],
  },
  {
    key: 'plan', label: 'Plan', tone: 'mint', kicker: 'In seconds, not minutes',
    title: 'HAVEN drafts the plan.',
    body: 'Close the valve. Bring Maya down while the lifts still run. Tell everyone else only what they need to know.',
    chips: [{ icon: <Waves size={14} />, text: 'Shut the water off', tone: 'water' }, { icon: <HeartHandshake size={14} />, text: 'Maya first, by lift', tone: 'mint' }],
  },
  {
    key: 'together', label: 'Together', tone: 'blue', kicker: 'You stay in charge',
    title: 'You say yes. Everyone moves.',
    body: 'Nothing happens until a person approves. One tap, and every resident, RA and plumber knows their part.',
    chips: [{ icon: <Check size={14} />, text: 'Approved by you', tone: 'mint' }, { icon: <HeartHandshake size={14} />, text: 'Nobody left behind', tone: 'lavender' }],
  },
]

// ---- shell ---------------------------------------------------------------------------------------

class CanvasBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export default function Landing() {
  const reduce = useReducedMotion()
  const lenis = useRef<Lenis | null>(null)
  const heroRef = useRef<HTMLElement>(null)
  const storyRef = useRef<HTMLElement>(null)
  const [ready, setReady] = useState(false)
  const [active, setActive] = useState(true)
  const gl = useMemo(webglAvailable, [])
  const px = useMotionValue(0)
  const py = useMotionValue(0)

  useEffect(() => {
    document.documentElement.classList.add('lp-html')
    document.title = 'HAVEN · Nobody gets left behind'
    return () => document.documentElement.classList.remove('lp-html')
  }, [])

  useEffect(() => {
    if (prefersReducedMotion()) return
    const l = new Lenis({ autoRaf: true, lerp: 0.085, wheelMultiplier: 0.95 })
    lenis.current = l
    return () => { l.destroy(); lenis.current = null }
  }, [])

  useEffect(() => {
    const move = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1
      px.set(pointer.x)
      py.set(pointer.y)
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => window.removeEventListener('pointermove', move)
  }, [px, py])

  const { scrollYProgress: heroOut } = useScroll({ target: heroRef, offset: ['start start', 'end start'] })
  const { scrollYProgress: storyP } = useScroll({ target: storyRef, offset: ['start start', 'end end'] })
  const { scrollYProgress: storyExit } = useScroll({ target: storyRef, offset: ['end end', 'end start'] })
  const chapter = useTransform(storyP, (p) => dwell(p * (CHAPTER_COUNT - 1)))

  const sync = useCallback(() => {
    const p = storyP.get()
    storyT.set(p > 0 ? dwell(p * (CHAPTER_COUNT - 1)) : heroOut.get() - 1)
  }, [storyP, heroOut])
  useMotionValueEvent(storyP, 'change', sync)
  useMotionValueEvent(heroOut, 'change', sync)
  useEffect(sync, [sync])

  const canvasOpacity = useTransform(storyExit, [0, 0.55], [1, 0])
  useMotionValueEvent(canvasOpacity, 'change', (v) => setActive(v > 0.01))

  const go = useCallback((id: string) => (e: React.MouseEvent) => {
    const el = document.getElementById(id)
    if (!el) return
    e.preventDefault()
    if (lenis.current) lenis.current.scrollTo(el, { offset: 0, duration: 1.6 })
    else el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' })
  }, [reduce])

  return (
    <div className="lp">
      <a className="lp-skip" href="#main">Skip to content</a>
      <Backdrop />
      <motion.div className={`lp-canvas ${ready ? 'is-ready' : ''}`} style={{ opacity: canvasOpacity }} aria-hidden="true">
        {gl ? (
          <CanvasBoundary fallback={<StillBuilding />}>
            <Suspense fallback={null}>
              <Scene3D active={active} onReady={() => setReady(true)} />
            </Suspense>
          </CanvasBoundary>
        ) : (
          <StillBuilding />
        )}
        {gl && <PersonTag />}
      </motion.div>
      {gl && !ready && <Loader />}

      <Nav go={go} />

      <main id="main">
        <Hero refEl={heroRef} progress={heroOut} px={px} py={py} go={go} />
        <Story refEl={storyRef} chapter={chapter} />
        <Principle />
        <Bento />
        <Teams />
        <Finale />
      </main>
      <Footer />
    </div>
  )
}

/** Maya's label rides over her window; the 3D scene moves it, the story picks its words. */
function PersonTag() {
  const [safe, setSafe] = useState(false)
  useMotionValueEvent(storyT, 'change', (t) => setSafe(moods(t).protect > 0.5))
  return (
    <div ref={(el) => { tags.person = el }} className={`lp-tag ${safe ? 'is-safe' : ''}`} style={{ opacity: 0 }}>
      <span className="lp-tag__in">
        <Accessibility size={14} />
        <b>Maya</b>
        <span>{safe ? 'on her way down, by lift' : 'floor 4 · needs the lift'}</span>
      </span>
    </div>
  )
}

function StillBuilding() {
  return <div className="lp-still" style={{ backgroundImage: `url(${heavy('/landing/aerial.webp')})` }} />
}

function Loader() {
  return (
    <div className="lp-loader" role="status" aria-live="polite">
      <span className="lp-loader__orb" />
      <span>Building your building…</span>
    </div>
  )
}

/** The living gradient behind everything; its mood follows the story. */
function Backdrop() {
  const danger = useTransform(storyT, (t) => moods(t).danger)
  const water = useTransform(storyT, (t) => moods(t).leak * 0.8)
  const safe = useTransform(storyT, (t) => Math.max(moods(t).protect * 0.9, moods(t).together))
  const person = useTransform(storyT, (t) => moods(t).person * (1 - moods(t).protect) * 0.9)
  return (
    <div className="lp-backdrop" aria-hidden="true">
      <div className="lp-blob lp-blob--blue" />
      <div className="lp-blob lp-blob--lavender" />
      <div className="lp-blob lp-blob--mint" />
      <div className="lp-blob lp-blob--peach" />
      <motion.div className="lp-mood lp-mood--water" style={{ opacity: water }} />
      <motion.div className="lp-mood lp-mood--danger" style={{ opacity: danger }} />
      <motion.div className="lp-mood lp-mood--person" style={{ opacity: person }} />
      <motion.div className="lp-mood lp-mood--safe" style={{ opacity: safe }} />
      <div className="lp-grain" />
    </div>
  )
}

function Logo() {
  return (
    <span className="lp-logo">
      <span className="lp-logo__mark"><ShieldCheck size={16} strokeWidth={2.4} /></span>
      HAVEN
    </span>
  )
}

function Nav({ go }: { go: (id: string) => (e: React.MouseEvent) => void }) {
  const { scrollY } = useScroll()
  const [solid, setSolid] = useState(false)
  useMotionValueEvent(scrollY, 'change', (v) => setSolid(v > 40))
  return (
    <motion.header className={`lp-nav ${solid ? 'is-solid' : ''}`} initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.9, ease: EASE, delay: 0.2 }}>
      <a href="#top" onClick={go('top')} aria-label="HAVEN, back to top"><Logo /></a>
      <nav aria-label="Sections" className="lp-nav__links">
        <a href="#story" onClick={go('story')}>The story</a>
        <a href="#features" onClick={go('features')}>What it does</a>
        <a href="#teams" onClick={go('teams')}>Who it’s for</a>
        <a href="/story">Deep dive</a>
      </nav>
      <Magnetic href={APP_URL} className="lp-btn--primary lp-btn--sm">Open HAVEN <ArrowUpRight size={15} /></Magnetic>
    </motion.header>
  )
}

// ---- hero ----------------------------------------------------------------------------------------

function FloatChip({ children, x, y, depth, className = '', delay = 0, px, py }: { children: ReactNode; x: string; y: string; depth: number; className?: string; delay?: number; px: MotionValue<number>; py: MotionValue<number> }) {
  const sx = useSpring(useTransform(px, (v) => v * depth), { stiffness: 60, damping: 18 })
  const sy = useSpring(useTransform(py, (v) => v * depth), { stiffness: 60, damping: 18 })
  return (
    <motion.div className="lp-float" style={{ left: x, top: y, x: sx, y: sy }} initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1, ease: EASE, delay }}>
      <Glass iri={false} className={`lp-chip lp-chip--float ${className}`} style={{ animationDelay: `${delay * -2}s` }}>{children}</Glass>
    </motion.div>
  )
}

function Hero({ refEl, progress, px, py, go }: { refEl: React.RefObject<HTMLElement | null>; progress: MotionValue<number>; px: MotionValue<number>; py: MotionValue<number>; go: (id: string) => (e: React.MouseEvent) => void }) {
  const y = useTransform(progress, [0, 1], ['0%', '-22%'])
  const opacity = useTransform(progress, [0, 0.7], [1, 0])
  const chipsOpacity = useTransform(progress, [0, 0.45], [1, 0])
  return (
    <section ref={refEl} id="top" className="lp-hero" aria-labelledby="hero-title">
      <motion.div className="lp-hero__copy" style={{ y, opacity }}>
        <motion.p className="lp-pill" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: EASE, delay: 0.1 }}>
          <span className="lp-dot" /> Watching over Blackwell Hall tonight
        </motion.p>
        <h1 id="hero-title" className="lp-display">
          <SplitWords text="When the building breaks, nobody gets left behind." accent={['nobody', 'left', 'behind']} delay={0.25} />
        </h1>
        <motion.p className="lp-lede" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, ease: EASE, delay: 0.95 }}>
          HAVEN keeps watch over your building, sees trouble before it spreads, and helps your team look after every single resident.
        </motion.p>
        <motion.div className="lp-ctas" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, ease: EASE, delay: 1.1 }}>
          <Magnetic href={APP_URL} className="lp-btn--primary">Open HAVEN <ArrowRight size={17} /></Magnetic>
          <Magnetic href="#story" onClick={go('story')} className="lp-btn--ghost">See one night <ArrowDown size={16} /></Magnetic>
        </motion.div>
      </motion.div>

      <motion.div className="lp-hero__chips" style={{ opacity: chipsOpacity }} aria-hidden="true">
        <FloatChip x="58%" y="20%" depth={-14} delay={1.3} px={px} py={py}><span className="lp-dot lp-dot--mint" /> Water sensor · dry</FloatChip>
        <FloatChip x="83%" y="34%" depth={22} delay={1.45} px={px} py={py}><Building2 size={14} /> Lifts running</FloatChip>
        <FloatChip x="62%" y="72%" depth={18} delay={1.6} px={px} py={py} className="lp-chip--lav"><Accessibility size={14} /> Maya · asleep, floor 4</FloatChip>
        <FloatChip x="86%" y="66%" depth={-20} delay={1.75} px={px} py={py}><BellRing size={14} /> Next check in 15 s</FloatChip>
      </motion.div>

      <motion.a href="#story" onClick={go('story')} className="lp-scrollhint" style={{ opacity }} aria-label="Scroll to the story">
        <span className="lp-scrollhint__mouse"><span /></span>
        Scroll
      </motion.a>
    </section>
  )
}

// ---- the story: a horizontal film over the living building --------------------------------------

function Story({ refEl, chapter }: { refEl: React.RefObject<HTMLElement | null>; chapter: MotionValue<number> }) {
  const x = useTransform(chapter, (c) => `${-c * 100}vw`)
  const fill = useTransform(chapter, (c) => `${(c / (CHAPTER_COUNT - 1)) * 100}%`)
  const [now, setNow] = useState(0)
  useMotionValueEvent(chapter, 'change', (c) => setNow(Math.round(c)))
  const minutes = useTransform(chapter, (c) => {
    const m = 41 + Math.round(c * 2.8)
    return `11:${String(m).padStart(2, '0')} pm`
  })
  return (
    <section ref={refEl} id="story" className="lp-story" style={{ height: `${CHAPTER_COUNT * 120}vh` }} aria-label="One night at Blackwell Hall, in six chapters">
      <div className="lp-story__sticky">
        <Glass iri={false} className="lp-clock" aria-hidden="true">
          <span className={`lp-dot ${now >= 1 && now <= 3 ? 'lp-dot--coral' : 'lp-dot--mint'}`} />
          <motion.span>{minutes}</motion.span>
        </Glass>
        <motion.ol className="lp-track" style={{ x }}>
          {CHAPTERS.map((ch, i) => <ChapterSlide key={ch.key} ch={ch} i={i} chapter={chapter} />)}
        </motion.ol>
        <nav className="lp-rail" aria-label="Chapters">
          <div className="lp-rail__bar"><motion.span style={{ width: fill }} /></div>
          <ol>
            {CHAPTERS.map((ch, i) => (
              <li key={ch.key} className={i === now ? 'is-now' : i < now ? 'is-past' : ''}>
                <span className={`lp-rail__dot tone-${ch.tone}`} />
                <span className="lp-rail__label">{ch.label}</span>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </section>
  )
}

function ChapterSlide({ ch, i, chapter }: { ch: Chapter; i: number; chapter: MotionValue<number> }) {
  const near = useTransform(chapter, (c) => 1 - clamp01(Math.abs(c - i) * 1.25))
  const opacity = useTransform(near, [0, 1], [0.05, 1])
  const scale = useTransform(near, [0, 1], [0.9, 1])
  const blur = useTransform(near, (n) => `blur(${(1 - n) * 10}px)`)
  const titleX = useTransform(chapter, (c) => `${(i - c) * 22}vw`)
  const chipsX = useTransform(chapter, (c) => `${(i - c) * 34}vw`)
  return (
    <li className="lp-slide" aria-label={`Chapter ${i + 1}: ${ch.label}`}>
      <motion.div style={{ opacity, scale, filter: blur }}>
        <Glass className={`lp-chapter tone-${ch.tone}`}>
          <p className="lp-chapter__kicker"><span className="lp-chapter__num">{String(i + 1).padStart(2, '0')}</span>{ch.kicker}</p>
          <motion.h2 className="lp-chapter__title" style={{ x: titleX }}>{ch.title}</motion.h2>
          <p className="lp-chapter__body">{ch.body}</p>
          <motion.ul className="lp-chapter__chips" style={{ x: chipsX }}>
            {ch.chips.map((c) => (
              <li key={c.text} className={`lp-chip tone-${c.tone ?? 'blue'}`}>{c.icon}{c.text}</li>
            ))}
          </motion.ul>
        </Glass>
      </motion.div>
    </li>
  )
}

// ---- principle -----------------------------------------------------------------------------------

function Principle() {
  return (
    <section className="lp-principle" aria-label="Our promise">
      <Reveal><p className="lp-eyebrow"><CircleDot size={14} /> The promise</p></Reveal>
      <ScrubText
        className="lp-scrub"
        text="HAVEN doesn’t take over. It *notices, it *thinks *ahead, and then it *asks. Safety and access always come first. And a person decides, every single time."
      />
    </section>
  )
}

// ---- bento ---------------------------------------------------------------------------------------

function Bento() {
  return (
    <section id="features" className="lp-section" aria-labelledby="features-title">
      <header className="lp-section__head">
        <Reveal><p className="lp-eyebrow"><Sparkles size={14} /> What it does</p></Reveal>
        <Reveal delay={0.05}><h2 id="features-title" className="lp-h2">Everything your night shift needs.<br /><span className="lp-soft">Nothing it doesn’t.</span></h2></Reveal>
      </header>
      <div className="lp-bento">
        <Reveal className="b-ripple"><RippleCard /></Reveal>
        <Reveal className="b-maya" delay={0.08}><MayaCard /></Reveal>
        <Reveal className="b-stat" delay={0.12}><StatCard /></Reveal>
        <Reveal className="b-voice" delay={0.05}><VoiceCard /></Reveal>
        <Reveal className="b-lang" delay={0.1}><LanguageCard /></Reveal>
        <Reveal className="b-approve" delay={0.05}><ApproveCard /></Reveal>
        <Reveal className="b-place" delay={0.1}><PlaceCard /></Reveal>
        <Reveal className="b-sensor" delay={0.15}><SensorCard /></Reveal>
      </div>
    </section>
  )
}

function CardHead({ icon, title, tone = 'blue', children }: { icon: ReactNode; title: string; tone?: Tone; children?: ReactNode }) {
  return (
    <div className="lp-card__head">
      <span className={`lp-icon tone-${tone}`}>{icon}</span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  )
}

const RIPPLE = [
  { icon: <Droplets size={16} />, label: 'Water sensor' },
  { icon: <Waves size={16} />, label: 'Basement pipe' },
  { icon: <Zap size={16} />, label: 'Power room' },
  { icon: <Building2 size={16} />, label: 'Lifts' },
  { icon: <UserRound size={16} />, label: 'Floors 3–4' },
]

function RippleCard() {
  const ref = useRef<HTMLDivElement>(null)
  const seen = useInView(ref, { margin: '-15% 0px' })
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (!seen) return
    const id = setInterval(() => setStep((s) => (s + 1) % (RIPPLE.length + 3)), 850)
    return () => clearInterval(id)
  }, [seen])
  const done = step >= RIPPLE.length
  return (
    <Glass className="lp-card lp-card--tall" ref={ref}>
      <CardHead icon={<Waves size={18} />} title="See the ripple before it spreads" tone="water">
        One leak touches pipes, power, lifts and people. HAVEN follows the whole chain, so you see what’s next.
      </CardHead>
      <div className="lp-ripple__art" aria-hidden="true"><img src={heavy('/landing/cutaway.webp')} alt="" loading="lazy" decoding="async" /></div>
      <ol className="lp-ripple" aria-label="How one leak spreads">
        {RIPPLE.map((n, i) => (
          <li key={n.label} className={i < step ? 'is-hit' : ''}>
            <span className="lp-ripple__node">{n.icon}</span>
            <span>{n.label}</span>
            {i < RIPPLE.length - 1 && <span className="lp-ripple__wire"><motion.span animate={{ scaleX: i < step - 1 ? 1 : 0 }} transition={{ duration: 0.5, ease: EASE }} /></span>}
          </li>
        ))}
      </ol>
      <AnimatePresence>
        {done && (
          <motion.p className="lp-callout tone-mint" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.4 }}>
            <ShieldCheck size={15} /> Seen 12 minutes before the lights go out.
          </motion.p>
        )}
      </AnimatePresence>
    </Glass>
  )
}

function MayaCard() {
  const [on, setOn] = useState(true)
  return (
    <Glass className="lp-card">
      <CardHead icon={<HeartHandshake size={18} />} title="Everyone gets a voice" tone="lavender">
        Each resident has an agent that speaks up for them. Try switching Maya’s off.
      </CardHead>
      <div className="lp-maya">
        <div className="lp-maya__who">
          <span className="lp-avatar"><Accessibility size={18} /></span>
          <div><b>Maya</b><small>Floor 4 · wheelchair user</small></div>
          <button type="button" role="switch" aria-checked={on} aria-label="Maya’s agent" className={`lp-switch ${on ? 'is-on' : ''}`} onClick={() => setOn((v) => !v)}>
            <motion.span layout transition={{ type: 'spring', stiffness: 500, damping: 30 }} />
          </button>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {on ? (
            <motion.p key="on" className="lp-callout tone-mint" initial={{ opacity: 0, y: 8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.97 }} transition={{ duration: 0.35, ease: EASE }}>
              <Check size={15} /> Her agent asks for the lift. She’s escorted down first.
            </motion.p>
          ) : (
            <motion.p key="off" className="lp-callout tone-coral" initial={{ opacity: 0, y: 8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.97 }} transition={{ duration: 0.35, ease: EASE }}>
              <BellRing size={15} /> No one speaks for her. HAVEN flags that she’d be left behind.
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </Glass>
  )
}

function StatCard() {
  return (
    <Glass className="lp-card lp-stat">
      <span className="lp-stat__num"><CountUp to={12} /><small>min</small></span>
      <p>earlier warning, before the power goes out.</p>
    </Glass>
  )
}

const QUOTE = '“Don’t wake floor seven unless the water reaches them.”'

function VoiceCard() {
  const ref = useRef<HTMLDivElement>(null)
  const seen = useInView(ref, { once: true, margin: '-15% 0px' })
  const [n, setN] = useState(0)
  const [run, setRun] = useState(0)
  const reduce = useReducedMotion()
  useEffect(() => {
    if (!seen) return
    if (reduce) { setN(QUOTE.length); return }
    setN(0)
    const id = setInterval(() => setN((v) => (v >= QUOTE.length ? (clearInterval(id), v) : v + 1)), 34)
    return () => clearInterval(id)
  }, [seen, run, reduce])
  const done = n >= QUOTE.length
  return (
    <Glass className="lp-card lp-card--wide" ref={ref}>
      <div className="lp-voice">
        <CardHead icon={<Mic size={18} />} title="Just say it" tone="peach">
          Give HAVEN a rule out loud, the way you’d tell a colleague. It listens and follows it.
        </CardHead>
        <div className="lp-voice__stage">
          <button type="button" className={`lp-mic ${done ? '' : 'is-live'}`} onClick={() => setRun((r) => r + 1)} aria-label="Play the voice example again">
            <Mic size={20} />
          </button>
          <div className="lp-wave" aria-hidden="true">{Array.from({ length: 22 }, (_, i) => <span key={i} style={{ animationDelay: `${(i % 7) * -0.13}s` }} className={done ? 'is-rest' : ''} />)}</div>
          <p className="lp-voice__quote" aria-label={QUOTE}><span aria-hidden="true">{QUOTE.slice(0, n)}<i className="lp-caret" /></span></p>
          <AnimatePresence>
            {done && (
              <motion.span className="lp-callout tone-mint" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 22 }}>
                <Check size={15} /> Rule added. Floor 7 sleeps on.
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Glass>
  )
}

const HELLOS = ['Stay in your room.', 'Quédate en tu cuarto.', '请留在房间里。']

function LanguageCard() {
  const [i, setI] = useState(0)
  const reduce = useReducedMotion()
  useEffect(() => {
    if (reduce) return
    const id = setInterval(() => setI((v) => (v + 1) % HELLOS.length), 2200)
    return () => clearInterval(id)
  }, [reduce])
  return (
    <Glass className="lp-card">
      <CardHead icon={<BellRing size={18} />} title="The right words, to the right people" tone="mint">
        Calm, short messages, in English, Spanish or Chinese. Only to the people who need them.
      </CardHead>
      <div className="lp-bubble-wrap" aria-live="off">
        <AnimatePresence mode="wait">
          <motion.p key={i} className="lp-bubble" initial={{ opacity: 0, y: 14, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10, scale: 0.96 }} transition={{ duration: 0.45, ease: EASE }}>
            {HELLOS[i]}
          </motion.p>
        </AnimatePresence>
      </div>
    </Glass>
  )
}

const STEPS = ['Shut off the water', 'Bring Maya down by lift', 'Text floors 3 and 4', 'Call the plumber']

function ApproveCard() {
  const [approved, setApproved] = useState(false)
  const [ticked, setTicked] = useState(0)
  useEffect(() => {
    if (!approved) { setTicked(0); return }
    const id = setInterval(() => setTicked((t) => (t >= STEPS.length ? (clearInterval(id), t) : t + 1)), 420)
    return () => clearInterval(id)
  }, [approved])
  return (
    <Glass className="lp-card lp-card--wide">
      <div className="lp-approve">
        <CardHead icon={<Phone size={18} />} title="One tap. You’re in charge." tone="blue">
          HAVEN never acts on its own. The plan waits for you, on your desk or on your phone.
        </CardHead>
        <div className="lp-phone" aria-label="Example plan on a phone">
          <div className="lp-phone__notch" />
          <p className="lp-phone__title">Plan ready <span>4 steps</span></p>
          <ul>
            {STEPS.map((s, i) => (
              <li key={s} className={i < ticked ? 'is-done' : ''}>
                <span className="lp-tick">{i < ticked ? <Check size={11} strokeWidth={3} /> : i + 1}</span>{s}
              </li>
            ))}
          </ul>
          <motion.button type="button" layout className={`lp-approve__btn ${approved ? 'is-approved' : ''}`} onClick={() => setApproved((a) => !a)} whileTap={{ scale: 0.95 }} aria-pressed={approved}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={approved ? 'y' : 'n'} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                {approved ? <><Check size={16} strokeWidth={3} /> Approved. Tap to undo</> : 'Approve plan'}
              </motion.span>
            </AnimatePresence>
          </motion.button>
        </div>
      </div>
    </Glass>
  )
}

function PlaceCard() {
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], ['-12%', '12%'])
  return (
    <Glass className="lp-card lp-place" ref={ref}>
      <motion.img src={heavy('/landing/street.webp')} alt="David Blackwell Hall, a seven-storey residence hall on Durant Avenue in Berkeley, rendered in 3D" style={{ y }} loading="lazy" decoding="async" />
      <div className="lp-place__cap">
        <span className="lp-chip tone-blue"><Building2 size={14} /> Rehearsed on a real building</span>
        <p>David Blackwell Hall, Berkeley. Seven floors, 250 residents.</p>
      </div>
    </Glass>
  )
}

function SensorCard() {
  return (
    <Glass className="lp-card lp-sensor">
      <div className="lp-drop" aria-hidden="true"><span className="lp-drop__d" /><span className="lp-drop__r" /><span className="lp-drop__r lp-drop__r--2" /></div>
      <h3>It starts with a <span className="lp-accent">$4 sensor.</span></h3>
      <p>No new wiring. It works with the building you already have.</p>
    </Glass>
  )
}

// ---- who it is for ------------------------------------------------------------------------------

const TEAMS = [
  { icon: <Building2 size={20} />, tone: 'blue' as Tone, title: 'Building managers', body: 'See the whole building at a glance, and approve the plan in one tap.' },
  { icon: <ShieldCheck size={20} />, tone: 'mint' as Tone, title: 'Security and front desk', body: 'Know who to help first, and exactly where they are.' },
  { icon: <HeartHandshake size={20} />, tone: 'lavender' as Tone, title: 'RAs and on-call staff', body: 'Your part of the plan lands on your phone. Tap when it’s done.' },
]

function Teams() {
  return (
    <section id="teams" className="lp-section" aria-labelledby="teams-title">
      <header className="lp-section__head">
        <Reveal><p className="lp-eyebrow"><UserRound size={14} /> Who it’s for</p></Reveal>
        <Reveal delay={0.05}><h2 id="teams-title" className="lp-h2">Made for the people<br /><span className="lp-soft">who keep the lights on.</span></h2></Reveal>
      </header>
      <ul className="lp-teams">
        {TEAMS.map((t, i) => (
          <Reveal as="li" key={t.title} delay={i * 0.08}>
            <Glass className="lp-card lp-team" tilt>
              <span className={`lp-icon lp-icon--lg tone-${t.tone}`}>{t.icon}</span>
              <h3>{t.title}</h3>
              <p>{t.body}</p>
            </Glass>
          </Reveal>
        ))}
      </ul>
    </section>
  )
}

function Finale() {
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end end'] })
  const scale = useTransform(scrollYProgress, [0, 1], [0.86, 1])
  const rot = useTransform(scrollYProgress, [0, 1], [14, 0])
  return (
    <section ref={ref} className="lp-finale" aria-labelledby="finale-title">
      <motion.div className="lp-finale__frame" style={{ scale, rotateX: rot }}>
        <Glass className="lp-finale__card" tilt>
          <img src={heavy('/landing/aerial.webp')} alt="" loading="lazy" decoding="async" />
          <div className="lp-finale__veil" />
          <div className="lp-finale__copy">
            <p className="lp-pill"><span className="lp-dot lp-dot--mint" /> Calm by default</p>
            <h2 id="finale-title" className="lp-display lp-display--md">Rest easy.<br /><span className="lp-accent">HAVEN is on watch.</span></h2>
            <div className="lp-ctas">
              <Magnetic href={APP_URL} className="lp-btn--primary">Open HAVEN <ArrowRight size={17} /></Magnetic>
              <Magnetic href="/phone" className="lp-btn--ghost"><Phone size={16} /> The manager’s phone</Magnetic>
              <Magnetic href="/story" className="lp-btn--ghost">The full story <ArrowUpRight size={16} /></Magnetic>
            </div>
          </div>
        </Glass>
      </motion.div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="lp-footer">
      <Logo />
      <p>Built at Cal Hacks 13.0. The building is real; the residents are a rehearsal.</p>
      <nav aria-label="More">
        <a href={APP_URL}>Command centre</a>
        <a href="/phone">Phone</a>
        <a href="/story">Deep dive</a>
      </nav>
    </footer>
  )
}
