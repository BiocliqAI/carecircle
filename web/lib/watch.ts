// Pattern watches: slow drifts that stay under every limit and so never trip an alert on their own
// (weight creeping up three days running, BP drifting, fluid build-up signs together, medicines slipping).
// They are advisory: a gentle heads-up to the family and a line for the doctor, never an escalation.
// The doctor can dismiss one, or turn a pattern off for a patient.
import { all, audit, get, getSetting, run, setSetting } from "./db";
import { getCaregivers, getPatient, getUser, latestVisit, type PatientRow } from "./engine";
import { sendWhatsApp } from "./whatsapp";
import { DAY, HOUR, dayKey, dayStart, localHHMM } from "./time";
import { isDiuretic, shortName, type Thresholds } from "./types";

export const WATCH_KEYS: Record<string, string> = {
  weight_creep: "Weight creeping up",
  bp_drift: "Blood pressure drifting up",
  fluid_buildup: "Possible fluid build-up",
  adherence_slip: "Medicines missed more often",
};
export interface Hit { key: string; title: string; detail: string; advice: string }
const first = (n: string) => shortName(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- detectors (pure)
export interface DayVal { day: string; v: number }

/** Last readings, one per day, rising on each of the last three days by at least `minRiseKg` in total. */
export function detectWeightCreep(w: DayVal[], now: number, minRiseKg = 0.9): Hit | null {
  const a = w.slice(-3);
  if (a.length < 3 || a[2].day < dayKey(now - 2 * DAY)) return null; // needs fresh readings
  if (!(a[0].v < a[1].v && a[1].v < a[2].v)) return null;
  const rise = a[2].v - a[0].v;
  if (rise < minRiseKg) return null;
  return {
    key: "weight_creep", title: WATCH_KEYS.weight_creep,
    detail: `Weight ${a.map((x) => x.v).join(" → ")} kg over 3 days (up ${r1(rise)} kg). Still inside the limits.`,
    advice: "Worth checking for swelling and keeping to the fluid and salt limits. Weigh again tomorrow morning.",
  };
}

/** Average systolic of the last 3 days at least 10 higher than the 7 days before, and getting close to the limit. */
export function detectBpDrift(d: DayVal[], th: Pick<Thresholds, "sysHigh">, now: number): Hit | null {
  const recent = d.filter((x) => x.day >= dayKey(now - 2 * DAY));
  const prior = d.filter((x) => x.day < dayKey(now - 2 * DAY) && x.day >= dayKey(now - 9 * DAY));
  if (recent.length < 2 || prior.length < 3) return null;
  const mean = (x: DayVal[]) => x.reduce((s, y) => s + y.v, 0) / x.length;
  const r = mean(recent), pr = mean(prior);
  if (r - pr < 10 || r < th.sysHigh - 15 || r >= th.sysHigh) return null;
  return {
    key: "bp_drift", title: WATCH_KEYS.bp_drift,
    detail: `Average top BP number is ${Math.round(r)} over the last 3 days, up from ${Math.round(pr)} the week before (limit ${th.sysHigh}).`,
    advice: "Please check the BP tablets are being taken, and keep the salt low. The doctor's team can see this trend.",
  };
}

/** Weight up ≥1 kg in 2 days together with swelling/breathlessness reported, or a missed water tablet. */
export function detectFluid(w: DayVal[], signs: { symptom: string | null; missedDiuretic: string | null }, now: number): Hit | null {
  const a = w.filter((x) => x.day >= dayKey(now - 2 * DAY));
  if (a.length < 2) return null;
  const rise = a[a.length - 1].v - Math.min(...a.slice(0, -1).map((x) => x.v));
  if (rise < 1 || !(signs.symptom || signs.missedDiuretic)) return null;
  const why = [signs.symptom && `${signs.symptom} reported`, signs.missedDiuretic && `${signs.missedDiuretic} dose missed`].filter(Boolean).join(" and ");
  return {
    key: "fluid_buildup", title: WATCH_KEYS.fluid_buildup,
    detail: `Weight is up ${r1(rise)} kg in 2 days, and ${why}. These together can mean fluid is building up.`,
    advice: "Please check for swelling and breathlessness, keep strictly to the fluid limit, and contact the clinic if it continues.",
  };
}

/** Last 3 days under 70% of doses taken after a good week (≥85%), with enough doses in both windows to mean something. */
export function detectAdherenceSlip(recent: { due: number; done: number }, prior: { due: number; done: number }): Hit | null {
  if (recent.due < 4 || prior.due < 10) return null;
  const rp = recent.done / recent.due, pp = prior.done / prior.due;
  if (rp >= 0.7 || pp < 0.85) return null;
  return {
    key: "adherence_slip", title: WATCH_KEYS.adherence_slip,
    detail: `Only ${recent.done} of ${recent.due} doses were confirmed in the last 3 days, after ${Math.round(pp * 100)}% the week before.`,
    advice: "Please check how things are going with the tablets. If it is getting hard, tell the clinic so they can help.",
  };
}

// ---------------------------------------------------------------- data + storage
const offKey = (pid: string, key: string) => `watch_off:${pid}:${key}`;
export const isOff = (pid: string, key: string) => getSetting(offKey(pid, key)) === "1";

function byDay(rows: { v: number; at: number }[]): DayVal[] {
  const m = new Map<string, { v: number; at: number }>();
  for (const r of rows) { const k = dayKey(r.at); const c = m.get(k); if (!c || r.at > c.at) m.set(k, r); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, r]) => ({ day, v: r.v }));
}
function meanByDay(rows: { v: number; at: number }[]): DayVal[] {
  const m = new Map<string, number[]>();
  for (const r of rows) { const k = dayKey(r.at); m.set(k, [...(m.get(k) ?? []), r.v]); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, v: v.reduce((s, x) => s + x, 0) / v.length }));
}

export function evaluateWatches(p: PatientRow, t: number) {
  const visit = latestVisit(p.id, t);
  if (!visit) return;
  const th = visit.plan.thresholds;
  const hits: Hit[] = [];
  const weightAlert = get("SELECT 1 FROM escalations WHERE patient_id = ? AND rule_key LIKE 'weight%' AND state IN ('NOTIFIED','ACKNOWLEDGED')", p.id);

  const weights = byDay(all<{ v1: number; observed_at: number }>("SELECT v1, observed_at FROM observations WHERE patient_id = ? AND type = 'weight' AND observed_at > ?", p.id, t - 7 * DAY).map((r) => ({ v: r.v1, at: r.observed_at })));
  if (!weightAlert) {
    const c = detectWeightCreep(weights, t); if (c) hits.push(c);
  }
  const bp = meanByDay(all<{ v1: number; observed_at: number }>("SELECT v1, observed_at FROM observations WHERE patient_id = ? AND type = 'bp' AND observed_at > ?", p.id, t - 10 * DAY).map((r) => ({ v: r.v1, at: r.observed_at })));
  const d = detectBpDrift(bp, th, t); if (d) hits.push(d);

  const sx = all<{ text: string }>("SELECT text FROM observations WHERE patient_id = ? AND type = 'symptom' AND observed_at > ? AND text IN ('edema','breathlessness','orthopnea')", p.id, t - 2 * DAY)[0]?.text;
  const missed = all<{ label: string }>("SELECT label FROM tasks WHERE patient_id = ? AND kind = 'med' AND status IN ('MISSED','NOT_DONE') AND due_at > ? AND due_at <= ?", p.id, t - 2 * DAY, t).find((x) => isDiuretic(x.label));
  const f = detectFluid(weights, { symptom: sx === "edema" ? "swelling" : sx === "breathlessness" || sx === "orthopnea" ? "breathlessness" : null, missedDiuretic: missed ? missed.label.split(" ")[0] : null }, t);
  if (f && !weightAlert) hits.push(f);

  const win = (from: number, to: number) => get<{ due: number; done: number }>("SELECT COUNT(*) AS due, COALESCE(SUM(status = 'DONE'), 0) AS done FROM tasks WHERE patient_id = ? AND kind = 'med' AND status IN ('DONE','MISSED','NOT_DONE') AND due_at > ? AND due_at <= ?", p.id, from, to)!;
  const a = detectAdherenceSlip(win(t - 3 * DAY, t), win(t - 10 * DAY, t - 3 * DAY)); if (a) hits.push(a);

  const live = new Set(hits.filter((h) => !isOff(p.id, h.key)).map((h) => h.key));
  // conditions that no longer hold close their watch
  for (const w of all<{ id: number; key: string }>("SELECT id, key FROM watches WHERE patient_id = ? AND state = 'OPEN'", p.id)) {
    if (!live.has(w.key)) { run("UPDATE watches SET state = 'CLEARED', closed_at = ?, closed_by = 'system' WHERE id = ?", t, w.id); }
  }
  for (const h of hits) {
    if (!live.has(h.key)) continue;
    const open = get<{ id: number }>("SELECT id FROM watches WHERE patient_id = ? AND key = ? AND state = 'OPEN'", p.id, h.key);
    if (open) { run("UPDATE watches SET detail = ?, updated_at = ? WHERE id = ?", h.detail, t, open.id); continue; }
    const cool = get("SELECT 1 FROM watches WHERE patient_id = ? AND key = ? AND state IN ('DISMISSED','CLEARED') AND closed_at > ?", p.id, h.key, t - 3 * DAY);
    if (cool) continue;
    const id = run("INSERT INTO watches(patient_id, key, title, detail, advice, state, started_at, updated_at) VALUES(?,?,?,?,?,'OPEN',?,?)", p.id, h.key, h.title, h.detail, h.advice, t, t).lastInsertRowid;
    audit(t, "system", "WATCH_OPENED", "patient", p.id, { key: h.key, watch: id });
    notify(p, h, t);
  }
}

/** A gentle heads-up (explicitly "not an alarm") to the patient and the first caregiver. */
function notify(p: PatientRow, h: Hit, t: number) {
  const doc = getUser(p.doctor_id)?.name ?? "the doctor";
  const cg = getCaregivers(p.id)[0];
  const body = (you: boolean) => `👀 A heads-up, not an alarm: ${you ? h.detail.replace(/^Weight /, "Your weight ").replace(/^Average/, "Your average") : h.detail}\n${h.advice}\n${doc}'s team can see this too.`;
  if (p.user_id) sendWhatsApp({ userId: p.user_id, patientId: p.id, body: body(true), kind: "info", at: t });
  if (cg?.user_id && !get("SELECT 1 FROM consents WHERE patient_id = ? AND user_id = ? AND status != 'GIVEN'", p.id, cg.user_id)) sendWhatsApp({ userId: cg.user_id, patientId: p.id, body: `👀 ${first(p.name)}: a heads-up, not an alarm.\n${h.detail}\n${h.advice}`, kind: "info", at: t });
}

export interface WatchRow { id: number; patient_id: string; key: string; title: string; detail: string; advice: string | null; state: string; started_at: number }
export const openWatches = (pid: string) => all<WatchRow>("SELECT * FROM watches WHERE patient_id = ? AND state = 'OPEN' ORDER BY started_at DESC", pid);
export const watchOffList = (pid: string) => Object.keys(WATCH_KEYS).filter((k) => isOff(pid, k));

export function dismissWatch(id: number, userId: string, t: number) {
  const w = get<WatchRow>("SELECT * FROM watches WHERE id = ?", id);
  if (!w || w.state !== "OPEN") return;
  run("UPDATE watches SET state = 'DISMISSED', closed_at = ?, closed_by = ? WHERE id = ?", t, userId, id);
  audit(t, userId, "WATCH_DISMISSED", "patient", w.patient_id, { key: w.key });
}
export function setWatchOff(pid: string, key: string, off: boolean, userId: string, t: number) {
  if (!WATCH_KEYS[key]) throw new Error("Unknown pattern");
  setSetting(offKey(pid, key), off ? "1" : "0");
  if (off) for (const w of all<{ id: number }>("SELECT id FROM watches WHERE patient_id = ? AND key = ? AND state = 'OPEN'", pid, key)) dismissWatch(w.id, userId, t);
  audit(t, userId, off ? "WATCH_TURNED_OFF" : "WATCH_TURNED_ON", "patient", pid, { key });
}

/** Once a morning for every patient (patterns also re-check right after a reading comes in). */
export function tickWatches(t: number) {
  if (localHHMM(t) < "09:30") return;
  for (const p of all<{ id: string }>("SELECT id FROM patients")) {
    const k = `watchday:${p.id}`;
    if (getSetting(k) === dayKey(t)) continue;
    setSetting(k, dayKey(t));
    const pt = getPatient(p.id);
    if (pt) evaluateWatches(pt, t);
  }
}
void HOUR; void dayStart;
