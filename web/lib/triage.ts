// Doctor triage queue: one line on why a patient needs attention, a 14-day trend against the
// doctor's limits, the care circle's status, and whether a clinician has reviewed it since.
import { all, audit, get, run } from "./db";
import { OUTCOMES, getCaregivers, getUser, type EscalationRow, type PatientRow } from "./engine";
import { DAY, fmtTime, fmtDate } from "./time";
import { VITAL_META, type Visit, type VitalType } from "./types";

export interface Trend { type: VitalType; label: string; points: number[]; lo: number | null; hi: number | null; bad: boolean; latest: string; unit: string; latestAt: number }
export interface CircleStatus { tone: "green" | "amber" | "red" | "grey"; label: string; detail: string }
export interface Triage {
  reason: { title: string; detail: string };
  trend: Trend | null;
  circle: CircleStatus;
  lastEventAt: number | null;
  review: { at: number; by: string; byId: string } | null;
  needsReview: boolean;
}

const SEV: Record<string, number> = { URGENT: 0, DEVIATION: 1, COMPLIANCE: 2 };
const LABEL: Partial<Record<VitalType, string>> = { bp: "Blood pressure", weight: "Weight", spo2: "SpO₂", glucose: "Sugar", hr: "Pulse", pain: "Pain" };
const when = (at: number, t: number) => (t - at < DAY && fmtDate(at) === fmtDate(t) ? fmtTime(at) : fmtDate(at, { day: "numeric", month: "short" }) + " " + fmtTime(at));
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(" ", n - 1) > n * 0.6 ? s.lastIndexOf(" ", n - 1) : n - 1).replace(/[,;:\s]+$/, "") + "…");
/** One short line from an alert's detail: drop doses/times in brackets and the "X hasn't confirmed:" lead-in. */
function shortDetail(e: { type: string; detail: string | null }): string {
  let d = (e.detail ?? "").replace(/\s*\([^)]*\)/g, "");
  if (e.type === "COMPLIANCE") {
    const list = d.replace(/^[^:]*:\s*/, "").split(/,\s*/).map((x) => x.trim().split(/\s+\d/)[0]).filter(Boolean);
    return list.length ? `Not confirmed: ${clip(list.join(", "), 60)}` : clip(d, 80);
  }
  d = d.split(/(?<=[.!?])\s/)[0].replace(/[.\s]+$/, "");
  return clip(d, 90);
}

function ruleVital(rule: string): VitalType | null {
  if (rule.startsWith("bp")) return "bp";
  if (rule.includes("spo2")) return "spo2";
  if (rule.includes("weight")) return "weight";
  if (rule.includes("glucose") || rule.includes("sugar")) return "glucose";
  if (rule.includes("hr") || rule.includes("pulse")) return "hr";
  if (rule.includes("pain")) return "pain";
  return null;
}

function trendFor(pid: string, visit: Visit | undefined, prefer: VitalType | null, t: number): Trend | null {
  const monitored = visit?.plan.monitoring.map((m) => m.key) ?? [];
  const type: VitalType | undefined = prefer ?? (monitored.includes("bp") ? "bp" : monitored[0]);
  if (!type) return null;
  const rows = all<{ v1: number; v2: number | null; flag: string | null; observed_at: number }>("SELECT v1, v2, flag, observed_at FROM observations WHERE patient_id = ? AND type = ? AND observed_at > ? ORDER BY observed_at", pid, type, t - 14 * DAY);
  if (rows.length < 1) return null;
  const th = visit?.plan.thresholds;
  let lo: number | null = null, hi: number | null = null;
  if (th) {
    if (type === "bp") { lo = th.sysLow; hi = th.sysHigh; }
    else if (type === "spo2") { lo = th.spo2Low; hi = 100; }
    else if (type === "glucose") { lo = th.glucoseLow; hi = th.glucoseHigh; }
    else if (type === "hr") { lo = th.hrLow; hi = th.hrHigh; }
    else if (type === "weight" && th.dryWeight) { lo = th.dryWeight - (th.weightBand ?? 1); hi = th.dryWeight + (th.weightBand ?? 1); }
    else if (type === "pain") { lo = 0; hi = th.painHigh; }
  }
  const pts = rows.slice(-20).map((r) => r.v1);
  const last = rows[rows.length - 1];
  return { type, label: LABEL[type] ?? type, points: pts, lo, hi, bad: !!last.flag || rows.slice(-3).some((r) => !!r.flag), latest: `${last.v1}${last.v2 ? `/${last.v2}` : ""}`, unit: VITAL_META[type]?.unit ?? "", latestAt: last.observed_at };
}

function circleStatus(pid: string, open: EscalationRow[], t: number): CircleStatus {
  const cgs = getCaregivers(pid);
  const top = [...open].sort((a, b) => SEV[a.type] - SEV[b.type])[0];
  if (top) {
    if (top.state === "ACKNOWLEDGED") {
      const who = top.ack_by ? getUser(top.ack_by)?.name.split(" ")[0] : "Caregiver";
      return { tone: "green", label: `${who} acknowledged`, detail: top.ack_at ? when(top.ack_at, t) : "" };
    }
    const cg = cgs.find((c) => c.level === top.level);
    const mins = Math.max(0, Math.round((t - top.level_at) / 60000));
    return { tone: top.level > 1 ? "red" : "amber", label: top.level > 1 ? "Waiting on backup" : "Waiting on primary", detail: `${cg?.name.split(" ")[0] ?? "Caregiver"} · ${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`}, no reply` };
  }
  const last = get<EscalationRow>("SELECT * FROM escalations WHERE patient_id = ? AND state IN ('RESOLVED','EXHAUSTED') AND resolved_at > ? ORDER BY resolved_at DESC LIMIT 1", pid, t - 3 * DAY);
  if (last) {
    const by = last.resolved_by ? getUser(last.resolved_by)?.name.split(" ")[0] : null;
    const label = last.state === "EXHAUSTED" ? "No one responded" : last.outcome_code === "2" ? "Contacted the clinic" : last.outcome_code === "3" ? "Taken to hospital" : last.outcome_code === "AUTO" ? "Resolved by patient" : "Resolved at home";
    return { tone: last.state === "EXHAUSTED" ? "red" : "grey", label, detail: [by, last.resolved_at ? when(last.resolved_at, t) : ""].filter(Boolean).join(" · ") };
  }
  return { tone: "grey", label: "No open alerts", detail: cgs.length ? `${cgs.length} in care circle` : "No care circle" };
}

export function triage(p: PatientRow, visit: Visit | undefined, open: EscalationRow[], medsPct: number | null, t: number): Triage {
  const top = [...open].sort((a, b) => SEV[a.type] - SEV[b.type] || b.started_at - a.started_at)[0];
  const recent = get<EscalationRow>("SELECT * FROM escalations WHERE patient_id = ? AND type != 'COMPLIANCE' AND started_at > ? ORDER BY started_at DESC LIMIT 1", p.id, t - 7 * DAY);
  const flagged = get<{ type: string; v1: number; v2: number | null; observed_at: number }>("SELECT type, v1, v2, observed_at FROM observations WHERE patient_id = ? AND flag IS NOT NULL AND observed_at > ? ORDER BY observed_at DESC LIMIT 1", p.id, t - 3 * DAY);

  let reason: Triage["reason"];
  if (top) reason = { title: top.title, detail: `${shortDetail(top)}${top.started_at ? ` · ${when(top.started_at, t)}` : ""}` };
  else if (recent) reason = { title: recent.title, detail: `Closed · ${shortDetail(recent)}` };
  else if (!visit) reason = { title: "Awaiting Visit 1", detail: "No care plan yet" };
  else if (medsPct != null && medsPct < 80) reason = { title: `Medicines logged on ${medsPct}% of doses`, detail: "Since the last visit" };
  else reason = { title: "On track", detail: "No alerts in the last 7 days" };

  const prefer = top ? ruleVital(top.rule_key) : recent ? ruleVital(recent.rule_key) : null;
  const lastEventAt = Math.max(top?.level_at ?? 0, top?.started_at ?? 0, recent?.started_at ?? 0, flagged?.observed_at ?? 0) || null;
  const r = get<{ at: number; user_id: string }>("SELECT at, user_id FROM patient_reviews WHERE patient_id = ? ORDER BY at DESC LIMIT 1", p.id);
  const review = r ? { at: r.at, by: getUser(r.user_id)?.name ?? "Unknown", byId: r.user_id } : null;
  const attention = !!top || !!recent || (medsPct != null && medsPct < 80);
  return {
    reason,
    trend: visit ? trendFor(p.id, visit, prefer, t) : null,
    circle: circleStatus(p.id, open, t),
    lastEventAt,
    review,
    needsReview: !!visit && attention && (!review || (lastEventAt != null && review.at < lastEventAt)),
  };
}

export function markReviewed(pid: string, userId: string, t: number) {
  run("INSERT INTO patient_reviews(patient_id, user_id, at) VALUES(?,?,?)", pid, userId, t);
  audit(t, userId, "PATIENT_REVIEWED", "patient", pid);
}

export function undoReview(pid: string, userId: string, t: number) {
  const r = get<{ id: number }>("SELECT id FROM patient_reviews WHERE patient_id = ? AND user_id = ? ORDER BY at DESC LIMIT 1", pid, userId);
  if (r) run("DELETE FROM patient_reviews WHERE id = ?", r.id);
  audit(t, userId, "PATIENT_REVIEW_UNDONE", "patient", pid);
}

export { OUTCOMES };
