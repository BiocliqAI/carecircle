// Between-visit analytics: what happened since the last visit, and visit-to-visit diff.
import { all } from "./db";
import { getCaregivers, getUser, latestVisit, type EscalationRow } from "./engine";
import { DAY, dayKey, dayStart, fmtDate } from "./time";
import type { CarePlan, ClinicVitals, Visit, VitalType } from "./types";
import { LAB_META, SYMPTOMS, VITAL_META, doseMg, isDiuretic } from "./types";
import { describeMed } from "./meds";

export interface AdherenceRow {
  key: string;
  kind: string;
  label: string;
  due: number;
  done: number;
  notDone: number;
  missed: number;
  late: number;
  pct: number | null;
  byDay: Record<string, "all" | "partial" | "none" | "pending">;
}

export interface VitalStats {
  type: VitalType;
  label: string;
  unit: string;
  count: number;
  series: { t: number; v1: number; v2: number | null; flag: string | null; by: string | null }[];
  first: number | null;
  last: number | null;
  firstV2: number | null;
  lastV2: number | null;
  avg: number | null;
  avgV2: number | null;
  min: number | null;
  max: number | null;
  outOfRange: number;
  earlyAvg: number | null;
  lateAvg: number | null;
  earlyAvgV2: number | null;
  lateAvgV2: number | null;
}

export interface EscalationView extends EscalationRow {
  ack_by_name: string | null;
  resolved_by_name: string | null;
  events: { at: number; event: string; level: number | null; actor: string | null; note: string | null }[];
}

export interface FluidDay {
  d: string;
  in: number | null;
  out: number | null;
  ratio: number | null;
  over: boolean;
}

export interface LabSeries {
  marker: string;
  label: string;
  unit: string;
  series: { t: number; v: number; flag: string | null; source: string; mark: string | null }[];
  latest: { t: number; v: number; flag: string | null } | null;
  pre: { t: number; v: number } | null; // last value at/before the interval start
}

export interface MedChangeRow {
  id: number;
  at: number;
  med_name: string;
  change: string;
  detail: string | null;
  prescriber: string | null;
  reported_by: string | null;
  reported_by_name: string | null;
  source: string;
  status: string;
  reviewed_by_name: string | null;
  reviewed_at: number | null;
  outside_visit_id?: number | null;
  med_key?: string | null;
  new_dose?: string | null;
  new_times?: string | null; // JSON ["HH:MM"]
  applied_at?: number | null;
}

export interface KidneySummary {
  limit: number | null;
  fluid: FluidDay[];
  avgIn: number | null;
  avgOut: number | null;
  daysOver: number;
  daysLogged: number;
  labs: LabSeries[];
  medChanges: MedChangeRow[];
  weightBand: { dry: number; band: number; inBand: number; above: number; below: number; total: number; pct: number | null } | null;
  diuretic: { d: string; mg: number; drugs: string }[];
}

export interface IntervalSummary {
  from: number;
  to: number;
  days: string[];
  adherence: AdherenceRow[];
  overall: { meds: number | null; physio: number | null; monitoring: number | null; checkin: number | null };
  vitals: VitalStats[];
  symptoms: { key: string; label: string; count: number; days: number; first: number; last: number; maxSeverity: string }[];
  symptomFreeDays: number;
  lifestyle: { ok: number; notOk: number };
  escalations: EscalationView[];
  logging: { total: number; byPatient: number; byCaregiver: number; byUser: { name: string; role: string; count: number }[] };
  highlights: { tone: "good" | "warn" | "bad" | "info"; text: string }[];
  kidney: KidneySummary | null;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);

/** Fluid day totals from observations (last 'total' + later 'add's). */
export function fluidDays(pid: string, from: number, to: number, limit: number | null): FluidDay[] {
  const rows = all<{ type: string; v1: number; text: string | null; observed_at: number }>(
    "SELECT type, v1, text, observed_at FROM observations WHERE patient_id = ? AND type IN ('fluid_in','urine_out') AND observed_at > ? AND observed_at <= ? ORDER BY observed_at, id",
    pid, from, to,
  );
  const m = new Map<string, { in: number | null; out: number | null }>();
  for (const r of rows) {
    const k = dayKey(r.observed_at);
    const e = m.get(k) ?? { in: null, out: null };
    const f = r.type === "fluid_in" ? "in" : "out";
    e[f] = r.text === "total" ? r.v1 : (e[f] ?? 0) + r.v1;
    m.set(k, e);
  }
  return [...m.entries()].map(([d, e]) => ({ d, in: e.in, out: e.out, ratio: e.in && e.out != null ? Math.round((e.out / e.in) * 100) / 100 : null, over: !!(limit && e.in && e.in > limit) }));
}

export function labSeries(pid: string, from: number, to: number): LabSeries[] {
  const rows = all<{ marker: string; value: number; taken_at: number; flag: string | null; source: string; mark: string | null }>("SELECT marker, value, taken_at, flag, source, mark FROM labs WHERE patient_id = ? AND taken_at > ? AND taken_at <= ? ORDER BY taken_at, id", pid, from, to);
  const markers = [...new Set(rows.map((r) => r.marker))].sort((a, b) => Object.keys(LAB_META).indexOf(a) - Object.keys(LAB_META).indexOf(b));
  return markers.map((mk) => {
    const s = rows.filter((r) => r.marker === mk);
    const pre = all<{ value: number; taken_at: number }>("SELECT value, taken_at FROM labs WHERE patient_id = ? AND marker = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1", pid, mk, from)[0];
    const last = s[s.length - 1];
    return {
      marker: mk,
      label: LAB_META[mk]?.label ?? mk,
      unit: LAB_META[mk]?.unit ?? "",
      series: s.map((r) => ({ t: r.taken_at, v: r.value, flag: r.flag, source: r.source, mark: r.mark })),
      latest: last ? { t: last.taken_at, v: last.value, flag: last.flag } : null,
      pre: pre ? { t: pre.taken_at, v: pre.value } : null,
    };
  });
}

export function medChanges(pid: string, from: number, to: number): MedChangeRow[] {
  return all<MedChangeRow>(
    `SELECT c.*, u.name AS reported_by_name, r.name AS reviewed_by_name FROM med_changes c
       LEFT JOIN users u ON u.id = c.reported_by LEFT JOIN users r ON r.id = c.reviewed_by
     WHERE c.patient_id = ? AND c.at > ? AND c.at <= ? ORDER BY c.at`,
    pid, from, to,
  );
}

/** Daily diuretic mg: confirmed (DONE) diuretic doses from tasks + imported history. */
export function diureticDays(pid: string, from: number, to: number): KidneySummary["diuretic"] {
  const m = new Map<string, { mg: number; drugs: Set<string> }>();
  const add = (t: number, mg: number, drug: string) => {
    const k = dayKey(t);
    const e = m.get(k) ?? { mg: 0, drugs: new Set<string>() };
    e.mg += mg;
    e.drugs.add(drug);
    m.set(k, e);
  };
  for (const r of all<{ label: string; due_at: number }>("SELECT label, due_at FROM tasks WHERE patient_id = ? AND kind = 'med' AND status = 'DONE' AND due_at > ? AND due_at <= ?", pid, from, to)) {
    if (!isDiuretic(r.label)) continue;
    const mg = doseMg(r.label);
    if (mg) add(r.due_at, mg, r.label.split(" ")[0]);
  }
  for (const r of all<{ v1: number; text: string; observed_at: number }>("SELECT v1, text, observed_at FROM observations WHERE patient_id = ? AND type = 'diuretic' AND observed_at > ? AND observed_at <= ?", pid, from, to)) add(r.observed_at, r.v1, (r.text || "").split(" ")[0]);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, e]) => ({ d, mg: e.mg, drugs: [...e.drugs].join(" + ") }));
}

function kidneySummary(pid: string, from: number, to: number, plan: CarePlan | undefined, weights: { v1: number }[]): KidneySummary | null {
  const labs = labSeries(pid, from, to);
  const fluid = fluidDays(pid, from, to, plan?.fluid?.limitMl ?? null);
  const mc = medChanges(pid, from, to);
  if (!plan?.fluid && plan?.template !== "kidney" && !labs.length && !fluid.length && !mc.length) return null;
  const ins = fluid.map((f) => f.in).filter((x): x is number => x != null);
  const outs = fluid.map((f) => f.out).filter((x): x is number => x != null);
  const dry = plan?.thresholds.dryWeight;
  const band = plan?.thresholds.weightBand ?? 1;
  let weightBand: KidneySummary["weightBand"] = null;
  if (dry && weights.length) {
    const above = weights.filter((w) => w.v1 > dry + band).length;
    const below = weights.filter((w) => w.v1 < dry - band).length;
    const inBand = weights.length - above - below;
    weightBand = { dry, band, inBand, above, below, total: weights.length, pct: pct(inBand, weights.length) };
  }
  return {
    limit: plan?.fluid?.limitMl ?? null,
    fluid,
    avgIn: ins.length ? Math.round(ins.reduce((s, x) => s + x, 0) / ins.length) : null,
    avgOut: outs.length ? Math.round(outs.reduce((s, x) => s + x, 0) / outs.length) : null,
    daysOver: fluid.filter((f) => f.over).length,
    daysLogged: ins.length,
    labs,
    medChanges: mc,
    weightBand,
    diuretic: diureticDays(pid, from, to),
  };
}

export function intervalSummary(pid: string, from: number, to: number): IntervalSummary {
  const days: string[] = [];
  for (let d = dayStart(from); d <= dayStart(to); d += DAY) days.push(dayKey(d + 12 * 3600_000));

  // ---- adherence
  const tasks = all<{ item_key: string; kind: string; label: string; due_at: number; status: string; late: number }>(
    "SELECT item_key, kind, label, due_at, status, late FROM tasks WHERE patient_id = ? AND due_at > ? AND due_at <= ? AND status != 'CANCELLED' ORDER BY due_at",
    pid, from, to,
  );
  const rows = new Map<string, AdherenceRow & { _days: Record<string, string[]> }>();
  for (const t of tasks) {
    let r = rows.get(t.item_key);
    if (!r) {
      r = { key: t.item_key, kind: t.kind, label: t.label, due: 0, done: 0, notDone: 0, missed: 0, late: 0, pct: null, byDay: {}, _days: {} };
      rows.set(t.item_key, r);
    }
    r.label = t.label;
    const dk = dayKey(t.due_at);
    (r._days[dk] ||= []).push(t.status);
    if (t.status === "PENDING") continue;
    r.due++;
    if (t.status === "DONE") r.done++;
    if (t.status === "NOT_DONE") r.notDone++;
    if (t.status === "MISSED") r.missed++;
    if (t.late) r.late++;
  }
  const adherence: AdherenceRow[] = [];
  for (const r of rows.values()) {
    r.pct = pct(r.done, r.due);
    for (const [dk, sts] of Object.entries(r._days)) {
      const closed = sts.filter((s) => s !== "PENDING");
      if (!closed.length) r.byDay[dk] = "pending";
      else if (closed.every((s) => s === "DONE")) r.byDay[dk] = "all";
      else if (closed.some((s) => s === "DONE")) r.byDay[dk] = "partial";
      else r.byDay[dk] = "none";
    }
    const { _days, ...rest } = r;
    void _days;
    adherence.push(rest);
  }
  const order = { med: 0, vital: 1, fluid: 2, physio: 3, checkin: 4, lab: 5 } as Record<string, number>;
  adherence.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.label.localeCompare(b.label));
  const kindPct = (k: string) => {
    const rs = adherence.filter((a) => a.kind === k);
    return pct(rs.reduce((s, r) => s + r.done, 0), rs.reduce((s, r) => s + r.due, 0));
  };

  // ---- vitals
  const obs = all<{ type: string; v1: number; v2: number | null; observed_at: number; flag: string | null; logged_by: string | null; text: string | null; severity: string | null }>(
    "SELECT type, v1, v2, observed_at, flag, logged_by, text, severity FROM observations WHERE patient_id = ? AND observed_at > ? AND observed_at <= ? ORDER BY observed_at",
    pid, from, to,
  );
  const mid = from + (to - from) / 2;
  const third = (to - from) / 3;
  const vitals: VitalStats[] = [];
  for (const type of Object.keys(VITAL_META) as VitalType[]) {
    const s = obs.filter((o) => o.type === type);
    if (!s.length) continue;
    const v1s = s.map((o) => o.v1);
    const v2s = s.map((o) => o.v2).filter((x): x is number => x != null);
    const early = s.filter((o) => o.observed_at < from + third);
    const late = s.filter((o) => o.observed_at > to - third);
    void mid;
    vitals.push({
      type,
      label: VITAL_META[type].label,
      unit: VITAL_META[type].unit,
      count: s.length,
      series: s.map((o) => ({ t: o.observed_at, v1: o.v1, v2: o.v2, flag: o.flag, by: o.logged_by })),
      first: s[0].v1,
      last: s[s.length - 1].v1,
      firstV2: s[0].v2,
      lastV2: s[s.length - 1].v2,
      avg: avg(v1s),
      avgV2: avg(v2s),
      min: Math.min(...v1s),
      max: Math.max(...v1s),
      outOfRange: s.filter((o) => o.flag).length,
      earlyAvg: avg(early.map((o) => o.v1)),
      lateAvg: avg(late.map((o) => o.v1)),
      earlyAvgV2: avg(early.map((o) => o.v2).filter((x): x is number => x != null)),
      lateAvgV2: avg(late.map((o) => o.v2).filter((x): x is number => x != null)),
    });
  }

  // ---- symptoms
  const sx = obs.filter((o) => o.type === "symptom" && o.text && o.text !== "none");
  const sevRank = { mild: 1, moderate: 2, severe: 3 } as Record<string, number>;
  const symMap = new Map<string, { key: string; label: string; count: number; daySet: Set<string>; first: number; last: number; maxSeverity: string }>();
  for (const o of sx) {
    const k = o.text!;
    let m = symMap.get(k);
    if (!m) {
      m = { key: k, label: SYMPTOMS[k] ?? k, count: 0, daySet: new Set(), first: o.observed_at, last: o.observed_at, maxSeverity: o.severity || "moderate" };
      symMap.set(k, m);
    }
    m.count++;
    m.daySet.add(dayKey(o.observed_at));
    m.last = o.observed_at;
    if ((sevRank[o.severity || ""] ?? 0) > (sevRank[m.maxSeverity] ?? 0)) m.maxSeverity = o.severity!;
  }
  const symptoms = [...symMap.values()].map(({ daySet, ...r }) => ({ ...r, days: daySet.size })).sort((a, b) => b.days - a.days);
  const sxDays = new Set(sx.map((o) => dayKey(o.observed_at)));
  const symptomFreeDays = days.length - sxDays.size;
  const lifestyle = { ok: obs.filter((o) => o.type === "lifestyle" && o.text === "ok").length, notOk: obs.filter((o) => o.type === "lifestyle" && o.text === "not_ok").length };

  // ---- escalations
  const escRows = all<EscalationRow>("SELECT * FROM escalations WHERE patient_id = ? AND started_at > ? AND started_at <= ? ORDER BY started_at", pid, from, to);
  const escalations: EscalationView[] = escRows.map((e) => ({
    ...e,
    ack_by_name: e.ack_by ? getUser(e.ack_by)?.name ?? null : null,
    resolved_by_name: e.resolved_by ? getUser(e.resolved_by)?.name ?? null : null,
    events: all("SELECT at, event, level, actor, note FROM escalation_events WHERE escalation_id = ? ORDER BY at, id", e.id) as EscalationView["events"],
  }));

  // ---- who logged
  const msgs = all<{ user_id: string; name: string; role: string; n: number }>(
    "SELECT m.user_id, u.name, u.role, COUNT(*) AS n FROM messages m JOIN users u ON u.id = m.user_id WHERE m.patient_id = ? AND m.direction = 'IN' AND m.parsed IS NOT NULL AND m.created_at > ? AND m.created_at <= ? GROUP BY m.user_id ORDER BY n DESC",
    pid, from, to,
  );
  const logging = {
    total: msgs.reduce((s, m) => s + m.n, 0),
    byPatient: msgs.filter((m) => m.role === "PATIENT").reduce((s, m) => s + m.n, 0),
    byCaregiver: msgs.filter((m) => m.role === "CAREGIVER").reduce((s, m) => s + m.n, 0),
    byUser: msgs.map((m) => ({ name: m.name, role: m.role, count: m.n })),
  };

  const summary: IntervalSummary = {
    from,
    to,
    days,
    adherence,
    overall: { meds: kindPct("med"), physio: kindPct("physio"), monitoring: kindPct("vital"), checkin: kindPct("checkin") },
    vitals,
    symptoms,
    symptomFreeDays,
    lifestyle,
    escalations,
    logging,
    highlights: [],
    kidney: null,
  };
  const visit = latestVisit(pid, from + 1);
  summary.kidney = kidneySummary(pid, from, to, visit?.plan, obs.filter((o) => o.type === "weight"));
  summary.highlights = buildHighlights(summary, visit?.vitals ?? {}, visit?.plan);
  return summary;
}

function buildHighlights(s: IntervalSummary, base: ClinicVitals, plan?: CarePlan): IntervalSummary["highlights"] {
  const h: IntervalSummary["highlights"] = [];
  const tone = (p: number | null, good = 90, ok = 75) => (p == null ? "info" : p >= good ? "good" : p >= ok ? "warn" : "bad");
  if (s.overall.meds != null) {
    const meds = s.adherence.filter((a) => a.kind === "med");
    const worst = [...meds].sort((a, b) => (a.pct ?? 100) - (b.pct ?? 100))[0];
    const missedTotal = meds.reduce((x, r) => x + r.missed + r.notDone, 0);
    const dueTotal = meds.reduce((x, r) => x + r.due, 0);
    h.push({ tone: tone(s.overall.meds), text: `Medication adherence ${s.overall.meds}% — ${missedTotal} of ${dueTotal} doses missed${worst && (worst.pct ?? 100) < 95 ? `; weakest: ${worst.label} (${worst.pct}%)` : ""}.` });
  }
  const bp = s.vitals.find((v) => v.type === "bp");
  if (bp && bp.earlyAvg != null && bp.lateAvg != null) {
    const better = bp.lateAvg < bp.earlyAvg - 3;
    const worse = bp.lateAvg > bp.earlyAvg + 3;
    h.push({
      tone: worse ? "bad" : better ? "good" : "info",
      text: `BP ${better ? "improved" : worse ? "worsened" : "stable"}: early avg ${Math.round(bp.earlyAvg)}/${Math.round(bp.earlyAvgV2 ?? 0)} → recent avg ${Math.round(bp.lateAvg)}/${Math.round(bp.lateAvgV2 ?? 0)} mmHg${base.sys ? ` (clinic at last visit ${base.sys}/${base.dia})` : ""}; ${bp.outOfRange} reading${bp.outOfRange === 1 ? "" : "s"} above limits.`,
    });
  }
  const wt = s.vitals.find((v) => v.type === "weight");
  if (wt && wt.first != null && wt.last != null) {
    const peak = wt.series.reduce((m, x) => (x.v1 > m.v1 ? x : m), wt.series[0]);
    const delta = Math.round((wt.last - (base.weight ?? wt.first)) * 10) / 10;
    h.push({
      tone: wt.outOfRange ? "warn" : "info",
      text: `Weight ${base.weight ?? wt.first} → ${wt.last} kg (${delta >= 0 ? "+" : ""}${delta} kg)${peak.v1 - (base.weight ?? wt.first) >= 1.5 ? `; peaked at ${peak.v1} kg on ${fmtDate(peak.t, { day: "numeric", month: "short" })}` : ""}.`,
    });
  }
  for (const v of s.vitals.filter((x) => ["glucose", "spo2", "pain", "hr"].includes(x.type))) {
    if (v.earlyAvg == null || v.lateAvg == null) continue;
    h.push({ tone: v.outOfRange > 2 ? "warn" : "info", text: `${v.label}: early avg ${Math.round(v.earlyAvg)} → recent avg ${Math.round(v.lateAvg)} ${v.unit}${v.outOfRange ? `; ${v.outOfRange} out of range` : ""}.` });
  }
  if (s.overall.physio != null) {
    const sk = s.symptoms.find((x) => x.key === "knee_pain");
    h.push({ tone: tone(s.overall.physio, 85, 65), text: `Physio / exercise adherence ${s.overall.physio}%${sk ? ` — knee pain reported on ${sk.days} day${sk.days > 1 ? "s" : ""}` : ""}.` });
  }
  const watched = s.symptoms.filter((x) => plan?.watchSymptoms.includes(x.key));
  const k = s.kidney;
  if (k) {
    const cr = k.labs.find((l) => l.marker === "creatinine");
    if (cr?.latest) {
      const base = cr.pre?.v ?? cr.series[0].v;
      const d = Math.round((cr.latest.v - base) * 100) / 100;
      h.push({ tone: d >= 0.3 ? "bad" : d > 0 ? "warn" : "good", text: `Creatinine ${base} → ${cr.latest.v} mg/dL (${d >= 0 ? "+" : ""}${d}) on ${fmtDate(cr.latest.t, { day: "numeric", month: "short" })}${cr.series.length > 1 ? `; ${cr.series.length} results since visit` : ""}.` });
    }
    const kk = k.labs.find((l) => l.marker === "potassium");
    if (kk?.latest) h.push({ tone: kk.latest.flag ? "warn" : "info", text: `Potassium latest ${kk.latest.v} mmol/L${kk.pre ? ` (was ${kk.pre.v} before the visit)` : ""}.` });
    if (k.weightBand) h.push({ tone: k.weightBand.pct != null && k.weightBand.pct >= 80 ? "good" : "warn", text: `Weight within dry-weight band ${k.weightBand.dry} ± ${k.weightBand.band} kg on ${k.weightBand.pct}% of readings (${k.weightBand.above} above, ${k.weightBand.below} below).` });
    if (k.daysLogged) h.push({ tone: k.daysOver > 2 ? "warn" : "info", text: `Fluids logged on ${k.daysLogged} days — avg intake ${k.avgIn} ml${k.limit ? ` (limit ${k.limit})` : ""}, avg urine ${k.avgOut ?? "—"} ml; ${k.daysOver} day${k.daysOver === 1 ? "" : "s"} over the limit.` });
    const pending = k.medChanges.filter((c) => c.status === "REPORTED");
    if (k.medChanges.length) h.push({ tone: pending.length ? "warn" : "info", text: `${k.medChanges.length} medicine change${k.medChanges.length > 1 ? "s" : ""} reported by other doctors/family (${k.medChanges.map((c) => `${c.med_name} ${c.change.replace("_", " ")}${c.prescriber ? ` – ${c.prescriber}` : ""}`).join("; ")})${pending.length ? ` — ${pending.length} awaiting reconciliation` : ""}.` });
  }
  if (s.symptoms.length)
    h.push({ tone: watched.length ? "warn" : "info", text: `Symptoms: ${s.symptoms.map((x) => `${x.label} (${x.days} day${x.days > 1 ? "s" : ""})`).join(", ")}. ${s.symptomFreeDays} of ${s.days.length} days symptom-free.` });
  else h.push({ tone: "good", text: `No symptoms reported in ${s.days.length} days.` });
  if (s.escalations.length) {
    const byType = (t: string) => s.escalations.filter((e) => e.type === t).length;
    const clinic = s.escalations.filter((e) => e.outcome_code === "2" || e.outcome_code === "3").length;
    const l2 = s.escalations.filter((e) => e.events.some((x) => x.event === "TIMEOUT")).length;
    h.push({
      tone: byType("URGENT") ? "bad" : "warn",
      text: `${s.escalations.length} care-circle alert${s.escalations.length > 1 ? "s" : ""} (${byType("DEVIATION")} deviation, ${byType("COMPLIANCE")} compliance${byType("URGENT") ? `, ${byType("URGENT")} urgent` : ""}); ${clinic} led to contacting the clinic/hospital${l2 ? `; ${l2} needed escalation beyond Level 1` : ""}.`,
    });
  } else h.push({ tone: "good", text: "No care-circle alerts were needed." });
  if (s.logging.total) h.push({ tone: "info", text: `${s.logging.total} WhatsApp logs — ${pct(s.logging.byPatient, s.logging.total)}% by patient, ${pct(s.logging.byCaregiver, s.logging.total)}% by caregivers.` });
  return h;
}

// ---------------------------------------------------------------- visit-to-visit diff
export interface VisitDiff {
  meds: { name: string; change: "added" | "removed" | "changed" | "same"; before: string | null; after: string | null }[];
  vitals: { key: string; label: string; unit: string; before: string | null; after: string | null; delta: number | null; better: boolean | null }[];
  physio: { name: string; change: "added" | "removed" | "changed" | "same"; before: string | null; after: string | null }[];
  lifestyle: { text: string; change: "added" | "removed" | "same" }[];
  monitoring: { label: string; change: "added" | "removed" | "changed" | "same"; before: string | null; after: string | null }[];
  thresholds: { label: string; before: number | null; after: number | null }[];
  diagnosis: { before: string; after: string };
}

const medKey = (n: string) => n.toLowerCase().split(/\s+/)[0];

export function visitDiff(a: Visit, b: Visit): VisitDiff {
  const fmtMed = (m: CarePlan["medications"][number]) => `${describeMed(m)}${m.instructions ? ` · ${m.instructions}` : ""}${m.prescriber ? ` · ${m.prescriber}` : ""}`;
  const am = new Map(a.plan.medications.map((m) => [medKey(m.name), m]));
  const bm = new Map(b.plan.medications.map((m) => [medKey(m.name), m]));
  const meds: VisitDiff["meds"] = [];
  for (const [k, m] of bm) {
    const old = am.get(k);
    if (!old) meds.push({ name: m.name, change: "added", before: null, after: fmtMed(m) });
    else meds.push({ name: m.name, change: fmtMed(old) === fmtMed(m) ? "same" : "changed", before: fmtMed(old), after: fmtMed(m) });
  }
  for (const [k, m] of am) if (!bm.has(k)) meds.push({ name: m.name, change: "removed", before: fmtMed(m), after: null });
  const rank = { added: 0, changed: 1, removed: 2, same: 3 };
  meds.sort((x, y) => rank[x.change] - rank[y.change]);

  const vitals: VisitDiff["vitals"] = [];
  const va = a.vitals, vb = b.vitals;
  if (va.sys || vb.sys) vitals.push({ key: "bp", label: "Blood pressure", unit: "mmHg", before: va.sys ? `${va.sys}/${va.dia}` : null, after: vb.sys ? `${vb.sys}/${vb.dia}` : null, delta: va.sys && vb.sys ? vb.sys - va.sys : null, better: va.sys && vb.sys ? vb.sys < va.sys : null });
  const simple: [keyof ClinicVitals, string, string, boolean][] = [
    ["weight", "Weight", "kg", true],
    ["hr", "Pulse", "bpm", true],
    ["glucose", "Blood sugar (fasting)", "mg/dL", true],
    ["spo2", "SpO₂", "%", false],
    ["pain", "Pain score", "/10", true],
  ];
  for (const [k, label, unit, lowerBetter] of simple) {
    const x = va[k], y = vb[k];
    if (x == null && y == null) continue;
    const delta = x != null && y != null ? Math.round((y - x) * 10) / 10 : null;
    vitals.push({ key: k, label, unit, before: x != null ? String(x) : null, after: y != null ? String(y) : null, delta, better: delta == null || delta === 0 ? null : lowerBetter ? delta < 0 : delta > 0 });
  }

  const ap = new Map(a.plan.physio.map((p) => [p.name.toLowerCase(), p]));
  const bp = new Map(b.plan.physio.map((p) => [p.name.toLowerCase(), p]));
  const physio: VisitDiff["physio"] = [];
  for (const [k, p] of bp) {
    const o = ap.get(k);
    const f = (x: typeof p) => `${x.detail} · ${x.times.join(", ")}`;
    physio.push(!o ? { name: p.name, change: "added", before: null, after: f(p) } : { name: p.name, change: f(o) === f(p) ? "same" : "changed", before: f(o), after: f(p) });
  }
  for (const [k, p] of ap) if (!bp.has(k)) physio.push({ name: p.name, change: "removed", before: `${p.detail}`, after: null });

  const al = new Set(a.plan.lifestyle.map((l) => l.text));
  const bl = new Set(b.plan.lifestyle.map((l) => l.text));
  const lifestyle: VisitDiff["lifestyle"] = [
    ...[...bl].map((t) => ({ text: t, change: (al.has(t) ? "same" : "added") as "same" | "added" })),
    ...[...al].filter((t) => !bl.has(t)).map((t) => ({ text: t, change: "removed" as const })),
  ];

  const amon = new Map(a.plan.monitoring.map((m) => [m.key, m]));
  const bmon = new Map(b.plan.monitoring.map((m) => [m.key, m]));
  const fm = (m: CarePlan["monitoring"][number]) => `${m.times.join(", ")}${m.days ? ` (${m.days.length}×/wk)` : " daily"}`;
  const monitoring: VisitDiff["monitoring"] = [];
  for (const [k, m] of bmon) {
    const o = amon.get(k);
    monitoring.push(!o ? { label: VITAL_META[k].label, change: "added", before: null, after: fm(m) } : { label: VITAL_META[k].label, change: fm(o) === fm(m) ? "same" : "changed", before: fm(o), after: fm(m) });
  }
  for (const [k, m] of amon) if (!bmon.has(k)) monitoring.push({ label: VITAL_META[k].label, change: "removed", before: fm(m), after: null });

  const TL: Record<string, string> = {
    sysHigh: "Systolic upper limit", diaHigh: "Diastolic upper limit", sysLow: "Systolic lower limit", weightGainKg: "Weight gain alert (kg / 3 days)", glucoseHigh: "Sugar upper limit", glucoseLow: "Sugar lower limit", hrHigh: "Pulse upper", hrLow: "Pulse lower", spo2Low: "SpO₂ lower limit", painHigh: "Pain alert level",
    dryWeight: "Dry (target) weight, kg", weightBand: "Dry-weight band ± kg", weightDayGainKg: "Weight gain alert (kg / day)", kHigh: "Potassium upper", kLow: "Potassium lower", naLow: "Sodium lower", naHigh: "Sodium upper", creatRiseAbs: "Creatinine rise alert (mg/dL)", creatRisePct: "Creatinine rise alert (%)", hbLow: "Haemoglobin lower",
  };
  const th = (v: Visit, k: string) => ((v.plan.thresholds as unknown as Record<string, number | undefined>)[k] ?? null);
  const thresholds: VisitDiff["thresholds"] = Object.keys(TL)
    .filter((k) => th(a, k) !== th(b, k))
    .map((k) => ({ label: TL[k], before: th(a, k), after: th(b, k) }));
  if ((a.plan.fluid?.limitMl ?? null) !== (b.plan.fluid?.limitMl ?? null)) thresholds.unshift({ label: "Fluid limit, ml/day", before: a.plan.fluid?.limitMl ?? null, after: b.plan.fluid?.limitMl ?? null });
  if ((a.plan.labs?.everyDays ?? null) !== (b.plan.labs?.everyDays ?? null)) thresholds.push({ label: "Lab tests every N days", before: a.plan.labs?.everyDays ?? null, after: b.plan.labs?.everyDays ?? null });

  return { meds, vitals, physio, lifestyle, monitoring, thresholds, diagnosis: { before: a.diagnosis, after: b.diagnosis } };
}

/** Whole-history kidney view: labs, weight, diuretic dose and fluids with visit markers. */
export function longRange(pid: string) {
  const visits = all<{ id: string; visit_at: number; plan: string }>("SELECT id, visit_at, plan FROM visits WHERE patient_id = ? ORDER BY visit_at", pid);
  const latest = visits.length ? (JSON.parse(visits[visits.length - 1].plan) as CarePlan) : undefined;
  return {
    visits: visits.map((v) => ({ id: v.id, t: v.visit_at })),
    labs: labSeries(pid, 0, Number.MAX_SAFE_INTEGER),
    weight: all<{ t: number; v: number; flag: string | null }>("SELECT observed_at AS t, v1 AS v, flag FROM observations WHERE patient_id = ? AND type = 'weight' ORDER BY observed_at", pid),
    diuretic: diureticDays(pid, 0, Number.MAX_SAFE_INTEGER),
    fluid: fluidDays(pid, 0, Number.MAX_SAFE_INTEGER, latest?.fluid?.limitMl ?? null),
    dryWeight: latest?.thresholds.dryWeight ?? null,
    band: latest?.thresholds.weightBand ?? null,
    limit: latest?.fluid?.limitMl ?? null,
  };
}
export type LongRange = ReturnType<typeof longRange>;

export function careCircle(pid: string) {
  return getCaregivers(pid).map((c) => ({ ...c }));
}
