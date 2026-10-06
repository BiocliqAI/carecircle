// Visits to other doctors (a specialist, a hospital, the local GP), told to us by the patient or the family on
// WhatsApp or on their web page. The clinic → primary doctor → patient axis does not change: the visit, its
// documents and its next appointment are on everyone's record at once, but medicine changes are only logged
// (med_changes, REPORTED). The primary doctor's team applies them to the plan, which is what changes reminders.
import { all, audit, get, getSetting, run, setSetting, tx } from "./db";
import { ensureTasks, getCaregivers, getPatient, getUser, latestVisit, type PatientRow, type UserRow } from "./engine";
import { parseRules } from "./parser";
import { sendWhatsApp } from "./whatsapp";
import { addDocument } from "./records";
import { describeMed } from "./meds";
import { DAY, HOUR, atLocal, dayKey, dayStart, fmtDate, localHHMM } from "./time";
import { shortName, type CarePlan, type Medication } from "./types";

// ---------------------------------------------------------------- types
export type ChangeKind = "started" | "stopped" | "dose_changed" | "other";
export interface OVMedChange {
  medName: string;
  planKey: string | null;
  change: ChangeKind;
  newDose: string | null;
  times: string[] | null;
  detail: string;
  unclear?: string | null;
}
export interface OVDraft {
  doctorName: string | null;
  specialty: string | null;
  hospital: string | null;
  visitAt: number | null;
  reason: string | null;
  advice: string | null;
  tests: string | null;
  nextVisitAt: number | null;
  nextVisitNote: string | null;
  noNextVisit: boolean;
}
export interface OutsideVisitRow {
  id: number;
  patient_id: string;
  visit_at: number;
  doctor_name: string | null;
  specialty: string | null;
  hospital: string | null;
  care_team_id: number | null;
  reason: string | null;
  advice: string | null;
  tests: string | null;
  next_visit_at: number | null;
  next_visit_note: string | null;
  status: "COLLECTING" | "COMPLETE";
  source: string;
  reported_by: string | null;
  message_id: number | null;
  created_at: number;
  updated_at: number;
  reviewed_by: string | null;
  reviewed_at: number | null;
  followup_of: number | null;
}
type Slot = "doctor" | "changes" | "documents" | "next" | "postponed";
interface Flow {
  visitId: number | null;
  followupOf: number | null;
  turns: { from: "user" | "bot"; text: string }[];
  asked: Slot[]; // rules mode: what we already asked (never twice)
  noNext?: boolean;
  startedAt: number;
  lastAt: number;
}
export interface FileIn { base64: string; mime: string; docId?: number; title?: string }

const FLOW_TTL = 12 * HOUR;
const first = (n: string) => shortName(n);
const clip = (s: unknown, n = 300) => (s == null || s === "" ? null : String(s).trim().slice(0, n) || null);

// ---------------------------------------------------------------- pure helpers (tested)
const SPECIALTIES: [RegExp, string][] = [
  [/cardio|heart (doctor|specialist)/, "Cardiology"], [/nephro|kidney (doctor|specialist)/, "Nephrology"], [/neuro/, "Neurology"],
  [/diabet|endocrin|sugar doctor/, "Diabetology"], [/ortho|bone doctor/, "Orthopaedics"], [/pulmo|chest (doctor|physician)|lung/, "Pulmonology"],
  [/gastro|liver doctor/, "Gastroenterology"], [/urolog/, "Urology"], [/eye|ophthal/, "Ophthalmology"], [/\bent\b/, "ENT"], [/derma|skin doctor/, "Dermatology"],
  [/psychiat/, "Psychiatry"], [/oncol|cancer/, "Oncology"], [/\bgp\b|family doctor|general physician|local doctor/, "General practice"],
];
export function specialtyIn(text: string): string | null {
  const t = text.toLowerCase();
  return SPECIALTIES.find(([re]) => re.test(t))?.[1] ?? null;
}

const VISIT_RE = /\b(took|taken|take|went|gone|go|visited|visit|saw|seen|consulted|met|showed|shown|admitted|checkup|check-up|review)\b[^.?!]{0,50}\b(dr\.?|doctor|cardiolog\w*|nephrolog\w*|neurolog\w*|diabetolog\w*|endocrinolog\w*|ortho\w*|pulmonolog\w*|gastro\w*|urolog\w*|specialist|hospital|gp|physician|surgeon|eye|ent)\b/;
const ADVICE_RE = /\b(dr\.?\s+\w+|doctor|cardiologist|nephrologist|neurologist|diabetologist|specialist|physician|surgeon)\b[^.?!]{0,60}\b(said|suggested|advised|asked|told|prescribed|changed|added|stopped|reduced|increased|started|gave)\b/;
export const FROM_VISIT_BUTTON = "From another doctor's visit";
/** Does a message start telling us about a visit to another doctor? (rules; Gemini also flags this when configured) */
export function looksLikeOutsideVisit(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes(FROM_VISIT_BUTTON.toLowerCase()) || /^(add|record|log) (a )?(visit|doctor visit)\b/.test(t)) return true;
  return VISIT_RE.test(t) || ADVICE_RE.test(t);
}

const SKIP_RE = /^\s*(skip|no|nope|nah|not now|later|don'?t know|dont know|not sure|na|nil|none|no prescription|didn'?t get|nothing)\b/i;
const STOP_RE = /^\s*(stop|cancel|that'?s all|thats all|done|finish|enough|bye)\W*$/i;

export function freqTimes(freq: string | null | undefined): string[] | null {
  const f = (freq || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (f === "OD" || f === "ONCE") return ["08:00"];
  if (f === "BD" || f === "TWICE") return ["08:00", "20:00"];
  if (f === "TDS" || f === "TID" || f === "THRICE") return ["08:00", "14:00", "20:00"];
  if (f === "QID") return ["08:00", "12:00", "16:00", "20:00"];
  if (f === "HS" || f === "NIGHT") return ["21:00"];
  return null;
}
function freqInText(t: string): string | null {
  const s = t.toLowerCase();
  if (/thrice|three times|3 times|tds|\b1-1-1\b/.test(s)) return "TDS";
  if (/twice|two times|2 times|\bbd\b|\b1-0-1\b/.test(s)) return "BD";
  if (/four times|4 times|qid/.test(s)) return "QID";
  if (/at night|bedtime|\bhs\b|\b0-0-1\b/.test(s)) return "HS";
  if (/once|daily|\bod\b|\b1-0-0\b|morning/.test(s)) return "OD";
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const noon = (ms: number) => atLocal(dayStart(ms), "12:00");
const fromKey = (k: string) => atLocal(dayStart(Date.parse(`${k}T12:00:00+05:30`)), "12:00");
/** A spoken date relative to t, as noon IST that day. dir "past" for when the visit was, "future" for the next one. */
export function parseWhen(text: string, t: number, dir: "past" | "future"): number | null {
  const s = text.toLowerCase();
  if (/\btoday\b|\bjust now\b|this morning|this evening/.test(s)) return noon(t);
  if (/\byesterday\b/.test(s)) return noon(t - DAY);
  if (/day before yesterday/.test(s)) return noon(t - 2 * DAY);
  if (/\btomorrow\b/.test(s)) return noon(t + DAY);
  const rel = s.match(/\b(?:in|after)\s+(\d{1,2}|a|one|two|three|four|six)\s*(day|week|month)s?\b/) ?? s.match(/\b(\d{1,2}|one|two|three|four|six)\s*(day|week|month)s?\s+(?:later|after|from now)\b/);
  if (rel) {
    const n = ({ a: 1, one: 1, two: 2, three: 3, four: 4, six: 6 } as Record<string, number>)[rel[1]] ?? Number(rel[1]);
    return noon(t + n * (rel[2] === "day" ? DAY : rel[2] === "week" ? 7 * DAY : 30 * DAY));
  }
  if (/\bnext week\b/.test(s)) return noon(t + 7 * DAY);
  if (/\bnext month\b/.test(s)) return noon(t + 30 * DAY);
  const iso = s.match(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return fromKey(`${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`);
  const year = Number(dayKey(t).slice(0, 4));
  const build = (d: number, m: number, y?: number) => {
    if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return null;
    let yy = y ?? year;
    let ms = fromKey(`${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    if (y == null && dir === "future" && ms < dayStart(t)) ms = fromKey(`${++yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    if (y == null && dir === "past" && ms > t + DAY) ms = fromKey(`${--yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    return Number.isFinite(ms) ? ms : null;
  };
  const dm = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (dm) return build(Number(dm[1]), MONTHS.indexOf(dm[2]) + 1);
  const md = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) return build(Number(md[2]), MONTHS.indexOf(md[1]) + 1);
  const num = s.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/);
  if (num) return build(Number(num[1]), Number(num[2]), num[3] ? (num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3])) : undefined);
  const wd = s.match(/\b(?:on\s+|this\s+|next\s+|last\s+)?(sun|mon|tue|wed|thu|fri|sat)(?:day|s|sday|nesday|rsday|urday|urs|r)?\b/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1]);
    const today = new Date(dayStart(t) + 5.5 * HOUR + 12 * HOUR).getUTCDay();
    let diff = dir === "future" ? (target - today + 7) % 7 || 7 : -((today - target + 7) % 7 || 7);
    if (dir === "past" && /\btoday\b/.test(s)) diff = 0;
    return noon(t + diff * DAY);
  }
  return null;
}

const COMMON = new Set(["only", "the", "one", "morning", "evening", "night", "yes", "no", "ok", "okay", "it", "was", "a", "an", "of", "him", "her", "my", "our", "same", "both", "half", "tablet", "dose", "not", "sure", "know", "later", "skip", "that", "this", "and"]);
const NOT_NAME = /^(at|in|from|of|and|said|says|told|the|on|is|was|has|had|who|he|she|they|we|for|to|with|reduced|stopped|started|added|visited|came|saw|checked|examined|increased|decreased|changed|suggested|advised|asked|prescribed|gave|wants|visit|saw|today|yesterday|sir|madam|appa|amma)$/i;
/** "it was dr ezhilan at apollo" → "Dr Ezhilan". Plain names get "Dr" in front. */
export function doctorNameIn(text: string): string | null {
  const m = text.match(/\b(?:dr\.?|doctor)\s+([a-z][a-z.]*(?:\s+[a-z][a-z.]*){0,2})/i);
  if (!m) return null;
  const words: string[] = [];
  for (const w of m[1].split(/\s+/)) {
    if (NOT_NAME.test(w)) break;
    words.push(w.replace(/\.$/, ""));
  }
  if (!words.length || NOT_NAME.test(words[0])) return null;
  return "Dr " + words.join(" ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
function hospitalIn(text: string): string | null {
  const m = text.match(/\b(?:at|in|from)\s+((?:[A-Z][\w&'.-]*\s?){1,4}(?:hospital|hospitals|clinic|centre|center|medical|healthcare|heart|institute)?)/);
  if (!m) return null;
  const h = m[1].trim();
  return /^(the|home|morning|evening|night)$/i.test(h) ? null : h.slice(0, 80);
}

export function matchPlanMed(name: string, plan: CarePlan | undefined): Medication | null {
  if (!plan) return null;
  const n = name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
  const w = n.split(/\s+/)[0];
  if (!w || w.length < 3) return null;
  return plan.medications.find((m) => {
    const mn = m.name.toLowerCase();
    return m.key === w || mn.split(/[\s/()]+/).includes(w) || mn.includes(w) || n.includes(mn.split(" ")[0]);
  }) ?? null;
}

/** "20 mg / 20 mg" → "20 mg"; different doses per time stay as they are. */
export const sameDose = (d: string | null) => {
  const per = d?.split(/\s*\/\s*/).filter(Boolean) ?? [];
  return per.length > 1 && per.every((x) => x === per[0]) ? per[0] : d;
};
const CHANGES = new Set(["started", "stopped", "dose_changed", "other"]);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Validates the medicine changes from Gemini (or the web form) against the current plan. */
export function normaliseChanges(raw: unknown, plan: CarePlan | undefined): OVMedChange[] {
  const out: OVMedChange[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = clip(o.medName, 80);
    if (!name) continue;
    const planMed: Medication | null = (o.planKey ? plan?.medications.find((m) => m.key === o.planKey) : undefined) ?? matchPlanMed(name, plan);
    let change = (CHANGES.has(String(o.change)) ? String(o.change) : "other") as ChangeKind;
    if (change === "started" && planMed) change = "dose_changed";
    let times = Array.isArray(o.times) ? (o.times as unknown[]).map(String).filter((s) => HHMM.test(s)) : [];
    if (!times.length) times = freqTimes(o.frequency as string) ?? [];
    const dup = out.find((c) => c.medName.toLowerCase() === (planMed?.name ?? name).toLowerCase());
    if (dup) continue;
    out.push({
      medName: planMed?.name ?? name,
      planKey: planMed?.key ?? null,
      change,
      newDose: change === "stopped" ? null : sameDose(clip(o.newDose, 40)),
      times: change === "stopped" || !times.length ? null : times,
      detail: clip(o.detail, 160) ?? `${change.replace("_", " ")}`,
      unclear: clip(o.unclear, 160),
    });
  }
  return out;
}

// ---------------------------------------------------------------- storage
export const getOutsideVisit = (id: number) => get<OutsideVisitRow>("SELECT * FROM outside_visits WHERE id = ?", id);

function upsertCareTeam(pid: string, name: string, specialty: string | null, hospital: string | null): number {
  const norm = (s: string) => s.toLowerCase().replace(/^dr\.?\s*/, "").replace(/[^a-z]/g, "");
  const hit = all<{ id: number; name: string; specialty: string | null; hospital: string | null }>("SELECT id, name, specialty, hospital FROM care_team WHERE patient_id = ?", pid).find((r) => norm(r.name) === norm(name));
  if (hit) {
    if ((!hit.specialty && specialty) || (!hit.hospital && hospital)) run("UPDATE care_team SET specialty = COALESCE(specialty, ?), hospital = COALESCE(hospital, ?) WHERE id = ?", specialty, hospital, hit.id);
    return hit.id;
  }
  return run("INSERT INTO care_team(patient_id, name, specialty, hospital, role) VALUES(?,?,?,?,'CONSULTING')", pid, name, specialty, hospital).lastInsertRowid;
}

function createRow(pid: string, by: string, source: string, t: number, msgId: number | null, followupOf: number | null): number {
  const id = run(
    "INSERT INTO outside_visits(patient_id, visit_at, status, source, reported_by, message_id, created_at, updated_at, followup_of) VALUES(?,?,?,?,?,?,?,?,?)",
    pid, noon(t), "COLLECTING", source, by, msgId, t, t, followupOf,
  ).lastInsertRowid;
  if (followupOf) {
    const prev = getOutsideVisit(followupOf);
    if (prev) run("UPDATE outside_visits SET doctor_name = ?, specialty = ?, hospital = ?, care_team_id = ? WHERE id = ?", prev.doctor_name, prev.specialty, prev.hospital, prev.care_team_id, id);
  }
  audit(t, by, "OUTSIDE_VISIT_STARTED", "patient", pid, { visit: id, source });
  return id;
}

/** Writes what we know so far. Medicine changes not yet reviewed by the clinic are replaced by the new list. */
function saveDraft(id: number, d: Partial<OVDraft>, changes: OVMedChange[] | null, t: number) {
  const v = getOutsideVisit(id)!;
  const doctor = d.doctorName !== undefined ? d.doctorName : v.doctor_name;
  const specialty = d.specialty !== undefined ? d.specialty : v.specialty;
  const hospital = d.hospital !== undefined ? d.hospital : v.hospital;
  const teamId = doctor ? upsertCareTeam(v.patient_id, doctor, specialty, hospital) : v.care_team_id;
  run(
    `UPDATE outside_visits SET doctor_name = ?, specialty = ?, hospital = ?, care_team_id = ?, visit_at = ?, reason = ?, advice = ?, tests = ?,
       next_visit_at = ?, next_visit_note = ?, updated_at = ? WHERE id = ?`,
    doctor, specialty, hospital, teamId, d.visitAt ?? v.visit_at, d.reason !== undefined ? d.reason : v.reason, d.advice !== undefined ? d.advice : v.advice,
    d.tests !== undefined ? d.tests : v.tests, d.nextVisitAt !== undefined ? d.nextVisitAt : v.next_visit_at, d.nextVisitNote !== undefined ? d.nextVisitNote : v.next_visit_note, t, id,
  );
  if (!changes) return;
  const reviewed = all<{ med_name: string }>("SELECT med_name FROM med_changes WHERE outside_visit_id = ? AND status != 'REPORTED'", id).map((r) => r.med_name.toLowerCase());
  run("DELETE FROM med_changes WHERE outside_visit_id = ? AND status = 'REPORTED'", id);
  const at = d.visitAt ?? v.visit_at;
  for (const c of changes) {
    if (reviewed.includes(c.medName.toLowerCase())) continue;
    const detail = c.unclear ? `${c.detail} (to confirm: ${c.unclear})` : c.detail;
    run(
      "INSERT INTO med_changes(patient_id, at, med_name, change, detail, prescriber, reported_by, message_id, source, status, outside_visit_id, med_key, new_dose, new_times) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      v.patient_id, dayStart(at) === dayStart(t) ? t : Math.min(at, t), c.medName, c.change, detail.slice(0, 200), doctor, v.reported_by, v.message_id, v.source === "web" ? "dashboard" : "whatsapp", "REPORTED", id, c.planKey, c.newDose, c.times ? JSON.stringify(c.times) : null,
    );
  }
}

function attachDocs(id: number, docIds: number[]) {
  for (const d of docIds) run("UPDATE patient_documents SET outside_visit_id = ?, category = CASE WHEN category IN ('other','voice') THEN 'prescription' ELSE category END WHERE id = ?", id, d);
}

function changeLine(c: { med_name: string; change: string; new_dose: string | null; new_times: string | null; detail: string | null }): string {
  const times = c.new_times ? (JSON.parse(c.new_times) as string[]).length : 0;
  const how = times ? ` · ${times === 1 ? "once" : times === 2 ? "twice" : times === 3 ? "3 times" : times + " times"} a day` : "";
  if (c.change === "stopped") return `${c.med_name}: stopped`;
  if (c.change === "started") return `${c.med_name}${c.new_dose ? ` ${c.new_dose}` : ""}: started${how}`;
  return `${c.med_name}: ${c.new_dose ? `now ${c.new_dose}${how}` : (c.detail ?? "changed")}`;
}

/** Closes the conversation for a visit and tells the rest of the care circle. */
function finishVisit(id: number, t: number) {
  const v = getOutsideVisit(id);
  if (!v || v.status === "COMPLETE") return;
  const changes = all<{ med_name: string; change: string; new_dose: string | null; new_times: string | null; detail: string | null }>("SELECT med_name, change, new_dose, new_times, detail FROM med_changes WHERE outside_visit_id = ?", id);
  const docs = get<{ n: number }>("SELECT COUNT(*) AS n FROM patient_documents WHERE outside_visit_id = ?", id)!.n;
  if (!v.doctor_name && !changes.length && !v.advice && !docs) {
    // Nothing useful was said: drop the empty shell rather than leave a blank visit on everyone's record.
    run("DELETE FROM outside_visits WHERE id = ?", id);
    return;
  }
  run("UPDATE outside_visits SET status = 'COMPLETE', updated_at = ? WHERE id = ?", t, id);
  audit(t, v.reported_by, "OUTSIDE_VISIT_RECORDED", "patient", v.patient_id, { visit: id, changes: changes.length, docs });
  const p = getPatient(v.patient_id);
  if (!p) return;
  const by = v.reported_by ? getUser(v.reported_by) : undefined;
  const primary = getUser(p.doctor_id)?.name ?? "the clinic";
  const body = [
    `📋 ${by ? first(by.name) : "Someone"} recorded ${first(p.name)}'s visit to ${v.doctor_name ?? "another doctor"}${v.specialty ? ` (${v.specialty})` : ""} on ${fmtDate(v.visit_at, { day: "numeric", month: "short" })}.`,
    changes.length ? changes.map((c) => `• ${changeLine(c)}`).join("\n") : "",
    v.next_visit_at ? `📅 Next visit: ${fmtDate(v.next_visit_at, { weekday: "short", day: "numeric", month: "short" })}` : "",
    changes.length ? `${primary}'s team will review the medicine changes; reminders change once they update the plan.` : "",
  ].filter(Boolean).join("\n");
  const circle = [p.user_id, ...getCaregivers(p.id).map((c) => c.user_id)].filter((u): u is string => !!u && u !== v.reported_by);
  for (const u of circle) sendWhatsApp({ userId: u, patientId: p.id, body, kind: "info", at: t + 1500 });
}

// ---------------------------------------------------------------- conversation state
const flowKey = (u: string) => `ov:${u}`;
export function activeFlow(userId: string, t: number): Flow | null {
  const raw = getSetting(flowKey(userId));
  if (!raw) return null;
  const f = JSON.parse(raw) as Flow;
  return t - f.lastAt > FLOW_TTL ? null : f;
}
const saveFlow = (u: string, f: Flow) => setSetting(flowKey(u), JSON.stringify(f));
const endFlow = (u: string) => run("DELETE FROM settings WHERE key = ?", flowKey(u));

/** The planned visit didn't happen: move it (reminder and follow-up are sent again for the new date). */
function postpone(id: number, to: number | null, t: number, by: string) {
  const v = getOutsideVisit(id);
  if (!v) return;
  run("UPDATE outside_visits SET next_visit_at = ?, next_visit_note = ?, updated_at = ? WHERE id = ?", to, to ? v.next_visit_note : "Postponed, new date not known yet", t, id);
  run("DELETE FROM settings WHERE key IN (?, ?)", `ovrem:${id}`, `ovfu:${id}`);
  audit(t, by, "OUTSIDE_VISIT_POSTPONED", "patient", v.patient_id, { visit: id, to });
}

/** Starts the conversation from a follow-up we sent ("did Appa see Dr X today?"). */
function openFollowup(userId: string, ofVisit: number, t: number) {
  saveFlow(userId, { visitId: null, followupOf: ofVisit, turns: [], asked: [], startedAt: t, lastAt: t });
}

function recordSoFar(id: number | null) {
  if (!id) return null;
  const v = getOutsideVisit(id)!;
  return {
    doctorName: v.doctor_name, specialty: v.specialty, hospital: v.hospital, visitDate: dayKey(v.visit_at), reason: v.reason, advice: v.advice, tests: v.tests,
    nextVisitDate: v.next_visit_at ? dayKey(v.next_visit_at) : null, nextVisitNote: v.next_visit_note,
    medChanges: all("SELECT med_name AS medName, med_key AS planKey, change, new_dose AS newDose, new_times AS times, detail, status FROM med_changes WHERE outside_visit_id = ?", id),
    documents: all<{ title: string }>("SELECT title FROM patient_documents WHERE outside_visit_id = ?", id).map((d) => d.title),
  };
}

function aiContext(p: PatientRow, user: UserRow, plan: CarePlan | undefined, f: Flow, t: number) {
  const cg = getCaregivers(p.id).find((c) => c.user_id === user.id);
  const prev = f.followupOf ? getOutsideVisit(f.followupOf) : undefined;
  return {
    today: `${dayKey(t)} (${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long" }).format(t)})`,
    patient: { name: p.name, conditions: p.conditions },
    sender: user.role === "PATIENT" ? { role: "patient", name: user.name } : { role: "family", name: user.name, relation: cg?.relation ?? null, howTheyMightCallThePatient: "may say Appa / Amma / Dad / Mom" },
    primaryDoctor: getUser(p.doctor_id)?.name ?? null,
    currentMedicines: (plan?.medications ?? []).map((m) => ({ key: m.key, name: m.name, dose: describeMed(m), times: m.times })),
    careTeam: all<{ name: string; specialty: string | null; hospital: string | null }>("SELECT name, specialty, hospital FROM care_team WHERE patient_id = ? AND role != 'PRIMARY'", p.id),
    followUpOf: prev ? { doctorName: prev.doctor_name, specialty: prev.specialty, plannedFor: prev.next_visit_at ? dayKey(prev.next_visit_at) : null, note: "We messaged them asking how this planned visit went." } : null,
    recordSoFar: recordSoFar(f.visitId),
    conversation: f.turns.slice(-12),
  };
}

function draftFromAi(o: Record<string, unknown>, t: number): Partial<OVDraft> {
  const v = (o.visit ?? {}) as Record<string, unknown>;
  const date = (k: unknown) => (typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k) ? fromKey(k) : null);
  const visitAt = date(v.visitDate);
  const next = date(v.nextVisitDate);
  const d: Partial<OVDraft> = {};
  const set = <K extends keyof OVDraft>(k: K, val: OVDraft[K] | null | undefined) => { if (val != null && val !== "") d[k] = val as OVDraft[K]; };
  set("doctorName", clip(v.doctorName, 80));
  set("specialty", clip(v.specialty, 60));
  set("hospital", clip(v.hospital, 80));
  if (visitAt && visitAt <= t + HOUR && visitAt > t - 120 * DAY) d.visitAt = visitAt;
  set("reason", clip(v.reason, 200));
  set("advice", clip(v.advice, 600));
  set("tests", clip(v.tests, 200));
  if (next && next >= dayStart(t)) d.nextVisitAt = next;
  set("nextVisitNote", clip(v.nextVisitNote, 160));
  d.noNextVisit = v.noNextVisit === true;
  return d;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), ms))]);
}

export interface TurnResult { handled: boolean; reply?: string; quick?: string[]; visitId?: number; via?: string }

/**
 * One inbound WhatsApp message (or a document) in the conversation about another doctor's visit.
 * `start` = the message itself looked like the beginning of one. Returns handled=false when the message
 * is about something else (a reading, "took tablets") so the normal logging handles it.
 */
export async function outsideVisitTurn(user: UserRow, p: PatientRow, body: string, t: number, opts: { start?: boolean; msgId?: number | null; files?: FileIn[]; allowAi?: boolean } = {}): Promise<TurnResult> {
  let f = activeFlow(user.id, t);
  if (!f && !opts.start) return { handled: false };
  const fresh = !f;
  f ??= { visitId: null, followupOf: null, turns: [], asked: [], startedAt: t, lastAt: t };
  // A document sent shortly before "it's from another doctor's visit" belongs to this visit.
  const files = [...(opts.files ?? [])];
  if (fresh) {
    const last = getSetting(`lastdoc:${user.id}`);
    if (last) {
      const [docId, at] = last.split(":").map(Number);
      if (t - at < 2 * HOUR && !get("SELECT 1 FROM patient_documents WHERE id = ? AND outside_visit_id IS NOT NULL", docId)) {
        const d = get<{ data: Uint8Array; mime: string; title: string }>("SELECT data, mime, title FROM patient_documents WHERE id = ?", docId);
        if (d) files.push({ base64: Buffer.from(d.data).toString("base64"), mime: d.mime, docId, title: d.title });
      }
    }
  }
  if (!fresh && STOP_RE.test(body) && !files.length) {
    if (f.visitId) finishVisit(f.visitId, t);
    endFlow(user.id);
    return { handled: true, reply: f.visitId ? `👍 Saved what we have. ${getUser(p.doctor_id)?.name ?? "The clinic"}'s team can see it. You can add the prescription anytime by sending it here.` : "👍 No problem." };
  }
  const plan = latestVisit(p.id, t)?.plan;
  const said = files.length && !body.trim() ? `[sent ${files.map((x) => x.title ?? "a document").join(", ")}]` : files.length ? `${body} [with ${files.length} attachment(s)]` : body;

  let ai: Record<string, unknown> | null = null;
  const { isGeminiConfigured, outsideVisitTurnAI } = await import("./gemini");
  if (opts.allowAi !== false && isGeminiConfigured()) {
    ai = await withTimeout(outsideVisitTurnAI(aiContext(p, user, plan, f, t), said, files), 25_000).catch(() => null);
  }

  if (ai) {
    if (ai.relevant === false) {
      if (fresh) return { handled: false };
      f.lastAt = t;
      saveFlow(user.id, f);
      return { handled: false };
    }
    if (ai.postponed === true && f.followupOf && !f.visitId) {
      const d = draftFromAi(ai, t);
      postpone(f.followupOf, d.nextVisitAt ?? null, t, user.id);
      const reply = clip(ai.reply, 1200) ?? "Noted.";
      if (d.nextVisitAt || ai.done === true) endFlow(user.id);
      else { f.turns.push({ from: "user", text: said.slice(0, 600) }, { from: "bot", text: reply }); f.lastAt = t; saveFlow(user.id, f); }
      return { handled: true, reply, quick: [] };
    }
    const draft = draftFromAi(ai, t);
    const changes = normaliseChanges(ai.medChanges, plan);
    const id = tx(() => {
      const vid = f!.visitId ?? createRow(p.id, user.id, "whatsapp", t, opts.msgId ?? null, f!.followupOf);
      saveDraft(vid, draft, changes, t);
      attachDocs(vid, files.map((x) => x.docId).filter((x): x is number => !!x));
      return vid;
    });
    const reply = clip(ai.reply, 1200) ?? "Noted, thank you.";
    const quick = Array.isArray(ai.quick) ? (ai.quick as unknown[]).map((q) => String(q).slice(0, 24)).filter(Boolean).slice(0, 3) : [];
    f.visitId = id;
    f.turns.push({ from: "user", text: said.slice(0, 600) }, { from: "bot", text: reply });
    f.lastAt = t;
    if (ai.done === true) {
      finishVisit(id, t + 1000);
      endFlow(user.id);
    } else saveFlow(user.id, f);
    return { handled: true, reply, quick, visitId: id, via: "gemini-visit" };
  }
  return rulesTurn(user, p, body, t, f, fresh, files, plan, opts.msgId ?? null);
}

/** Without Gemini: fixed questions in order (doctor → prescription → next visit), never the same one twice. */
function rulesTurn(user: UserRow, p: PatientRow, body: string, t: number, f: Flow, fresh: boolean, files: FileIn[], plan: CarePlan | undefined, msgId: number | null): TurnResult {
  const last = f.asked[f.asked.length - 1];
  const firstTurn = !f.visitId;
  const dir = last === "next" || last === "postponed" ? "future" : "past";
  // Readings, tablets and symptoms always go to the normal log, even mid-conversation ("urine 970 ml today").
  if (!fresh && !files.length) {
    const pr = parseRules(body.toLowerCase(), plan?.medications ?? []);
    const isLog = pr.vitals.length || pr.fluids.length || pr.labs.length || pr.help || pr.symptoms.length || pr.meds.allTaken || pr.meds.allMissed || pr.meds.taken.length || pr.meds.missed.length;
    if (isLog) return { handled: false };
  }
  const when = last === "next" || last === "postponed" || (f.followupOf && !f.visitId) ? parseWhen(body, t, dir) : null;
  const nm = first(p.name);
  const skip = SKIP_RE.test(body);

  // Answering our follow-up about a planned visit.
  if (f.followupOf && firstTurn && last !== "changes") {
    if (last === "postponed" || /postpone|cancel|didn'?t go|did not go|not yet|another day|rescheduled/i.test(body)) {
      if (when || last === "postponed") {
        postpone(f.followupOf, when, t, user.id);
        endFlow(user.id);
        return { handled: true, reply: when ? `📅 Noted, the visit is now on ${fmtDate(when, { weekday: "short", day: "numeric", month: "short" })}. I'll remind you the day before.` : "👍 Noted. Tell me the new date whenever it's fixed." };
      }
      f.asked.push("postponed");
      f.lastAt = t;
      saveFlow(user.id, f);
      return { handled: true, reply: "No problem. When is the visit now? (e.g. “next Monday” or “25 Oct”)", quick: ["Not fixed yet"] };
    }
  }
  const draft: Partial<OVDraft> = {};
  let changes: OVMedChange[] | null = null;
  // "Dr X" anywhere in a reply names the doctor; a bare short name only counts as the answer to "which doctor?".
  const bare = body.trim().replace(/^(it was|yes,?|yeah,?)\s+/i, "");
  const dn = doctorNameIn(body) ?? (last === "doctor" && !skip && bare.length <= 30 && /^[a-z .]+$/i.test(bare) && !bare.split(/\s+/).some((w) => COMMON.has(w.toLowerCase())) ? "Dr " + bare.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null);
  if (dn) draft.doctorName = dn;
  if (firstTurn || last === "doctor") {
    const sp = specialtyIn(body);
    if (sp) draft.specialty = sp;
    const h = hospitalIn(body);
    if (h) draft.hospital = h;
  }
  if (firstTurn && !f.followupOf) {
    const w = parseWhen(body, t, "past");
    if (w) draft.visitAt = w;
  }
  if (firstTurn || last === "changes") {
    const rc = parseRules(body.toLowerCase(), plan?.medications ?? []).medChanges;
    const freq = freqInText(body);
    changes = normaliseChanges(rc.map((c) => {
      const dose = c.detail.match(/(\d+(?:\.\d+)?\s*(?:mg|mcg|iu|ml|units?)|½\s*tab|half|\.\d+|0\.\d+)/i)?.[1] ?? null;
      return { ...c, newDose: dose, frequency: c.change === "started" ? freq : null };
    }), plan);
    if (!changes.length && last === "changes" && !skip) draft.advice = clip(body, 600);
    if (!changes.length && firstTurn && f.followupOf && /^\s*no\b|no change|same/i.test(body)) draft.advice = "No medicine changes";
  }
  if (last === "next") {
    if (when) draft.nextVisitAt = when;
    else if (skip || /not planned|not fixed/i.test(body)) f.noNext = true;
  }
  const id = tx(() => {
    const vid = f.visitId ?? createRow(p.id, user.id, "whatsapp", t, msgId, f.followupOf);
    saveDraft(vid, draft, changes, t);
    attachDocs(vid, files.map((x) => x.docId).filter((x): x is number => !!x));
    return vid;
  });
  f.visitId = id;
  const v = getOutsideVisit(id)!;
  const ch = all<{ med_name: string; change: string; new_dose: string | null; new_times: string | null; detail: string | null }>("SELECT med_name, change, new_dose, new_times, detail FROM med_changes WHERE outside_visit_id = ?", id);
  const hasDocs = !!get("SELECT 1 FROM patient_documents WHERE outside_visit_id = ?", id);
  const lines: string[] = [];
  if (firstTurn || last === "changes") {
    if (ch.length) lines.push(`📝 Noted for ${nm}:\n${ch.map((c) => `• ${changeLine(c)}`).join("\n")}`);
    else if (v.advice === "No medicine changes") lines.push("👍 Noted: no medicine changes.");
    else if (firstTurn && !(f.followupOf && /yes|change/i.test(body))) lines.push(`📝 Noted: a visit to ${v.doctor_name ?? "another doctor"} for ${nm}.`);
  } else if (files.length) lines.push("📄 Thank you, the prescription is attached to this visit.");
  else if (last === "next" && when) lines.push(`📅 Next visit noted: ${fmtDate(when, { weekday: "short", day: "numeric", month: "short" })}.`);
  else if (last === "doctor" && v.doctor_name) lines.push(`👍 ${v.doctor_name}${v.specialty ? ` (${v.specialty})` : ""}.`);

  const needChanges = !!f.followupOf && !ch.length && v.advice !== "No medicine changes" && /yes|change/i.test(body);
  const want: Slot | undefined = (["changes", "doctor", "documents", "next"] as Slot[]).find((s) =>
    !f.asked.includes(s) && (s === "changes" ? needChanges : s === "doctor" ? !v.doctor_name : s === "documents" ? !hasDocs && v.advice !== "No medicine changes" : !v.next_visit_at && !f.noNext));
  let quick: string[] = [];
  if (want) {
    f.asked.push(want);
    if (want === "changes") {
      lines.push(`What did ${v.doctor_name ?? "the doctor"} change? Write it your way, e.g. “Lasix reduced to 20 mg, Nifedipine 10 mg 3 times a day added”. Or send a photo of the prescription.`);
    } else if (want === "doctor") {
      const team = all<{ name: string }>("SELECT name FROM care_team WHERE patient_id = ? AND role != 'PRIMARY' AND (? IS NULL OR specialty LIKE ?)", p.id, v.specialty, `%${v.specialty ?? ""}%`).map((r) => r.name);
      lines.push(`Which doctor did ${user.role === "PATIENT" ? "you" : nm} see${v.specialty ? ` (${v.specialty.toLowerCase()})` : ""}? Their name, and the hospital if you like.`);
      quick = team.slice(0, 3);
    } else if (want === "documents") {
      lines.push("Could you send a photo of the prescription or any reports from the visit? Tap 📎 to attach. Or reply *SKIP*.");
      quick = ["Skip"];
    } else {
      lines.push(`When is the next visit with ${v.doctor_name ?? "this doctor"}? (e.g. “20 Oct” or “after 2 weeks”, or *NO* if not planned)`);
      quick = ["After 2 weeks", "After 1 month", "Not planned"];
    }
    f.lastAt = t;
    saveFlow(user.id, f);
  } else {
    finishVisit(id, t + 1000);
    endFlow(user.id);
    const w = getOutsideVisit(id);
    lines.push(`✅ Saved ${nm}'s visit to ${w?.doctor_name ?? "the doctor"}${w?.next_visit_at ? `, next visit ${fmtDate(w.next_visit_at, { day: "numeric", month: "short" })}` : ""}. ${ch.length ? `${getUser(p.doctor_id)?.name ?? "The clinic"}'s team will review the medicine change${ch.length > 1 ? "s" : ""}, and reminders will change once they update the plan.` : "It's on the record for the care team."}`);
  }
  return { handled: true, reply: lines.join("\n\n"), quick, visitId: id, via: "rules-visit" };
}

/** A document arrived on WhatsApp. If a visit conversation is open it joins that visit (and is read). */
export async function outsideVisitDocument(user: UserRow, p: PatientRow, doc: { id: number; base64: string; mime: string; title: string }, t: number): Promise<TurnResult> {
  setSetting(`lastdoc:${user.id}`, `${doc.id}:${t}`);
  if (!activeFlow(user.id, t)) return { handled: false };
  return outsideVisitTurn(user, p, "", t, { files: [{ base64: doc.base64, mime: doc.mime, docId: doc.id, title: doc.title }] });
}

// ---------------------------------------------------------------- web (patient / family page)
export interface WebVisitInput {
  visitDate?: string; doctorName?: string; specialty?: string; hospital?: string; reason?: string; advice?: string; tests?: string;
  nextVisitDate?: string; nextVisitNote?: string; medChanges?: unknown[]; files?: { base64: string; mime: string; filename?: string }[];
}
const dateIn = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? fromKey(s) : null);

export function saveWebVisit(pid: string, user: UserRow, input: WebVisitInput, t: number, id?: number): number {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  if (!clip(input.doctorName)) throw new Error("Which doctor was it? Add their name.");
  const visitAt = dateIn(input.visitDate) ?? noon(t);
  if (visitAt > t + DAY) throw new Error("The visit date can't be in the future");
  const next = dateIn(input.nextVisitDate);
  const plan = latestVisit(pid, t)?.plan;
  const changes = normaliseChanges(input.medChanges, plan);
  return tx(() => {
    let vid = id;
    if (vid) {
      const v = getOutsideVisit(vid);
      if (!v || v.patient_id !== pid) throw new Error("Visit not found");
    } else vid = createRow(pid, user.id, "web", t, null, null);
    saveDraft(vid, {
      doctorName: clip(input.doctorName, 80), specialty: clip(input.specialty, 60), hospital: clip(input.hospital, 80), visitAt,
      reason: clip(input.reason, 200), advice: clip(input.advice, 600), tests: clip(input.tests, 200), nextVisitAt: next, nextVisitNote: clip(input.nextVisitNote, 160),
    }, changes, t);
    const ids: number[] = [];
    for (const f of input.files ?? []) {
      ids.push(addDocument(pid, { title: (f.filename || "Prescription").slice(0, 100), category: "prescription", mime: f.mime || "application/octet-stream", base64: f.base64, source: "whatsapp" }, t, user.id));
    }
    attachDocs(vid, ids);
    if (!id) finishVisit(vid, t);
    else audit(t, user.id, "OUTSIDE_VISIT_UPDATED", "patient", pid, { visit: vid });
    return vid;
  });
}

/** "Fill it in for me": the family's own words and/or prescription photos → a draft for the form. Nothing is saved. */
export async function draftWebVisit(pid: string, user: UserRow, text: string, files: { base64: string; mime: string }[], t: number) {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  const plan = latestVisit(pid, t)?.plan;
  const { isGeminiConfigured, outsideVisitTurnAI } = await import("./gemini");
  if (isGeminiConfigured()) {
    const f: Flow = { visitId: null, followupOf: null, turns: [], asked: [], startedAt: t, lastAt: t };
    const ai = await withTimeout(outsideVisitTurnAI({ ...aiContext(p, user, plan, f, t), mode: "Web form: extract everything you can from the text and attachments. The reply is shown above the form: one line listing anything unclear the family should check, or empty." }, text || "[see attachments]", files), 40_000).catch(() => null);
    if (ai) {
      const d = draftFromAi({ ...ai, relevant: true }, t);
      return { via: "ai" as const, note: clip(ai.reply, 400), draft: webDraft(d), medChanges: normaliseChanges(ai.medChanges, plan) };
    }
  }
  const rc = parseRules(text.toLowerCase(), plan?.medications ?? []).medChanges;
  const freq = freqInText(text);
  const d: Partial<OVDraft> = { doctorName: doctorNameIn(text), specialty: specialtyIn(text), hospital: hospitalIn(text), visitAt: parseWhen(text, t, "past") ?? noon(t) };
  return { via: "rules" as const, note: files.length ? "Photos are attached to the visit, but couldn't be read automatically. Please fill in the medicines." : null, draft: webDraft(d), medChanges: normaliseChanges(rc.map((c) => ({ ...c, frequency: c.change === "started" ? freq : null })), plan) };
}
function webDraft(d: Partial<OVDraft>) {
  return {
    doctorName: d.doctorName ?? "", specialty: d.specialty ?? "", hospital: d.hospital ?? "", visitDate: d.visitAt ? dayKey(d.visitAt) : "",
    reason: d.reason ?? "", advice: d.advice ?? "", tests: d.tests ?? "", nextVisitDate: d.nextVisitAt ? dayKey(d.nextVisitAt) : "", nextVisitNote: d.nextVisitNote ?? "",
  };
}

export function deleteOutsideVisit(id: number, by: string, t: number) {
  const v = getOutsideVisit(id);
  if (!v) throw new Error("Visit not found");
  if (get("SELECT 1 FROM med_changes WHERE outside_visit_id = ? AND status != 'REPORTED'", id)) throw new Error("The clinic has already reviewed this visit. Ask them to correct it.");
  tx(() => {
    run("DELETE FROM med_changes WHERE outside_visit_id = ?", id);
    run("UPDATE patient_documents SET outside_visit_id = NULL WHERE outside_visit_id = ?", id);
    run("DELETE FROM outside_visits WHERE id = ?", id);
    audit(t, by, "OUTSIDE_VISIT_DELETED", "patient", v.patient_id, { visit: id });
  });
}

export function reviewOutsideVisit(id: number, by: string, t: number) {
  run("UPDATE outside_visits SET reviewed_by = ?, reviewed_at = ? WHERE id = ?", by, t, id);
  audit(t, by, "OUTSIDE_VISIT_REVIEWED", "outside_visit", id);
}

// ---------------------------------------------------------------- views
export interface OutsideVisitView extends OutsideVisitRow {
  reported_by_name: string | null;
  reviewed_by_name: string | null;
  changes: { id: number; med_name: string; change: string; detail: string | null; new_dose: string | null; new_times: string[] | null; med_key: string | null; status: string; applied_at: number | null; reviewed_by_name: string | null }[];
  documents: { id: number; title: string; mime: string; category: string }[];
}
export function outsideVisits(pid: string): OutsideVisitView[] {
  return all<OutsideVisitRow & { reported_by_name: string | null; reviewed_by_name: string | null }>(
    `SELECT o.*, u.name AS reported_by_name, r.name AS reviewed_by_name FROM outside_visits o
       LEFT JOIN users u ON u.id = o.reported_by LEFT JOIN users r ON r.id = o.reviewed_by
     WHERE o.patient_id = ? ORDER BY o.visit_at DESC, o.id DESC`, pid,
  ).map((o) => ({
    ...o,
    changes: all<{ id: number; med_name: string; change: string; detail: string | null; new_dose: string | null; new_times: string | null; med_key: string | null; status: string; applied_at: number | null; reviewed_by_name: string | null }>(
      "SELECT c.id, c.med_name, c.change, c.detail, c.new_dose, c.new_times, c.med_key, c.status, c.applied_at, r.name AS reviewed_by_name FROM med_changes c LEFT JOIN users r ON r.id = c.reviewed_by WHERE c.outside_visit_id = ? ORDER BY c.id", o.id,
    ).map((c) => ({ ...c, new_times: c.new_times ? (JSON.parse(c.new_times) as string[]) : null })),
    documents: all<{ id: number; title: string; mime: string; category: string }>("SELECT id, title, mime, category FROM patient_documents WHERE outside_visit_id = ? ORDER BY uploaded_at", o.id),
  }));
}

// ---------------------------------------------------------------- the clinic applies changes to the plan
export interface ApplyEdit { id: number; name?: string; dose?: string; times?: string[] }
const slug = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "med";

/**
 * The primary doctor / PA accepts medicine changes from another doctor's visit: the current plan is amended
 * (same visit, so the visit count is unchanged), future reminders are rebuilt, and the patient and family are told.
 */
export function applyMedChanges(pid: string, edits: ApplyEdit[], by: string, t: number): string[] {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  const visit = latestVisit(pid, t);
  if (!visit) throw new Error("There is no care plan yet. Record Visit 1 first.");
  const plan: CarePlan = JSON.parse(JSON.stringify(visit.plan));
  const done: string[] = [];
  tx(() => {
    for (const e of edits) {
      const c = get<{ id: number; patient_id: string; med_name: string; change: string; med_key: string | null; new_dose: string | null; new_times: string | null; prescriber: string | null; status: string; at: number }>("SELECT * FROM med_changes WHERE id = ?", e.id);
      if (!c || c.patient_id !== pid) throw new Error("Change not found");
      if (c.status !== "REPORTED") continue;
      const dose = sameDose((e.dose ?? c.new_dose ?? "").trim()) ?? "";
      const times = (e.times ?? (c.new_times ? (JSON.parse(c.new_times) as string[]) : [])).filter((x) => HHMM.test(x)).sort();
      const name = (e.name ?? c.med_name).trim();
      const idx = plan.medications.findIndex((m) => (c.med_key && m.key === c.med_key) || m.name.toLowerCase() === c.med_name.toLowerCase());
      const tag = `${c.prescriber ? `by ${c.prescriber}` : "by another doctor"}, ${fmtDate(c.at, { day: "numeric", month: "short" })}`;
      if (c.change === "stopped") {
        if (idx < 0) throw new Error(`${c.med_name} isn't in the current plan`);
        plan.medications.splice(idx, 1);
        done.push(`${c.med_name}: stopped`);
      } else if (c.change === "started" || idx < 0) {
        if (!dose) throw new Error(`Add the dose for ${name}`);
        if (!times.length) throw new Error(`Add the times for ${name}`);
        let key = slug(name);
        while (plan.medications.some((m) => m.key === key)) key += "_2";
        plan.medications.push({ key, name, dose, times, prescriber: c.prescriber ?? undefined, instructions: `Added ${tag}` });
        done.push(`${name} ${dose}: started`);
      } else {
        const m = plan.medications[idx];
        if (!dose && !times.length) throw new Error(`Add the new dose or times for ${m.name}`);
        // "20 mg / 10 mg" with two times = a different dose at each time.
        const per = dose.split(/\s*\/\s*/).filter(Boolean);
        if (times.length) m.times = times;
        if (per.length > 1 && per.length === m.times.length) {
          m.dose = per[0];
          if (per.every((x) => x === per[0])) delete m.doses;
          else m.doses = per;
        } else if (dose) { m.dose = dose; delete m.doses; }
        else if (m.doses && m.doses.length !== m.times.length) delete m.doses;
        m.prescriber = c.prescriber ?? m.prescriber;
        m.instructions = `Changed ${tag}`;
        done.push(`${m.name}: now ${describeMed(m)}`);
      }
      run("UPDATE med_changes SET status = 'CONFIRMED', reviewed_by = ?, reviewed_at = ?, applied_at = ?, new_dose = ?, new_times = ?, med_name = ? WHERE id = ?", by, t, t, dose || null, times.length ? JSON.stringify(times) : null, name, c.id);
    }
    if (!done.length) return;
    run("UPDATE visits SET plan = ? WHERE id = ?", JSON.stringify(plan), visit.id);
    run("DELETE FROM tasks WHERE patient_id = ? AND status = 'PENDING' AND due_at > ?", pid, t);
    setSetting(`gen:${pid}`, String(t));
    ensureTasks(pid, t);
    audit(t, by, "PLAN_AMENDED", "visit", visit.id, { changes: done, source: "outside_visit" });
  });
  if (done.length) {
    const who = getUser(by)?.name ?? "The clinic";
    const body = `💊 ${who} has updated ${first(p.name)}'s medicines:\n${done.map((d) => `• ${d}`).join("\n")}\n\nReminders follow the new plan from now.`;
    for (const u of [p.user_id, ...getCaregivers(pid).map((c) => c.user_id)]) if (u) sendWhatsApp({ userId: u, patientId: pid, body, kind: "info", at: t });
  }
  return done;
}

// ---------------------------------------------------------------- scheduler: reminders and follow-ups
export function tickOutsideVisits(t: number) {
  // Conversations left half-way are saved as they are.
  for (const r of all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'ov:%'")) {
    const f = JSON.parse(r.value) as Flow;
    if (t - f.lastAt <= FLOW_TTL) continue;
    if (f.visitId) finishVisit(f.visitId, t);
    run("DELETE FROM settings WHERE key = ?", r.key);
  }
  const hhmm = localHHMM(t);
  if (hhmm < "18:00") return;
  const today = dayStart(t);
  for (const v of all<OutsideVisitRow>("SELECT * FROM outside_visits WHERE status = 'COMPLETE' AND next_visit_at >= ? AND next_visit_at < ?", today, today + 2 * DAY)) {
    const p = getPatient(v.patient_id);
    if (!p?.user_id) continue;
    const doc = v.doctor_name ?? "the doctor";
    const tomorrow = v.next_visit_at! >= today + DAY;
    // Evening before: a reminder to the patient and the person who reported the visit.
    if (tomorrow && !getSetting(`ovrem:${v.id}`)) {
      setSetting(`ovrem:${v.id}`, String(t));
      const meds = latestVisit(p.id, t)?.plan.medications.length ?? 0;
      for (const u of new Set([p.user_id, v.reported_by].filter((x): x is string => !!x))) {
        const you = u === p.user_id;
        sendWhatsApp({ userId: u, patientId: p.id, kind: "reminder", at: t, body: `📅 Reminder: ${you ? "your" : `${first(p.name)}'s`} visit with ${doc}${v.specialty ? ` (${v.specialty})` : ""} is tomorrow.${v.next_visit_note ? `\n${v.next_visit_note}` : ""}\nCarry the medicine strips${meds ? ` (${meds} current medicines)` : ""} and recent reports. After the visit, just tell me what the doctor said or send a photo of the prescription.` });
      }
    }
    // Evening of the visit: ask how it went (once), so changes reach the record the same day.
    if (!tomorrow && hhmm >= "19:00" && !getSetting(`ovfu:${v.id}`)) {
      setSetting(`ovfu:${v.id}`, String(t));
      const u = v.reported_by ?? p.user_id;
      if (activeFlow(u, t)) continue;
      const you = u === p.user_id;
      openFollowup(u, v.id, t);
      sendWhatsApp({ userId: u, patientId: p.id, kind: "prompt", at: t, body: `👋 How did ${you ? "your" : `${first(p.name)}'s`} visit with ${doc} go today? Were any medicines changed? You can reply in your own words or send a photo of the prescription.`, quick: ["No changes", "Yes, there were changes", "Visit postponed"] });
    }
  }
}
