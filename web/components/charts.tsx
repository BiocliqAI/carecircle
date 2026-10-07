"use client";
// Lightweight SVG charts (no chart library dependency).
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dayKey, fmtDate } from "@/lib/time";

/** True inside an enlarged (popped-out) chart: charts draw taller so the extra width isn't just bigger text. */
const ChartZoom = createContext(false);
const ZOOM_H = 1.8;

/** A chart card that opens larger in an overlay on click (or Enter/Space). Esc, ✕ or a click outside closes it. */
export function ChartCard({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open]);
  return (
    <>
      <div className="card chart-card" role="button" tabIndex={0} aria-label={`${label}: open larger`}
        onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a, input, select")) setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}>
        {children}
        <span className="chart-card-hint" aria-hidden>⤢</span>
      </div>
      {open && createPortal(
        <div className="chart-pop" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="card chart-pop-box">
            <button type="button" className="chart-pop-x" onClick={() => setOpen(false)} aria-label="Close" autoFocus>✕</button>
            <ChartZoom.Provider value={true}>{children}</ChartZoom.Provider>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export interface Pt {
  t: number;
  v1: number;
  v2?: number | null;
  flag?: string | null;
}

export interface Marker { t: number; label: string; color?: string; row?: number; title?: string }

/** Medicine changes (including other doctors') as chart markers, so cause and effect is visible. Rejected ones are left out. */
export function medMarkers(changes: { at: number; med_name: string; change: string; new_dose?: string | null; prescriber?: string | null; status: string }[], from: number, to: number): Marker[] {
  const live = changes.filter((c) => c.status !== "REJECTED" && c.at >= from && c.at <= to).sort((a, b) => a.at - b.at);
  const byDay = new Map<string, typeof live>();
  for (const c of live) byDay.set(dayKey(c.at), [...(byDay.get(dayKey(c.at)) ?? []), c]);
  const word = (c: (typeof live)[number]) => {
    const w = c.med_name.split(/[\s(]/)[0];
    return c.change === "started" ? `+${w}` : c.change === "stopped" ? `−${w}` : c.change === "dose_changed" ? `${w} ↕` : w;
  };
  // Several changes on one day are one marker ("+Aldactone +3"), with every change in its tooltip.
  return [...byDay.values()].map((day, i) => ({
    t: day[0].at, row: 1 + (i % 3), color: "#b45309",
    label: day.length > 1 ? `${word(day[0])} +${day.length - 1}` : word(day[0]),
    title: day.map((c) => `${c.med_name}: ${c.change.replace("_", " ")}${c.new_dose ? ` → ${c.new_dose}` : ""}${c.prescriber ? ` · ${c.prescriber}` : ""}`).join("\n") + `\n${fmtDate(day[0].at, { day: "numeric", month: "short" })}`,
  }));
}

interface Props {
  series: Pt[];
  from: number;
  to: number;
  lines?: { y: number; label: string; color?: string }[];
  markers?: Marker[];
  dual?: boolean;
  height?: number;
  unit?: string;
  color?: string;
  color2?: string;
  /** Names for the two lines of a dual chart, shown under it (e.g. ["Intake", "Urine"]). */
  legend?: [string, string];
  /** For daily logs: leave a gap in the line where this many days or more have nothing, instead of bridging it. */
  breakGapDays?: number;
}

export function LineChart({ series, from, to, lines = [], markers = [], dual, height = 200, unit = "", color = "#0f766e", color2 = "#7c3aed", legend, breakGapDays }: Props) {
  const zoom = useContext(ChartZoom);
  const W = 760, H = zoom ? Math.round(height * ZOOM_H) : height, L = 44, R = 12, T = 14, B = 26;
  const vals = [...series.map((p) => p.v1), ...(dual ? series.filter((p) => p.v2 != null).map((p) => p.v2!) : []), ...lines.map((l) => l.y)];
  if (!series.length) return <div className="empty">No readings in this period</div>;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.12, 1);
  lo = Math.floor(lo - pad);
  hi = Math.ceil(hi + pad);
  const x = (t: number) => L + ((t - from) / Math.max(1, to - from)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / Math.max(1e-6, hi - lo)) * (H - T - B);
  const gap = breakGapDays ? breakGapDays * 86400000 : Infinity;
  const path = (get: (p: Pt) => number, pts: Pt[] = series) => pts.map((p, i) => `${i && p.t - pts[i - 1].t < gap ? "L" : "M"}${x(p.t).toFixed(1)},${y(get(p)).toFixed(1)}`).join(" ");
  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) * i) / ticks);
  const days = Math.max(1, Math.round((to - from) / 86400000));
  const step = days > 300 ? 60 : days > 120 ? 30 : days > 40 ? 14 : days > 14 ? 7 : days > 6 ? 2 : 1; // about 8 date labels, never crowded
  const xTicks: number[] = [];
  for (let t = from; t <= to; t += step * 86400000) xTicks.push(t);
  const chart = (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img">
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#eef2f6" />
          <text x={L - 6} y={y(v) + 4} fontSize="10" textAnchor="end" fill="#7a8899">
            {Math.round(v * 10) / 10}
          </text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <text key={i} x={x(t)} y={H - 8} fontSize="10" textAnchor="middle" fill="#7a8899">
          {fmtDate(t, { day: "numeric", month: "short" })}
        </text>
      ))}
      {lines.map((l, i) => (
        <g key={i}>
          <line x1={L} x2={W - R} y1={y(l.y)} y2={y(l.y)} stroke={l.color || "#ef4444"} strokeDasharray="5 4" strokeWidth="1.2" />
          <text x={W - R - 2} y={y(l.y) - 4} fontSize="10" textAnchor="end" fill={l.color || "#ef4444"}>
            {l.label}
          </text>
        </g>
      ))}
      {markers.filter((m) => m.t >= from && m.t <= to).map((m, i) => (
        <g key={i}>
          <title>{m.title ?? m.label}</title>
          <line x1={x(m.t)} x2={x(m.t)} y1={T} y2={H - B} stroke={m.color || "#0f766e"} strokeDasharray="2 3" />
          <text x={x(m.t) + 3} y={T + 9 + (m.row ?? 0) * 11} fontSize="10" fill={m.color || "#0f766e"}>
            {m.label}
          </text>
        </g>
      ))}
      <path d={path((p) => p.v1)} fill="none" stroke={color} strokeWidth="2" />
      {dual && <path d={path((p) => p.v2!, series.filter((p) => p.v2 != null))} fill="none" stroke={color2} strokeWidth="2" />}
      {series.map((p, i) => (
        <g key={i}>
          <circle cx={x(p.t)} cy={y(p.v1)} r={p.flag ? 4.5 : 2.6} fill={p.flag ? "#ef4444" : color}>
            <title>{legend
              ? `${fmtDate(p.t, { day: "numeric", month: "short" })}: ${legend[0]} ${p.v1}${p.v2 != null ? `, ${legend[1]} ${p.v2}` : ""} ${unit}`
              : `${fmtDate(p.t, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}: ${p.v1}${dual && p.v2 != null ? "/" + p.v2 : ""} ${unit}`}</title>
          </circle>
          {dual && p.v2 != null && <circle cx={x(p.t)} cy={y(p.v2)} r={p.flag ? 4 : 2.3} fill={p.flag ? "#ef4444" : color2}><title>{`${fmtDate(p.t, { day: "numeric", month: "short" })}: ${legend ? `${legend[1]} ` : ""}${p.v2} ${unit}`}</title></circle>}
        </g>
      ))}
    </svg>
  );
  if (!legend) return chart;
  return (
    <div>
      {chart}
      <div className="chart-legend">
        <span><i style={{ background: color }} />{legend[0]}</span>
        <span><i style={{ background: color2 }} />{legend[1]}</span>
      </div>
    </div>
  );
}

export function Sparkline({ values, color = "#0f766e", w = 90, h = 26 }: { values: number[]; color?: string; w?: number; h?: number }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / Math.max(1e-6, hi - lo)) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

export interface ComboProps {
  from: number;
  to: number;
  line?: { pts: { t: number; v: number; flag?: string | null }[]; unit: string; color?: string; band?: [number, number]; label?: string };
  bars?: { pts: { t: number; v: number }[]; unit: string; color: string; label: string }[];
  barLines?: { y: number; label: string; color?: string }[];
  markers?: Marker[];
  height?: number;
}

/** Line (left axis) + grouped daily bars (right axis). Used for weight vs diuretic dose and fluid in/out. */
export function ComboChart({ from, to, line, bars = [], barLines = [], markers = [], height = 230 }: ComboProps) {
  const zoom = useContext(ChartZoom);
  const W = 760, H = zoom ? Math.round(height * ZOOM_H) : height, L = 44, R = 46, T = 16, B = 26;
  const hasLine = !!line && line.pts.length > 0;
  const hasBars = bars.some((b) => b.pts.length);
  if (!hasLine && !hasBars) return <div className="empty">No data in this period</div>;
  const x = (t: number) => L + ((t - from) / Math.max(1, to - from)) * (W - L - R);
  // left axis (line)
  let lo = 0, hi = 1;
  if (hasLine) {
    const vs = [...line!.pts.map((p) => p.v), ...(line!.band ?? [])];
    lo = Math.min(...vs);
    hi = Math.max(...vs);
    const pad = Math.max((hi - lo) * 0.12, 0.5);
    lo = Math.floor((lo - pad) * 2) / 2;
    hi = Math.ceil((hi + pad) * 2) / 2;
  }
  const y = (v: number) => T + (1 - (v - lo) / Math.max(1e-6, hi - lo)) * (H - T - B);
  // right axis (bars)
  const bmax = Math.max(1, ...bars.flatMap((b) => b.pts.map((p) => p.v)), ...barLines.map((l) => l.y)) * 1.1;
  const yb = (v: number) => H - B - (v / bmax) * (H - T - B);
  const dayW = ((W - L - R) / Math.max(1, (to - from) / 86400000)) * 0.8;
  const bw = Math.max(1.2, Math.min(14, dayW / Math.max(1, bars.length)));
  const days = Math.max(1, Math.round((to - from) / 86400000));
  const step = days > 300 ? 60 : days > 120 ? 30 : days > 40 ? 14 : days > 14 ? 7 : 2;
  const xTicks: number[] = [];
  for (let t = from; t <= to; t += step * 86400000) xTicks.push(t);
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  const bTicks = Array.from({ length: 5 }, (_, i) => (bmax * i) / 4);
  const fmtX = (t: number) => fmtDate(t, days > 120 ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" });
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img">
        {hasLine &&
          yTicks.map((v, i) => (
            <g key={i}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#eef2f6" />
              <text x={L - 6} y={y(v) + 4} fontSize="10" textAnchor="end" fill="#7a8899">{Math.round(v * 10) / 10}</text>
            </g>
          ))}
        {hasBars &&
          bTicks.map((v, i) => (
            <text key={i} x={W - R + 6} y={yb(v) + 4} fontSize="10" fill="#9aa6b2">{Math.round(v)}</text>
          ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={H - 8} fontSize="10" textAnchor="middle" fill="#7a8899">{fmtX(t)}</text>
        ))}
        {hasLine && line!.band && <rect x={L} width={W - L - R} y={y(line!.band[1])} height={Math.max(0, y(line!.band[0]) - y(line!.band[1]))} fill="#0f766e" opacity="0.08" />}
        {hasLine && line!.band && <text x={L + 4} y={y(line!.band[1]) - 3} fontSize="10" fill="#0f766e">target band {line!.band[0]}–{line!.band[1]} {line!.unit}</text>}
        {bars.map((b, bi) =>
          b.pts.map((p, i) => (
            <rect key={`${bi}-${i}`} x={x(p.t) - (bw * bars.length) / 2 + bi * bw} y={yb(p.v)} width={bw * 0.92} height={Math.max(0, H - B - yb(p.v))} fill={b.color} opacity="0.55">
              <title>{`${fmtDate(p.t, { day: "numeric", month: "short", year: "numeric" })}: ${b.label} ${p.v} ${b.unit}`}</title>
            </rect>
          )),
        )}
        {barLines.map((l, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={yb(l.y)} y2={yb(l.y)} stroke={l.color || "#ef4444"} strokeDasharray="5 4" strokeWidth="1.2" />
            <text x={W - R - 2} y={yb(l.y) - 4} fontSize="10" textAnchor="end" fill={l.color || "#ef4444"}>{l.label}</text>
          </g>
        ))}
        {markers.filter((m) => m.t >= from && m.t <= to).map((m, i) => (
          <g key={i}>
            <title>{m.title ?? m.label}</title>
            <line x1={x(m.t)} x2={x(m.t)} y1={T} y2={H - B} stroke={m.color || "#334155"} strokeDasharray="2 3" />
            <text x={x(m.t) + 3} y={T + 9 + (m.row ?? 0) * 11} fontSize="10" fill={m.color || "#334155"}>{m.label}</text>
          </g>
        ))}
        {hasLine && (
          <>
            <path d={line!.pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} fill="none" stroke={line!.color || "#0f766e"} strokeWidth="1.8" />
            {line!.pts.map((p, i) => (
              <circle key={i} cx={x(p.t)} cy={y(p.v)} r={p.flag ? 3.6 : 2} fill={p.flag ? "#ef4444" : line!.color || "#0f766e"}>
                <title>{`${fmtDate(p.t, { day: "numeric", month: "short", year: "numeric" })}: ${p.v} ${line!.unit}`}</title>
              </circle>
            ))}
          </>
        )}
      </svg>
      <div className="row" style={{ gap: 14, fontSize: 12, color: "#5b6b7c", marginTop: 2 }}>
        {hasLine && <span><span style={{ display: "inline-block", width: 14, height: 3, background: line!.color || "#0f766e", verticalAlign: "middle" }} /> {line!.label ?? line!.unit} (left)</span>}
        {bars.map((b) => (
          <span key={b.label}><span style={{ display: "inline-block", width: 10, height: 10, background: b.color, opacity: 0.6, verticalAlign: "middle" }} /> {b.label} ({b.unit}{hasLine ? ", right" : ""})</span>
        ))}
      </div>
    </div>
  );
}

export function Ring({ pct, size = 64, label }: { pct: number | null; size?: number; label?: string }) {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const p = pct ?? 0;
  const col = pct == null ? "#cbd5e1" : p >= 90 ? "#16a34a" : p >= 75 ? "#f59e0b" : "#ef4444";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="#eef2f6" strokeWidth="7" fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke={col} strokeWidth="7" fill="none" strokeDasharray={`${(c * p) / 100} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size / 4.2} fontWeight="700" fill="#0f1d2b">
        {pct == null ? "—" : `${pct}%`}
      </text>
      {label && <title>{label}</title>}
    </svg>
  );
}
