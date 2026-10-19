import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useBuilding } from '../state/building'
import type { WorldState } from '../state/types'

/**
 * The guide: what this is, what each panel means, and what to click, in order. Opens by itself the
 * first time someone lands on a quiet building, and from the "?" button after that. The steps light
 * up from the world state, so it doubles as a checklist while the demo runs. Names come from the
 * roster and the spec: the first named resident is the one whose agent the demo toggles.
 */

const SEEN = 'haven.guide.seen'

export function useGuide(world: WorldState | null) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!world) return
    try {
      if (localStorage.getItem(SEEN) !== '1' && world.plan.status === 'none') setOpen(true)
    } catch {
      /* ignore */
    }
  }, [world == null])
  const close = () => {
    setOpen(false)
    try {
      localStorage.setItem(SEEN, '1')
    } catch {
      /* ignore */
    }
  }
  return { open, setOpen, close }
}

export function Guide({ world, onClose }: { world: WorldState; onClose: () => void }) {
  const spec = useBuilding((b) => b.spec)
  const heroId = useBuilding((b) => b.heroId)
  const residents = useBuilding((b) => b.residents)
  const hero = heroId ? residents[heroId] : undefined
  const first = hero?.name.split(' ')[0] ?? 'the first resident'
  const building = spec?.name ?? 'the building'
  const wet = world.wet_spaces.length > 0
  const planned = world.plan.status !== 'none'
  const heroOff = heroId != null && world.agents[`resident:${heroId}`] === false
  const ruled = world.rules.length > 0
  const approved = world.approved_plan != null
  const acted = Object.values(world.actions).some((a) => a.status === 'done')
  const steps: { n: number; title: string; what: string; where: string; done: boolean }[] = [
    { n: 1, title: 'A sensor detects water', what: 'Press Simulate leak (or drip on the ESP32 probe). The reading is the first input event in the log.', where: 'Top bar, Simulate leak', done: wet },
    { n: 2, title: 'HAVEN traces the chain', what: 'One dependency graph: riser to switchgear to lifts to floors to the fridges. The forecast says what fails and when; the story strip says it in words.', where: 'Story strip; Cascade tab; the building', done: world.forecast.events.length > 0 },
    { n: 3, title: 'The agents negotiate', what: `Safety wants the power cut now. ${first}’s agent vetoes: ${hero?.story ?? 'a hard need the naive plan ignores.'} The plan reroutes.`, where: 'The agents: How they argued', done: planned },
    { n: 4, title: `The ${first} moment`, what: `Switch ${first}’s agent off. Nobody speaks for ${first}; the plan leaves them behind and says so. Switch it back on.`, where: 'Story strip, the switch; or the first agent card', done: heroOff || (planned && world.timeline.some((t) => t.kind === 'agent_toggle')) },
    { n: 5, title: 'The manager governs by voice', what: 'Say or type “Nobody gets moved off campus”. It becomes a hard rule every agent re-plans under.', where: 'Left column, Say a rule', done: ruled },
    { n: 6, title: 'A human approves', what: 'Nothing fires without it. Approve on the story strip, the plan panel or the manager’s phone.', where: 'Approve', done: approved },
    { n: 7, title: 'HAVEN acts', what: 'Plumber called, breakers opened at the safe moment, medication moved, every person messaged in their language. Responders acknowledge from their phones.', where: 'Messages tab; Responder’s phone', done: acted },
  ]
  const panels: [string, string][] = [
    ['Story strip', 'What is happening, what it means and for whom, what the agents propose, and what you should do now: the backend’s own words, shared by every screen. The stage rail above it is lit by facts, not timers.'],
    ['Stage', 'The building: the 3D twin (a night scene; every window shows whether its room has power) or a 2D floor plan. Water, dark floors, routes, people and responders are drawn from the live world state. Click anything for its record; Connections draws what powers and feeds what.'],
    ['Left column', 'Inputs to the world: the sensor, the valve and breaker levers, a spoken rule, and the ledger of who is affected.'],
    ['Plan', 'The negotiated plan: steps with times and reasons, the checker’s verdicts, Approve.'],
    ['The agents', 'Who speaks and what each says; how they argued, round by round; the hard rules and whether the plan holds them, with the red team’s attacks.'],
    ['Messages', 'The outbox: one message per person, in their language, timed to a step.'],
    ['Cascade', 'What fails next and when, then what has happened.'],
    ['Buds', 'The companion: hold Ctrl+Alt and ask anything; it points at the answer and only acts after you approve.'],
  ]
  return (
    <div className="guide-backdrop" onClick={onClose}>
      <div className="guide glass" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Guide">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">HAVEN · what this is</div>
            <h2 className="mt-1 text-[20px] leading-tight font-semibold text-t1">A building fails as one system. The response shouldn’t come from four teams.</h2>
            <p className="mt-2 text-[13px] text-t2">
              A $4 water sensor in the basement of {building} detects a leak. HAVEN traces the chain through one shared dependency graph, lets specialist agents and a personal agent for every resident negotiate a plan under hard safety and accessibility constraints, takes a rule from the manager by voice, and acts on approval. Every screen is a view of one event-sourced world. Nobody gets left behind.
            </p>
          </div>
          <button className="btn-secondary btn-icon shrink-0" onClick={onClose} aria-label="Close guide">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-[1.3fr_1fr] gap-5">
          <div>
            <div className="eyebrow mb-2">The two-minute demo, in order</div>
            <ol className="space-y-2">
              {steps.map((s) => (
                <li key={s.n} className={`glass-card flex gap-3 px-3 py-2.5 ${s.done ? 'tint-green' : ''}`}>
                  <span className={`mono mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${s.done ? 'bg-haven-safe text-white' : 'bg-haven-blue/10 text-haven-blue'}`}>{s.done ? '✓' : s.n}</span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-t1">{s.title}</div>
                    <div className="mt-0.5 text-[12px] text-t2">{s.what}</div>
                    <div className="mt-0.5 text-[11px] text-t3">Where: {s.where}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <div className="eyebrow mb-2">What each panel is</div>
            <ul className="space-y-1.5">
              {panels.map(([k, v]) => (
                <li key={k} className="text-[12px]">
                  <span className="font-semibold text-t1">{k}.</span> <span className="text-t2">{v}</span>
                </li>
              ))}
            </ul>
            <div className="eyebrow mt-4 mb-2">Keys</div>
            <ul className="space-y-1 text-[12px] text-t2">
              <li>
                <span className="mono text-t1">T</span> hide or show the left column · <span className="mono text-t1">N</span> the right column
              </li>
              <li>
                <span className="mono text-t1">Ctrl+Alt</span> hold to talk to Buds · <span className="mono text-t1">Alt+C</span> its chat · <span className="mono text-t1">Alt+B</span> on/off
              </li>
              <li>
                <span className="mono text-t1">?</span> this guide
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-between">
          <span className="text-[11px] text-t3">What is real: the sensor, the physics, the negotiation, the human gate, the messages. Synthetic: the building and the roster. The README has the full table.</span>
          <button className="btn-primary" onClick={onClose}>
            Start
          </button>
        </div>
      </div>
    </div>
  )
}
