// Patient record maintenance after onboarding: demographics, care circle (max 2), clinical notes,
// documents, and the patient's WhatsApp SOS. Every change is audited.
import { all, audit, get, run, tx } from "./db";
import { clinicLabel, createEscalation, getCaregivers, getPatient, getUser, requestConsent, type CaregiverRow } from "./engine";
import { sendWhatsApp } from "./whatsapp";
import { consentReminderBody } from "./consenttext";
import { MAX_CAREGIVERS, shortName } from "./types";

const PHONE_RE = /^\+?[\d\s-]{8,}$/;
const digits = (s: string) => s.replace(/\D/g, "");

// ---------------------------------------------------------------- demographics
export interface PatientEdit {
  name?: string;
  age?: number | null;
  sex?: string;
  phone?: string;
  address?: string;
  conditions?: string;
  doctorId?: string;
}

export function updatePatient(pid: string, e: PatientEdit, t: number, actor: string) {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  const name = e.name?.trim() || p.name;
  const phone = e.phone?.trim() || p.phone;
  if (!PHONE_RE.test(phone) || digits(phone).length < 10) throw new Error("Enter a valid WhatsApp number with country code");
  if (digits(phone) !== digits(p.phone) && all<{ phone: string }>("SELECT phone FROM patients WHERE id != ?", pid).some((x) => digits(x.phone) === digits(phone)))
    throw new Error("Another patient already uses this WhatsApp number");
  if (getCaregivers(pid).some((c) => digits(c.phone) === digits(phone))) throw new Error("That number belongs to a caregiver in this care circle");
  const age = e.age === undefined ? p.age : e.age === null ? null : Number(e.age);
  if (age !== null && (!Number.isFinite(age) || age < 0 || age > 120)) throw new Error("Age must be between 0 and 120");
  let doctorId = p.doctor_id;
  if (e.doctorId && e.doctorId !== p.doctor_id) {
    if (getUser(e.doctorId)?.role !== "DOCTOR") throw new Error("Choose a doctor from the clinic");
    doctorId = e.doctorId;
  }
  tx(() => {
    run(
      "UPDATE patients SET name = ?, age = ?, sex = ?, phone = ?, address = ?, conditions = ?, doctor_id = ? WHERE id = ?",
      name, age, e.sex ?? p.sex, phone, e.address !== undefined ? e.address.trim() : p.address, e.conditions !== undefined ? e.conditions.trim() : p.conditions, doctorId, pid,
    );
    if (p.user_id) run("UPDATE users SET name = ?, phone = ? WHERE id = ?", name, phone, p.user_id);
    if (doctorId !== p.doctor_id) {
      const d = getUser(doctorId)!;
      run("DELETE FROM care_team WHERE patient_id = ? AND role = 'PRIMARY'", pid);
      run("INSERT INTO care_team(patient_id, name, specialty, role, user_id) VALUES(?,?,?,?,?)", pid, d.name, d.title, "PRIMARY", d.id);
    }
    audit(t, actor, "PATIENT_UPDATED", "patient", pid, { fields: Object.keys(e), doctorChanged: doctorId !== p.doctor_id });
  });
}

// ---------------------------------------------------------------- care circle
export interface CaregiverInput {
  id?: string; // existing caregiver row id; omit for a new person
  name: string;
  relation: string;
  phone: string;
  dashboard: boolean;
}

/**
 * Replaces the care circle with `list` (order = escalation order, max 2). Existing people keep their
 * account and consent; new people (or a changed number) get the welcome + consent request on WhatsApp.
 * Open alerts stay with whoever is now at their level.
 */
export function setCareCircle(pid: string, list: CaregiverInput[], t: number, actor: string): CaregiverRow[] {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  const clean = list.filter((c) => c.name?.trim() || c.phone?.replace(/\D/g, "").length > 2);
  if (!clean.length) throw new Error("The care circle needs at least one caregiver");
  if (clean.length > MAX_CAREGIVERS) throw new Error(`A care circle has at most ${MAX_CAREGIVERS} caregivers (primary and backup)`);
  for (const [i, c] of clean.entries()) {
    if (!c.name?.trim()) throw new Error(`Enter a name for caregiver ${i + 1}`);
    if (!PHONE_RE.test(c.phone || "") || digits(c.phone).length < 10) throw new Error(`Enter a WhatsApp number for caregiver ${i + 1}`);
    if (digits(c.phone) === digits(p.phone)) throw new Error(`Caregiver ${i + 1} can't use the patient's own number`);
  }
  if (new Set(clean.map((c) => digits(c.phone))).size !== clean.length) throw new Error("Each caregiver needs a different WhatsApp number");

  const before = getCaregivers(pid);
  const clinic = clinicLabel();
  tx(() => {
    run("DELETE FROM caregivers WHERE patient_id = ?", pid);
    clean.forEach((c, i) => {
      const level = i + 1;
      const prev = c.id ? before.find((b) => b.id === c.id) : undefined;
      const samePerson = prev && digits(prev.phone) === digits(c.phone);
      let uid = samePerson ? prev!.user_id : null;
      if (!uid) {
        uid = all<{ id: string; phone: string }>("SELECT id, phone FROM users WHERE role = 'CAREGIVER'").find((u) => digits(u.phone) === digits(c.phone))?.id ?? null;
        if (!uid) {
          uid = `u_cg_${pid.slice(2, 22)}_${t.toString(36)}${level}`;
          run("INSERT INTO users(id, name, role, phone, title) VALUES(?,?,?,?,?)", uid, c.name.trim(), "CAREGIVER", c.phone.trim(), `${c.relation || "Family"} of ${shortName(p.name)}`);
        }
      }
      run("UPDATE users SET name = ?, title = ? WHERE id = ?", c.name.trim(), `${c.relation || "Family"} of ${shortName(p.name)}`, uid);
      const id = samePerson ? prev!.id : `cg_${pid.slice(2, 22)}_${t.toString(36)}${level}`;
      run("INSERT INTO caregivers(id, patient_id, user_id, name, relation, phone, level, dashboard) VALUES(?,?,?,?,?,?,?,?)", id, pid, uid, c.name.trim(), c.relation || "Family", c.phone.trim(), level, c.dashboard === false ? 0 : 1);
      const isNew = !before.some((b) => b.user_id === uid);
      if (isNew) {
        requestConsent(pid, uid, "CAREGIVER", t);
        sendWhatsApp({
          userId: uid, patientId: pid, at: t, kind: "info", quick: ["YES", "NO"],
          body: `👋 Hi ${shortName(c.name)}, ${p.name} has added you as ${level === 1 ? "the primary" : "the backup"} caregiver in their CareCircle (${c.relation || "Family"})${clinic ? ` at ${clinic}` : ""}.\nIf a medicine is missed or a reading goes outside the doctor's limits, I'll alert you here. Reply *ACK* to alerts to take ownership.\n\nReply *YES* to join the care circle, or *NO* to decline.`,
        });
      } else {
        const old = before.find((b) => b.user_id === uid)!;
        if (old.level !== level) sendWhatsApp({ userId: uid, patientId: pid, at: t, kind: "info", body: `ℹ️ You're now ${level === 1 ? "the primary" : "the backup"} caregiver for ${p.name}.` });
      }
    });
    // People no longer in the circle: withdraw their pending consent and tell them.
    const now = getCaregivers(pid);
    for (const b of before) {
      if (!b.user_id || now.some((n) => n.user_id === b.user_id)) continue;
      run("DELETE FROM consents WHERE patient_id = ? AND user_id = ? AND status = 'PENDING'", pid, b.user_id);
      sendWhatsApp({ userId: b.user_id, patientId: pid, at: t, kind: "info", body: `ℹ️ You've been removed from ${p.name}'s care circle by the clinic. You won't receive alerts for ${shortName(p.name)} any more.` });
    }
    audit(t, actor, "CARE_CIRCLE_UPDATED", "patient", pid, { before: before.map((b) => `${b.level}:${b.name}`), after: now.map((n) => `${n.level}:${n.name}`) });
  });
  return getCaregivers(pid);
}

// ---------------------------------------------------------------- notes
export interface NoteRow {
  id: number;
  patient_id: string;
  author_id: string;
  author_name: string | null;
  author_role: string | null;
  kind: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export const listNotes = (pid: string) =>
  all<NoteRow>("SELECT n.*, u.name AS author_name, u.role AS author_role FROM patient_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.patient_id = ? ORDER BY n.created_at DESC", pid);

export function addNote(pid: string, body: string, kind: string, t: number, actor: string): number {
  const text = body.trim();
  if (!text) throw new Error("The note is empty");
  if (text.length > 5000) throw new Error("Notes are limited to 5,000 characters");
  const id = run("INSERT INTO patient_notes(patient_id, author_id, kind, body, created_at, updated_at) VALUES(?,?,?,?,?,?)", pid, actor, kind === "clinical" ? "clinical" : "general", text, t, t).lastInsertRowid;
  audit(t, actor, "NOTE_ADDED", "patient", pid, { note: id, kind });
  return id;
}

/** Authors edit or delete their own notes. */
export function editNote(id: number, body: string | null, t: number, actor: string) {
  const n = get<{ patient_id: string; author_id: string }>("SELECT patient_id, author_id FROM patient_notes WHERE id = ?", id);
  if (!n) throw new Error("Note not found");
  if (n.author_id !== actor) throw new Error("You can only change your own notes");
  if (body === null) {
    run("DELETE FROM patient_notes WHERE id = ?", id);
    audit(t, actor, "NOTE_DELETED", "patient", n.patient_id, { note: id });
    return;
  }
  if (!body.trim()) throw new Error("The note is empty");
  run("UPDATE patient_notes SET body = ?, updated_at = ? WHERE id = ?", body.trim().slice(0, 5000), t, id);
  audit(t, actor, "NOTE_EDITED", "patient", n.patient_id, { note: id });
}

// ---------------------------------------------------------------- documents
export const DOC_CATEGORIES = ["prescription", "lab", "discharge", "imaging", "voice", "other"] as const;
export const MAX_DOC_BYTES = 5 * 1024 * 1024;

export interface DocumentRow {
  id: number;
  filed_at: number | null;
  patient_id: string;
  title: string;
  category: string;
  mime: string;
  size: number;
  notes: string | null;
  source: string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  uploaded_at: number;
}

export const listDocuments = (pid: string) =>
  all<DocumentRow>(
    "SELECT d.id, d.filed_at, d.patient_id, d.title, d.category, d.mime, d.size, d.notes, d.source, d.uploaded_by, u.name AS uploaded_by_name, d.uploaded_at FROM patient_documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.patient_id = ? ORDER BY d.uploaded_at DESC",
    pid,
  );

export function getDocumentFile(id: number) {
  return get<{ patient_id: string; title: string; mime: string; data: Uint8Array }>("SELECT patient_id, title, mime, data FROM patient_documents WHERE id = ?", id);
}

export function addDocument(pid: string, d: { title: string; category: string; mime: string; base64: string; notes?: string; source?: string; messageId?: number | null }, t: number, actor: string): number {
  const raw = d.base64.replace(/^data:[^;]+;base64,/, "");
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length) throw new Error("The file is empty");
  if (bytes.length > MAX_DOC_BYTES) throw new Error("Files are limited to 5 MB");
  const category = (DOC_CATEGORIES as readonly string[]).includes(d.category) ? d.category : "other";
  const title = (d.title || "Document").trim().slice(0, 120);
  const id = run(
    "INSERT INTO patient_documents(patient_id, title, category, mime, size, data, notes, source, uploaded_by, uploaded_at, message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    pid, title, category, (d.mime || "application/octet-stream").slice(0, 100), bytes.length, new Uint8Array(bytes), d.notes?.trim() || null, d.source || "clinic", actor, t, d.messageId ?? null,
  ).lastInsertRowid;
  if ((d.source || "clinic") === "clinic") run("UPDATE patient_documents SET filed_at = ? WHERE id = ?", t, id);
  audit(t, actor, "DOCUMENT_ADDED", "patient", pid, { document: id, category, source: d.source || "clinic" });
  return id;
}

export function updateDocument(id: number, e: { title?: string; category?: string; notes?: string }, t: number, actor: string) {
  const d = get<{ patient_id: string; title: string; category: string; notes: string | null }>("SELECT patient_id, title, category, notes FROM patient_documents WHERE id = ?", id);
  if (!d) throw new Error("Document not found");
  const category = e.category && (DOC_CATEGORIES as readonly string[]).includes(e.category) ? e.category : d.category;
  run("UPDATE patient_documents SET title = ?, category = ?, notes = ?, filed_at = COALESCE(filed_at, ?) WHERE id = ?", e.title?.trim().slice(0, 120) || d.title, category, e.notes !== undefined ? e.notes.trim() || null : d.notes, t, id);
  audit(t, actor, "DOCUMENT_UPDATED", "patient", d.patient_id, { document: id });
}

export function deleteDocument(id: number, t: number, actor: string) {
  const d = get<{ patient_id: string }>("SELECT patient_id FROM patient_documents WHERE id = ?", id);
  if (!d) throw new Error("Document not found");
  run("DELETE FROM patient_documents WHERE id = ?", id);
  audit(t, actor, "DOCUMENT_DELETED", "patient", d.patient_id, { document: id });
}

// ---------------------------------------------------------------- WhatsApp SOS
/** Patient (or caregiver) taps "Call for help": urgent alert to the care circle, starting at the primary caregiver. */
export function raiseSos(userId: string, t: number): { patientName: string; calling: string | null } {
  const u = getUser(userId);
  if (!u) throw new Error("Unknown user");
  const pid = u.role === "PATIENT"
    ? get<{ id: string }>("SELECT id FROM patients WHERE user_id = ?", userId)?.id
    : get<{ patient_id: string }>("SELECT patient_id FROM caregivers WHERE user_id = ? ORDER BY level LIMIT 1", userId)?.patient_id;
  const p = pid ? getPatient(pid) : undefined;
  if (!p) throw new Error("This number isn't linked to a patient");
  const cgs = getCaregivers(p.id);
  const msgId = run("INSERT INTO messages(patient_id, user_id, direction, body, created_at, kind) VALUES(?,?,?,?,?,?)", p.id, userId, "IN", "🆘 Emergency: call for help", t, "sos").lastInsertRowid;
  createEscalation(
    p,
    {
      type: "URGENT",
      ruleKey: "sos",
      title: "Emergency: help requested on WhatsApp",
      detail: `${u.role === "PATIENT" ? p.name : `${u.name} (for ${p.name})`} pressed the emergency button.`,
      advice: `Call ${shortName(p.name)} immediately. If there is chest pain, breathlessness, fainting or confusion, call 108 or go to the nearest emergency department.`,
      messageId: msgId,
    },
    t,
  );
  const first = cgs[0];
  sendWhatsApp({
    userId, patientId: p.id, at: t + 1000, kind: "reply",
    body: `🆘 Help is on the way.\n${first ? `I've alerted ${first.name} (${first.relation}) and I'm calling them now.` : "I've alerted your care circle."}\n\nIf this is severe (chest pain, can't breathe, fainting), call *108* now.`,
  });
  audit(t, userId, "SOS_RAISED", "patient", p.id, { message: msgId });
  return { patientName: p.name, calling: first ? first.name : null };
}

// ---------------------------------------------------------------- consent reminders
export function resendConsent(pid: string, onlyUser: string | null, t: number, actor: string): number {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  const pending = all<{ user_id: string; role: string }>("SELECT user_id, role FROM consents WHERE patient_id = ? AND status = 'PENDING'", pid).filter((c) => !onlyUser || c.user_id === onlyUser);
  const clinic = clinicLabel();
  for (const c of pending) {
    const u = getUser(c.user_id);
    if (!u) continue;
    sendWhatsApp({
      userId: c.user_id, patientId: pid, at: t, kind: "info", quick: ["YES", "NO"],
      body: consentReminderBody(c.role, p.name, clinic),
    });
  }
  if (pending.length) audit(t, actor, "CONSENT_RESENT", "patient", pid, { n: pending.length });
  return pending.length;
}
