// What changed, in plain words, for the evening digest and the weekly family summary. Rules over the record:
// every sentence comes from numbers in it. Pure builders (tested) and a small data gatherer.
import { all, get } from "./db";
import { DAY, dayKey, dayStart, fmtDate } from "./time";

const r1 = (n: number) => Math.round(n * 10) / 10;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

export interface DayStat { day: string; v: number }

/** Up to two short sentences about what moved, with good news (a streak) only when nothing needs a word. */
export function digestInsights(i: { weights: DayStat[]; sysToday: number | null; sysPrior: number[]; sugarToday: number | null; sugarPrior: number[]; medStreak: number }): string[] {
  const out: string[] = [];
  const w = i.weights.slice(-4);
  if (w.length >= 3) {
    const d = r1(w[w.length - 1].v - w[0].v);
    if (Math.abs(d) >= 0.5) out.push(`⚖️ Weight ${w[w.length - 1].v} kg, ${d > 0 ? "up" : "down"} ${Math.abs(d)} kg over ${w.length - 1} days`);
  }
  if (i.sysToday != null && i.sysPrior.length >= 3) {
    const m = Math.round(mean(i.sysPrior)), diff = Math.round(i.sysToday - m);
    if (Math.abs(diff) >= 8) out.push(`🩺 Top BP number ${Math.round(i.sysToday)}, ${diff > 0 ? "higher" : "lower"} than the usual ${m} this week`);
  }
  if (i.sugarToday != null && i.sugarPrior.length >= 3) {
    const m = mean(i.sugarPrior), diff = i.sugarToday - m;
    if (Math.abs(diff) >= 15 && Math.abs(diff) / m >= 0.15) out.push(`🍬 Sugar ${Math.round(i.sugarToday)}, ${diff > 0 ? "higher" : "lower"} than the usual ${Math.round(m)} this week`);
  }
  if (!out.length && i.medStreak >= 3) out.push(`💊 All medicines taken ${i.medStreak} days in a row. Well done`);
  return out.slice(0, 2);
}

export interface WeekStats {
  name: string; // first name
  medDaysOk: number; medDays: number; dosesDone: number; dosesDue: number;
  sys: number | null; dia: number | null; sysPrev: number | null; diaPrev: number | null;
  weightFrom: number | null; weightTo: number | null;
  sugar: number | null; sugarPrev: number | null;
  alerts: number; alertsClosed: number; openNow: number;
  nextVisit: string | null;
}

/** The Sunday summary. `you` writes it to the patient ("your week"), otherwise to the family ("Ramesh's week"). */
export function buildWeekly(s: WeekStats, you: boolean): string {
  const L: string[] = [`🗓 ${you ? "Your week" : `${s.name}'s week`}`];
  if (s.dosesDue) L.push(`💊 Medicines: fully on track on ${s.medDaysOk} of ${s.medDays} days (${s.dosesDone} of ${s.dosesDue} doses)`);
  const bits: string[] = [];
  if (s.sys != null && s.dia != null) bits.push(`BP average ${Math.round(s.sys)}/${Math.round(s.dia)}${s.sysPrev != null ? ` (week before ${Math.round(s.sysPrev)}/${Math.round(s.diaPrev ?? 0)})` : ""}`);
  if (s.weightFrom != null && s.weightTo != null) bits.push(s.weightFrom === s.weightTo ? `weight ${s.weightTo} kg` : `weight ${s.weightFrom} → ${s.weightTo} kg`);
  if (s.sugar != null) bits.push(`sugar average ${Math.round(s.sugar)}${s.sugarPrev != null ? ` (week before ${Math.round(s.sugarPrev)})` : ""}`);
  if (bits.length) L.push(`📏 ${bits.join(" · ")}`);
  L.push(s.alerts ? `🔔 ${s.alerts} alert${s.alerts > 1 ? "s" : ""} this week${s.alertsClosed ? `, ${s.alertsClosed} closed` : ""}${s.openNow ? `, ${s.openNow} still open` : ""}` : "🔔 No alerts this week");
  if (s.medDays >= 5 && s.medDaysOk === s.medDays) L.push(you ? "Great job keeping up with your medicines 👏" : `${s.name} kept up with every medicine this week 👏`);
  if (s.nextVisit) L.push(`📅 Next visit: ${s.nextVisit}`);
  return L.join("\n");
}

// ---------------------------------------------------------------- data
const daily = (pid: string, type: string, from: number, to: number, col: "v1" | "v2" = "v1"): DayStat[] => {
  const m = new Map<string, number[]>();
  for (const r of all<{ v: number | null; at: number }>(`SELECT ${col} AS v, observed_at AS at FROM observations WHERE patient_id = ? AND type = ? AND observed_at > ? AND observed_at <= ?`, pid, type, from, to)) if (r.v != null) m.set(dayKey(r.at), [...(m.get(dayKey(r.at)) ?? []), r.v]);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, v: mean(v) }));
};

export function gatherDigestInsights(pid: string, t: number): string[] {
  const today = dayKey(t);
  const wt = all<{ v1: number; at: number }>("SELECT v1, observed_at AS at FROM observations WHERE patient_id = ? AND type = 'weight' AND observed_at > ? AND observed_at <= ? ORDER BY observed_at", pid, t - 4 * DAY, t);
  const lastPerDay = new Map<string, number>();
  for (const r of wt) lastPerDay.set(dayKey(r.at), r.v1);
  const weights = [...lastPerDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, v }));
  const sys = daily(pid, "bp", t - 8 * DAY, t), sug = daily(pid, "glucose", t - 8 * DAY, t);
  const only = (a: DayStat[], f: (x: DayStat) => boolean) => a.filter(f).map((x) => x.v);
  // days in a row (ending today) on which every due medicine was confirmed
  let streak = 0;
  for (let n = 0; n < 14; n++) {
    const d0 = dayStart(t) - n * DAY;
    const r = get<{ due: number; done: number }>("SELECT COUNT(*) AS due, COALESCE(SUM(status = 'DONE'), 0) AS done FROM tasks WHERE patient_id = ? AND kind = 'med' AND due_at >= ? AND due_at < ? AND due_at <= ?", pid, d0, d0 + DAY, t)!;
    if (!r.due || r.done < r.due) break;
    streak++;
  }
  return digestInsights({
    weights, sysToday: sys.find((x) => x.day === today)?.v ?? null, sysPrior: only(sys, (x) => x.day < today),
    sugarToday: sug.find((x) => x.day === today)?.v ?? null, sugarPrior: only(sug, (x) => x.day < today), medStreak: streak,
  });
}

export function gatherWeekStats(pid: string, name: string, t: number, nextVisit: number | null): WeekStats {
  const from = t - 7 * DAY, prev = t - 14 * DAY;
  const avg = (type: string, col: "v1" | "v2", a: number, b: number) => { const d = daily(pid, type, a, b, col); return d.length ? mean(d.map((x) => x.v)) : null; };
  const w = all<{ v1: number }>("SELECT v1 FROM observations WHERE patient_id = ? AND type = 'weight' AND observed_at > ? AND observed_at <= ? ORDER BY observed_at", pid, from, t);
  const days = new Map<string, { due: number; done: number }>();
  for (const r of all<{ due_at: number; status: string }>("SELECT due_at, status FROM tasks WHERE patient_id = ? AND kind = 'med' AND status IN ('DONE','MISSED','NOT_DONE') AND due_at > ? AND due_at <= ?", pid, from, t)) {
    const c = days.get(dayKey(r.due_at)) ?? { due: 0, done: 0 };
    c.due++; if (r.status === "DONE") c.done++;
    days.set(dayKey(r.due_at), c);
  }
  const esc = all<{ state: string }>("SELECT state FROM escalations WHERE patient_id = ? AND type != 'COMPLIANCE' AND started_at > ?", pid, from);
  const open = get<{ n: number }>("SELECT COUNT(*) AS n FROM escalations WHERE patient_id = ? AND state IN ('NOTIFIED','ACKNOWLEDGED')", pid)!.n;
  return {
    name, medDays: days.size, medDaysOk: [...days.values()].filter((d) => d.done === d.due).length,
    dosesDue: [...days.values()].reduce((s, d) => s + d.due, 0), dosesDone: [...days.values()].reduce((s, d) => s + d.done, 0),
    sys: avg("bp", "v1", from, t), dia: avg("bp", "v2", from, t), sysPrev: avg("bp", "v1", prev, from), diaPrev: avg("bp", "v2", prev, from),
    weightFrom: w.length ? w[0].v1 : null, weightTo: w.length ? w[w.length - 1].v1 : null,
    sugar: avg("glucose", "v1", from, t), sugarPrev: avg("glucose", "v1", prev, from),
    alerts: esc.length, alertsClosed: esc.filter((e) => e.state === "RESOLVED").length, openNow: open,
    nextVisit: nextVisit ? fmtDate(nextVisit, { weekday: "short", day: "numeric", month: "short" }) : null,
  };
}
