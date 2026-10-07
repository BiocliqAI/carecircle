// "Ask the record": the doctor asks a question in words ("when did creatinine start rising?", "weight against the
// Lasix dose") and gets a short answer from this patient's own record, with the chart. The AI reads a compact
// summary of the record and may only choose which series to show; every plotted point comes from the database.
// Without AI, a keyword match picks the series and the answer is plain statistics.
import { createHash } from "node:crypto";
import { all, get, run } from "./db";
import { getBaseline } from "./clinic";
import { getVisits, getPatient } from "./engine";
import { DAY, dayKey, dayStart, fmtDate } from "./time";
import { LAB_META, VITAL_META, type VitalType } from "./types";
import { medChanges } from "./summary";

export interface Panel { name: string; label: string; unit: string; dual: boolean; points: { t: number; v1: number; v2?: number }[] }
export interface ChartData { from: number; to: number; panels: Panel[]; changes: { at: number; med_name: string; change: string; new_dose: string | null; prescriber: string | null; status: string }[] }
export interface Answer { via: "ai" | "rules"; answer: string; facts: string[]; chart: ChartData | null; note: string | null; reusedFrom?: number; ctxHash?: string }

const VITALS: VitalType[] = ["bp", "weight", "glucose", "hr", "spo2"];
// Day totals: fluid intake and urine output (a logged "total" replaces the running sum, as in dayFluid), water tablets.
const DAILY: Record<string, { label: string; unit: string }> = {
  fluid_in: { label: "Fluid intake", unit: "ml/day" },
  urine_out: { label: "Urine output", unit: "ml/day" },
  diuretic: { label: "Water tablet (diuretic) dose", unit: "mg/day" },
};
export const seriesNames = (): string[] => [...VITALS, ...Object.keys(DAILY), ...Object.keys(LAB_META)];

/** One value per day for fluid intake, urine output or total diuretic mg, with the drugs taken that day. */
export function dailyTotals(pid: string, type: string, from: number, t: number): { day: number; v: number; drugs: string[] }[] {
  const days = new Map<number, { v: number; drugs: Set<string> }>();
  for (const r of all<{ v1: number; text: string | null; at: number }>("SELECT v1, text, observed_at AS at FROM observations WHERE patient_id = ? AND type = ? AND observed_at > ? AND observed_at <= ? ORDER BY observed_at, id", pid, type, from, t)) {
    const d = dayStart(r.at);
    const cur = days.get(d) ?? { v: 0, drugs: new Set<string>() };
    if (type === "diuretic") { cur.v += r.v1; if (r.text) cur.drugs.add(r.text); }
    else cur.v = r.text === "total" ? r.v1 : cur.v + r.v1;
    days.set(d, cur);
  }
  return [...days.entries()].sort((a, b) => a[0] - b[0]).map(([day, x]) => ({ day, v: Math.round(x.v), drugs: [...x.drugs] }));
}

/** Plotted points for the chosen series, straight from the database. */
export function buildChart(pid: string, names: string[], days: number, t: number): ChartData | null {
  const from = t - Math.max(7, Math.min(730, days)) * DAY;
  const panels: Panel[] = [];
  for (const n of [...new Set(names)].slice(0, 3)) {
    if ((VITALS as string[]).includes(n)) {
      const pts = all<{ v1: number; v2: number | null; at: number }>("SELECT v1, v2, observed_at AS at FROM observations WHERE patient_id = ? AND type = ? AND observed_at > ? AND observed_at <= ? ORDER BY observed_at", pid, n, from, t);
      if (pts.length) panels.push({ name: n, label: VITAL_META[n as VitalType].label, unit: VITAL_META[n as VitalType].unit, dual: n === "bp", points: pts.map((p) => ({ t: p.at, v1: p.v1, ...(p.v2 != null ? { v2: p.v2 } : {}) })) });
    } else if (DAILY[n]) {
      const pts = dailyTotals(pid, n, from, t);
      if (pts.length) panels.push({ name: n, label: DAILY[n].label, unit: DAILY[n].unit, dual: false, points: pts.map((p) => ({ t: p.day + 12 * 3600_000, v1: p.v })) });
    } else if (LAB_META[n]) {
      const pts = all<{ value: number; at: number }>("SELECT value, taken_at AS at FROM labs WHERE patient_id = ? AND marker = ? AND taken_at > ? AND taken_at <= ? ORDER BY taken_at", pid, n, from, t);
      if (pts.length) panels.push({ name: n, label: LAB_META[n].label, unit: LAB_META[n].unit, dual: false, points: pts.map((p) => ({ t: p.at, v1: p.value })) });
    }
  }
  if (!panels.length) return null;
  const changes = medChanges(pid, from, t).map((c) => ({ at: c.at, med_name: c.med_name, change: c.change, new_dose: c.new_dose ?? null, prescriber: c.prescriber, status: c.status }));
  return { from, to: t, panels, changes };
}

// ---------------------------------------------------------------- the compact record the AI reads
const doseText = (m: { dose: string; times: string[]; doses?: string[] }) =>
  m.doses?.length && m.doses.some((d) => d !== m.dose) ? m.times.map((t, i) => `${m.doses![i] ?? m.dose} at ${t}`).join(" + ") : m.dose;
const thin = <T,>(a: T[], max: number): T[] => (a.length <= max ? a : a.filter((_, i) => i % Math.ceil(a.length / max) === 0 || i === a.length - 1));

export function buildContext(pid: string, t: number) {
  const p = getPatient(pid)!;
  const day = (ms: number) => dayKey(ms);
  const from = t - 180 * DAY;
  const dailyMean = (type: string, col: "v1" | "v2" = "v1") => {
    const m = new Map<string, number[]>();
    for (const r of all<{ v: number | null; at: number }>(`SELECT ${col} AS v, observed_at AS at FROM observations WHERE patient_id = ? AND type = ? AND observed_at > ? AND observed_at <= ?`, pid, type, from, t)) if (r.v != null) m.set(day(r.at), [...(m.get(day(r.at)) ?? []), r.v]);
    return thin([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => [d, Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10]), 40);
  };
  const labs: Record<string, [string, number][]> = {};
  for (const r of all<{ marker: string; value: number; at: number }>("SELECT marker, value, taken_at AS at FROM labs WHERE patient_id = ? AND taken_at > ? ORDER BY taken_at", pid, t - 365 * DAY)) (labs[r.marker] ??= []).push([day(r.at), r.value]);
  for (const k of Object.keys(labs)) labs[k] = labs[k].slice(-16); // the recent run of each marker is what questions are about
  const weeks = all<{ wk: number; due: number; done: number }>("SELECT CAST((? - due_at) / ? AS INTEGER) AS wk, COUNT(*) AS due, SUM(status = 'DONE') AS done FROM tasks WHERE patient_id = ? AND kind = 'med' AND status IN ('DONE','MISSED','NOT_DONE') AND due_at > ? AND due_at <= ? GROUP BY wk ORDER BY wk DESC", t, 7 * DAY, pid, t - 12 * 7 * DAY, t);
  return {
    today: day(t),
    patient: { name: p.name, age: p.age, sex: p.sex, conditions: p.conditions, allergies: getBaseline(pid)?.allergies || null },
    // A different dose at each time ("40 mg" at 08:00, "20 mg" at 16:00) is spelled out, so totals come out right.
    currentPlan: getVisits(pid).at(-1)?.plan.medications.map((m) => ({ name: m.name, dose: doseText(m), times: m.times, by: m.prescriber ?? null })) ?? [],
    visits: getVisits(pid).slice(-6).map((v) => ({ date: day(v.visit_at), note: v.notes.slice(0, 200), medicines: v.plan.medications.map((m) => `${m.name} ${doseText(m)}`) })),
    medicineChanges: medChanges(pid, 0, t).slice(-45).map((c) => ({ date: day(c.at), medicine: c.med_name, change: c.change, detail: (c.detail ?? "").slice(0, 90), by: c.prescriber })),
    dailyAverages: { bpSystolic: dailyMean("bp"), bpDiastolic: dailyMean("bp", "v2"), weightKg: dailyMean("weight"), sugar: dailyMean("glucose"), pulse: dailyMean("hr"), spo2: dailyMean("spo2") },
    // [date, intake ml, urine ml] — a day's totals; null when only one of the two was logged.
    fluidPerDay: (() => {
      const inn = new Map(dailyTotals(pid, "fluid_in", from, t).map((x) => [x.day, x.v])), out = new Map(dailyTotals(pid, "urine_out", from, t).map((x) => [x.day, x.v]));
      return [...new Set([...inn.keys(), ...out.keys()])].sort((a, b) => a - b).map((d) => [day(d), inn.get(d) ?? null, out.get(d) ?? null]); // every day: counts of logged days must be right
    })(),
    // [date, total mg, drugs]
    diureticPerDay: dailyTotals(pid, "diuretic", from, t).map((x) => [day(x.day), x.v, x.drugs.join(" + ")]),
    labs,
    weeklyMedicineAdherence: weeks.map((w) => ({ weeksAgo: w.wk, dosesDue: w.due, dosesTaken: w.done })),
    alerts: all<{ started_at: number; type: string; title: string; state: string; outcome_code: string | null }>("SELECT started_at, type, title, state, outcome_code FROM escalations WHERE patient_id = ? AND started_at > ? ORDER BY started_at DESC LIMIT 25", pid, from).map((e) => ({ date: day(e.started_at), type: e.type, title: e.title, state: e.state, outcome: e.outcome_code })),
    symptoms: all<{ observed_at: number; text: string; severity: string | null }>("SELECT observed_at, text, severity FROM observations WHERE patient_id = ? AND type = 'symptom' AND text != 'none' AND observed_at > ? ORDER BY observed_at DESC LIMIT 20", pid, from).map((s) => ({ date: day(s.observed_at), symptom: s.text, severity: s.severity })),
    availableChartSeries: seriesNames(),
  };
}

// ---------------------------------------------------------------- without AI
const KEYWORDS: [RegExp, string][] = [
  [/creatinine|creat\b/i, "creatinine"], [/egfr/i, "egfr"], [/urea|\bbun\b/i, "urea"], [/potassium|\bk\+?\b/i, "potassium"], [/sodium|\bna\b/i, "sodium"], [/uric/i, "uric_acid"],
  [/haemoglobin|hemoglobin|\bhb\b/i, "hb"], [/bnp/i, "ntprobnp"], [/albumin/i, "albumin"],
  [/fluid|intake|input|i\/p|drink|water(?! tablet)|tea|liquid/i, "fluid_in"], [/urine|output|o\/p|\bpee|passed/i, "urine_out"],
  [/diuretic|water tablet|lasix|furosemide|dytor|torsemide|zytanix|metolazone|aldactone/i, "diuretic"],
  [/weight|\bwt\b|kg/i, "weight"], [/\bbp\b|pressure|systolic|diastolic/i, "bp"], [/sugar|glucose|diabet/i, "glucose"], [/pulse|heart ?rate|\bhr\b/i, "hr"], [/spo2|oxygen|saturation/i, "spo2"],
];
export function questionSeries(q: string): string[] { return KEYWORDS.filter(([re]) => re.test(q)).map(([, n]) => n).filter((n, i, a) => a.indexOf(n) === i).slice(0, 3); }
export function questionDays(q: string): number {
  const m = q.toLowerCase().match(/(\d+)\s*(day|week|month|year)s?/);
  if (m) return Math.min(730, Number(m[1]) * ({ day: 1, week: 7, month: 30, year: 365 } as Record<string, number>)[m[2]]);
  return /since (the )?last visit/.test(q.toLowerCase()) ? 60 : 120;
}

export function statsFor(c: ChartData): string[] {
  return c.panels.map((p) => {
    const v = p.points.map((x) => x.v1), first = p.points[0], last = p.points[p.points.length - 1];
    const hi = p.points[v.indexOf(Math.max(...v))], lo = p.points[v.indexOf(Math.min(...v))];
    const d = (x: { t: number }) => fmtDate(x.t, { day: "numeric", month: "short" });
    const fmt = (x: { v1: number; v2?: number }) => (p.dual ? `${x.v1}/${x.v2 ?? "?"}` : String(x.v1));
    return `${p.label}: ${fmt(first)} (${d(first)}) → ${fmt(last)} (${d(last)}) over ${p.points.length} readings; highest ${hi.v1} on ${d(hi)}, lowest ${lo.v1} on ${d(lo)} ${p.unit}`.trim();
  });
}

/** What the AI sends back is only a plan for the chart; this validates it. */
export function cleanSpec(raw: unknown): { series: string[]; days: number } | null {
  const o = (raw ?? {}) as { series?: unknown; days?: unknown };
  const names = Array.isArray(o.series) ? (o.series as unknown[]).map(String).filter((n) => seriesNames().includes(n)) : [];
  return names.length ? { series: names.slice(0, 3), days: Number.isFinite(Number(o.days)) ? Math.max(14, Math.min(730, Number(o.days))) : 120 } : null;
}

export async function askRecord(pid: string, question: string, t: number): Promise<Answer> {
  const q = question.trim().slice(0, 400);
  const { isGeminiConfigured, askRecordAI } = await import("./gemini");
  const aiOn = isGeminiConfigured();
  if (aiOn) {
    const context = buildContext(pid, t);
    // The same question about an unchanged record has the same answer: reuse it instead of asking the AI again.
    const ctxHash = createHash("sha256").update(q.toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "") + "\u0000" + JSON.stringify(context)).digest("hex");
    const prev = get<{ id: number; at: number }>("SELECT id, at FROM record_questions WHERE patient_id = ? AND ctx_hash = ? AND via = 'ai' ORDER BY at DESC LIMIT 1", pid, ctxHash);
    const saved = prev ? getQuestion(pid, prev.id) : null;
    if (saved) return { via: "ai", answer: saved.answer, facts: saved.facts, chart: saved.chart, note: saved.note, reusedFrom: saved.at, ctxHash };
    const ai = await Promise.race([askRecordAI(context, q), new Promise<null>((r) => setTimeout(() => r(null), 50_000))]).catch(() => null);
    if (ai && typeof ai.answer === "string" && ai.answer.trim()) {
      const spec = cleanSpec(ai.chart) ?? (questionSeries(q).length ? { series: questionSeries(q), days: questionDays(q) } : null);
      return {
        ctxHash,
        via: "ai", answer: ai.answer.trim().slice(0, 900),
        facts: Array.isArray(ai.facts) ? (ai.facts as unknown[]).map(String).slice(0, 6) : [],
        chart: spec ? buildChart(pid, spec.series, spec.days, t) : null,
        note: typeof ai.note === "string" && ai.note.trim() ? ai.note.trim().slice(0, 240) : null,
      };
    }
  }
  const series = questionSeries(q);
  const chart = series.length ? buildChart(pid, series, questionDays(q), t) : null;
  if (!chart) return { via: "rules", answer: series.length ? "There are no readings for that in this period." : aiOn ? "The AI did not answer in time. Please ask again, or name a reading, for example “creatinine”, “weight” or “BP”, to see its chart." : "AI is off, so I can only chart what the question names. Try naming a reading, for example “creatinine”, “weight” or “BP”, or switch Gemini on in Clinic settings for written answers.", facts: [], chart: null, note: null };
  return { via: "rules", answer: aiOn ? "The AI did not answer in time, so here are the numbers and the chart for what you asked about. You can ask again, or ask something narrower." : "AI is off, so here are the numbers and the chart for what you asked about.", facts: statsFor(chart), chart, note: null };
}


// ---------------------------------------------------------------- the record of questions asked
export interface AskedQuestion { id: number; at: number; by: string; question: string; answer: string; facts: string[]; note: string | null; via: string; chart: ChartData | null }

/** Keeps the question and answer. The chart is kept as which series over how many days, and redrawn from the record as of then. */
export function saveQuestion(pid: string, userId: string, question: string, a: Answer, t: number): number {
  const spec = a.chart ? { series: a.chart.panels.map((p) => p.name), days: Math.round((a.chart.to - a.chart.from) / DAY) } : null;
  return run("INSERT INTO record_questions(patient_id, user_id, at, question, answer, facts, note, via, chart, ctx_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
    pid, userId, t, question, a.answer, JSON.stringify(a.facts), a.note, a.via, spec ? JSON.stringify(spec) : null, a.ctxHash ?? null).lastInsertRowid;
}

type QRow = { id: number; at: number; by: string | null; question: string; answer: string; facts: string | null; note: string | null; via: string; chart: string | null };
const QSELECT = "SELECT q.id, q.at, u.name AS by, q.question, q.answer, q.facts, q.note, q.via, q.chart FROM record_questions q LEFT JOIN users u ON u.id = q.user_id";

/** Everything asked about this patient, newest first (charts are drawn when one is opened). */
export function listQuestions(pid: string, limit = 100): AskedQuestion[] {
  return all<QRow>(`${QSELECT} WHERE q.patient_id = ? ORDER BY q.at DESC, q.id DESC LIMIT ?`, pid, limit).map((r) => ({ ...fromRow(r), chart: null }));
}

export function getQuestion(pid: string, id: number): AskedQuestion | null {
  const r = get<QRow>(`${QSELECT} WHERE q.patient_id = ? AND q.id = ?`, pid, id);
  if (!r) return null;
  const spec = r.chart ? (JSON.parse(r.chart) as { series: string[]; days: number }) : null;
  return { ...fromRow(r), chart: spec ? buildChart(pid, spec.series, spec.days, r.at) : null };
}

const fromRow = (r: QRow) => ({ id: r.id, at: r.at, by: r.by ?? "Someone", question: r.question, answer: r.answer, facts: r.facts ? (JSON.parse(r.facts) as string[]) : [], note: r.note, via: r.via });
