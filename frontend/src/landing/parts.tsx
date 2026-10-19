import { animate, motion, useInView, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue } from 'motion/react'
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react'

export const EASE = [0.22, 1, 0.36, 1] as const

/** A button or link that leans toward the pointer and springs back when it leaves. */
export function Magnetic({
  href, children, className = '', strength = 0.35, onClick, ariaLabel,
}: { href?: string; children: ReactNode; className?: string; strength?: number; onClick?: (e: React.MouseEvent) => void; ariaLabel?: string }) {
  const reduce = useReducedMotion()
  const x = useSpring(0, { stiffness: 220, damping: 16, mass: 0.4 })
  const y = useSpring(0, { stiffness: 220, damping: 16, mass: 0.4 })
  const ix = useTransform(x, (v) => v * 0.45)
  const iy = useTransform(y, (v) => v * 0.45)
  const move = (e: React.PointerEvent<HTMLElement>) => {
    if (reduce || e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    x.set((e.clientX - r.left - r.width / 2) * strength)
    y.set((e.clientY - r.top - r.height / 2) * strength)
  }
  const leave = () => { x.set(0); y.set(0) }
  const inner = <motion.span className="lp-btn__inner" style={{ x: ix, y: iy }}>{children}</motion.span>
  const common = { className: `lp-btn ${className}`, style: { x, y }, onPointerMove: move, onPointerLeave: leave, whileTap: { scale: 0.96 }, 'aria-label': ariaLabel }
  return href ? (
    <motion.a href={href} onClick={onClick} {...common}>{inner}</motion.a>
  ) : (
    <motion.button type="button" onClick={onClick} {...common}>{inner}</motion.button>
  )
}

/** Frosted glass with a light that follows the pointer and an iridescent rim on hover. */
export function Glass({
  as: Tag = 'div', className = '', children, style, iri = true, tilt = false, ref: outer, ...rest
}: { as?: ElementType; className?: string; children?: ReactNode; style?: CSSProperties; iri?: boolean; tilt?: boolean; ref?: React.Ref<HTMLDivElement> } & Record<string, unknown>) {
  const ref = useRef<HTMLElement | null>(null)
  const setRef = (el: HTMLElement | null) => {
    ref.current = el
    if (typeof outer === 'function') outer(el as HTMLDivElement)
    else if (outer) (outer as React.RefObject<HTMLElement | null>).current = el
  }
  const reduce = useReducedMotion()
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    el.style.setProperty('--mx', `${px * 100}%`)
    el.style.setProperty('--my', `${py * 100}%`)
    if (tilt && !reduce && e.pointerType === 'mouse') {
      el.style.setProperty('--rx', `${(0.5 - py) * 6}deg`)
      el.style.setProperty('--ry', `${(px - 0.5) * 8}deg`)
    }
  }
  const leave = () => {
    ref.current?.style.setProperty('--rx', '0deg')
    ref.current?.style.setProperty('--ry', '0deg')
  }
  return (
    <Tag ref={setRef} className={`lp-glass ${iri ? 'lp-iri' : ''} ${tilt ? 'lp-tilt' : ''} ${className}`} style={style} onPointerMove={move} onPointerLeave={leave} {...rest}>
      {children}
    </Tag>
  )
}

/** Rises into place the first time it scrolls into view. */
export function Reveal({ children, delay = 0, y = 28, className = '', as = 'div' }: { children: ReactNode; delay?: number; y?: number; className?: string; as?: 'div' | 'li' | 'p' | 'h2' | 'span' }) {
  const reduce = useReducedMotion()
  const M = motion[as]
  return (
    <M
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y, filter: 'blur(8px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: 0.9, ease: EASE, delay }}
    >
      {children}
    </M>
  )
}

/** A headline whose words rise one after another. */
export function SplitWords({ text, className = '', delay = 0, accent = [] }: { text: string; className?: string; delay?: number; accent?: string[] }) {
  const reduce = useReducedMotion()
  const words = text.split(' ')
  return (
    <span className={className} aria-label={text} role="text">
      {words.map((w, i) =>
        w === '\n' ? (
          <br key={i} />
        ) : (
          <Fragment key={i}>
          <span className="lp-word" aria-hidden="true">
            <motion.span
              className={accent.includes(w.replace(/[.,]/g, '')) ? 'lp-accent' : undefined}
              initial={reduce ? { opacity: 0 } : { y: '110%', opacity: 0, rotate: 4 }}
              animate={{ y: '0%', opacity: 1, rotate: 0 }}
              transition={{ duration: 1.0, ease: EASE, delay: delay + i * 0.07 }}
            >
              {w}
            </motion.span>
          </span>
          {i < words.length - 1 && ' '}
          </Fragment>
        ),
      )}
    </span>
  )
}

/** A paragraph that lights up word by word as it is scrolled through. */
export function ScrubText({ text, className = '' }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 85%', 'end 45%'] })
  const words = text.split(' ')
  return (
    <p ref={ref} className={className} aria-label={text}>
      {words.map((w, i) => (
        <ScrubWord key={i} progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]}>{w}</ScrubWord>
      ))}
    </p>
  )
}
function ScrubWord({ children, progress, range }: { children: string; progress: MotionValue<number>; range: [number, number] }) {
  const opacity = useTransform(progress, range, [0.16, 1])
  const accent = children.startsWith('*')
  return (
    <motion.span aria-hidden="true" style={{ opacity }} className={accent ? 'lp-accent' : undefined}>
      {accent ? children.slice(1) : children}{' '}
    </motion.span>
  )
}

/** Counts up to a number when it comes into view. */
export function CountUp({ to, suffix = '', duration = 1.6 }: { to: number; suffix?: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useInView(ref, { once: true, margin: '-10% 0px' })
  const mv = useMotionValue(0)
  const [v, setV] = useState(0)
  useEffect(() => {
    if (!seen) return
    const c = animate(mv, to, { duration, ease: EASE, onUpdate: (n) => setV(Math.round(n)) })
    return () => c.stop()
  }, [seen, to, duration, mv])
  return <span ref={ref}>{v}{suffix}</span>
}
