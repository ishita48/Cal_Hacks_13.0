import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { api, formatClockHM, type LoggedEvent } from '../lib/api'
import { useBuilding } from '../state/building'
import type { SponsorReport } from '../state/types'
import { connectWorld, useWorld } from '../state/world'
import './story.css'

/**
 * The story page: editorial, on paper, one blue. It is not a brochure of a different product: the
 * "live state" room shows the REAL event log of the run the backend is in, and the "under the hood"
 * grid shows the REAL round-trip proof for every sponsor. Reload the dashboard, and this page moves.
 */

// ---- small hooks -----------------------------------------------------------------------------------

function useInView<T extends Element>(ref: React.RefObject<T | null>, threshold = 0.3, once = true) {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setSeen(true)
            if (once) io.disconnect()
          } else if (!once) setSeen(false)
        }
      },
      { threshold },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, threshold, once])
  return seen
}

/** Step through a timed sequence once `run` is true; `replay` restarts it. */
function useSequence(run: boolean, delays: number[]) {
  const [step, setStep] = useState(0)
  const [gen, setGen] = useState(0)
  useEffect(() => {
    if (!run) return
    setStep(0)
    const timers = delays.map((d, i) => setTimeout(() => setStep(i + 1), d))
    return () => timers.forEach(clearTimeout)
  }, [run, gen, delays])
  return { step, replay: () => setGen((g) => g + 1) }
}

// ---- primitives ----------------------------------------------------------------------------------

function Eyebrow({ index, children }: { index?: string; children: ReactNode }) {
  return (
    <p className="eyebrow">
      {index && <i>{index}</i>}
      {index && <b aria-hidden="true" />}
      <span>{children}</span>
    </p>
  )
}

function RevealLines({ as: Tag = 'h2', lines, className = '', delay = 0, show, id }: { as?: 'h1' | 'h2' | 'p'; lines: ReactNode[]; className?: string; delay?: number; show?: boolean; id?: string }) {
  const ref = useRef<HTMLElement>(null)
  const seen = useInView(ref, 0.3)
  const on = show ?? seen
  return (
    <Tag ref={ref as React.RefObject<HTMLHeadingElement>} id={id} className={`${className} ${on ? 'is-in' : ''}`}>
      {lines.map((line, i) => (
        <span className="reveal-line" key={i}>
          <span className="reveal-line__inner" style={{ '--i': i, '--d': `${delay}ms` } as CSSProperties}>
            {line}
          </span>
        </span>
      ))}
    </Tag>
  )
}

// ---- sections ------------------------------------------------------------------------------------

function Nav() {
  const bar = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const page = document.querySelector<HTMLElement>('.argus-page')
    if (!page) return
    const update = () => {
      const max = page.scrollHeight - page.clientHeight
      if (bar.current) bar.current.style.transform = `scaleX(${max > 0 ? page.scrollTop / max : 0})`
    }
    update()
    page.addEventListener('scroll', update, { passive: true })
    return () => page.removeEventListener('scroll', update)
  }, [])
  return (
    <header className="nav">
      <div className="nav__shell lp-glass">
        <a href="#top" className="nav__brand">
          <i aria-hidden="true" /> HAVEN
        </a>
        <nav className="nav__links" aria-label="Primary">
          <a href="#how">How it works</a>
          <a href="#agents">The agents</a>
          <a href="#live">One shared state</a>
          <a href="#hood">Under the hood</a>
        </nav>
        {import.meta.env.VITE_CLERK_PUBLISHABLE_KEY && (
          <a href="/app" className="nav__signin">
            Sign in
          </a>
        )}
        <a href="/app" className="btn btn--primary nav__cta">
          Open the command centre <span className="btn__arrow">→</span>
        </a>
        <span className="nav__progress" aria-hidden="true">
          <span ref={bar} />
        </span>
      </div>
    </header>
  )
}

const CHAIN: [string, boolean][] = [
  ['water_riser → B1-mech · 150 L/s', false],
  ['B1-mech → B1-elec · 3 m, weir flow', false],
  ['msb_b floods at 10 cm · +12.5 min', true],
  ['ats_eq → lift_1, lift_2 offline', true],
  ['msb_b → floors 3–4 dark · fridge_L3', true],
  ['room_412 · Maya · no step-free route', true],
]

function Hero() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])
  const delays = useMemo(() => [600, 1500, 2100, 2500, 2900, 3300, 3700, 4100, 5200, 6400], [])
  const { step } = useSequence(mounted, delays)
  const world = useWorld((s) => s.world)
  const spec = useBuilding((b) => b.spec)
  const residentCount = useBuilding((b) => Object.keys(b.residents).length)
  const wet = Object.values(world?.sensors ?? {}).some((s) => s.wet)
  const chainOn = Math.max(0, step - 2)

  return (
    <section id="top" className="hero" aria-labelledby="hero-title">
      <div className="hero__grid" aria-hidden="true" />
      <div className="container hero__inner">
        <div className="hero__meta">
          <Eyebrow>
            <span className={`hero__live ${wet ? 'is-wet' : ''}`} aria-hidden="true" /> {wet ? 'Water in the basement, right now' : 'Tuesday, 23:41 · a $4 water sensor'}
          </Eyebrow>
          <p className="annot" style={{ textAlign: 'right', maxWidth: '30ch' }}>
            {spec ? `${spec.name} · ${spec.address.split(',')[0]} · ${residentCount} residents` : 'one building · every resident'}
          </p>
        </div>

        <RevealLines as="h1" id="hero-title" className="hero__title" show={mounted} lines={['A building', 'fails as', 'one system.']} />

        <figure className="hs" aria-label="A sensor reading becomes a traced cascade, a negotiated plan, and a human approval.">
          <div className={`hs-card ${step >= 1 ? 'is-on' : ''}`}>
            <span className="hs-card__k">sensor_reading</span>
            <p className="big">0.9</p>
            <p>basement_mech_1 · ESP32 · 23:41:30. Nobody has phoned anyone yet.</p>
          </div>
          <svg className={`hs-path ${step >= 2 ? 'is-on' : ''}`} viewBox="0 0 400 22" preserveAspectRatio="none" aria-hidden="true">
            <path d="M200 0 C 200 10, 212 12, 212 22" />
          </svg>
          <div className={`hs-card ${step >= 2 ? 'is-on' : ''}`}>
            <span className="hs-card__k red">cascade · one graph</span>
            <ol className="hs-chain">
              {CHAIN.map(([line, hot], i) => (
                <li key={line} className={`${i < chainOn ? 'is-on' : ''} ${hot ? 'hot' : ''}`}>
                  <span>→</span>
                  {line}
                </li>
              ))}
            </ol>
          </div>
          <div className={`hs-card hs-veto ${step >= 9 ? 'is-on' : ''}`}>
            <span className="hs-card__k violet">resident:maya · veto</span>
            <p>“Cutting the power now strands Maya on L4: a wheelchair cannot use the stairs and no one is coming to the door.”</p>
          </div>
          <div className={`hs-card ${step >= 10 ? 'is-on' : ''}`}>
            <span className="hs-card__k lime">plan v2 · awaiting approval</span>
            <p>Hold the lifts 6 min for escorts, then cut section B and ATS-EQ. Insulin moved. 221 placed on campus. Nobody left behind.</p>
          </div>
        </figure>

        <RevealLines as="p" className="hero__turn serif" show={mounted} delay={420} lines={['The response shouldn’t come from four teams.']} />

        <div className="hero__foot">
          <p className="lead">
            HAVEN traces the chain through one shared dependency graph, lets specialist agents and a personal agent for every
            resident negotiate under hard safety and accessibility constraints, takes a rule from the manager by voice, and acts
            on approval. Every surface is a view of one event-sourced world.
          </p>
          <div className="hero__ctas">
            <a href="/app" className="btn btn--primary">
              Open the command centre <span className="btn__arrow">→</span>
            </a>
            <a href="#how" className="btn btn--ghost">
              See how it works <span className="btn__arrow">↓</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

function How() {
  return (
    <section id="how" className="section">
      <div className="container">
        <Eyebrow index="01">Trace, negotiate, act</Eyebrow>
        <RevealLines className="h2" lines={['Logic does the work.', <span className="serif" key="s">The model only speaks.</span>]} />
        <div className="how__grid">
          <article className="how__card">
            <span className="n">01 · trace</span>
            <h3 className="h3">One graph, one physics</h3>
            <p>
              Rooms, risers, switchgear, lifts and people are nodes in a NetworkX graph. Water is volume per space and weir flow
              through doors; equipment floods at its <code>flood_height</code>. The same <code>step()</code> runs the live world and
              the 60-minute forecast. Deterministic, replayable from the event log.
            </p>
          </article>
          <article className="how__card">
            <span className="n">02 · negotiate</span>
            <h3 className="h3">A veto is a constraint, not a comment</h3>
            <p>
              Safety, Housing, Capacity and a checker argue over the naive plan; one personal agent per resident contests what
              harms them. Needs are hard filters the optimiser cannot buy its way out of. Switch Maya’s agent off and the plan
              strands her: <code>plan.left_behind</code>.
            </p>
          </article>
          <article className="how__card">
            <span className="n">03 · act</span>
            <h3 className="h3">A human gates it, then it fires</h3>
            <p>
              The manager says “nobody gets moved off campus” and every agent re-plans under the code. On approval the plumber is
              phoned, the ticket is filed, breakers open at the safe moment, and 250 people get a message in their own language.
            </p>
          </article>
        </div>
      </div>
    </section>
  )
}

const AGENTS = [
  { id: 'safety', name: 'Safety agent', q: 'Is the switchgear dead before the water touches it?', plain: 'A hard veto. De-energise MSB-B and ATS-EQ with a two-minute margin before contact, and nobody enters standing water.', did: 'Proposed the naive plan: cut now. Accepted the six-minute hold once the escorts were timed.' },
  { id: 'housing', name: 'Housing agent', q: 'Who is affected, and where do they sleep tonight?', plain: 'Lists every resident on a floor that goes dark, who is asleep, who is away, and the overflow lounges in order.', did: 'Split 221 residents across Unit 2 and the upper lounges by capacity; night-shift Jordan left alone.' },
  { id: 'capacity', name: 'Capacity agent', q: 'Does the overflow space actually fit?', plain: 'Counts seats and outlets in every destination and refuses a lounge that holds 20 when 38 are sent.', did: 'Objected to “everyone to Unit 2”; the plan now fills each lounge to capacity, then the next.' },
  { id: 'resident:maya', name: 'Maya’s agent', q: 'Does Maya keep a step-free route?', plain: 'Maya uses a power wheelchair on floor 4. Her agent vetoes any plan that cuts the lifts before she is down.', did: 'Vetoed round one. Round two holds power six minutes while two staff bring her down by lift first.' },
  { id: 'checker', name: 'Checker agent', q: 'Does the final plan survive every hard constraint?', plain: 'Verifies the plan against the facts, not against who spoke. It cannot be switched off.', did: 'Ten checks pass: contact margin, every need covered, capacity, the manager’s rule.' },
]
const POS = [
  { x: 10, y: 20 },
  { x: 8, y: 74 },
  { x: 90, y: 18 },
  { x: 92, y: 70 },
  { x: 50, y: 97 },
]

function AgentField() {
  const [sel, setSel] = useState(3)
  const [touched, setTouched] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const inView = useInView(stage, 0.4, false)
  const world = useWorld((s) => s.world)
  useEffect(() => {
    if (touched || !inView) return
    const id = window.setInterval(() => setSel((s) => (s + 1) % AGENTS.length), 3600)
    return () => window.clearInterval(id)
  }, [touched, inView])
  const a = AGENTS[sel]
  const stance = world?.plan.stances.find((s) => s.agent === a.id)
  return (
    <section id="agents" className="section">
      <div className="container">
        <Eyebrow index="02">A society, not a prompt</Eyebrow>
        <RevealLines className="h2" lines={['Five specialists and one agent', <span className="serif" key="s">for every resident.</span>]} />
        <p className="lead">Hover or tap to see what each one asks, and what it changed in the plan.</p>
        <div className="af__stage" ref={stage}>
          <svg className="af__tethers" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {POS.map((p, i) => (
              <line key={i} x1={p.x} y1={p.y} x2={50} y2={50} className={i === sel ? 'is-on' : ''} />
            ))}
          </svg>
          {AGENTS.map((ag, i) => (
            <button key={ag.id} className={`af__node ${i === sel ? 'is-on' : ''}`} style={{ left: `${POS[i].x}%`, top: `${POS[i].y}%`, animationDelay: `${i * -1.3}s` }} onMouseEnter={() => { setTouched(true); setSel(i) }} onClick={() => { setTouched(true); setSel(i) }}>
              <span className="af__node-idx">0{i + 1}</span>
              <span className="af__node-name">{ag.name}</span>
              <span className="af__node-q">{ag.q}</span>
            </button>
          ))}
          <div className="af__core">
            <span className="k">the plan · a pure function of the world</span>
            <span className="t">{world?.plan.headline || 'Hold the lifts 6 min for escorts, then cut section B and ATS-EQ. Nobody left behind.'}</span>
            <span className="m">{world ? `v${world.plan.version} · ${world.plan.enabled_agents.length}/${Object.keys(world.agents).length} agents on · ${world.plan.left_behind.length} left behind` : 'round 1 vetoed · round 2 feasible'}</span>
          </div>
        </div>
        <div className="af__detail" key={a.id}>
          <div>
            <p className="h3">{a.name}</p>
            <p style={{ marginTop: 10, color: 'var(--ink-2)' }}>{a.plain}</p>
          </div>
          <dl>
            <div>
              <dt className="annot">In the demo</dt>
              <dd>{a.did}</dd>
            </div>
            <div>
              <dt className="annot">Right now</dt>
              <dd>{stance ? <span className={`pill pill--${stance.stance === 'veto' ? 'finding' : stance.stance === 'support' ? 'pass' : 'agent'}`}><i /> {stance.stance} · {stance.reason}</span> : <span className="annot">no incident on the table</span>}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  )
}

function describeEvent(ev: LoggedEvent): { call: string; who: string } {
  const e = ev.event as Record<string, unknown> & { type: string }
  switch (e.type) {
    case 'sensor_reading':
      return { call: `sensor_reading(${e.sensor_id}, ${e.value})`, who: String(e.source) }
    case 'agent_toggle':
      return { call: `agent_toggle(${e.agent}, ${e.enabled ? 'on' : 'off'})`, who: 'manager' }
    case 'manager_rule':
      return { call: `manager_rule(${e.code})`, who: String(e.actor) }
    case 'plan_decision':
      return { call: `plan_decision(v${e.plan_version}, ${e.decision})`, who: String(e.actor) }
    case 'equipment_command':
      return { call: `equipment_command(${e.equipment_id}, ${e.command})`, who: String(e.actor) }
    case 'action':
      return { call: `action(${e.step_id}, ${e.status})`, who: String(e.actor ?? 'haven') }
    default:
      return { call: e.type, who: '' }
  }
}

function LiveState() {
  const world = useWorld((s) => s.world)
  const clock = useWorld((s) => s.clock)
  const connection = useWorld((s) => s.connection)
  const [events, setEvents] = useState<LoggedEvent[]>([])
  useEffect(() => {
    if (!world) return
    api.runEvents(world.run_id).then(setEvents).catch(() => {})
  }, [world?.run_id, world?.version])
  const plan = world?.approved_plan ?? world?.plan
  const m = plan?.metrics ?? {}
  const doneSteps = world ? Object.values(world.actions).filter((a) => a.status === 'done').length : 0
  const presence = [
    { n: 'Safety', k: 'agent' }, { n: 'Housing', k: 'agent' }, { n: 'Capacity', k: 'agent' }, { n: 'Checker', k: 'agent' },
    { n: `${world ? Object.keys(world.agents).filter((a) => a.startsWith('resident:')).length : 55} resident agents`, k: 'agent' },
    { n: 'Manager · phone', k: 'human' }, { n: 'Dashboard', k: 'human' }, { n: '3D twin', k: 'human' }, { n: 'Blender', k: 'human' },
  ]
  const Surface = ({ kind }: { kind: 'phone' | 'dash' }) => (
    <div className={`ls-surface ls-surface--${kind}`}>
      <p className="ls-surface__k mono">{kind === 'phone' ? 'Manager · phone (/phone)' : 'Facilities · dashboard (/)'}</p>
      <div className={`ls-inc ${plan?.status === 'approved' || plan?.status === 'executing' || plan?.status === 'done' ? 'is-v' : ''}`}>
        <p className="ls-inc__id mono">{world ? `run ${world.run_id} · v${world.version}` : 'not connected'}</p>
        <p className="ls-inc__t">{plan?.headline || world?.narrative.headline || 'No incident.'}</p>
        <span className={`pill ${plan?.status === 'none' ? '' : plan?.status === 'draft' ? 'pill--agent' : 'pill--live'}`}>
          <i /> {plan?.status ?? 'offline'}
        </span>
      </div>
      <ul className="ls-facts">
        <li><span className="mono">clock</span> {clock ? formatClockHM(clock.time_of_day) : '—'} · {clock?.speed ?? 1}×</li>
        <li><span className="mono">affected</span> {Number(m.residents_affected ?? 0)} · {Number(m.left_behind ?? 0)} left behind</li>
        <li><span className="mono">water</span> {world ? `${Math.round(Math.max(0, ...Object.values(world.water).map((w) => w.depth)) * 100)} cm` : '—'} · dark {world?.impact.dark_levels.join(', ') || 'none'}</li>
        <li><span className="mono">actions</span> {doneSteps} done of {plan?.steps.length ?? 0}</li>
      </ul>
    </div>
  )
  return (
    <section id="live" className="ls section">
      <div className="container">
        <Eyebrow index="03">Live coordination</Eyebrow>
        <RevealLines className="h2" lines={['One shared state.', <span className="serif" key="s">Every surface sees it change.</span>]} />
        <p className="lead">
          The dashboard, the phone, the 3D twin, Blender and the agents never hold their own truth. They subscribe to one
          event-sourced world: inputs are logged with the step they applied at, everything else is derived. This room is live:
          it shows the run the backend is in right now.
        </p>
        <div className="ls__system">
          <ul className="ls__presence" aria-label="Connected clients">
            {presence.map((p) => (
              <li key={p.n} className={`ls__who ls__who--${p.k}`}>
                <i aria-hidden="true" /> {p.n}
              </li>
            ))}
            <li className="ls__note mono">{connection === 'open' ? 'subscribed · /ws' : connection}</li>
          </ul>
          <div className="ls__grid">
            <Surface kind="phone" />
            <div className="ls-core">
              <p className="ls-core__k mono">WorldEngine · event log · {events.length} inputs</p>
              <div className="ls-core__tables mono" aria-hidden="true">
                {['sensor_reading', 'agent_toggle', 'manager_rule', 'plan_decision', 'equipment_command', 'action'].map((t) => <span key={t}>{t}</span>)}
              </div>
              <ol className="ls-log mono" aria-live="polite">
                {events.length === 0 && <li>→ waiting for the first input · press “Simulate leak” in the command centre</li>}
                {events.slice(-14).map((ev) => {
                  const d = describeEvent(ev)
                  return (
                    <li key={ev.seq}>
                      <p><span className="ls-log__arrow">→</span> {d.call}</p>
                      <p className="ls-log__who">actor: {d.who} · step {ev.step}</p>
                      <p className="ls-log__res">✓ applied · every subscriber re-derived</p>
                    </li>
                  )
                })}
              </ol>
              <button className="ls-core__replay mono" onClick={() => api.loadDemo().catch(() => {})} title="Import the recorded run and replay it from the log">↺ Replay the recorded run</button>
            </div>
            <Surface kind="dash" />
          </div>
          <p className="ls__caveat annot">Replay re-emits the same inputs at the same steps; the physics, the plan and the messages re-derive identically.</p>
        </div>
      </div>
    </section>
  )
}

function UnderTheHood({ live }: { live: boolean }) {
  const [report, setReport] = useState<SponsorReport | null>(null)
  useEffect(() => {
    if (live) api.sponsors().then(setReport).catch(() => {})
  }, [live])
  return (
    <section id="hood" className="section">
      <div className="container">
        <Eyebrow index="04">Under the hood</Eyebrow>
        <RevealLines className="h2" lines={['Every integration is load-bearing,', <span className="serif" key="s">and proves it.</span>]} />
        <p className="lead">A read-only round trip per service whose answer only the live service could give. Green means a request just succeeded; grey means simulated.</p>
        <div className="uh__grid">
          {(report?.sponsors ?? []).map((s) => (
            <article key={s.id} className={`uh__card is-${s.state}`}>
              <p className="n"><i style={s.state === 'live' ? { background: s.color } : undefined} /> {s.name}</p>
              <p className="r">{s.role}</p>
              <p className="p">{s.proof}{s.latency_ms != null ? ` · ${s.latency_ms} ms` : ''}</p>
            </article>
          ))}
          {!report && <p className="annot">checking the stack…</p>}
        </div>
      </div>
    </section>
  )
}

function Final() {
  return (
    <section className="section fin">
      <div className="container">
        <RevealLines className="h2" lines={['Connected failure,', <span className="serif" key="s">connected response.</span>, 'Nobody left behind.']} />
        <div className="fin__ctas">
          <a href="/app" className="btn btn--primary">Open the command centre <span className="btn__arrow">→</span></a>
          <a href="/phone" className="btn btn--ghost">The manager’s phone</a>
        </div>
      </div>
    </section>
  )
}

export function Story() {
  // The story is public; the live world is not. Only a signed-in admin (or the open demo) gets the live log,
  // the event stream and the sponsor proofs. Everyone else reads the story with its built-in examples.
  const [live, setLive] = useState(false)
  useEffect(() => {
    api.me().then((m) => setLive(m.role === 'admin')).catch(() => setLive(false))
  }, [])
  useEffect(() => (live ? connectWorld() : undefined), [live])
  const loadBuilding = useBuilding((b) => b.load)
  const [publicName, setPublicName] = useState('')
  useEffect(() => {
    if (live) loadBuilding().catch(() => {})
    else api.building().then((b) => setPublicName(b.name)).catch(() => {})
  }, [live, loadBuilding])
  const buildingName = useBuilding((b) => b.spec?.name) ?? (publicName || 'one building')
  return (
    <div className="argus argus-page">
      <Nav />
      <main>
        <Hero />
        <How />
        <AgentField />
        <LiveState />
        <UnderTheHood live={live} />
        <Final />
      </main>
      <footer>
        <span>HAVEN · Cal Hacks 2026 · {buildingName}</span>
        <span className="mono">one world state · the Maya moment is sacred · logic first, beauty last</span>
      </footer>
    </div>
  )
}
