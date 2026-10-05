// Core engine: care-plan task scheduling, WhatsApp ingestion, deterministic deviation rules and
// the care-circle escalation state machine (patient -> caregiver L1 -> L2 -> L3).
// Doctors/PAs are NEVER notified by this engine — they see everything on the dashboard.
import { all, audit, get, getSetting, run, setSetting, tx } from "./db";
import { now, setSimNow } from "./clock";
import { parseMessage } from "./parser";
import { sendWhatsApp } from "./whatsapp";
import { DAY, HOUR, MIN, atLocal, dayStart, fmtDate, fmtTime, localDow, localHHMM } from "./time";
import type { CarePlan, ClinicVitals, EscalationType, ParsedMessage, Visit, VitalType } from "./types";
import { LAB_META, MAX_CAREGIVERS, SYMPTOMS, VITAL_META, shortName } from "./types";
import { dayIndex, describeMed, doseAt, medDueOn } from "./meds";

// ---------------------------------------------------------------- loaders
export interface UserRow {
  id: string;
  name: string;
  role: string;
  phone: string | null;
  title: string | null;
}
export interface PatientRow {
  id: string;
  user_id: string | null;
  name: string;
  age: number | null;
  sex: string | null;
  phone: string;
  conditions: string | null;
  address: string | null;
  doctor_id: string;
  created_at: number;
}
export interface CaregiverRow {
  id: string;
  patient_id: string;
  user_id: string | null;
  name: string;
  relation: string | null;
  phone: string;
  level: number;
  dashboard: number;
}
export interface EscalationRow {
  id: number;
  patient_id: string;
  type: EscalationType;
  rule_key: string;
  title: string;
  detail: string | null;
  advice: string | null;
  state: string;
  level: number;
  started_at: number;
  level_at: number;
  ack_by: string | null;
  ack_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  outcome_code: string | null;
  outcome_note: string | null;
  trigger_message_id: number | null;
  trigger_observation_id: number | null;
  task_ids: string | null;
}
interface TaskRow {
  id: number;
  patient_id: string;
  visit_id: string;
  kind: string;
  item_key: string;
  label: string;
  due_at: number;
  status: string;
}

export const getUser = (id: string) => get<UserRow>("SELECT * FROM users WHERE id = ?", id);
export const getPatient = (id: string) => get<PatientRow>("SELECT * FROM patients WHERE id = ?", id);
export const listPatients = () => all<PatientRow>("SELECT * FROM patients ORDER BY name");
export const getCaregivers = (pid: string) => all<CaregiverRow>("SELECT * FROM caregivers WHERE patient_id = ? ORDER BY level", pid);

export function rowToVisit(r: Record<string, unknown>): Visit {
  return {
    id: String(r.id),
    patient_id: String(r.patient_id),
    doctor_id: String(r.doctor_id),
    visit_at: Number(r.visit_at),
    vitals: JSON.parse(String(r.vitals)) as ClinicVitals,
    diagnosis: String(r.diagnosis ?? ""),
    notes: String(r.notes ?? ""),
    plan: JSON.parse(String(r.plan)) as CarePlan,
    next_visit_at: r.next_visit_at == null ? null : Number(r.next_visit_at),
    created_at: Number(r.created_at),
  };
}
export const getVisits = (pid: string) => all("SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_at", pid).map(rowToVisit);
export function getVisit(id: string): Visit | undefined {
  const r = get("SELECT * FROM visits WHERE id = ?", id);
  return r ? rowToVisit(r) : undefined;
}
export function latestVisit(pid: string, at = Infinity): Visit | undefined {
  const r = get("SELECT * FROM visits WHERE patient_id = ? AND visit_at <= ? ORDER BY visit_at DESC LIMIT 1", pid, at === Infinity ? Number.MAX_SAFE_INTEGER : at);
  return r ? rowToVisit(r) : undefined;
}

export function patientIdsForUser(user: UserRow): string[] {
  if (user.role === "PA") return listPatients().map((p) => p.id);
  if (user.role === "DOCTOR") return all<{ id: string }>("SELECT id FROM patients WHERE doctor_id = ? ORDER BY name", user.id).map((r) => r.id);
  if (user.role === "PATIENT") return all<{ id: string }>("SELECT id FROM patients WHERE user_id = ?", user.id).map((r) => r.id);
  return all<{ patient_id: string }>("SELECT patient_id FROM caregivers WHERE user_id = ?", user.id).map((r) => r.patient_id);
}

const first = (name: string) => shortName(name);
const doctorName = (p: PatientRow) => getUser(p.doctor_id)?.name ?? "your doctor";
export const clinicLabel = () => clinicName();
const clinicName = () => {
  const raw = getSetting("clinic");
  return raw ? (JSON.parse(raw) as { name: string }).name : null;
};

// ---------------------------------------------------------------- consent (requested on WhatsApp at onboarding)
export interface ConsentRow {
  user_id: string;
  role: string;
  status: "PENDING" | "GIVEN" | "DECLINED";
  requested_at: number;
  responded_at: number | null;
  message_id: number | null;
}
export const getConsents = (pid: string) => all<ConsentRow>("SELECT user_id, role, status, requested_at, responded_at, message_id FROM consents WHERE patient_id = ?", pid);
const pendingConsent = (pid: string, userId: string) => !!get("SELECT 1 FROM consents WHERE patient_id = ? AND user_id = ? AND status = 'PENDING'", pid, userId);

export function requestConsent(pid: string, userId: string, role: string, t: number) {
  run("INSERT INTO consents(patient_id, user_id, role, status, requested_at) VALUES(?,?,?,'PENDING',?) ON CONFLICT(patient_id, user_id) DO NOTHING", pid, userId, role, t);
}

function respondConsent(pid: string, userId: string, status: "GIVEN" | "DECLINED", msgId: number, t: number) {
  run("UPDATE consents SET status = ?, responded_at = ?, message_id = ? WHERE patient_id = ? AND user_id = ?", status, t, msgId, pid, userId);
  audit(t, userId, status === "GIVEN" ? "CONSENT_GIVEN" : "CONSENT_DECLINED", "patient", pid, { channel: "whatsapp", message: msgId });
}

// ---------------------------------------------------------------- tasks
const MISSED_AFTER: Record<string, number> = { med: 3 * HOUR, vital: 3 * HOUR, physio: 6 * HOUR, checkin: 3 * HOUR, fluid: 3 * HOUR, lab: 3 * DAY };

interface PlanItem {
  kind: string;
  key: string;
  label: string;
  times: string[];
  labels?: string[]; // per-time label (split doses)
  due: (dayIdx: number, dow: number) => boolean;
}

function planItems(plan: CarePlan): PlanItem[] {
  return [
    ...plan.medications
      .filter((m) => !m.prn)
      .map((m) => ({
        kind: "med",
        key: `med:${m.key}`,
        label: `${m.name} ${m.dose}`.trim(),
        labels: m.times.map((_, i) => `${m.name} ${doseAt(m, i)}`.trim()),
        times: m.times,
        due: (di: number, dow: number) => medDueOn(m, di, dow),
      })),
    ...plan.monitoring.map((v) => ({ kind: "vital", key: `vital:${v.key}`, label: VITAL_META[v.key]?.label ?? v.key, times: v.times, due: (_: number, dow: number) => !v.days || v.days.includes(dow) })),
    ...plan.physio.map((p) => ({ kind: "physio", key: `physio:${p.key}`, label: p.name, times: p.times, due: () => true })),
    ...(plan.checkinTime ? [{ kind: "checkin", key: "checkin:daily", label: "Evening check-in (symptoms & lifestyle)", times: [plan.checkinTime], due: () => true }] : []),
    ...(plan.fluid ? [{ kind: "fluid", key: "fluid:daily", label: "Fluid intake & urine (day totals)", times: [plan.fluid.checkTime || "21:00"], due: () => true }] : []),
    ...(plan.labs && plan.labs.everyDays > 0
      ? [{ kind: "lab", key: "lab:panel", label: `Lab test: ${plan.labs.panel}`, times: ["08:00"], due: (di: number) => di > 0 && di % plan.labs!.everyDays === 0 }]
      : []),
  ];
}

/** Idempotently materialise tasks from each visit's care plan up to a 2-day horizon. */
export function ensureTasks(pid: string, t: number) {
  const horizon = dayStart(t) + 2 * DAY;
  const genKey = `gen:${pid}`;
  const genUntil = Number(getSetting(genKey) || 0);
  if (genUntil >= horizon) return;
  const visits = getVisits(pid);
  for (let i = 0; i < visits.length; i++) {
    const v = visits[i];
    const segEnd = Math.min(i + 1 < visits.length ? visits[i + 1].visit_at : Infinity, horizon);
    const segStart = Math.max(v.visit_at, genUntil);
    if (segStart >= segEnd) continue;
    const items = planItems(v.plan);
    for (let d = dayStart(segStart); d <= segEnd; d += DAY) {
      const dow = localDow(d + 12 * HOUR);
      const di = dayIndex(v.visit_at, d);
      for (const it of items) {
        if (!it.due(di, dow)) continue;
        it.times.forEach((hhmm, ti) => {
          const due = atLocal(d, hhmm);
          if (due <= segStart || due > segEnd) return;
          run("INSERT OR IGNORE INTO tasks(patient_id, visit_id, kind, item_key, label, due_at) VALUES(?,?,?,?,?,?)", pid, v.id, it.kind, it.key, it.labels?.[ti] ?? it.label, due);
        });
      }
    }
  }
  setSetting(genKey, String(horizon));
}

function greet(due: number): string {
  const hour24 = Number(localHHMM(due).slice(0, 2));
  if (hour24 < 12) return "🌅 Good morning";
  if (hour24 < 17) return "☀️ Good afternoon";
  return "🌙 Good evening";
}

function promptText(p: PatientRow, tasks: TaskRow[], due: number): string {
  const meds = tasks.filter((t) => t.kind === "med").map((t) => `💊 ${t.label}`);
  const vitals = tasks.filter((t) => t.kind === "vital").map((t) => t.label);
  const physio = tasks.filter((t) => t.kind === "physio").map((t) => `🏃 ${t.label}`);
  const checkin = tasks.some((t) => t.kind === "checkin");
  const fluid = tasks.some((t) => t.kind === "fluid");
  const lab = tasks.find((t) => t.kind === "lab");
  const lines = [`${greet(due)} ${first(p.name)}! Time for:`];
  lines.push(...meds);
  if (vitals.length) lines.push(`📏 Check & send: ${vitals.join(", ")}`);
  lines.push(...physio);
  if (checkin) lines.push("📝 Daily check-in: any swelling, breathlessness, pain or other symptoms? Did you follow the diet/salt advice?");
  if (fluid) {
    const today = dayFluid(p.id, due);
    const limit = latestVisit(p.id, due)?.plan.fluid?.limitMl;
    lines.push(`💧 Fluid check: total intake today${today.in ? ` (I have ${today.in}${limit ? ` / ${limit}` : ""} ml so far)` : ""} and urine passed today, in ml.`);
  }
  if (lab) lines.push(`🧪 ${lab.label} is due. Please get it done and send the values, e.g. “creatinine 2.4, urea 80, K 4.6, Na 136”.`);
  const example = vitals.length ? "“BP 132/84, weight 77.2, took all tablets”" : fluid ? "“intake 950 ml, urine 800 ml”" : physio.length ? "“exercises done”" : checkin ? "“no symptoms, salt ok”" : "“took all tablets”";
  lines.push(`\nJust reply in your own words, e.g. ${example}.`);
  return lines.join("\n");
}

function groupByDue(tasks: TaskRow[]): Map<number, TaskRow[]> {
  const m = new Map<number, TaskRow[]>();
  for (const t of tasks) m.set(t.due_at, [...(m.get(t.due_at) || []), t]);
  return m;
}

function tickTasks(p: PatientRow, t: number) {
  // 1. Prompts at due time
  const toPrompt = all<TaskRow>("SELECT * FROM tasks WHERE patient_id = ? AND status = 'PENDING' AND prompted = 0 AND due_at <= ?", p.id, t);
  if (toPrompt.length) {
    const fresh = toPrompt.filter((x) => x.due_at > t - 2 * HOUR);
    for (const [due, group] of groupByDue(fresh)) {
      sendWhatsApp({ userId: p.user_id!, patientId: p.id, body: promptText(p, group, due), quick: ["Took all tablets ✅", "Feeling fine, no symptoms"], kind: "prompt", at: due });
    }
    run("UPDATE tasks SET prompted = 1 WHERE patient_id = ? AND status = 'PENDING' AND prompted = 0 AND due_at <= ?", p.id, t);
  }
  // 2. Patient reminder (before any caregiver escalation)
  const toRemind = all<TaskRow>("SELECT * FROM tasks WHERE patient_id = ? AND status = 'PENDING' AND reminded = 0 AND kind != 'lab' AND due_at <= ? AND due_at > ?", p.id, t - HOUR, t - 3 * HOUR);
  if (toRemind.length) {
    const labels = toRemind.map((x) => `• ${x.label} (${fmtTime(x.due_at)})`).join("\n");
    sendWhatsApp({ userId: p.user_id!, patientId: p.id, body: `⏰ Gentle reminder, ${first(p.name)} — we haven't heard about:\n${labels}\n\nPlease reply once done (or tell us if you couldn't).`, quick: ["Took all tablets ✅", "Missed my tablets ❌"], kind: "reminder", at: t });
    run(`UPDATE tasks SET reminded = 1 WHERE id IN (${toRemind.map((x) => x.id).join(",")})`);
  }
  run("UPDATE tasks SET reminded = 1 WHERE patient_id = ? AND status = 'PENDING' AND reminded = 0 AND due_at <= ?", p.id, t - 3 * HOUR);
  // 3. Mark missed
  const pending = all<TaskRow>("SELECT * FROM tasks WHERE patient_id = ? AND status = 'PENDING' AND due_at <= ?", p.id, t - HOUR * 3);
  const missed = pending.filter((x) => x.due_at + (MISSED_AFTER[x.kind] ?? 3 * HOUR) <= t);
  if (!missed.length) return;
  run(`UPDATE tasks SET status = 'MISSED' WHERE id IN (${missed.map((x) => x.id).join(",")})`);
  for (const m of missed) audit(t, "system", "TASK_MISSED", "task", m.id, { label: m.label, due_at: m.due_at });
  // 4. Compliance rules
  const meds = missed.filter((x) => x.kind === "med");
  if (meds.length) {
    complianceEscalate(p, `med`, "Medicines not logged", `${first(p.name)} hasn't confirmed: ${meds.map((x) => `${x.label} (${fmtTime(x.due_at)})`).join(", ")}.`, meds.map((x) => x.id), t);
  }
  for (const v of missed.filter((x) => x.kind === "vital")) {
    const prev = get<{ status: string }>("SELECT status FROM tasks WHERE patient_id = ? AND item_key = ? AND due_at < ? ORDER BY due_at DESC LIMIT 1", p.id, v.item_key, v.due_at);
    if (prev?.status === "MISSED") complianceEscalate(p, v.item_key, `${v.label} not logged 2 days running`, `${first(p.name)} hasn't sent ${v.label.toLowerCase()} readings for 2 consecutive days.`, [v.id], t);
  }
  for (const ph of missed.filter((x) => x.kind === "physio")) checkPhysioStreak(p, ph.item_key, ph.label, t);
}

function checkPhysioStreak(p: PatientRow, itemKey: string, label: string, t: number) {
  const last = all<{ id: number; status: string; due_at: number }>("SELECT id, status, due_at FROM tasks WHERE patient_id = ? AND item_key = ? AND due_at <= ? AND status != 'CANCELLED' AND status != 'PENDING' ORDER BY due_at DESC LIMIT 3", p.id, itemKey, t);
  if (last.length < 3 || !last.every((x) => x.status === "MISSED" || x.status === "NOT_DONE")) return;
  const recent = get("SELECT id FROM escalations WHERE patient_id = ? AND rule_key = ? AND started_at > ?", p.id, itemKey, t - 3 * DAY);
  if (recent) return;
  complianceEscalate(p, itemKey, `${label} skipped 3 times in a row`, `${first(p.name)}'s ${label.toLowerCase()} has not been done the last 3 times it was due.`, last.map((x) => x.id), t);
}

// ---------------------------------------------------------------- escalation state machine
const OPEN = "('NOTIFIED','ACKNOWLEDGED')";
const TIMER_MIN = (plan: CarePlan | undefined, type: EscalationType) =>
  type === "URGENT" ? plan?.escalation.urgentMin ?? 15 : type === "DEVIATION" ? plan?.escalation.deviationMin ?? 60 : plan?.escalation.complianceMin ?? 120;

export const OUTCOMES: Record<string, string> = {
  "1": "Spoke with patient — resolved at home",
  "2": "Contacted doctor / clinic",
  "3": "Taken to hospital / emergency",
  "4": "Other action taken",
  AUTO: "Patient completed the task",
  EXHAUSTED: "No one acknowledged",
};

function escEvent(escId: number, at: number, event: string, level: number | null, actor: string | null, note?: string) {
  run("INSERT INTO escalation_events(escalation_id, at, event, level, actor, note) VALUES(?,?,?,?,?,?)", escId, at, event, level, actor, note ?? null);
}

function complianceEscalate(p: PatientRow, ruleKey: string, title: string, detail: string, taskIds: number[], t: number) {
  const open = get<EscalationRow>(`SELECT * FROM escalations WHERE patient_id = ? AND type = 'COMPLIANCE' AND state IN ${OPEN} ORDER BY id DESC LIMIT 1`, p.id);
  if (open) {
    const ids = [...new Set([...(JSON.parse(open.task_ids || "[]") as number[]), ...taskIds])];
    run("UPDATE escalations SET task_ids = ?, detail = ? WHERE id = ?", JSON.stringify(ids), `${open.detail} ${detail}`.slice(0, 600), open.id);
    escEvent(open.id, t, "ADDED", open.level, "system", detail);
    return;
  }
  createEscalation(p, { type: "COMPLIANCE", ruleKey, title, detail, advice: `Please check in with ${first(p.name)} and help complete it.`, taskIds }, t);
}

export interface NewEsc {
  type: EscalationType;
  ruleKey: string;
  title: string;
  detail: string;
  advice: string;
  messageId?: number;
  observationId?: number;
  taskIds?: number[];
}

export function createEscalation(p: PatientRow, e: NewEsc, t: number): number | null {
  const dup = get<EscalationRow>(`SELECT * FROM escalations WHERE patient_id = ? AND rule_key = ? AND state IN ${OPEN}`, p.id, e.ruleKey);
  if (dup) {
    escEvent(dup.id, t, "REPEAT", dup.level, "system", e.detail);
    return null;
  }
  const cgs = getCaregivers(p.id);
  const level = cgs[0]?.level ?? 1;
  const r = run(
    `INSERT INTO escalations(patient_id, type, rule_key, title, detail, advice, state, level, started_at, level_at, trigger_message_id, trigger_observation_id, task_ids)
     VALUES(?,?,?,?,?,?,'NOTIFIED',?,?,?,?,?,?)`,
    p.id, e.type, e.ruleKey, e.title, e.detail, e.advice, level, t, t, e.messageId ?? null, e.observationId ?? null, e.taskIds ? JSON.stringify(e.taskIds) : null,
  );
  const id = r.lastInsertRowid;
  escEvent(id, t, "CREATED", null, "system", e.detail);
  audit(t, "system", "ESCALATION_CREATED", "escalation", id, { type: e.type, rule: e.ruleKey });
  const esc = get<EscalationRow>("SELECT * FROM escalations WHERE id = ?", id)!;
  notifyLevel(p, esc, level, t, null);
  return id;
}

function escalationText(p: PatientRow, esc: EscalationRow, prev: CaregiverRow | null, timer: number): string {
  const pre = prev ? `${prev.name} (Level ${prev.level}) hasn't responded in ${timer} min, so this is now with you.\n\n` : "";
  const doc = doctorName(p);
  if (esc.type === "URGENT")
    return `🚨 URGENT — ${p.name}\n${pre}${esc.detail}\n\n${esc.advice}\nPlease call ${first(p.name)} right now. If unwell, call 108 / go to the nearest emergency, and inform ${doc}.\n\nReply *ACK* to take ownership.`;
  if (esc.type === "DEVIATION")
    return `⚠️ Care Circle alert — ${p.name}\n${pre}${esc.title}: ${esc.detail}\n\nAdvice set by ${doc}: ${esc.advice}\nIf it persists or ${first(p.name)} feels unwell, please contact ${doc}'s clinic or seek medical attention.\n\nReply *ACK* to take ownership.`;
  return `📋 Care Circle — ${p.name}\n${pre}${esc.detail}\n${esc.advice}\n\nReply *ACK* to take ownership.`;
}

function notifyLevel(p: PatientRow, esc: EscalationRow, level: number, t: number, prev: CaregiverRow | null) {
  const cg = getCaregivers(p.id).find((c) => c.level === level);
  if (!cg || !cg.user_id) return;
  const timer = TIMER_MIN(latestVisit(p.id, t)?.plan, esc.type);
  sendWhatsApp({ userId: cg.user_id, patientId: p.id, body: escalationText(p, esc, prev, timer), quick: ["ACK – I'll handle it", "Miss"], kind: "escalation", at: t });
  escEvent(esc.id, t, "NOTIFIED", level, cg.name);
}

export function timeoutCaregiver(escId: number, t: number, via: "whatsapp" | "dashboard" | "timer" = "whatsapp"): string | null {
  const esc = get<EscalationRow>("SELECT * FROM escalations WHERE id = ?", escId);
  if (!esc) return "Not found";
  if (esc.state !== "NOTIFIED") return "Already acknowledged or closed";
  const p = getPatient(esc.patient_id)!;
  const cgs = getCaregivers(p.id);
  const plan = latestVisit(p.id, t)?.plan;
  const timer = TIMER_MIN(plan, esc.type);
  const cur = cgs.find((c) => c.level === esc.level) || null;
  const next = cgs.find((c) => c.level > esc.level);
  if (next) {
    run("UPDATE escalations SET level = ?, level_at = ? WHERE id = ?", next.level, t, esc.id);
    escEvent(esc.id, t, "TIMEOUT", esc.level, "system", `${cur?.name ?? "Level " + esc.level} did not acknowledge within ${timer} min${via === "whatsapp" ? " (simulated miss)" : ""}`);
    audit(t, "system", "ESCALATION_LEVEL_UP", "escalation", esc.id, { from: esc.level, to: next.level, via });
    notifyLevel(p, { ...esc, level: next.level, level_at: t }, next.level, t, cur);
    if (via !== "timer" && cur?.user_id) {
      sendWhatsApp({
        userId: cur.user_id,
        patientId: p.id,
        body: `⏱️ Alert timeout: no response received from Level ${esc.level} (${cur.name}). Escalated to Level ${next.level} (${next.name}).`,
        kind: "info",
        at: t,
      });
    }
  } else {
    run("UPDATE escalations SET state = 'EXHAUSTED', resolved_at = ?, outcome_code = 'EXHAUSTED' WHERE id = ?", t, esc.id);
    escEvent(esc.id, t, "EXHAUSTED", esc.level, "system", `No caregiver acknowledged at any level${via === "whatsapp" ? " (simulated miss)" : ""}`);
    audit(t, "system", "ESCALATION_EXHAUSTED", "escalation", esc.id, { via });
    const msg = `❗ Nobody in ${first(p.name)}'s care circle acknowledged: ${esc.title}.\nPlease act now — contact ${doctorName(p)}'s clinic or seek medical attention if needed.`;
    for (const c of cgs) if (c.user_id) sendWhatsApp({ userId: c.user_id, patientId: p.id, body: msg, kind: "escalation", at: t });
    sendWhatsApp({ userId: p.user_id!, patientId: p.id, body: `❗ We couldn't reach your care circle about: ${esc.title}. If you feel unwell, please contact ${doctorName(p)}'s clinic or go to the nearest hospital.`, kind: "escalation", at: t });
  }
  return null;
}

function tickEscalations(p: PatientRow, t: number) {
  const open = all<EscalationRow>("SELECT * FROM escalations WHERE patient_id = ? AND state = 'NOTIFIED'", p.id);
  if (!open.length) return;
  const plan = latestVisit(p.id, t)?.plan;
  for (const esc of open) {
    const timer = TIMER_MIN(plan, esc.type);
    if (esc.level_at + timer * MIN > t + 5000) continue; // 5 s grace: replies are stamped t+1s
    const at = esc.level_at + timer * MIN;
    timeoutCaregiver(esc.id, at, "timer");
  }
}

export function acknowledge(escId: number, userId: string, t: number, via: "whatsapp" | "dashboard"): string | null {
  const esc = get<EscalationRow>("SELECT * FROM escalations WHERE id = ?", escId);
  const user = getUser(userId);
  if (!esc || !user) return "Not found";
  if (esc.state !== "NOTIFIED") return "Already acknowledged or closed";
  const p = getPatient(esc.patient_id)!;
  const cgs = getCaregivers(p.id);
  const me = cgs.find((c) => c.user_id === userId);
  if (!me) return "Only care-circle members can acknowledge";
  run("UPDATE escalations SET state = 'ACKNOWLEDGED', ack_by = ?, ack_at = ? WHERE id = ?", userId, t, escId);
  escEvent(escId, t, "ACKNOWLEDGED", me.level, user.name, via === "dashboard" ? "via dashboard" : "via WhatsApp");
  audit(t, userId, "ESCALATION_ACK", "escalation", escId, { via });
  run("INSERT INTO convo_state(user_id, state, escalation_id) VALUES(?, 'awaiting_outcome', ?) ON CONFLICT(user_id) DO UPDATE SET state = 'awaiting_outcome', escalation_id = excluded.escalation_id, data = NULL", userId, escId);
  const notified = new Set(all<{ actor: string }>("SELECT actor FROM escalation_events WHERE escalation_id = ? AND event = 'NOTIFIED'", escId).map((r) => r.actor));
  for (const c of cgs) if (c.user_id && c.user_id !== userId && notified.has(c.name)) sendWhatsApp({ userId: c.user_id, patientId: p.id, body: `👍 ${user.name} has taken ownership of the alert about ${first(p.name)} (${esc.title}).`, kind: "info", at: t });
  if (esc.type !== "COMPLIANCE") sendWhatsApp({ userId: p.user_id!, patientId: p.id, body: `💙 ${user.name} from your care circle is following up on: ${esc.title}.`, kind: "info", at: t });
  sendWhatsApp({
    userId,
    patientId: p.id,
    body: `Thanks ${first(user.name)} — you now own this alert.\nWhen you've acted, tell me what happened:\n1️⃣ Spoke with ${first(p.name)}, sorted at home\n2️⃣ Contacted ${doctorName(p)}'s clinic\n3️⃣ Took ${first(p.name)} to hospital / emergency\n4️⃣ Other`,
    quick: ["1", "2", "3", "4"],
    kind: "reply",
    at: t,
  });
  return null;
}

export function resolveEscalation(escId: number, userId: string, code: string, note: string | null, t: number, via: "whatsapp" | "dashboard" | "auto"): string | null {
  const esc = get<EscalationRow>("SELECT * FROM escalations WHERE id = ?", escId);
  if (!esc) return "Not found";
  if (esc.state === "RESOLVED" || esc.state === "EXHAUSTED") return "Already closed";
  const user = getUser(userId);
  const p = getPatient(esc.patient_id)!;
  run("UPDATE escalations SET state = 'RESOLVED', resolved_at = ?, resolved_by = ?, outcome_code = ?, outcome_note = ? WHERE id = ?", t, userId, code, note, escId);
  escEvent(escId, t, "RESOLVED", esc.level, user?.name ?? "system", [OUTCOMES[code] ?? code, note].filter(Boolean).join(" — "));
  audit(t, userId, "ESCALATION_RESOLVED", "escalation", escId, { code, note, via });
  run("DELETE FROM convo_state WHERE escalation_id = ?", escId);
  if (via !== "auto") {
    sendWhatsApp({ userId, patientId: p.id, body: `✅ Recorded: ${OUTCOMES[code] ?? code}${note ? ` — “${note}”` : ""}.\nThank you! This is now on ${first(p.name)}'s record for ${doctorName(p)} to review at the next visit.`, kind: "reply", at: t });
    if (esc.type !== "COMPLIANCE") sendWhatsApp({ userId: p.user_id!, patientId: p.id, body: `✅ ${user?.name} closed the alert “${esc.title}”: ${OUTCOMES[code] ?? code}${note ? ` — ${note}` : ""}.`, kind: "info", at: t });
  }
  return null;
}

// ---------------------------------------------------------------- deviation rules (deterministic)
interface Alert {
  type: EscalationType;
  ruleKey: string;
  title: string;
  detail: string;
  advice: string;
  observationId?: number;
}

function evaluateVital(p: PatientRow, plan: CarePlan, baseline: ClinicVitals, type: VitalType, v1: number, v2: number | undefined, t: number, obsId: number): { flag: string | null; alert: Alert | null } {
  const th = plan.thresholds;
  const nm = first(p.name);
  switch (type) {
    case "bp": {
      const s = v1, d = v2 ?? 0;
      if (s >= 180 || d >= 110)
        return { flag: "critical", alert: { type: "URGENT", ruleKey: "bp_crisis", title: "Very high blood pressure", detail: `${nm}'s BP is ${s}/${d} mmHg (emergency rule ≥180/110).`, advice: "Sit and rest, recheck in 5 minutes. If still ≥180/110 or with chest pain, severe headache, weakness or confusion — go to emergency now.", observationId: obsId } };
      if (s > th.sysHigh || d > th.diaHigh)
        return { flag: "high", alert: { type: "DEVIATION", ruleKey: "bp_high", title: "BP above doctor's limit", detail: `BP ${s}/${d} mmHg (limit ${th.sysHigh}/${th.diaHigh}).`, advice: "Rest for 15 minutes and recheck. Confirm the BP tablets were taken. If it stays high on 2 readings, contact the clinic.", observationId: obsId } };
      if (s < th.sysLow)
        return { flag: "low", alert: { type: "DEVIATION", ruleKey: "bp_low", title: "Low blood pressure", detail: `BP ${s}/${d} mmHg (below ${th.sysLow}).`, advice: "Sit or lie down and drink water. If dizzy or faint, seek medical attention.", observationId: obsId } };
      return { flag: null, alert: null };
    }
    case "weight": {
      const prior = get<{ mn: number | null }>("SELECT MIN(v1) AS mn FROM observations WHERE patient_id = ? AND type = 'weight' AND observed_at >= ? AND observed_at < ? AND id != ?", p.id, t - 3 * DAY, t, obsId)?.mn;
      const gain3 = prior != null ? v1 - prior : 0;
      const prevDay = get<{ v1: number }>("SELECT v1 FROM observations WHERE patient_id = ? AND type = 'weight' AND observed_at >= ? AND observed_at < ? ORDER BY observed_at DESC LIMIT 1", p.id, dayStart(t) - DAY, dayStart(t))?.v1;
      const gainDay = prevDay != null ? v1 - prevDay : 0;
      const dry = th.dryWeight;
      const band = th.weightBand ?? 1;
      const gainBase = !dry && baseline.weight ? v1 - baseline.weight : 0;
      const reasons: string[] = [];
      if (th.weightDayGainKg && gainDay >= th.weightDayGainKg) reasons.push(`up ${gainDay.toFixed(1)} kg since yesterday (limit ${th.weightDayGainKg} kg/day)`);
      if (gain3 >= th.weightGainKg) reasons.push(`up ${gain3.toFixed(1)} kg in 3 days (limit ${th.weightGainKg} kg)`);
      if (dry && v1 > dry + band) reasons.push(`above the doctor's target ${dry} ± ${band} kg`);
      if (!dry && gainBase >= th.weightGainKg + 1) reasons.push(`${gainBase.toFixed(1)} kg above clinic baseline ${baseline.weight} kg`);
      if (reasons.length)
        return {
          flag: "high",
          alert: { type: "DEVIATION", ruleKey: "weight_gain", title: dry ? "Weight above target — possible fluid build-up" : "Rapid weight gain", detail: `Weight ${v1} kg — ${reasons.join("; ")}.`, advice: "This can mean fluid build-up. Keep strictly to the fluid and salt limits today, check for swelling or breathlessness, and contact the clinic — the doctor may adjust the water tablet. Do not change doses on your own.", observationId: obsId },
        };
      if (dry && v1 < dry - band)
        return {
          flag: "low",
          alert: { type: "DEVIATION", ruleKey: "weight_below_band", title: "Weight below target — possible dehydration", detail: `Weight ${v1} kg — below the doctor's target ${dry} ± ${band} kg${prevDay != null && gainDay < 0 ? ` (down ${Math.abs(gainDay).toFixed(1)} kg since yesterday)` : ""}.`, advice: "Too much fluid may be coming off (water tablets, loose stools, poor intake). Check BP, dizziness and urine output, and contact the clinic today before the next water-tablet dose. Do not change doses on your own.", observationId: obsId },
        };
      return { flag: null, alert: null };
    }
    case "glucose":
      if (v1 < 54) return { flag: "critical", alert: { type: "URGENT", ruleKey: "glucose_very_low", title: "Very low blood sugar", detail: `Sugar ${v1} mg/dL.`, advice: "Take 15 g of sugar/glucose now and recheck in 15 minutes. If not improving or drowsy, seek emergency care.", observationId: obsId } };
      if (v1 < th.glucoseLow) return { flag: "low", alert: { type: "DEVIATION", ruleKey: "glucose_low", title: "Low blood sugar", detail: `Sugar ${v1} mg/dL (below ${th.glucoseLow}).`, advice: "Have a sugary drink or snack and recheck in 15 minutes. Inform the clinic if it repeats.", observationId: obsId } };
      if (v1 > th.glucoseHigh) return { flag: "high", alert: { type: "DEVIATION", ruleKey: "glucose_high", title: "High blood sugar", detail: `Sugar ${v1} mg/dL (above ${th.glucoseHigh}).`, advice: "Drink water, check medicines were taken, recheck later. Contact the clinic if it stays high.", observationId: obsId } };
      return { flag: null, alert: null };
    case "hr":
      if (v1 > th.hrHigh || v1 < th.hrLow) return { flag: v1 > th.hrHigh ? "high" : "low", alert: { type: "DEVIATION", ruleKey: "hr_abnormal", title: "Pulse outside limits", detail: `Pulse ${v1} bpm (range ${th.hrLow}–${th.hrHigh}).`, advice: "Rest and recheck in 15 minutes. If dizzy, breathless or with chest discomfort, seek medical attention.", observationId: obsId } };
      return { flag: null, alert: null };
    case "spo2":
      if (v1 < 88) return { flag: "critical", alert: { type: "URGENT", ruleKey: "spo2_very_low", title: "Very low oxygen", detail: `SpO₂ ${v1}%.`, advice: "Sit upright, use the rescue inhaler as prescribed and seek emergency care if it does not improve within minutes.", observationId: obsId } };
      if (v1 < th.spo2Low) return { flag: "low", alert: { type: "DEVIATION", ruleKey: "spo2_low", title: "Oxygen below doctor's limit", detail: `SpO₂ ${v1}% (limit ${th.spo2Low}%).`, advice: `Rest, use the inhaler as prescribed and recheck in 15 minutes. If still below ${th.spo2Low}% or breathless, contact the clinic / seek medical attention.`, observationId: obsId } };
      return { flag: null, alert: null };
    case "temp":
      if (v1 >= 100.4) return { flag: "high", alert: { type: "DEVIATION", ruleKey: "fever", title: "Fever", detail: `Temperature ${v1}°F.`, advice: "Take paracetamol if prescribed, drink fluids and recheck. Contact the clinic if it persists beyond a day.", observationId: obsId } };
      return { flag: null, alert: null };
    case "pain":
      if (v1 >= th.painHigh) return { flag: "high", alert: { type: "DEVIATION", ruleKey: "pain_high", title: "High pain score", detail: `Pain ${v1}/10 (limit ${th.painHigh}).`, advice: "Rest, apply ice if advised and take prescribed pain relief. If pain keeps rising or with swelling/fever, contact the clinic.", observationId: obsId } };
      return { flag: null, alert: null };
  }
  return { flag: null, alert: null };
}

const RED_FLAGS: Record<string, string> = {
  chest_pain: "Chest pain can be serious.",
  fainting: "Fainting / collapse needs urgent assessment.",
  confusion: "New confusion or unusual drowsiness needs urgent assessment (it can be caused by blood salts, sugar or kidney function).",
};

function evaluateSymptom(p: PatientRow, plan: CarePlan, key: string, severity: string, text: string, obsId: number): Alert | null {
  const nm = first(p.name);
  if (RED_FLAGS[key])
    return { type: "URGENT", ruleKey: `sx:${key}`, title: SYMPTOMS[key], detail: `${nm} reported: “${text}”. ${RED_FLAGS[key]}`, advice: "Do not wait — call 108 or go to the nearest emergency department now.", observationId: obsId };
  if (key === "breathlessness" && severity === "severe")
    return { type: "URGENT", ruleKey: "sx:breathlessness_severe", title: "Severe breathlessness", detail: `${nm} reported: “${text}”.`, advice: "Sit upright. If breathless at rest or worsening, call 108 / go to emergency now.", observationId: obsId };
  if (plan.watchSymptoms.includes(key) && !text.includes("(improving)"))
    return { type: "DEVIATION", ruleKey: `sx:${key}`, title: `${SYMPTOMS[key]} reported`, detail: `${nm} reported: “${text}” — a symptom the doctor asked to watch for.`, advice: "Please check on them today and contact the clinic if it continues or worsens.", observationId: obsId };
  return null;
}

// ---------------------------------------------------------------- kidney: fluids, labs, reported medicine changes
/** Day totals: the last 'total' message of the day plus any incremental 'add' entries after it. */
export function dayFluid(pid: string, t: number): { in: number; out: number; inLogged: boolean; outLogged: boolean } {
  const rows = all<{ type: string; v1: number; text: string | null }>(
    "SELECT type, v1, text FROM observations WHERE patient_id = ? AND type IN ('fluid_in','urine_out') AND observed_at >= ? AND observed_at < ? ORDER BY observed_at, id",
    pid, dayStart(t), dayStart(t) + DAY,
  );
  const acc = { fluid_in: 0, urine_out: 0 } as Record<string, number>;
  const seen = { fluid_in: false, urine_out: false } as Record<string, boolean>;
  for (const r of rows) {
    acc[r.type] = r.text === "total" ? r.v1 : acc[r.type] + r.v1;
    seen[r.type] = true;
  }
  return { in: Math.round(acc.fluid_in), out: Math.round(acc.urine_out), inLogged: seen.fluid_in, outLogged: seen.urine_out };
}

const fmtLab = (marker: string, v: number) => `${v.toFixed(LAB_META[marker]?.digits ?? 1)} ${LAB_META[marker]?.unit ?? ""}`.trim();

/** Deterministic lab rules (only thresholds set in the care plan apply; K ≥ 6.0 always urgent). */
export function evaluateLab(p: PatientRow, plan: CarePlan | undefined, visitAt: number | null, marker: string, value: number, takenAt: number, labId: number): { flag: string | null; alert: Alert | null } {
  const th = plan?.thresholds ?? ({} as CarePlan["thresholds"]);
  const nm = first(p.name);
  const doc = doctorName(p);
  const prevOf = (before: number) => get<{ value: number; taken_at: number }>("SELECT value, taken_at FROM labs WHERE patient_id = ? AND marker = ? AND taken_at < ? AND id != ? ORDER BY taken_at DESC LIMIT 1", p.id, marker, before, labId);
  switch (marker) {
    case "potassium":
      if (value >= 6.0) return { flag: "critical", alert: { type: "URGENT", ruleKey: "lab:k_very_high", title: "Very high potassium", detail: `${nm}'s potassium is ${fmtLab(marker, value)} (≥ 6.0 is dangerous for the heart).`, advice: `Call ${doc}'s clinic now. If there is weakness, palpitations, breathlessness or chest discomfort, go to the emergency department.` } };
      if (th.kHigh && value > th.kHigh) return { flag: "high", alert: { type: "DEVIATION", ruleKey: "lab:k_high", title: "Potassium above limit", detail: `Potassium ${fmtLab(marker, value)} (limit ${th.kHigh}).`, advice: `Avoid high-potassium foods (banana, coconut water, tomato, oranges) and share the report with ${doc}'s clinic today.` } };
      if (th.kLow && value < th.kLow) return { flag: "low", alert: { type: "DEVIATION", ruleKey: "lab:k_low", title: "Potassium low", detail: `Potassium ${fmtLab(marker, value)} (below ${th.kLow}).`, advice: `Share the report with ${doc}'s clinic today — water tablets can lower potassium.` } };
      return { flag: null, alert: null };
    case "sodium":
      if ((th.naLow && value < th.naLow) || (th.naHigh && value > th.naHigh))
        return { flag: th.naLow && value < th.naLow ? "low" : "high", alert: { type: "DEVIATION", ruleKey: "lab:na", title: `Sodium ${th.naLow && value < th.naLow ? "low" : "high"}`, detail: `Sodium ${fmtLab(marker, value)} (range ${th.naLow ?? "–"}–${th.naHigh ?? "–"}).`, advice: `Share the report with ${doc}'s clinic today. Watch for confusion, drowsiness or unsteadiness.` } };
      return { flag: null, alert: null };
    case "creatinine": {
      const prev = prevOf(takenAt);
      const pre = visitAt ? prevOf(visitAt + DAY) : undefined;
      const reasons: string[] = [];
      if (th.creatRiseAbs && prev && value - prev.value >= th.creatRiseAbs) reasons.push(`up ${(value - prev.value).toFixed(2)} from ${prev.value} on ${fmtDate(prev.taken_at, { day: "numeric", month: "short" })}`);
      if (th.creatRisePct && pre && pre.taken_at !== prev?.taken_at && ((value - pre.value) / pre.value) * 100 >= th.creatRisePct) reasons.push(`${Math.round(((value - pre.value) / pre.value) * 100)}% above the pre-visit value ${pre.value}`);
      else if (th.creatRisePct && pre && !reasons.length && ((value - pre.value) / pre.value) * 100 >= th.creatRisePct) reasons.push(`${Math.round(((value - pre.value) / pre.value) * 100)}% above ${pre.value}`);
      if (reasons.length) return { flag: "high", alert: { type: "DEVIATION", ruleKey: "lab:creat_rise", title: "Creatinine rising", detail: `Creatinine ${fmtLab(marker, value)} — ${reasons.join("; ")}.`, advice: `Share this report with ${doc}'s clinic today. Avoid painkillers like ibuprofen/diclofenac, keep to the fluid plan and do not change medicines on your own.` } };
      return { flag: prev && value > prev.value ? "up" : null, alert: null };
    }
    case "hb":
      if (th.hbLow && value < th.hbLow) return { flag: "low", alert: { type: "DEVIATION", ruleKey: "lab:hb_low", title: "Haemoglobin low", detail: `Hb ${fmtLab(marker, value)} (below ${th.hbLow}).`, advice: `Share the report with ${doc}'s clinic. Watch for breathlessness, dizziness or black stools (he is on a blood thinner) — seek care if present.` } };
      return { flag: null, alert: null };
  }
  return { flag: null, alert: null };
}

/** Records a lab value with provenance, flags it and returns any rule alert (caller decides whether to escalate). */
export function addLab(pid: string, marker: string, value: number, takenAt: number, source: string, enteredBy: string | null, messageId: number | null): { id: number; flag: string | null; alert: Alert | null } {
  const p = getPatient(pid)!;
  const id = run("INSERT INTO labs(patient_id, marker, value, taken_at, source, entered_by, message_id) VALUES(?,?,?,?,?,?,?)", pid, marker, value, takenAt, source, enteredBy, messageId).lastInsertRowid;
  const v = latestVisit(pid, takenAt + DAY);
  const { flag, alert } = evaluateLab(p, v?.plan, v?.visit_at ?? null, marker, value, takenAt, id);
  if (flag) run("UPDATE labs SET flag = ? WHERE id = ?", flag, id);
  return { id, flag, alert };
}

/** Mark lab tasks due within ±7 days as done. */
export function completeLabTasks(pid: string, t: number, by: string, msgId: number | null) {
  run("UPDATE tasks SET status = 'DONE', completed_at = ?, completed_by = ?, message_id = ? WHERE patient_id = ? AND kind = 'lab' AND status IN ('PENDING','MISSED') AND due_at <= ? AND due_at >= ?", t, by, msgId, pid, t + 7 * DAY, t - 21 * DAY);
}

/** Lab entry from the dashboard (PA/doctor) — runs the same rules and escalates within the care circle. */
export function enterLabs(pid: string, values: { marker: string; value: number }[], takenAt: number, by: string, t: number): { marker: string; flag: string | null }[] {
  const p = getPatient(pid)!;
  const out: { marker: string; flag: string | null }[] = [];
  const alerts: Alert[] = [];
  tx(() => {
    for (const x of values) {
      const r = addLab(pid, x.marker, x.value, takenAt, "clinic", by, null);
      out.push({ marker: x.marker, flag: r.flag });
      if (r.alert && takenAt > t - 3 * DAY) alerts.push(r.alert);
    }
    completeLabTasks(pid, takenAt, by, null);
    audit(t, by, "LABS_ENTERED", "patient", pid, { n: values.length, takenAt });
  });
  for (const a of alerts) createEscalation(p, a, t);
  return out;
}

export function addMedChange(pid: string, at: number, c: { medName: string; change: string; detail: string; prescriber: string | null }, reportedBy: string | null, messageId: number | null, source: string, status = "REPORTED"): number {
  const id = run("INSERT INTO med_changes(patient_id, at, med_name, change, detail, prescriber, reported_by, message_id, source, status) VALUES(?,?,?,?,?,?,?,?,?,?)", pid, at, c.medName, c.change, c.detail, c.prescriber, reportedBy, messageId, source, status).lastInsertRowid;
  audit(at, reportedBy ?? "system", "MED_CHANGE_REPORTED", "patient", pid, { med: c.medName, change: c.change, source });
  return id;
}

export function reviewMedChange(id: number, status: "CONFIRMED" | "REVIEWED" | "REJECTED", by: string, t: number) {
  run("UPDATE med_changes SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", status, by, t, id);
  audit(t, by, "MED_CHANGE_" + status, "med_change", id);
}

const recentEsc = (pid: string, rule: string, since: number) => get("SELECT id FROM escalations WHERE patient_id = ? AND rule_key = ? AND started_at >= ?", pid, rule, since);

/** Once each morning: intake over limit 2 days running; output/intake ratio low 2 days running. */
function kidneyMorningCheck(p: PatientRow, t: number) {
  if (localHHMM(t) < "06:00") return;
  const key = `fluidEval:${p.id}`;
  if (Number(getSetting(key) || 0) >= dayStart(t)) return;
  setSetting(key, String(dayStart(t)));
  const plan = latestVisit(p.id, t)?.plan;
  const fp = plan?.fluid;
  if (!fp) return;
  const d1 = dayFluid(p.id, t - DAY), d2 = dayFluid(p.id, t - 2 * DAY);
  const nm = first(p.name);
  if (d1.inLogged && d2.inLogged && d1.in > fp.limitMl * 1.1 && d2.in > fp.limitMl * 1.1 && !recentEsc(p.id, "fluid_over", t - 2 * DAY))
    createEscalation(p, { type: "DEVIATION", ruleKey: "fluid_over", title: "Fluid intake over limit 2 days running", detail: `${nm}'s intake was ${d2.in} ml and ${d1.in} ml on the last two days (limit ${fp.limitMl} ml).`, advice: "Please help keep total fluids (including tea, soup, milk) within the limit — use a marked bottle, small cups, ice chips for thirst. Watch weight and breathlessness; contact the clinic if weight is rising." }, t);
  const ratio = (d: typeof d1) => (d.inLogged && d.outLogged && d.in > 0 ? d.out / d.in : null);
  const r1 = ratio(d1), r2 = ratio(d2);
  if (r1 != null && r2 != null && r1 < fp.ratioLow && r2 < fp.ratioLow && !recentEsc(p.id, "fluid_ratio_low", t - 2 * DAY))
    createEscalation(p, { type: "DEVIATION", ruleKey: "fluid_ratio_low", title: "Urine output low compared to intake", detail: `Urine was ${d2.out} of ${d2.in} ml and ${d1.out} of ${d1.in} ml on the last two days (below ${Math.round(fp.ratioLow * 100)}% of intake).`, advice: "Fluid may be building up. Check weight, swelling and breathlessness and share these numbers with the clinic today." }, t);
}

// ---------------------------------------------------------------- ingestion
const ACK_RE = /^\s*(ack\b|acknowledged?|ok(ay)?\b|on it|i'?ll handle|will handle|handling|yes\b|👍)/i;
const YES_RE = /^\s*(yes|y|i agree|agree|ok|okay|haan|ha)\W*$/i;
const NO_RE = /^\s*(no|n|stop|i do not agree|disagree)\W*$/i;
const MISS_RE = /^\s*(miss(ed)?|timeout|simulate\s*timeout|skip|unresponsive)\b/i;

export async function ingestMessage(userId: string, body: string, opts: { allowAi?: boolean; at?: number } = {}): Promise<void> {
  const t = opts.at ?? now();
  const user = getUser(userId);
  if (!user) throw new Error("Unknown user");
  const pid = patientIdsForUser(user)[0];
  const p = pid ? getPatient(pid) : undefined;
  const msgId = run("INSERT INTO messages(patient_id, user_id, direction, body, created_at, kind) VALUES(?,?,?,?,?,?)", p?.id ?? null, userId, "IN", body, t, "inbound").lastInsertRowid;
  const reply = (text: string, quick?: string[]) => sendWhatsApp({ userId, patientId: p?.id ?? null, body: text, quick, kind: "reply", at: t + 1000 });
  if (!p) return void reply("Hi! This number isn't linked to a patient yet. Please contact your clinic.");

  // --- caregiver conversational flows: ACK / outcome / note
  if (user.role === "CAREGIVER") {
    // Joining the care circle: a plain YES / NO answers the consent request, unless an alert is waiting (then YES = ACK).
    if (pendingConsent(p.id, userId) && (YES_RE.test(body) || NO_RE.test(body)) && !get("SELECT 1 FROM escalations WHERE patient_id = ? AND state = 'NOTIFIED'", p.id)) {
      if (YES_RE.test(body)) {
        respondConsent(p.id, userId, "GIVEN", msgId, t);
        return void reply(`Thank you, ${first(user.name)}! ✅ You're now in ${first(p.name)}'s care circle. I'll message you only if something needs attention. You can also log readings for ${first(p.name)} here anytime.`);
      }
      respondConsent(p.id, userId, "DECLINED", msgId, t);
      return void reply(`Understood. You won't receive care-circle alerts for ${first(p.name)}. The clinic will be told so they can update the care circle.`);
    }
    const cs = get<{ state: string; escalation_id: number; data: string | null }>("SELECT * FROM convo_state WHERE user_id = ?", userId);
    if (cs?.state === "awaiting_note") {
      resolveEscalation(cs.escalation_id, userId, cs.data || "4", body.trim().slice(0, 500), t + 1000, "whatsapp");
      return;
    }
    const digit = body.trim().match(/^([1-4])\b/);
    if (cs?.state === "awaiting_outcome" && digit) {
      if (digit[1] === "1") resolveEscalation(cs.escalation_id, userId, "1", null, t + 1000, "whatsapp");
      else {
        run("UPDATE convo_state SET state = 'awaiting_note', data = ? WHERE user_id = ?", digit[1], userId);
        reply(digit[1] === "2" ? "Got it. Briefly, what did the doctor / clinic advise?" : digit[1] === "3" ? "Thank you for acting quickly. Briefly, what happened at the hospital?" : "Briefly, what action was taken?");
      }
      return;
    }
    if (ACK_RE.test(body)) {
      const mine = get<EscalationRow>(
        `SELECT e.* FROM escalations e WHERE e.patient_id = ? AND e.state = 'NOTIFIED'
         ORDER BY CASE e.type WHEN 'URGENT' THEN 0 WHEN 'DEVIATION' THEN 1 ELSE 2 END, e.started_at LIMIT 1`, p.id);
      if (mine) {
        const err = acknowledge(mine.id, userId, t + 1000, "whatsapp");
        if (err) reply(err);
      } else reply("👍 Nothing is waiting for acknowledgement right now. Thank you!");
      return;
    }
    if (MISS_RE.test(body)) {
      const cgs = getCaregivers(p.id);
      const me = cgs.find((c) => c.user_id === userId);
      let mine = me
        ? get<EscalationRow>(
            `SELECT e.* FROM escalations e WHERE e.patient_id = ? AND e.state = 'NOTIFIED' AND e.level = ?
             ORDER BY CASE e.type WHEN 'URGENT' THEN 0 WHEN 'DEVIATION' THEN 1 ELSE 2 END, e.started_at LIMIT 1`,
            p.id,
            me.level,
          )
        : null;
      if (!mine) {
        mine = get<EscalationRow>(
          `SELECT e.* FROM escalations e WHERE e.patient_id = ? AND e.state = 'NOTIFIED'
           ORDER BY CASE e.type WHEN 'URGENT' THEN 0 WHEN 'DEVIATION' THEN 1 ELSE 2 END, e.started_at LIMIT 1`,
          p.id,
        );
      }
      if (mine) {
        const err = timeoutCaregiver(mine.id, t + 1000, "whatsapp");
        if (err) reply(err);
      } else {
        reply("👍 No active alert waiting on your response right now. Thank you!");
      }
      return;
    }
  }

  if (user.role === "PATIENT" && YES_RE.test(body)) {
    if (pendingConsent(p.id, userId)) respondConsent(p.id, userId, "GIVEN", msgId, t);
    else audit(t, userId, "CONSENT_GIVEN", "patient", p.id, { channel: "whatsapp" });
    return void reply(`Thank you, ${first(p.name)}! ✅ Consent recorded. Your readings will be shared with ${doctorName(p)}'s care team and your care circle.`);
  }
  if (user.role === "PATIENT" && NO_RE.test(body) && pendingConsent(p.id, userId)) {
    respondConsent(p.id, userId, "DECLINED", msgId, t);
    return void reply(`Understood, ${first(p.name)}. Nothing will be shared. If you change your mind, reply *YES* anytime or speak to the clinic.`);
  }

  const visit = latestVisit(p.id, t);
  if (!visit) return void reply(`Thanks! ${first(p.name)} isn't on an active care plan yet — the clinic will set it up at the visit.`);
  const plan = visit.plan;

  const { parsed, parser } = await parseMessage(body, plan.medications, opts.allowAi !== false);
  run("UPDATE messages SET parsed = ?, parser = ? WHERE id = ?", JSON.stringify(parsed), parser, msgId);

  const alerts: Alert[] = [];
  const lines: string[] = [];
  tx(() => {
    for (const v of parsed.vitals) {
      const obsId = run("INSERT INTO observations(patient_id, type, v1, v2, observed_at, logged_by, message_id, parser) VALUES(?,?,?,?,?,?,?,?)", p.id, v.type, v.v1, v.v2 ?? null, t, userId, msgId, parser).lastInsertRowid;
      const { flag, alert } = evaluateVital(p, plan, visit.vitals, v.type, v.v1, v.v2, t, obsId);
      if (flag) run("UPDATE observations SET flag = ? WHERE id = ?", flag, obsId);
      if (alert) alerts.push(alert);
      const val = v.type === "bp" ? `${v.v1}/${v.v2}` : String(v.v1);
      lines.push(`• ${VITAL_META[v.type].label}: ${val} ${VITAL_META[v.type].unit}${flag ? " ⚠️" : ""}`);
      completeTasks(p.id, "vital", [`vital:${v.type}`], "DONE", t, userId, msgId);
    }
    // fluids
    if (parsed.fluids.length) {
      for (const f of parsed.fluids) run("INSERT INTO observations(patient_id, type, v1, text, observed_at, logged_by, message_id, parser) VALUES(?,?,?,?,?,?,?,?)", p.id, f.kind === "in" ? "fluid_in" : "urine_out", f.ml, f.total ? "total" : "add", t, userId, msgId, parser);
      const day = dayFluid(p.id, t);
      const lim = plan.fluid?.limitMl;
      if (parsed.fluids.some((f) => f.kind === "in")) {
        let s = `• 💧 Fluid today: ${day.in}${lim ? ` / ${lim} ml (${Math.max(0, lim - day.in)} ml left)` : " ml"}`;
        if (lim && day.in > lim) s += `\n  ⚠️ Over today's limit by ${day.in - lim} ml — please hold further fluids unless the doctor advised otherwise.`;
        else if (lim && day.in >= lim * 0.9) s += "\n  ⚠️ Nearly at today's limit — small sips / ice chips only.";
        lines.push(s);
      }
      if (parsed.fluids.some((f) => f.kind === "out")) {
        lines.push(`• 🚻 Urine today: ${day.out} ml${day.in ? ` (${Math.round((day.out / Math.max(1, day.in)) * 100)}% of intake)` : ""}`);
        const fp = plan.fluid;
        if (fp && localHHMM(t) >= "18:00" && day.out < fp.lowOutputMl && !recentEsc(p.id, "urine_low", dayStart(t)))
          alerts.push({ type: "DEVIATION", ruleKey: "urine_low", title: "Low urine output", detail: `${first(p.name)} passed only ${day.out} ml of urine today (doctor's minimum ${fp.lowOutputMl} ml).`, advice: "Check weight, swelling, dizziness and whether the water tablets were taken. Share these numbers with the clinic today; seek care if there's breathlessness or confusion." });
      }
      if (localHHMM(t) >= "15:00" && (parsed.fluids.some((f) => f.kind === "out") || parsed.fluids.some((f) => f.total))) completeTasks(p.id, "fluid", ["fluid:daily"], "DONE", t, userId, msgId, true);
    }
    // labs (values sent as text; report photos are Phase 2)
    if (parsed.labs.length) {
      const parts: string[] = [];
      for (const l of parsed.labs) {
        const prev = get<{ value: number }>("SELECT value FROM labs WHERE patient_id = ? AND marker = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1", p.id, l.marker, t);
        const r = addLab(p.id, l.marker, l.value, t, "whatsapp", userId, msgId);
        if (r.alert) alerts.push(r.alert);
        parts.push(`${LAB_META[l.marker].label} ${fmtLab(l.marker, l.value)}${prev ? ` (prev ${prev.value})` : ""}${r.flag && r.flag !== "up" ? " ⚠️" : ""}`);
      }
      lines.push(`• 🧪 Lab results: ${parts.join(", ")}`);
      completeLabTasks(p.id, t, userId, msgId);
    }
    // medicine changes reported by other doctors — logged for the clinic, NOT applied to reminders
    for (const c of parsed.medChanges) {
      addMedChange(p.id, t, c, userId, msgId, "whatsapp");
      const what = c.change === "stopped" ? "stopped" : c.change === "started" ? "started" : c.change === "dose_changed" ? "dose changed" : "changed";
      lines.push(`• 📝 Medicine change noted: ${c.medName} — ${what}${c.prescriber ? ` (${c.prescriber})` : ""}`);
    }
    if (parsed.medChanges.length) lines.push(`  I'll keep reminding as per ${doctorName(p)}'s plan until the clinic confirms the change.`);
    // medicines
    const medKeys = plan.medications.map((m) => `med:${m.key}`);
    const name = (k: string) => plan.medications.find((m) => m.key === k)?.name ?? k;
    if (parsed.meds.allMissed) {
      const n = completeTasks(p.id, "med", medKeys, "NOT_DONE", t, userId, msgId);
      lines.push(`• Medicines: noted as NOT taken${n.length ? ` (${n.length} dose${n.length > 1 ? "s" : ""})` : ""}`);
      if (n.length) complianceEscalate(p, "med_reported_missed", "Medicines reported missed", `${first(p.name)} reported not taking: ${n.map((x) => x.label).join(", ")}.`, n.map((x) => x.id), t);
    } else {
      const takenKeys = parsed.meds.allTaken ? medKeys.filter((k) => !parsed.meds.missed.includes(k.slice(4))) : parsed.meds.taken.map((k) => `med:${k}`);
      if (takenKeys.length) {
        const n = completeTasks(p.id, "med", takenKeys, "DONE", t, userId, msgId);
        lines.push(parsed.meds.allTaken ? `• Medicines: ${n.length ? `${n.length} due dose${n.length > 1 ? "s" : ""} marked taken ✔` : "noted as taken ✔"}` : `• Taken: ${parsed.meds.taken.map(name).join(", ")} ✔`);
      }
      if (parsed.meds.missed.length) {
        const n = completeTasks(p.id, "med", parsed.meds.missed.map((k) => `med:${k}`), "NOT_DONE", t, userId, msgId);
        lines.push(`• Not taken: ${parsed.meds.missed.map(name).join(", ")}`);
        if (n.length) complianceEscalate(p, "med_reported_missed", "Medicines reported missed", `${first(p.name)} reported not taking: ${n.map((x) => x.label).join(", ")}.`, n.map((x) => x.id), t);
      }
    }
    // physio
    if (parsed.physio) {
      const keys = plan.physio.map((x) => `physio:${x.key}`);
      const n = completeTasks(p.id, "physio", keys, parsed.physio === "done" ? "DONE" : "NOT_DONE", t, userId, msgId);
      lines.push(parsed.physio === "done" ? `• Exercise / physio: done ✔${n.length ? "" : ""}` : "• Exercise / physio: not done");
      if (parsed.physio === "not_done") for (const k of keys) checkPhysioStreak(p, k, plan.physio.find((x) => `physio:${x.key}` === k)?.name ?? k, t);
    }
    // symptoms & lifestyle check-in
    for (const s of parsed.symptoms) {
      const obsId = run("INSERT INTO observations(patient_id, type, text, severity, observed_at, logged_by, message_id, parser) VALUES(?,?,?,?,?,?,?,?)", p.id, "symptom", s.key, s.severity, t, userId, msgId, parser).lastInsertRowid;
      const a = evaluateSymptom(p, plan, s.key, s.severity, s.text, obsId);
      if (a) {
        alerts.push(a);
        run("UPDATE observations SET flag = ? WHERE id = ?", a.type === "URGENT" ? "critical" : "watch", obsId);
      }
      lines.push(`• Symptom noted: ${SYMPTOMS[s.key]} (${s.severity})`);
    }
    if (parsed.noSymptoms) {
      run("INSERT INTO observations(patient_id, type, text, observed_at, logged_by, message_id, parser) VALUES(?,?,?,?,?,?,?)", p.id, "symptom", "none", t, userId, msgId, parser);
      lines.push("• No symptoms reported 👍");
    }
    if (parsed.lifestyle) {
      run("INSERT INTO observations(patient_id, type, text, observed_at, logged_by, message_id, parser) VALUES(?,?,?,?,?,?,?)", p.id, "lifestyle", parsed.lifestyle, t, userId, msgId, parser);
      lines.push(parsed.lifestyle === "ok" ? "• Diet / salt / fluids: on track ✔" : "• Diet / salt / fluids: not followed today");
    }
    if (parsed.symptoms.length || parsed.noSymptoms || parsed.lifestyle) completeTasks(p.id, "checkin", ["checkin:daily"], "DONE", t, userId, msgId, true);
    if (parsed.help) alerts.push({ type: "URGENT", ruleKey: "help", title: "Help requested", detail: `${first(p.name)}'s care circle received a help request: “${body.slice(0, 140)}”`, advice: "Call them immediately. If it's a medical emergency, call 108." });

    autoResolveCompliance(p, userId, t);
  });

  // --- reply to sender
  const forWhom = user.role === "CAREGIVER" ? ` for ${first(p.name)}` : "";
  let text = lines.length
    ? `✅ Logged${forWhom}:\n${lines.join("\n")}`
    : `🤔 Sorry, I couldn't pick up any readings from that. You can write naturally, e.g.:\n“BP 130/80, weight 76.5, sugar 120, took all tablets, walked 20 min, no swelling”`;
  const created: { a: Alert; id: number | null }[] = [];
  for (const a of alerts) created.push({ a, id: createEscalation(p, { ...a, messageId: msgId }, t + 500) });
  const cgs = getCaregivers(p.id);
  for (const { a, id } of created) {
    if (a.type === "URGENT") text += `\n\n🚨 ${a.detail.replace(/^.*?reported: /, "")}\n${a.advice}${id ? `\nAlerting your care circle now (${cgs[0]?.name ?? "caregiver"}).` : ""}`;
    else text += `\n\n⚠️ ${a.title} — ${a.detail}\n${a.advice}${id ? `\nI've let ${cgs[0]?.name ?? "your caregiver"} in your care circle know.` : ""}`;
  }
  sendWhatsApp({ userId, patientId: p.id, body: text, kind: "reply", at: t + 1000 });
  // If a caregiver logged it, keep the patient informed of alerts.
  if (user.role === "CAREGIVER" && created.some((c) => c.id)) {
    sendWhatsApp({ userId: p.user_id!, patientId: p.id, body: `ℹ️ ${user.name} logged a reading for you that needs attention: ${created.map((c) => c.a.title).join(", ")}. Please follow ${doctorName(p)}'s advice and rest.`, kind: "info", at: t + 1000 });
  }
  if (parsed.medChanges.length) {
    const msg = `📝 ${user.name} reported a medicine change for ${first(p.name)}: ${parsed.medChanges.map((c) => `${c.medName} (${c.change.replace("_", " ")}${c.prescriber ? `, ${c.prescriber}` : ""})`).join("; ")}. It's logged for ${doctorName(p)}'s team to review; reminders stay as per the current plan until confirmed.`;
    if (user.role === "CAREGIVER") sendWhatsApp({ userId: p.user_id!, patientId: p.id, body: msg, kind: "info", at: t + 1000 });
    else for (const c of cgs.filter((c) => c.level === cgs[0]?.level && c.user_id)) sendWhatsApp({ userId: c.user_id!, patientId: p.id, body: msg, kind: "info", at: t + 1000 });
  }
}

function completeTasks(pid: string, kind: string, keys: string[], status: "DONE" | "NOT_DONE", t: number, by: string, msgId: number, anyTimeToday = false): TaskRow[] {
  if (!keys.length) return [];
  const qs = keys.map(() => "?").join(",");
  const upper = anyTimeToday ? dayStart(t) + DAY : t + (kind === "physio" ? 45 * MIN : 2 * HOUR);
  // Pending tasks due today up to +2h, plus recently-missed ones (late logging within 6h)
  const rows = all<TaskRow>(
    `SELECT * FROM tasks WHERE patient_id = ? AND kind = ? AND item_key IN (${qs})
       AND ((status = 'PENDING' AND due_at >= ? AND due_at <= ?) OR (status = 'MISSED' AND due_at >= ?))
     ORDER BY due_at`,
    pid, kind, ...keys, dayStart(t), upper, Math.max(dayStart(t), t - 6 * HOUR),
  );
  // vitals: one reading completes one slot per parameter
  const picked = kind === "vital" ? keys.map((k) => rows.find((r) => r.item_key === k)).filter(Boolean) as TaskRow[] : rows;
  for (const r of picked) {
    run("UPDATE tasks SET status = ?, completed_at = ?, completed_by = ?, message_id = ?, late = ? WHERE id = ?", status, t, by, msgId, r.status === "MISSED" ? 1 : 0, r.id);
  }
  return picked;
}

function autoResolveCompliance(p: PatientRow, userId: string, t: number) {
  const open = all<EscalationRow>(`SELECT * FROM escalations WHERE patient_id = ? AND type = 'COMPLIANCE' AND state IN ${OPEN}`, p.id);
  for (const e of open) {
    const ids = JSON.parse(e.task_ids || "[]") as number[];
    if (!ids.length || e.rule_key === "med_reported_missed") continue;
    const left = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE id IN (${ids.join(",")}) AND status != 'DONE'`)!.n;
    if (left === 0) {
      resolveEscalation(e.id, userId, "AUTO", "Logged late via WhatsApp", t, "auto");
      for (const c of getCaregivers(p.id)) {
        const notified = get("SELECT 1 FROM escalation_events WHERE escalation_id = ? AND event = 'NOTIFIED' AND actor = ?", e.id, c.name);
        if (notified && c.user_id) sendWhatsApp({ userId: c.user_id, patientId: p.id, body: `✅ Update: ${first(p.name)} has now logged it (“${e.title}”). No action needed.`, kind: "info", at: t + 1000 });
      }
    }
  }
}

// ---------------------------------------------------------------- scheduler
export function tick(t: number) {
  for (const p of listPatients()) {
    if (!p.user_id) continue;
    ensureTasks(p.id, t);
    tickTasks(p, t);
    kidneyMorningCheck(p, t);
    tickEscalations(p, t);
  }
}

/** Catch the scheduler up to `target` in 15-minute steps so timestamps stay realistic. */
export function runScheduler(target = now()) {
  let last = Number(getSetting("last_tick") || 0);
  if (!last || target - last > 14 * DAY) last = target - 15 * MIN;
  const STEP = 15 * MIN;
  try {
    for (let t = last + STEP; t <= target; t += STEP) {
      setSimNow(t);
      tx(() => tick(t));
      setSetting("last_tick", String(t));
    }
    if (target - Number(getSetting("last_tick")) > 0) {
      setSimNow(target);
      tx(() => tick(target));
      setSetting("last_tick", String(target));
    }
  } finally {
    setSimNow(null);
  }
}

// ---------------------------------------------------------------- visits & onboarding
export function createVisit(pid: string, doctorId: string, data: { vitals: ClinicVitals; diagnosis: string; notes: string; plan: CarePlan; next_visit_at: number | null }, t: number): string {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  const id = `v_${pid}_${t}`;
  tx(() => {
    run("INSERT INTO visits(id, patient_id, doctor_id, visit_at, vitals, diagnosis, notes, plan, next_visit_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, pid, doctorId, t, JSON.stringify(data.vitals), data.diagnosis, data.notes, JSON.stringify(data.plan), data.next_visit_at, t);
    // Replace not-yet-due tasks from the previous plan with the new plan's schedule.
    run("DELETE FROM tasks WHERE patient_id = ? AND status = 'PENDING' AND due_at > ?", pid, t);
    setSetting(`gen:${pid}`, String(t));
    audit(t, doctorId, "VISIT_RECORDED", "visit", id, { diagnosis: data.diagnosis });
    ensureTasks(pid, t);
    const doc = getUser(doctorId)?.name ?? "Your doctor";
    const meds = data.plan.medications.map((m) => `💊 ${m.name} ${describeMed(m)}${m.instructions ? ` (${m.instructions})` : ""}`).join("\n");
    const mon = data.plan.monitoring.map((m) => VITAL_META[m.key].label).join(", ");
    const physio = data.plan.physio.map((x) => `🏃 ${x.name}: ${x.detail}`).join("\n");
    const life = data.plan.lifestyle.map((x) => `🥗 ${x.text}`).join("\n");
    const fl = data.plan.fluid ? `\n💧 Fluid limit: ${data.plan.fluid.limitMl} ml/day (all drinks). Tell me whenever you drink — e.g. “2 glasses water” — and I'll keep the running total. Send urine total in the evening.` : "";
    const lb = data.plan.labs ? `\n🧪 Blood tests: ${data.plan.labs.panel} every ${data.plan.labs.everyDays} days — just type the values from the report.` : "";
    const next = data.next_visit_at ? `\n📅 Next visit: ${fmtDate(data.next_visit_at, { weekday: "short", day: "numeric", month: "short" })}` : "";
    sendWhatsApp({ userId: p.user_id!, patientId: pid, body: `👩‍⚕️ ${doc} has set your care plan after today's visit:\n\n${meds}\n\n📏 Please send: ${mon || "—"}${fl}${lb}\n${physio}\n${life}${next}\n\nI'll remind you at the right times. Just reply here in your own words. 💙`, kind: "info", at: t });
    for (const c of getCaregivers(pid)) if (c.user_id) sendWhatsApp({ userId: c.user_id, patientId: pid, body: `👩‍⚕️ ${first(p.name)}'s care plan was updated by ${doc} today. You're Level ${c.level} in the care circle — I'll message you only if something needs attention.${next}`, kind: "info", at: t });
  });
  return id;
}

export interface OnboardInput {
  name: string;
  age: number | null;
  sex: string;
  phone: string;
  conditions: string;
  address: string;
  doctorId: string;
  caregivers: { name: string; relation: string; phone: string; level: number; dashboard?: boolean }[];
}

export function onboardPatient(input: OnboardInput, t: number, actor: string): string {
  const slug = input.name.toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "").slice(0, 20) + "_" + (t % 100000);
  const pid = `p_${slug}`;
  if (get("SELECT 1 FROM patients WHERE phone = ?", input.phone)) throw new Error("A patient with this WhatsApp number already exists");
  const clinic = clinicName();
  tx(() => {
    const uid = `u_${slug}`;
    run("INSERT INTO users(id, name, role, phone, title) VALUES(?,?,?,?,?)", uid, input.name, "PATIENT", input.phone, "Patient");
    run("INSERT INTO patients(id, user_id, name, age, sex, phone, conditions, address, doctor_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", pid, uid, input.name, input.age, input.sex, input.phone, input.conditions, input.address, input.doctorId, t);
    const docU = getUser(input.doctorId);
    if (docU) run("INSERT INTO care_team(patient_id, name, specialty, role, user_id) VALUES(?,?,?,?,?)", pid, docU.name, docU.title, "PRIMARY", docU.id);
    for (const c of input.caregivers.filter((c) => c.name && c.phone).slice(0, MAX_CAREGIVERS)) {
      let cu = get<{ id: string }>("SELECT id FROM users WHERE phone = ? AND role = 'CAREGIVER'", c.phone)?.id;
      if (!cu) {
        cu = `u_cg_${slug}_${c.level}`;
        run("INSERT INTO users(id, name, role, phone, title) VALUES(?,?,?,?,?)", cu, c.name, "CAREGIVER", c.phone, `${c.relation} of ${first(input.name)}`);
      }
      run("INSERT INTO caregivers(id, patient_id, user_id, name, relation, phone, level, dashboard) VALUES(?,?,?,?,?,?,?,?)", `cg_${slug}_${c.level}`, pid, cu, c.name, c.relation, c.phone, c.level, c.dashboard === false ? 0 : 1);
      requestConsent(pid, cu, "CAREGIVER", t);
      sendWhatsApp({ userId: cu, patientId: pid, body: `👋 Hi ${first(c.name)}, ${input.name} has added you as Level ${c.level} in their CareCircle (${c.relation})${clinic ? ` at ${clinic}` : ""}.\nIf a medicine is missed or a reading goes outside the doctor's limits, I'll alert you here and ask you to follow up. You can log readings for them anytime. Reply *ACK* to alerts to take ownership.\n\nReply *YES* to join the care circle, or *NO* to decline.`, quick: ["YES", "NO"], kind: "info", at: t });
    }
    requestConsent(pid, uid, "PATIENT", t);
    sendWhatsApp({ userId: uid, patientId: pid, body: `👋 Welcome to CareCircle, ${first(input.name)}! I'm ${clinic ? `${clinic}'s` : "your clinic's"} WhatsApp care assistant.\nAfter your visit I'll remind you about medicines, readings and exercises — just reply in your own words. Your care circle will be kept in the loop if anything needs attention.\n\nReply *YES* to consent to share your readings with your care team, or *NO* to decline.`, quick: ["YES", "NO"], kind: "info", at: t });
    audit(t, actor, "PATIENT_ONBOARDED", "patient", pid, { name: input.name });
  });
  return pid;
}
