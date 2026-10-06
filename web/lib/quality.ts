// Trusting the data: typo checks, corrections, recheck-before-alerting and device-photo readings.
// Rules and the doctor's limits still decide every alert. Nothing here lowers a safety rule:
// emergency readings alert at once, real-looking readings are always logged, and a held reading is
// escalated anyway if no recheck arrives.
import { all, audit, get, getSetting, run, setSetting } from "./db";
import { createEscalation, evaluateVital, getCaregivers, getPatient, getUser, resolveEscalation, type Alert, type EscalationRow, type PatientRow, type UserRow } from "./engine";
import { sendWhatsApp } from "./whatsapp";
import { DAY, HOUR, MIN, fmtTime } from "./time";
import { VITAL_META, shortName, type CarePlan, type ClinicVitals, type ParsedMessage, type VitalType } from "./types";

const first = (n: string) => shortName(n);
const OPEN = "('NOTIFIED','ACKNOWLEDGED')";

// ---------------------------------------------------------------- typo check (pure)
export interface Doubt {
  type: VitalType;
  raw: string; // what they wrote, e.g. "592 kg"
  label: string; // "weight"
  why: "high" | "low" | "odd";
  fix: { label: string; text: string } | null; // what we think they meant
}
const LIM: Partial<Record<VitalType, [number, number]>> = { weight: [20, 250], hr: [30, 220], spo2: [50, 100], glucose: [20, 600] };
const inR = (v: number, t: VitalType) => v >= LIM[t]![0] && v <= LIM[t]![1];
const r1 = (n: number) => Math.round(n * 10) / 10;
const bpOk = (s: number, d: number) => s >= 70 && s <= 260 && d >= 40 && d <= 160 && s > d;
const closest = (cands: number[], ref: number | null) => (ref == null ? cands[0] : [...cands].sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))[0]);

export interface LastReadings { weight?: number | null; bp?: [number, number] | null }

/** Vitals written in the message that the parser had to drop because the number is impossible. */
export function findDoubts(body: string, have: Set<VitalType>, last: LastReadings = {}): Doubt[] {
  const t = " " + body.toLowerCase().replace(/[’']/g, "'") + " ";
  const out: Doubt[] = [];
  const single = (type: VitalType, label: string, unit: string, res: RegExp[], cands: (n: number) => number[], fixText: (v: number) => string, ref: number | null) => {
    if (have.has(type)) return;
    for (const re of res) {
      const m = t.match(re);
      if (!m) continue;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || inR(n, type)) return;
      const ok = cands(n).filter((c) => inR(c, type));
      const v = ok.length ? closest(ok, ref) : null;
      out.push({ type, label, raw: `${m[1]}${unit ? " " + unit : ""}`, why: n > LIM[type]![1] ? "high" : n < LIM[type]![0] ? "low" : "odd", fix: v == null ? null : { label: `${v}${unit ? " " + unit : ""}`, text: fixText(v) } });
      return;
    }
  };
  single("weight", "weight", "kg", [/(?:weight|\bwt\b|weigh\w*)(?:\s*(?:is|was|now|today|:|-|=))*\s*(\d+(?:\.\d+)?)/, /(\d+(?:\.\d+)?)\s*kgs?\b/], (n) => [r1(n / 10), r1(n * 10), r1(n / 100)], (v) => `weight ${v}`, last.weight ?? null);
  single("hr", "pulse", "bpm", [/(?:pulse|\bhr\b|heart ?rate|heartbeat)(?:\s*(?:is|was|now|today|:|-|=))*\s*(\d+)/], (n) => [Math.round(n / 10), n * 10], (v) => `pulse ${v}`, null);
  single("spo2", "oxygen", "%", [/(?:spo2|sp02|sp o2|oxygen|o2|saturation|sats?)\D{0,10}(\d+)/], (n) => (n > 100 ? [Math.round(n / 10)] : []), (v) => `spo2 ${v}`, null);

  if (!have.has("glucose")) {
    const m = t.match(/(?:sugar|glucose|fbs|ppbs|rbs|fasting|bsl|gluco\w*)\D{0,14}(\d+(?:\.\d+)?)/);
    const n = m ? Number(m[1]) : NaN;
    if (m && Number.isFinite(n) && (n < 20 || n > 600)) {
      if (n >= 2 && n <= 35) {
        const mg = Math.round(n * 18);
        out.push({ type: "glucose", label: "sugar", raw: m[1], why: "low", fix: { label: `${m[1]} mmol/L = about ${mg} mg/dL`, text: `sugar ${mg}` } });
      } else {
        const ok = [Math.round(n / 10), n * 10].filter((c) => c >= 20 && c <= 600);
        out.push({ type: "glucose", label: "sugar", raw: m[1], why: n > 600 ? "high" : "low", fix: ok.length ? { label: `${ok[0]} mg/dL`, text: `sugar ${ok[0]}` } : null });
      }
    }
  }

  if (!have.has("bp")) {
    const m = t.match(/(\d{1,4})\s*(?:\/|over|by)\s*(\d{1,4})/);
    if (m) {
      const s = Number(m[1]), d = Number(m[2]);
      const keyword = /\b(bp|b\.p|blood pressure|pressure)\b/.test(t);
      const looksTypo = s >= 300 || d >= 200; // "1400/80", "140/800"
      const isFraction = s <= 20 && d <= 20; // "1/2 tablet", "4/10 pain"
      if (!bpOk(s, d) && (keyword || looksTypo) && !isFraction) {
        const cands: [number, number][] = [[d, s], [Math.round(s / 10), d], [s * 10, d], [s, Math.round(d / 10)], [s, d * 10], [Math.round(s / 10), Math.round(d / 10)]];
        const ok = cands.filter(([a, b]) => bpOk(a, b));
        const ref = last.bp ? last.bp[0] : null;
        const pick = ok.length ? [...ok].sort((a, b) => (ref == null ? 0 : Math.abs(a[0] - ref) - Math.abs(b[0] - ref)))[0] : null;
        out.push({ type: "bp", label: "blood pressure", raw: `${m[1]}/${m[2]}`, why: s > 260 || d > 160 ? "high" : "odd", fix: pick ? { label: `${pick[0]}/${pick[1]}`, text: `BP ${pick[0]}/${pick[1]}` } : null });
      }
    }
  }
  return out;
}

export function doubtReply(d: Doubt, who: string): { text: string; fixText: string | null; quick: string[] } {
  const verb = d.why === "odd" ? "doesn't look right" : `looks too ${d.why}`;
  if (d.fix) return { text: `🤔 I haven't logged ${who}${d.label} “${d.raw}”: that ${verb}.\nDid you mean *${d.fix.label}*?`, fixText: d.fix.text, quick: [`Yes, ${d.fix.label}`.slice(0, 24), "No"] };
  return { text: `🤔 I haven't logged ${who}${d.label} “${d.raw}”: that ${verb}. Please check the reading and send it again, for example “${d.type === "bp" ? "BP 130/80" : d.type === "weight" ? "weight 72.8" : d.type === "glucose" ? "sugar 110" : d.type === "hr" ? "pulse 76" : "oxygen 97"}”.`, fixText: null, quick: [] };
}

/** A real-looking weight far from the last one: still logged (it may be real fluid gain), with a gentle "typo?" note. */
export function weightJumpNote(prev: { v: number; at: number } | null, v: number, t: number): string | null {
  if (!prev || t - prev.at > 4 * DAY) return null;
  const diff = v - prev.v;
  if (Math.abs(diff) < Math.max(4, prev.v * 0.08)) return null;
  return `That's ${Math.abs(r1(diff))} kg ${diff > 0 ? "above" : "below"} the last weight (${prev.v} kg). It's logged. If it was a typo, reply with the right number, for example “sorry, weight is ${r1(prev.v)}”.`;
}

// ---------------------------------------------------------------- corrections
export const CORRECTION_RE = /\b(correction|corrected|correcting|typo|mistyped|i meant|meant to (?:type|write|say)|should (?:have )?(?:be|been|say|read)|instead of|rather than|by mistake|my mistake|(?:wrong|incorrect|mistaken) (?:number|reading|value|entry|one)|(?:was|were|that was|that one was) (?:wrong|incorrect|a mistake))\b/i;

/** "that was 128, not 182" → { to: 128, from: 182 } */
export function correctionPair(body: string): { from: number; to: number } | null {
  const t = body.toLowerCase();
  const N = "(\\d+(?:\\.\\d+)?)";
  let m = t.match(new RegExp(`${N}\\s*(?:,|\\.)?\\s*(?:and\\s+)?not\\s*${N}`));
  if (m) return { to: Number(m[1]), from: Number(m[2]) };
  m = t.match(new RegExp(`not\\s*${N}\\s*(?:,|\\.)?\\s*(?:but|it was|it is|rather|really|actually)?\\s*${N}`));
  if (m) return { from: Number(m[1]), to: Number(m[2]) };
  m = t.match(new RegExp(`${N}\\s*(?:instead of|rather than)\\s*${N}`));
  if (m) return { to: Number(m[1]), from: Number(m[2]) };
  return null;
}

interface ObsRow { id: number; type: VitalType; v1: number; v2: number | null; observed_at: number; flag: string | null }
const fmtVal = (type: VitalType, v1: number, v2: number | null) => `${VITAL_META[type].label.replace(/ \(.*\)/, "")} ${type === "bp" ? `${v1}/${v2}` : v1}`;
const circle = (p: PatientRow, exceptUser: string) => [p.user_id, ...getCaregivers(p.id).map((c) => c.user_id)].filter((u): u is string => !!u && u !== exceptUser);

export interface CorrectionResult { lines: string[]; remove: Set<VitalType>; alerts: Alert[] }

/**
 * Applies "sorry, that was 128 not 182" and "typo, BP should be 128/82" to the latest matching reading in the
 * last 36 hours: the value is replaced (the old one stays in the audit trail), the alert rules run again,
 * and an alert the typo caused is closed with everyone told.
 */
export function applyCorrections(p: PatientRow, plan: CarePlan, baseline: ClinicVitals, user: UserRow, body: string, parsed: ParsedMessage, msgId: number, t: number): CorrectionResult {
  const out: CorrectionResult = { lines: [], remove: new Set(), alerts: [] };
  const since = t - 36 * HOUR;
  const recent = (type: VitalType) => get<ObsRow>("SELECT id, type, v1, v2, observed_at, flag FROM observations WHERE patient_id = ? AND type = ? AND observed_at > ? ORDER BY observed_at DESC LIMIT 1", p.id, type, since);
  const targets: { obs: ObsRow; v1: number; v2: number | null }[] = [];

  if (CORRECTION_RE.test(body)) {
    for (const v of parsed.vitals) {
      const obs = recent(v.type);
      if (obs && (obs.v1 !== v.v1 || (obs.v2 ?? null) !== (v.v2 ?? null))) targets.push({ obs, v1: v.v1, v2: v.v2 ?? null });
    }
  }
  const pair = !targets.length ? correctionPair(body) : null;
  if (pair && pair.from !== pair.to) {
    const rows = all<ObsRow>("SELECT id, type, v1, v2, observed_at, flag FROM observations WHERE patient_id = ? AND observed_at > ? AND type IN ('bp','weight','glucose','hr','spo2','temp') ORDER BY observed_at DESC", p.id, since);
    const hit = rows.find((o) => o.v1 === pair.from || o.v2 === pair.from);
    if (hit) targets.push({ obs: hit, v1: hit.v1 === pair.from ? pair.to : hit.v1, v2: hit.type === "bp" ? (hit.v2 === pair.from ? pair.to : hit.v2) : null });
  }

  for (const { obs, v1, v2 } of targets) {
    if (obs.type === "bp" && (v2 == null || !bpOk(v1, v2))) continue;
    if (obs.type !== "bp" && LIM[obs.type] && !inR(v1, obs.type)) continue;
    const old = fmtVal(obs.type, obs.v1, obs.v2);
    run("UPDATE observations SET v1 = ?, v2 = ? WHERE id = ?", v1, v2, obs.id);
    const { flag, alert } = evaluateVital(p, plan, baseline, obs.type, v1, v2 ?? undefined, obs.observed_at, obs.id);
    run("UPDATE observations SET flag = ? WHERE id = ?", flag, obs.id);
    audit(t, user.id, "OBSERVATION_CORRECTED", "observation", obs.id, { type: obs.type, from: [obs.v1, obs.v2], to: [v1, v2], messageId: msgId });
    clearRecheck(p.id, obs.type);
    out.remove.add(obs.type);
    out.lines.push(`✏️ Corrected: ${old} → ${fmtVal(obs.type, v1, v2)}${flag ? " ⚠️" : ""}`);

    const esc = get<EscalationRow>(`SELECT * FROM escalations WHERE trigger_observation_id = ? AND state IN ${OPEN}`, obs.id);
    const stale = esc && (!alert || alert.ruleKey !== esc.rule_key); // the typo's alert no longer applies
    if (esc && stale) {
      resolveEscalation(esc.id, user.id, "CORRECTED", `Reading corrected from ${old} to ${fmtVal(obs.type, v1, v2)}`, t, "auto");
      for (const u of circle(p, user.id)) sendWhatsApp({ userId: u, patientId: p.id, kind: "info", at: t + 500, body: `✏️ Correction: ${first(p.name)}'s ${fmtVal(obs.type, v1, v2).toLowerCase()} was entered wrongly earlier (${old}). The alert “${esc.title}” is closed${alert ? `, but the corrected reading still needs attention (see the next message)` : ". No action needed"}.` });
    }
    if (alert && (!esc || stale)) out.alerts.push({ ...alert, observationId: obs.id });
  }
  return out;
}

// ---------------------------------------------------------------- recheck before alerting
const RECHECK_WINDOW = 60 * MIN; // a new reading in this time counts as the recheck
const RECHECK_WAIT = 30 * MIN; // after this, the family is alerted anyway
const rkey = (pid: string, type: VitalType) => `recheck:${pid}:${type}`;
interface Pending { at: number; alert: Alert; reading: string; by: string }

/** Is this a borderline single reading, safe to ask for a recheck first? Never for emergency rules. */
export function isBorderline(type: VitalType, alert: Alert, plan: CarePlan, v1: number, v2: number | undefined): boolean {
  const th = plan.thresholds;
  if (alert.type !== "DEVIATION") return false;
  if (type === "bp" && alert.ruleKey === "bp_high") return v1 <= th.sysHigh + 20 && (v2 ?? 0) <= th.diaHigh + 10;
  if (type === "hr" && alert.ruleKey === "hr_abnormal") return v1 > th.hrHigh && v1 <= th.hrHigh + 20;
  return false;
}

const clearRecheck = (pid: string, type: VitalType) => run("DELETE FROM settings WHERE key = ?", rkey(pid, type));
const getPending = (pid: string, type: VitalType, t: number): Pending | null => {
  const raw = getSetting(rkey(pid, type));
  if (!raw) return null;
  const p = JSON.parse(raw) as Pending;
  return t - p.at <= RECHECK_WINDOW ? p : null;
};

export interface Gate { alert: Alert | null; say: string | null }
/**
 * Decides what to do with the alert a reading produced. Returns the alert to raise now (or null to hold it) and
 * a sentence for the reply. A held reading is alerted by `tickRechecks` if no recheck arrives.
 */
export function recheckGate(p: PatientRow, plan: CarePlan, type: VitalType, v1: number, v2: number | undefined, alert: Alert | null, by: UserRow, t: number): Gate {
  const pending = getPending(p.id, type, t);
  if (!alert) {
    if (pending) { clearRecheck(p.id, type); return { alert: null, say: "👍 The recheck is back within the doctor's limits. Thank you." }; }
    return { alert: null, say: null };
  }
  if (pending) {
    clearRecheck(p.id, type);
    return { alert: { ...alert, detail: `${alert.detail} Still outside the limit on recheck (first reading ${pending.reading}).` }, say: null };
  }
  const open = get("SELECT 1 FROM escalations WHERE patient_id = ? AND rule_key = ? AND state IN " + OPEN, p.id, alert.ruleKey);
  if (open || !isBorderline(type, alert, plan, v1, v2)) return { alert, say: null };
  const reading = type === "bp" ? `${v1}/${v2}` : String(v1);
  setSetting(rkey(p.id, type), JSON.stringify({ at: t, alert, reading, by: by.id } satisfies Pending));
  const caregiver = by.role === "CAREGIVER";
  const first1 = getCaregivers(p.id)[0]?.name;
  return {
    alert: null,
    say: `⏳ That's only a little above the limit. ${caregiver ? `Please let ${first(p.name)} sit quietly` : "Please sit quietly"} for 10 minutes (feet flat, arm resting), then measure again and send it.\nIf it's still high${first1 ? `, I'll let ${first1} know` : ", I'll let your care circle know"}. If ${caregiver ? "they feel" : "you feel"} unwell, don't wait.`,
  };
}

/** Held readings whose recheck never came: alert the care circle now, as the rule always intended. */
export function tickRechecks(t: number) {
  for (const r of all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'recheck:%'")) {
    const p0 = JSON.parse(r.value) as Pending;
    if (t - p0.at < RECHECK_WAIT) continue;
    run("DELETE FROM settings WHERE key = ?", r.key);
    const pid = r.key.split(":")[1];
    const p = getPatient(pid);
    if (!p) continue;
    const id = createEscalation(p, { ...p0.alert, detail: `${p0.alert.detail} No recheck was received within 30 minutes.` }, t);
    audit(t, "system", "RECHECK_TIMEOUT", "patient", pid, { reading: p0.reading, escalation: id });
    if (p.user_id && id) sendWhatsApp({ userId: p.user_id, patientId: pid, kind: "info", at: t, body: `I didn't get a recheck (${fmtTime(p0.at)} reading ${p0.reading}), so I've let your care circle know. It's best to have it checked.` });
  }
}

// ---------------------------------------------------------------- device photos
export interface DeviceRead {
  isDevice: boolean;
  device?: string;
  readings?: { sys?: number; dia?: number; pulse?: number; glucose?: number; weight?: number; spo2?: number; temp?: number };
  unit?: string;
  confidence?: string;
  note?: string;
}
/** Turns what the AI read off a device into the text the normal parser understands, or null if unsure. */
export function deviceText(d: DeviceRead | null): { text: string; label: string } | null {
  if (!d?.isDevice || !d.readings || d.confidence === "low") return null;
  const r = d.readings, parts: string[] = [], shown: string[] = [];
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const sys = num(r.sys), dia = num(r.dia), pulse = num(r.pulse), spo2 = num(r.spo2), temp = num(r.temp);
  let glucose = num(r.glucose), weight = num(r.weight);
  if (sys != null && dia != null) { parts.push(`BP ${sys}/${dia}`); shown.push(`BP ${sys}/${dia}`); }
  if (glucose != null) {
    if (/mmol/i.test(d.unit ?? "") || (glucose < 35 && /\./.test(String(glucose)))) glucose = Math.round(glucose * 18);
    parts.push(`sugar ${glucose}`); shown.push(`sugar ${glucose} mg/dL`);
  }
  if (weight != null) {
    if (/lb|pound/i.test(d.unit ?? "")) weight = r1(weight * 0.4536);
    parts.push(`weight ${weight}`); shown.push(`weight ${weight} kg`);
  }
  if (spo2 != null) { parts.push(`spo2 ${spo2}`); shown.push(`oxygen ${spo2}%`); }
  if (pulse != null) { parts.push(`pulse ${pulse}`); shown.push(`pulse ${pulse}`); }
  if (temp != null) { parts.push(`temp ${temp}`); shown.push(`temperature ${temp}`); }
  return parts.length ? { text: parts.join(", "), label: shown.join(", ") } : null;
}
