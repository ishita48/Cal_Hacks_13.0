import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleAlert, Droplets, Fuel, Gauge, ShieldAlert, Wrench, Zap } from 'lucide-react'
import { api } from '../lib/api'
import { useBuilding } from '../state/building'
import type { OpsFinding, OpsHealth, OpsSnapshot, WorldState } from '../state/types'
import { select } from './Inspector'

/**
 * Operations: the building on an ordinary night, and what HAVEN knows before anything breaks.
 * Energy (load now, by floor, the day's curve, cost and carbon, the standby generator), plant health
 * from the maintenance log, and the resilience audit: every piece of electrical plant failed in the
 * dependency graph, ranked by who it would strand. The findings it implies become work orders.
 * All of it comes from GET /api/ops (backend/haven/world/operations.py); the drill button sends the
 * same sensor event the ESP32 sends.
 */

const SEV: Record<OpsFinding['severity'], { label: string; cls: string; Icon: typeof AlertTriangle }> = {
  critical: { label: 'Critical', cls: 'pill-red', Icon: ShieldAlert },
  serious: { label: 'Serious', cls: 'pill-orange', Icon: AlertTriangle },
  warning: { label: 'Warning', cls: 'pill-amber', Icon: CircleAlert },
}

export function OpsView({ world, onDrill }: { world: WorldState; onDrill: (kind: 'flood' | 'grid' | 'generator') => void }) {
  const [ops, setOps] = useState<OpsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const version = world.version
  const last = useRef(0)
  useEffect(() => {
    // Refresh when the world changes, at most every 3 s (the energy figures move with the clock).
    const now = performance.now()
    const wait = Math.max(0, 3000 - (now - last.current))
    const t = setTimeout(() => {
      last.current = performance.now()
      api.ops().then(setOps).catch((e: Error) => setError(e.message))
    }, wait)
    return () => clearTimeout(t)
  }, [version])

  if (!ops) return <div className="glass flex h-64 items-center justify-center text-[12px] text-t3">{error ?? 'Reading the meters and the maintenance log…'}</div>
  const e = ops.energy
  const s = ops.summary
  const critical = ops.findings.filter((f) => f.severity === 'critical')
  const room = ops.audit.rooms[0]
  const quiet = world.narrative.stage === 'quiet'

  return (
    <div className="flex flex-col gap-3">
      {/* what a facilities manager needs to know tonight, in one sentence */}
      <section className="glass flex flex-wrap items-center gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Operations · {ops.date}</div>
          <p className="story-headline mt-1">
            {quiet ? 'Normal night.' : 'Incident in progress.'} {e.now_kw.toFixed(0)} kW now, {s.overdue} of {s.plant} plant items overdue for service.
          </p>
          {room && (
            <p className="story-detail">
              The audit's worst case: {Math.round(room.depth_m * 100)} cm of water in the {room.name.toLowerCase()} takes out {room.fails.join(' and ')}, darkens floors{' '}
              {room.impact.dark_levels.map((lv) => lv.replace(/^L/, '')).join(', ')} and strands {room.impact.stranded} wheelchair user{room.impact.stranded === 1 ? '' : 's'}.
              {critical.length > 0 && ` ${critical.length} critical finding${critical.length === 1 ? '' : 's'} below would close it.`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-t3">{quiet ? 'Run a drill:' : ''}</span>
          <button className="argus-btn flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-40" onClick={() => onDrill('flood')} disabled={world.mode === 'replay'} title="Trip the basement water sensor: the agents plan the response live. The drill-and-compliance use of HAVEN.">
            <Droplets className="h-4 w-4" /> {quiet ? 'Riser burst' : 'Open the incident'}
          </button>
          {quiet && (
            <>
              <button className="btn-secondary" onClick={() => onDrill('grid')} disabled={world.mode === 'replay'} title="The utility feed fails: the generator carries the lifts and life safety, the floors go dark">
                <Zap className="h-3.5 w-3.5" /> Grid outage
              </button>
              <button className="btn-secondary" onClick={() => onDrill('generator')} disabled={world.mode === 'replay'} title="The standby generator trips: no power for the lifts and life safety">
                <Fuel className="h-3.5 w-3.5" /> Generator trips
              </button>
            </>
          )}
        </div>
      </section>

      {/* KPIs */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi Icon={Zap} value={`${e.now_kw.toFixed(0)} kW`} label="load now" sub={`evening peak ${e.peak_kw.toFixed(0)} kW at ${String(e.peak_hour).padStart(2, '0')}:00`} />
        <Kpi Icon={Gauge} value={`${(e.today_kwh / 1000).toFixed(1)} MWh`} label="energy today" sub={`$${e.today_usd.toLocaleString()} · ${(e.today_co2_kg / 1000).toFixed(1)} t CO₂`} />
        <Kpi Icon={Fuel} value={e.standby ? `${e.standby.runtime_h ?? '—'} h` : '—'} label="standby runtime" sub={e.standby ? `${e.standby.fuel_pct}% fuel · carries ${e.standby.load_kw} kW${e.standby.running ? ' · RUNNING' : ''}` : 'no generator'} tone={e.standby?.running ? 'warn' : undefined} />
        <Kpi Icon={Wrench} value={`${s.overdue}`} label="overdue for service" sub={`of ${s.plant} plant items`} tone={s.overdue ? 'warn' : 'ok'} />
        <Kpi Icon={ShieldAlert} value={`${s.critical_findings}`} label="critical findings" sub={`${s.open_findings} with no work order`} tone={s.critical_findings ? 'bad' : 'ok'} />
        <Kpi Icon={AlertTriangle} value={`${s.single_points}`} label="single points of failure" sub="one item fails, someone is stranded" tone={s.single_points ? 'bad' : 'ok'} />
      </section>

      {/* energy */}
      <section className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="glass p-4">
          <ChartHead title="Building load today" note={`kW, hourly · ${e.tariff_usd_kwh ? `$${e.tariff_usd_kwh}/kWh` : ''}`} />
          <LoadCurve curve={e.curve_kw} hour={e.hour} nowKw={e.now_kw} />
        </div>
        <div className="glass p-4">
          <ChartHead title="Load by floor, now" note="kW · a dark floor draws nothing" />
          <FloorBars floors={e.floors} dark={e.dark_levels} />
        </div>
      </section>

      {/* findings and the audit */}
      <section className="grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="glass p-4">
          <ChartHead title="Findings · what to fix this month" note="from the resilience audit and the maintenance log" />
          <ul className="mt-2 space-y-2">
            {ops.findings.map((f) => (
              <FindingRow key={f.id} f={f} replay={world.mode === 'replay'} />
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-3">
          <div className="glass p-4">
            <ChartHead title="Resilience audit · if this one item fails" note="each failed in the dependency graph" />
            <AuditTable ops={ops} />
          </div>
          {e.standby && (
            <div className="glass p-4">
              <ChartHead title="What the standby generator carries" note={`${e.standby.rated_kw} kW rated`} />
              <ul className="mt-2 space-y-1.5">
                {e.standby.carries.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-[12px]">
                    <button className="truncate text-left text-t1 hover:underline" onClick={() => select({ kind: 'equipment', id: c.id })}>
                      {c.name}
                    </button>
                    <span className="mono ml-auto text-t2">{c.kw} kW</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-t3">Floor lighting, outlets and fridges are not on standby: when a floor panel loses its feed, those rooms go dark.</p>
            </div>
          )}
        </div>
      </section>

      <section className="glass p-4">
        <ChartHead title="Plant health" note="condition from age and service history; click a row for its record" />
        <HealthTable rows={ops.health} />
      </section>
    </div>
  )
}

function Kpi({ Icon, value, label, sub, tone }: { Icon: typeof Zap; value: string; label: string; sub: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-haven-danger' : tone === 'warn' ? 'text-haven-amber' : tone === 'ok' ? 'text-haven-safe' : 'text-t1'
  return (
    <div className="glass px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] text-t3">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`num mt-1 text-[24px] leading-none ${color}`}>{value}</div>
      <div className="mt-1 truncate text-[11px] text-t3" title={sub}>
        {sub}
      </div>
    </div>
  )
}

function ChartHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="text-[13px] font-semibold text-t1">{title}</span>
      {note && <span className="text-[11px] text-t3">{note}</span>}
    </div>
  )
}

/** A single-series area over the day, the current hour marked; hover shows the hour's load. */
function LoadCurve({ curve, hour, nowKw }: { curve: number[]; hour: number; nowKw: number }) {
  const W = 640
  const H = 200
  const pad = { l: 40, r: 12, t: 12, b: 24 }
  const max = Math.max(...curve, nowKw) * 1.1
  const x = (h: number) => pad.l + (h / 24) * (W - pad.l - pad.r)
  const y = (kw: number) => pad.t + (1 - kw / max) * (H - pad.t - pad.b)
  const pts = curve.map((kw, i) => [x(i + 0.5), y(kw)] as const)
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
  const area = `${line} L${x(23.5)},${y(0)} L${x(0.5)},${y(0)} Z`
  const ticks = useMemo(() => {
    const step = max > 600 ? 200 : max > 300 ? 100 : 50
    const out = []
    for (let v = 0; v <= max; v += step) out.push(v)
    return out
  }, [max])
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div className="relative mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Building load over the day" onMouseLeave={() => setHover(null)}
        onMouseMove={(ev) => {
          const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = ((ev.clientX - r.left) / r.width) * W
          const h = Math.floor(((px - pad.l) / (W - pad.l - pad.r)) * 24)
          setHover(h >= 0 && h < 24 ? h : null)
        }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border-soft)" />
            <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--ink-3)">{v}</text>
          </g>
        ))}
        {[0, 6, 12, 18, 24].map((h) => (
          <text key={h} x={x(h)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--ink-3)">{String(h % 24).padStart(2, '0')}:00</text>
        ))}
        <path d={area} fill="var(--argus-blue)" opacity={0.12} />
        <path d={line} fill="none" stroke="var(--argus-blue)" strokeWidth={2} strokeLinejoin="round" />
        <line x1={x(hour)} x2={x(hour)} y1={pad.t} y2={y(0)} stroke="var(--ink-2)" strokeDasharray="3 3" />
        <circle cx={x(hour)} cy={y(nowKw)} r={5} fill="var(--argus-blue)" stroke="var(--surface)" strokeWidth={2} />
        <text x={x(hour) - 6} y={pad.t + 10} textAnchor="end" fontSize={10} fill="var(--ink-2)">now · {nowKw.toFixed(0)} kW</text>
        {hover != null && (
          <g>
            <line x1={x(hover + 0.5)} x2={x(hover + 0.5)} y1={pad.t} y2={y(0)} stroke="var(--border-strong)" />
            <circle cx={x(hover + 0.5)} cy={y(curve[hover])} r={4} fill="var(--argus-blue)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="glass-card pointer-events-none absolute top-1 px-2.5 py-1.5 text-[11px]" style={{ left: `${((x(hover + 0.5) / W) * 100).toFixed(1)}%`, transform: 'translateX(-50%)' }}>
          <span className="mono text-t3">{String(hover).padStart(2, '0')}:00</span> <span className="font-semibold text-t1">{curve[hover].toFixed(0)} kW</span>
        </div>
      )}
    </div>
  )
}

/** Horizontal bars, one per level, top floor first; a dark floor shows an empty bar labelled "dark". */
function FloorBars({ floors, dark }: { floors: Record<string, number>; dark: string[] }) {
  const levels = useBuilding((b) => b.levels)
  const rows = Object.entries(floors).sort((a, b) => (levels[b[0]]?.index ?? 0) - (levels[a[0]]?.index ?? 0))
  const max = Math.max(1, ...rows.map(([, v]) => v))
  const [hover, setHover] = useState<string | null>(null)
  return (
    <ul className="mt-3 space-y-1.5">
      {rows.map(([lv, kw]) => {
        const isDark = dark.includes(lv)
        return (
          <li key={lv} className="flex items-center gap-2 text-[12px]" onMouseEnter={() => setHover(lv)} onMouseLeave={() => setHover(null)}>
            <span className="mono w-8 shrink-0 text-t2">{lv}</span>
            <span className="relative h-4 flex-1 rounded-[4px] bg-[var(--chip-bg)]">
              <span className="absolute inset-y-0 left-0 rounded-[4px] transition-[width] duration-500" style={{ width: `${(kw / max) * 100}%`, background: 'var(--argus-blue)', opacity: hover && hover !== lv ? 0.45 : 1 }} />
            </span>
            <span className={`mono w-16 shrink-0 text-right ${isDark ? 'font-semibold text-haven-danger' : 'text-t1'}`}>{isDark ? 'dark' : `${kw.toFixed(0)} kW`}</span>
          </li>
        )
      })}
    </ul>
  )
}

function FindingRow({ f, replay }: { f: OpsFinding; replay: boolean }) {
  const sev = SEV[f.severity]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wo = f.work_order
  const file = (status: 'open' | 'done') => {
    setBusy(true)
    setError(null)
    api
      .workOrder(f.id, status)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  return (
    <li className={`glass-card px-3 py-2.5 ${f.severity === 'critical' && !wo ? 'tint-red' : ''}`}>
      <div className="flex items-start gap-2">
        <span className={`pill ${sev.cls} shrink-0`}>
          <sev.Icon className="h-3 w-3" />
          {sev.label}
        </span>
        <div className="min-w-0 flex-1">
          <button className="text-left text-[13px] font-semibold text-t1 hover:underline" onClick={() => f.equipment && select({ kind: 'equipment', id: f.equipment })}>
            {f.title}
          </button>
          <p className="mt-0.5 text-[12px] leading-snug text-t2">{f.why}</p>
          {wo ? (
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-haven-safe">
              <CheckCircle2 className="h-3.5 w-3.5" /> Work order {wo.status === 'done' ? 'closed' : 'open'} · {wo.detail}
              {wo.status === 'open' && (
                <button className="ml-2 text-haven-blue hover:underline" disabled={busy || replay} onClick={() => file('done')}>
                  mark done
                </button>
              )}
            </p>
          ) : null}
          {error && <p className="mt-1 text-[11px] text-haven-danger">{error}</p>}
        </div>
        {!wo && (
          <button className="btn-secondary btn-sm shrink-0" disabled={busy || replay} onClick={() => file('open')}>
            {busy ? '…' : 'File work order'}
          </button>
        )}
      </div>
    </li>
  )
}

function AuditTable({ ops }: { ops: OpsSnapshot }) {
  const rows = ops.audit.single.slice(0, 7)
  return (
    <table className="mt-2 w-full text-[12px]">
      <thead>
        <tr className="text-left text-[10.5px] text-t3">
          <th className="pb-1 font-medium">Item</th>
          <th className="pb-1 text-right font-medium">Dark floors</th>
          <th className="pb-1 text-right font-medium">In the dark</th>
          <th className="pb-1 text-right font-medium">Meds · devices</th>
          <th className="pb-1 text-right font-medium">Stranded</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="row cursor-pointer hover:bg-[var(--hover-bg)]" onClick={() => select({ kind: 'equipment', id: r.id })}>
            <td className="py-1.5 pr-2 text-t1">{r.name}</td>
            <td className="mono py-1.5 text-right text-t2">{r.impact.dark_levels.length || '—'}</td>
            <td className="mono py-1.5 text-right text-t2">{r.impact.on_dark_floors || '—'}</td>
            <td className={`mono py-1.5 text-right ${r.impact.medication + r.impact.device_power ? 'text-haven-amber' : 'text-t2'}`}>{r.impact.medication + r.impact.device_power || '—'}</td>
            <td className={`mono py-1.5 text-right ${r.impact.stranded ? 'font-semibold text-haven-danger' : 'text-t2'}`}>{r.impact.stranded || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function HealthTable({ rows }: { rows: OpsHealth[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 10)
  return (
    <>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12px]">
          <thead>
            <tr className="text-left text-[10.5px] text-t3">
              <th className="pb-1 font-medium">Item</th>
              <th className="pb-1 font-medium">Where</th>
              <th className="pb-1 font-medium">Condition</th>
              <th className="pb-1 font-medium">Last service</th>
              <th className="pb-1 font-medium">Due</th>
              <th className="pb-1 font-medium">Task</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((h) => (
              <tr key={h.id} className="row cursor-pointer hover:bg-[var(--hover-bg)]" onClick={() => select({ kind: 'equipment', id: h.id })}>
                <td className="py-1.5 pr-2 text-t1">{h.name}</td>
                <td className="mono py-1.5 pr-2 text-t3">{h.level}</td>
                <td className="py-1.5 pr-2">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-16 rounded-full bg-[var(--chip-bg)]">
                      <span className="block h-full rounded-full" style={{ width: `${h.condition}%`, background: h.condition < 50 ? 'var(--c-danger)' : h.condition < 75 ? 'var(--c-amber)' : 'var(--c-safe)' }} />
                    </span>
                    <span className="mono text-t2">{h.condition}</span>
                  </span>
                </td>
                <td className="mono py-1.5 pr-2 text-t2">{h.last_service ?? '—'}</td>
                <td className={`py-1.5 pr-2 ${h.overdue_days ? 'font-semibold text-haven-danger' : 'text-t2'}`}>{h.overdue_days ? `${h.overdue_days} d overdue` : (h.next_due ?? '—')}</td>
                <td className="py-1.5 text-t3">{h.task ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 10 && (
        <button className="btn-secondary btn-sm mt-2" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </>
  )
}
