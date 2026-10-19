import { useEffect, useRef, useState } from 'react'
import { api, formatClockHM, formatCountdown, formatTimeOfDay } from '../lib/api'
import { speak, stopSpeaking } from '../lib/speak'
import { useBuilding } from '../state/building'
import type { ActionState, Clock, Plan, PlanStep, RuleParse, WorldState } from '../state/types'
import { connectWorld, useWorld } from '../state/world'

// ---- Web Speech API (same minimal typing as VoiceRule) ----------------------------------------

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((ev: { error?: string }) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function speechCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * The on-call manager's phone: the plan with reasons, a rule by voice, one Approve button.
 * Same world store as the command centre; nothing here is a second copy of the truth.
 */
export function Phone() {
  useEffect(() => connectWorld(), [])
  const loadBuilding = useBuilding((b) => b.load)
  useEffect(() => {
    loadBuilding().catch(() => {})
  }, [loadBuilding])
  const { connection, clock, world } = useWorld()

  return (
    <div className="min-h-full w-full">
      <div className="mx-auto flex min-h-screen w-full max-w-[430px] flex-col">
        {!world || !clock ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-t3">connecting to the world…</div>
        ) : (
          <PhoneBody world={world} clock={clock} connection={connection} />
        )}
      </div>
    </div>
  )
}

/** Who holds this phone: the manager (default) or a responder named in ?as=... (ra_4, staff, facilities, plumber). */
function whoAmI(): string {
  const as = new URLSearchParams(location.search).get('as')
  return as && /^[a-z_0-9]+$/.test(as) ? as : 'manager'
}

function PhoneBody({ world, clock, connection }: { world: WorldState; clock: Clock; connection: string }) {
  const roster = useBuilding((b) => b.residents)
  const buildingName = useBuilding((b) => b.spec?.name ?? '')
  const me = whoAmI()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (me !== 'manager') return <ResponderBody world={world} clock={clock} me={me} />
  const approved = world.approved_plan
  const plan: Plan = approved ?? world.plan
  const incident = plan.status !== 'none'
  const m = plan.metrics
  const affected = Number(m.residents_affected ?? 0)
  const leftBehind = plan.left_behind.length
  const violations = Number(m.violations ?? 0)
  const bad = plan.checks.filter((c) => !c.ok)
  const nameOf = (id: string) => roster[id]?.name ?? id
  const isApproved = approved != null && world.approved_plan_version === approved.version
  const replay = world.mode === 'replay'

  const decide = (decision: 'approve' | 'reject') => {
    setBusy(true)
    setError(null)
    const version = useWorld.getState().world?.plan.version ?? plan.version
    api
      .decidePlan(version, decision)
      .catch((e: Error) => setError(e.message.replace(/^.*→ \d+: /, '').replace(/^\{"detail":"|"\}$/g, '')))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <header className="glass sticky top-0 z-10 flex items-center gap-3 rounded-none border-x-0 border-t-0 px-4 py-3">
        <span className="text-[13px] font-semibold tracking-[0.18em] text-t1">HAVEN</span>
        <span className="truncate text-[11px] text-t3">{buildingName}</span>
        <span className="mono ml-auto text-[15px] font-semibold text-t1">{formatTimeOfDay(clock.time_of_day)}</span>
        <span
          className={`h-2 w-2 rounded-full ${connection === 'open' ? 'bg-haven-safe' : connection === 'connecting' ? 'bg-haven-amber' : 'bg-haven-danger'}`}
          style={{ boxShadow: connection === 'open' ? '0 0 8px rgba(48,209,88,0.6)' : undefined }}
          title={connection}
        />
      </header>

      <main className="flex flex-1 flex-col gap-3 px-3 pt-3 pb-28">
        <section className={`glass px-4 py-3.5 ${leftBehind > 0 ? 'tint-red' : ''}`}>
          <div className="flex items-center justify-between">
            <span className="eyebrow">{approved ? `Plan v${plan.version} · ${plan.status}` : incident ? `Plan v${plan.version} · draft` : 'Status'}</span>
            {replay && <span className="pill pill-amber pill-mono">REPLAY</span>}
          </div>
          <p className="mt-1.5 text-[17px] leading-snug font-semibold text-t1">{incident ? plan.headline || 'Working out the plan…' : world.narrative.headline || 'No incident.'}</p>
          {incident && world.narrative.detail && <p className="mt-1 text-[12px] leading-snug text-t2">{world.narrative.detail}</p>}
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Tile n={affected} label="affected" />
            <Tile n={leftBehind} label="left behind" hot={leftBehind > 0} />
            <Tile n={violations} label="violations" hot={violations > 0} />
          </div>
          {incident && <BriefRow />}
        </section>

        <RuleInput disabled={replay} rules={world.rules} />

        {incident && plan.checks.length > 0 && (
          <div className={`glass-card flex items-center gap-2 px-3.5 py-2.5 ${bad.length ? 'tint-red' : ''}`}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${bad.length ? 'bg-haven-danger haven-ring' : 'bg-haven-safe'}`} />
            <span className={`text-[12px] font-medium ${bad.length ? 'text-haven-danger' : 'text-t1'}`}>
              {bad.length ? `${bad.length} violation${bad.length === 1 ? '' : 's'}: ${bad.map((c) => c.label).join('; ')}` : `${plan.checks.length} checks pass`}
            </span>
          </div>
        )}

        {leftBehind > 0 && (
          <div className="glass-card tint-red px-3.5 py-3">
            <div className="text-[13px] font-semibold text-haven-danger">Left behind · {leftBehind}</div>
            <div className="mt-0.5 text-[13px] text-t1">{plan.left_behind.map(nameOf).join(', ')}</div>
            <div className="mt-0.5 text-[11px] text-t2">A hard need nobody in the negotiation spoke for.</div>
          </div>
        )}

        {incident && plan.steps.length > 0 && (
          <section className="glass px-3.5 py-3">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="eyebrow">Steps</span>
              <span className="mono text-[10px] text-t3">{plan.steps.length}</span>
            </div>
            <ol>
              {plan.steps.map((s) => (
                <StepRow key={s.id} step={s} clock={clock} base={plan.computed_step} action={approved ? world.actions[s.id] : undefined} />
              ))}
            </ol>
          </section>
        )}
        {error && <p className="px-1 text-[11px] text-haven-danger">{error}</p>}
      </main>

      {incident && (
        <div className="glass fixed bottom-0 left-1/2 z-10 w-full max-w-[430px] -translate-x-1/2 rounded-none rounded-t-2xl border-b-0 px-4 pt-3 pb-5">
          {isApproved ? (
            <div className="flex items-center gap-3">
              <div className="flex flex-1 items-center justify-center gap-2 rounded-[12px] bg-haven-safe/15 px-4 py-3 text-[14px] font-semibold text-haven-safe">
                <span>✓</span> Approved v{approved.version} · {approved.status}
              </div>
              <button className="text-[12px] text-t3 underline-offset-2 hover:text-t1 hover:underline" disabled={busy || replay} onClick={() => decide('reject')}>
                Reject
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <button className="btn-primary flex-1 py-3 text-[15px]" disabled={busy || replay} onClick={() => decide('approve')}>
                Approve plan v{plan.version}
              </button>
              <button className="text-[12px] text-t3 underline-offset-2 hover:text-t1 hover:underline" disabled={busy || replay} onClick={() => decide('reject')}>
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** A responder's phone: only their steps, with a Done button. A tap is a real acknowledgement, logged as
 *  an input event; a step nobody acknowledges is closed by the clock and labelled as such. */
function ResponderBody({ world, clock, me }: { world: WorldState; clock: Clock; me: string }) {
  const roster = useBuilding((b) => b.residents)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const approved = world.approved_plan
  const mine = (approved?.steps ?? []).filter((s) => s.actor.split(',').map((a) => a.trim()).includes(me))
  const name = world.actors[me]?.label ?? roster[me]?.name ?? me
  const brief = (approved ?? world.plan).messages.find((m) => m.to === me)
  const ack = (stepId: string, status: 'done' | 'failed') => {
    setBusy(stepId)
    setError(null)
    api
      .acknowledge(stepId, me, status)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null))
  }
  return (
    <>
      <header className="glass sticky top-0 z-10 flex items-center gap-3 rounded-none border-x-0 border-t-0 px-4 py-3">
        <span className="text-[13px] font-semibold tracking-[0.18em] text-t1">HAVEN</span>
        <span className="text-[11px] text-t3">{name}</span>
        <span className="mono ml-auto text-[15px] font-semibold text-t1">{formatTimeOfDay(clock.time_of_day)}</span>
      </header>
      <main className="flex flex-1 flex-col gap-3 px-3 pt-3 pb-10">
        {brief && (
          <section className="glass px-4 py-3.5">
            <span className="eyebrow">Your brief</span>
            <p className="mt-1.5 text-[14px] leading-snug text-t1">{brief.text}</p>
          </section>
        )}
        <section className="glass px-3.5 py-3">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="eyebrow">Your steps</span>
            <span className="mono text-[10px] text-t3">{approved ? `plan v${approved.version} · ${approved.status}` : 'no approved plan yet'}</span>
          </div>
          {mine.length === 0 && <p className="py-3 text-[12px] text-t3">Nothing assigned to you{approved ? '' : ' until the manager approves'}.</p>}
          <ol>
            {mine.map((s) => {
              const a = world.actions[s.id]
              const st = a?.status
              return (
                <li key={s.id} className="row flex items-start gap-2.5 py-2.5">
                  <span className={`mono mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${st === 'done' ? 'bg-haven-safe/20 text-haven-safe' : st === 'assigned' ? 'bg-haven-power/25 text-haven-power haven-pulse' : 'border border-white/15 text-t3'}`}>
                    {st === 'done' ? '✓' : st === 'assigned' ? '●' : s.order}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-snug text-t1">{s.title}</div>
                    <div className="mt-0.5 text-[11px] leading-snug text-t2">{s.reason}</div>
                    {a?.detail && <div className="mono mt-1 text-[10px] text-t3">{a.detail}</div>}
                    {st === 'assigned' && (
                      <div className="mt-2 flex gap-2">
                        <button className="btn-primary btn-sm" disabled={busy === s.id || world.mode === 'replay'} onClick={() => ack(s.id, 'done')}>
                          Done
                        </button>
                        <button className="btn-secondary btn-sm" disabled={busy === s.id || world.mode === 'replay'} onClick={() => ack(s.id, 'failed')}>
                          Could not
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
          {error && <p className="mt-2 text-[11px] text-haven-danger">{error}</p>}
        </section>
        <p className="px-1 text-[10px] text-t3">Open this phone as someone else: ?as=ra_3, ?as=staff, ?as=facilities, ?as=plumber. Steps nobody acknowledges close at their deadline, labelled as auto-confirmed.</p>
      </main>
    </>
  )
}

function Tile({ n, label, hot = false }: { n: number; label: string; hot?: boolean }) {
  return (
    <div className="glass-card px-2.5 py-2">
      <div className={`num text-[24px] leading-none ${hot ? 'text-haven-danger glow-red' : 'text-t1'}`}>{n}</div>
      <div className="label mt-1 leading-tight">{label}</div>
    </div>
  )
}

function BriefRow() {
  const [state, setState] = useState<'idle' | 'loading' | 'speaking'>('idle')
  const [source, setSource] = useState<string | null>(null)
  const run = async () => {
    if (state === 'speaking') {
      stopSpeaking()
      setState('idle')
      return
    }
    setState('loading')
    try {
      const b = await api.brief()
      setState('speaking')
      const via = await speak(b.text)
      setSource(`${b.source} · ${via}`)
    } catch (e) {
      setSource((e as Error).message)
    } finally {
      setTimeout(() => setState('idle'), 1500)
    }
  }
  return (
    <div className="mt-3 flex items-center gap-2">
      <button className="btn-secondary btn-sm" onClick={run} disabled={state === 'loading'}>
        {state === 'speaking' ? '■ Stop' : state === 'loading' ? '…' : '▶ Brief me'}
      </button>
      {source && <span className="mono text-[10px] text-t3">{source}</span>}
    </div>
  )
}

function StepRow({ step, clock, base, action }: { step: PlanStep; clock: Clock; base: number; action?: ActionState }) {
  const start = base * clock.dt + step.at_s
  const remaining = start - clock.sim_time
  const deadline = step.deadline_s != null ? base * clock.dt + step.deadline_s - clock.sim_time : null
  const status = action?.status
  return (
    <li className="row flex items-start gap-2.5 py-2">
      <span
        className={`mono mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
          status === 'done'
            ? 'bg-haven-safe/20 text-haven-safe'
            : status === 'failed'
              ? 'bg-haven-danger/20 text-haven-danger'
              : status === 'assigned'
                ? 'bg-haven-power/25 text-haven-power haven-pulse'
                : 'border border-white/15 text-t3'
        }`}
      >
        {status === 'done' ? '✓' : status === 'failed' ? '✕' : status === 'assigned' ? '●' : step.order}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-snug text-t1">{step.title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-t2">{step.reason}</div>
        <div className="mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-t3">
          <span>{step.actor}</span>
          {step.count > 0 && <span>· {step.count} people</span>}
          {status === 'done' && action ? (
            <span className="text-haven-safe">done {formatTimeOfDay(clock.time_of_day - (clock.step - action.step) * clock.dt)}</span>
          ) : (
            <>
              <span className="pill pill-mono">{remaining > 0 ? `in ${formatCountdown(remaining)}` : formatClockHM(clock.time_of_day + (start - clock.sim_time))}</span>
              {deadline != null && <span className={deadline < 120 && status !== 'done' ? 'text-haven-danger' : ''}>by {formatClockHM(clock.time_of_day + deadline)}</span>}
            </>
          )}
        </div>
      </div>
    </li>
  )
}

function RuleInput({ disabled, rules }: { disabled: boolean; rules: WorldState['rules'] }) {
  const [text, setText] = useState('')
  const [interim, setInterim] = useState('')
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RuleParse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const supported = speechCtor() !== null

  useEffect(() => () => recRef.current?.abort(), [])

  const submit = (phrase: string) => {
    const t = phrase.trim()
    if (!t || busy) return
    setBusy(true)
    setError(null)
    api
      .parseRule(t)
      .then((r) => {
        setResult(r)
        setText('')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const listen = () => {
    const Ctor = speechCtor()
    if (!Ctor) return
    if (listening) {
      recRef.current?.stop()
      return
    }
    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.interimResults = true
    rec.continuous = false
    let finalText = ''
    rec.onresult = (ev) => {
      let heard = ''
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i]
        heard += res[0].transcript
        if (res.isFinal) finalText = heard
      }
      setInterim(heard)
    }
    rec.onerror = (ev) => {
      setError(ev.error ? `speech: ${ev.error}` : 'speech recognition failed')
      setListening(false)
    }
    rec.onend = () => {
      setListening(false)
      setInterim('')
      if (finalText) submit(finalText)
    }
    recRef.current = rec
    setInterim('')
    setError(null)
    setListening(true)
    rec.start()
  }

  return (
    <section className="glass px-3.5 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="eyebrow">Say a rule</span>
        <span className="label">manager</span>
      </div>
      <div className="relative">
        <input
          value={listening ? interim : text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(text)
          }}
          disabled={disabled || listening}
          placeholder={listening ? 'Listening…' : supported ? 'Tap the mic, or type and press Return' : 'Type a rule and press Return'}
          className="input pr-12"
        />
        <button
          disabled={!supported || disabled}
          onClick={listen}
          aria-label={listening ? 'Stop listening' : 'Speak a rule'}
          className={`absolute top-1/2 right-1.5 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-white transition-all disabled:opacity-35 ${
            listening ? 'bg-haven-danger haven-ring' : 'bg-haven-blue hover:brightness-110'
          }`}
        >
          {listening ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <rect width="10" height="10" rx="2" />
            </svg>
          ) : (
            <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
              <rect x="3.5" y="0" width="5" height="8" rx="2.5" />
              <path d="M1 6.5a5 5 0 0 0 10 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M6 11.5v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>
      {result && (
        <div className={`glass-card mt-2 px-3 py-2 ${result.confident ? 'tint-green' : 'tint-amber'}`}>
          <div className={`eyebrow ${result.confident ? 'text-haven-safe' : 'text-haven-amber'}`}>{result.confident ? 'Rule in force' : 'Not understood · not enforced'}</div>
          <div className="mt-0.5 text-[12px] text-t1">“{result.text}”</div>
          <div className="mono mt-0.5 text-[10px] text-t2">{result.confident ? `${result.code} · ${result.summary}` : result.summary}</div>
        </div>
      )}
      {error && <p className="mt-1 text-[11px] text-haven-danger">{error}</p>}
      {rules.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {rules.map((r, i) => (
            <span key={`${r.code}-${i}`} className="pill pill-blue" title={r.code}>
              {r.rule}
              <span className="rounded-full bg-haven-blue/25 px-1.5 text-[9px] text-t1">{r.source}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
