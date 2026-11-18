// Documents sent on WhatsApp are read as soon as they arrive, so the assistant's "Document to file" task comes
// pre-filled (what it is, its date, any lab values) and filing is one tap. Nothing reaches the record until the
// assistant (or doctor) confirms: lab values enter the lab history only on "Confirm & file".
import { all, get, run } from "./db";
import { audit } from "./db";
import { enterLabs, getPatient, getUser } from "./engine";
import { sameDayOutsideVisit, saveDocumentVisit } from "./outside";
import { now as clockNow } from "./clock";
import { analyzeDocumentOCR, isAIConfigured, type OCROutput } from "./gemini";
import { addDocument, MAX_DOC_BYTES, MAX_DOC_LABEL } from "./records";
import { fmtDate } from "./time";
import { LAB_META } from "./types";
import { resolveMarker } from "./labmarkers";
import { readableType } from "./mimetypes";

export interface DocExtract {
  category: string; // prescription | lab | discharge | other
  title: string;
  date: string | null; // YYYY-MM-DD
  prescriber: string | null;
  /** `date` when the sample was taken on another day than the document's (a note quoting an earlier report). */
  labs: { marker: string; value: number; unit: string; date?: string; uncertain?: boolean }[];
  /** What the AI took the document to be (lab_report, vitals_diary, discharge_summary…): sorts onboarding records into piles. */
  kind?: string;
  /** The document's text as transcribed (capped): what the onboarding summary is built from. */
  text?: string;
  /** Home readings with their own dates (a BP or sugar diary). */
  readings?: { type: string; v1: number; v2?: number; date: string; time?: string }[];
  /** Each separate consultation in the document, with its own date (a running note often has several). */
  visits?: DocVisit[];
  /** Results that aren't plain numbers, as printed (kept, never dropped). */
  texts?: TextResult[];
  meds: number;
  medList?: string[]; // names and doses, shown to the checker (medicines are never entered from here)
  note: string | null;
  reread?: boolean; // read again on request (e.g. a document filed before it could be read); shown for confirmation even if filed
  done?: boolean; // the checker has confirmed or rejected this reading
}
export interface TextResult { test: string; group?: string; result: string; reference?: string }
export type VisitKind = "outside" | "treating" | "skip";
export interface DocVisit {
  date: string | null; doctorName: string; specialty?: string; hospital?: string; reason?: string; findings?: string; advice?: string; tests?: string;
  nextVisitDate?: string | null; medChanges?: { medName: string; change: string; newDose?: string; frequency?: string; detail?: string }[];
  /** Where it goes: a visit to another doctor, the treating doctor's own visit (entered on the visit form), or nowhere. */
  kind: VisitKind;
  /** Set when this visit is already on the record (same doctor, same day): recording it again updates that visit. */
  recorded?: string | null;
  /** Set when a visit to this doctor is on record a few days away: the date may have been misread. */
  nearby?: string | null;
}
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00+05:30`));
const normDoc = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/^dr\.?\s*/, "").replace(/[^a-z]/g, "");

/** The visits the AI found (or the checker corrected), tidied, each with a suggested destination. */
export function cleanVisits(raw: unknown, pid: string, t: number): DocVisit[] {
  const p = getPatient(pid);
  const treatingName = p ? getUser(p.doctor_id)?.name : null;
  const out: DocVisit[] = [];
  for (const r of Array.isArray(raw) ? (raw as Record<string, unknown>[]).slice(0, 20) : []) {
    const doctorName = clip(r?.doctorName, 80);
    const date = isDay(r?.date) && Date.parse(`${r.date}T12:00:00+05:30`) <= t + 86_400_000 ? r.date : null;
    const what = ["reason", "findings", "advice", "tests"].some((k) => clip(r?.[k], 10));
    if (!doctorName && !date && !what) continue;
    const meds = (Array.isArray(r.medChanges) ? (r.medChanges as Record<string, unknown>[]) : []).filter((m) => clip(m?.medName, 80)).slice(0, 30)
      .map((m) => ({ medName: clip(m.medName, 80), change: clip(m.change, 20) || "other", ...(clip(m.newDose, 40) ? { newDose: clip(m.newDose, 40) } : {}), ...(clip(m.frequency, 20) ? { frequency: clip(m.frequency, 20) } : {}), ...(clip(m.detail, 160) ? { detail: clip(m.detail, 160) } : {}) }));
    const treating = !!doctorName && !!treatingName && normDoc(doctorName) === normDoc(treatingName);
    const v: DocVisit = {
      date, doctorName, kind: treating ? "treating" : "outside",
      ...(clip(r.specialty, 60) ? { specialty: clip(r.specialty, 60) } : {}), ...(clip(r.hospital, 80) ? { hospital: clip(r.hospital, 80) } : {}),
      ...(clip(r.reason, 200) ? { reason: clip(r.reason, 200) } : {}), ...(clip(r.findings, 600) ? { findings: clip(r.findings, 600) } : {}),
      ...(clip(r.advice, 600) ? { advice: clip(r.advice, 600) } : {}), ...(clip(r.tests, 200) ? { tests: clip(r.tests, 200) } : {}),
      nextVisitDate: isDay(r.nextVisitDate) ? r.nextVisitDate : null, ...(meds.length ? { medChanges: meds } : {}),
    };
    v.recorded = alreadyRecorded(pid, v);
    v.nearby = v.recorded ? null : nearbyVisit(pid, v);
    if (v.recorded || v.nearby) v.kind = "skip"; // only clearly new visits are set to record; the checker decides the rest
    out.push(v);
  }
  return out.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
}

/** A visit to the same doctor (or by the treating doctor) on record within 3 days but not on the same day. */
function nearbyVisit(pid: string, v: DocVisit): string | null {
  if (!v.date) return null;
  const day = Date.parse(`${v.date}T00:00:00+05:30`), span = 3 * 86_400_000;
  const near = (at: number) => at >= day - span && at < day + 86_400_000 + span && (at < day || at >= day + 86_400_000);
  const label = (at: number) => fmtDate(at, { day: "numeric", month: "short", year: "numeric" });
  if (v.kind === "treating") {
    const hit = all<{ visit_at: number }>("SELECT visit_at FROM visits WHERE patient_id = ?", pid).find((r) => near(r.visit_at));
    return hit ? `A visit on ${label(hit.visit_at)} is already recorded. Check this date before entering it` : null;
  }
  const hit = all<{ visit_at: number; doctor_name: string | null }>("SELECT visit_at, doctor_name FROM outside_visits WHERE patient_id = ?", pid)
    .find((r) => near(r.visit_at) && normDoc(r.doctor_name) === normDoc(v.doctorName));
  return hit ? `${hit.doctor_name}'s visit on ${label(hit.visit_at)} is already recorded. Check this date before recording` : null;
}

/** Whether this visit is already on the record: the treating doctor's visit that day, or a visit to this doctor that day. */
function alreadyRecorded(pid: string, v: DocVisit): string | null {
  if (!v.date) return null;
  const day = Date.parse(`${v.date}T00:00:00+05:30`);
  if (v.kind === "treating") return get("SELECT 1 FROM visits WHERE patient_id = ? AND visit_at >= ? AND visit_at < ?", pid, day, day + 86_400_000) ? "A visit on this date is already recorded" : null;
  return v.doctorName && sameDayOutsideVisit(pid, v.date, v.doctorName) ? "Already recorded as a visit to this doctor" : null;
}
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
/** The AI's (or the checker's) text results, tidied: every one with a test name and a result is kept. */
export function cleanTexts(raw: unknown): TextResult[] {
  const out: TextResult[] = [];
  for (const r of Array.isArray(raw) ? (raw as Record<string, unknown>[]).slice(0, 300) : []) {
    const test = clip(r?.test, 80), result = clip(r?.result, 200);
    if (!test || !result) continue;
    out.push({ test, result, ...(clip(r.group, 60) ? { group: clip(r.group, 60) } : {}), ...(clip(r.reference, 120) ? { reference: clip(r.reference, 120) } : {}) });
  }
  return out;
}
/** Files text results under the patient's labs, once per test, panel and date. Returns how many were new. */
export function enterTexts(pid: string, texts: TextResult[], takenAt: number, userId: string | null, docId: number | null, source = "DOCUMENT"): number {
  let n = 0;
  for (const x of texts) {
    if (get("SELECT 1 FROM lab_texts WHERE patient_id = ? AND test = ? AND COALESCE(grp, '') = ? AND taken_at = ?", pid, x.test, x.group ?? "", takenAt)) continue;
    run("INSERT INTO lab_texts(patient_id, test, grp, result, reference, taken_at, source, entered_by, document_id) VALUES(?,?,?,?,?,?,?,?,?)", pid, x.test, x.group ?? null, x.result, x.reference ?? null, takenAt, source, userId, docId);
    n++;
  }
  return n;
}

const READING_TYPES = new Set(["bp", "weight", "glucose", "hr", "spo2", "temp"]);
/** Home readings that carry their own date (diaries); undated ones can't be charted and are left out. */
export function cleanReadings(raw: unknown): NonNullable<DocExtract["readings"]> {
  const out: NonNullable<DocExtract["readings"]> = [];
  for (const r of Array.isArray(raw) ? (raw as Record<string, unknown>[]).slice(0, 2000) : []) {
    const type = String(r?.type ?? ""), v1 = Number(r?.v1), v2 = r?.v2 == null ? undefined : Number(r.v2);
    if (!READING_TYPES.has(type) || !Number.isFinite(v1) || !isDay(r?.date)) continue;
    if (type === "bp" && !Number.isFinite(v2)) continue;
    const time = typeof r.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : undefined;
    out.push({ type, v1, ...(v2 !== undefined && Number.isFinite(v2) ? { v2 } : {}), date: r.date as string, ...(time ? { time } : {}) });
  }
  return out;
}

export const DOC_TYPE_CATEGORY: Record<string, string> = { handwritten_prescription: "prescription", lab_report: "lab", discharge_summary: "discharge", vitals_diary: "other", other: "other" };

export function readExtract(raw: string | null | undefined): DocExtract | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as DocExtract; } catch { return null; }
}

/** A one-line description of what was read, for the task. */
export function extractLine(x: DocExtract): string {
  const labs = x.labs.slice(0, 5).map((l) => `${LAB_META[l.marker]?.label.replace(/ \(.*\)/, "") ?? l.marker} ${l.value}`).join(", ");
  return [x.title, x.date ? fmtDate(Date.parse(`${x.date}T12:00:00+05:30`), { day: "numeric", month: "short", year: "numeric" }) : null, x.prescriber, labs && `Values: ${labs}`, x.meds ? `${x.meds} medicine${x.meds > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ");
}

/** Reads one stored document in the background. Never throws; leaves nothing behind if the read fails. */
export async function extractDocument(docId: number, opts: { reread?: boolean } = {}): Promise<DocExtract | null> {
  if (!isAIConfigured()) return null;
  const d = get<{ patient_id: string; mime: string; data: Uint8Array; category: string; title: string }>("SELECT patient_id, mime, data, category, title FROM patient_documents WHERE id = ?", docId);
  if (!d || !readableType(d.mime, d.title)) return null;
  try {
    const r = await analyzeDocumentOCR({ imageBase64: Buffer.from(d.data).toString("base64"), mimeType: d.mime, patientId: d.patient_id, name: d.title });
    if (!r.source || /sample|simulator/i.test(r.source)) return null; // never present the simulated reader's output as a real reading (it is what a failed AI call falls back to)
    // Every numeric result is kept: a test the record doesn't know yet is learned now (lib/labmarkers.ts).
    const labs: DocExtract["labs"] = [];
    for (const l of r.extracted.labs) {
      const value = Number(l.value);
      if (!Number.isFinite(value)) continue;
      const marker = resolveMarker(l.marker, l.label, l.unit);
      const taken = isDay((l as { date?: unknown }).date) ? String((l as { date?: unknown }).date) : undefined;
      const on = taken && taken !== r.documentDate ? taken : undefined;
      if (marker && !labs.some((x) => x.marker === marker && x.date === on)) labs.push({ marker, value, unit: l.unit || LAB_META[marker].unit, ...(on ? { date: on } : {}), ...((l as { uncertain?: unknown }).uncertain === true ? { uncertain: true } : {}) });
    }
    const date = r.documentDate && /^\d{4}-\d{2}-\d{2}$/.test(r.documentDate) ? r.documentDate : null;
    const x: DocExtract = { category: DOC_TYPE_CATEGORY[r.documentType] ?? "other", title: (r.documentTypeName || "Medical document").slice(0, 90), date, prescriber: r.prescriber, labs, texts: cleanTexts(r.extracted.texts), visits: cleanVisits(r.visits, d.patient_id, clockNow()), kind: r.documentType, text: (r.transcription || "").slice(0, 30_000), readings: cleanReadings(r.extracted.vitals), meds: r.extracted.medications.length, medList: r.extracted.medications.slice(0, 12).map((m) => `${m.name} ${m.dose ?? ""}`.trim().slice(0, 80)), note: r.doctorNotes?.slice(0, 300) ?? null, ...(opts.reread ? { reread: true } : {}) };
    run("UPDATE patient_documents SET extract = ? WHERE id = ?", JSON.stringify(x), docId);
    return x;
  } catch {
    return null;
  }
}

/** Whether a reading is still waiting for a person to confirm or reject it. */
export const awaitingCheck = (filedAt: number | null, x: DocExtract | null) => !!x && !x.done && (!filedAt || !!x.reread);

export interface ReadEdit {
  labs?: { marker: string; value: number; date?: string | null }[]; // the checker's corrected values; replaces what was read
  visits?: DocVisit[]; // the checker's corrected visits, each with where it goes; replaces what was read
  texts?: TextResult[]; // the checker's corrected text results; replaces what was read
  date?: string | null; // YYYY-MM-DD the samples were taken
  reject?: boolean; // the reading is wrong: file the document and enter nothing
  skipReadings?: boolean; // file the values but leave out the home readings the AI found
}

/**
 * The checker confirms the reading, optionally corrected, and the lab values enter the lab history; or rejects it
 * and nothing is entered. A document that was already filed keeps its title and category.
 */
export function autoFile(docId: number, userId: string, t: number, edit: ReadEdit = {}): { filed: string; labs: number; texts?: number; visits?: number; readings?: number } {
  const d = get<{ patient_id: string; extract: string | null; filed_at: number | null; title: string; category: string }>("SELECT patient_id, extract, filed_at, title, category FROM patient_documents WHERE id = ?", docId);
  if (!d) throw new Error("Document not found");
  const x = readExtract(d.extract);
  if (!x) throw new Error("This document has not been read yet. Review and file it by hand.");
  const p = getPatient(d.patient_id);
  if (!p) throw new Error("Patient not found");
  if (edit.reject) {
    run("UPDATE patient_documents SET extract = ?, filed_at = COALESCE(filed_at, ?), filed_by = COALESCE(filed_by, ?) WHERE id = ?", JSON.stringify({ ...x, done: true }), t, userId, docId);
    audit(t, userId, "DOCUMENT_READING_REJECTED", "patient", p.id, { document: docId });
    return { filed: d.title, labs: 0 };
  }
  let labsIn: { marker: string; value: number; date?: string }[] = x.labs.map((l) => ({ marker: l.marker, value: l.value, ...(l.date ? { date: l.date } : {}) }));
  if (edit.labs) {
    const seen = new Set<string>();
    labsIn = [];
    for (const l of edit.labs) {
      if (!LAB_META[l.marker]) throw new Error(`Unknown lab test: ${l.marker}`);
      if (!Number.isFinite(l.value) || l.value < 0) throw new Error(`Enter a valid number for ${LAB_META[l.marker].label}`);
      if (l.date && !isDay(l.date)) throw new Error(`Enter a valid date for ${LAB_META[l.marker].label}`);
      const k = `${l.marker}|${l.date ?? ""}`;
      if (seen.has(k)) throw new Error(`${LAB_META[l.marker].label} is listed twice for the same date`);
      seen.add(k);
      labsIn.push({ marker: l.marker, value: l.value, ...(l.date ? { date: l.date } : {}) });
    }
  }
  let date = x.date;
  if (edit.date !== undefined) {
    if (edit.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(edit.date)) throw new Error("Enter the report date as a date");
    date = edit.date;
  }
  const at = date ? Date.parse(`${date}T09:00:00+05:30`) : t;
  if (date && (!Number.isFinite(at) || at > t + 86_400_000)) throw new Error("The report date can't be in the future");
  const textsIn = edit.texts ? cleanTexts(edit.texts) : x.texts ?? [];
  // Visits: the checker's choices (kind) are kept as given; anything else is tidied again.
  const visitsIn: DocVisit[] = edit.visits
    ? cleanVisits(edit.visits, p.id, t).map((v, i) => ({ ...v, kind: (["outside", "treating", "skip"] as const).find((k) => k === edit.visits![i]?.kind) ?? v.kind }))
    : x.visits ?? [];
  for (const v of visitsIn) if (v.kind === "outside" && (!v.date || !v.doctorName)) throw new Error("Each visit to record needs a date and the doctor's name");
  const edited = !!edit.labs || !!edit.texts || !!edit.visits || (edit.date !== undefined && edit.date !== x.date);
  const kept: DocExtract = { ...x, date, texts: textsIn, visits: visitsIn, labs: labsIn.map((l) => ({ ...l, unit: x.labs.find((o) => o.marker === l.marker)?.unit ?? LAB_META[l.marker].unit })), done: true };
  const title = d.filed_at ? d.title : `${x.title}${date ? ` · ${fmtDate(Date.parse(`${date}T12:00:00+05:30`), { day: "numeric", month: "short", year: "numeric" })}` : ""}`.slice(0, 120);
  run("UPDATE patient_documents SET title = ?, category = ?, notes = COALESCE(notes, ?), extract = ?, filed_at = COALESCE(filed_at, ?), filed_by = COALESCE(filed_by, ?) WHERE id = ?", title, d.filed_at ? d.category : x.category, x.note, JSON.stringify(kept), t, userId, docId);
  // Each value under the day its sample was taken; one already on record for that day (e.g. from the lab report itself) isn't entered again.
  let labs = 0;
  for (const day of [...new Set(labsIn.map((l) => l.date ?? ""))]) {
    const takenAt = Math.min(day ? Date.parse(`${day}T09:00:00+05:30`) : at, t);
    const fresh = labsIn.filter((l) => (l.date ?? "") === day).map(({ marker, value }) => ({ marker, value }))
      .filter((l) => !get("SELECT 1 FROM labs WHERE patient_id = ? AND marker = ? AND taken_at >= ? AND taken_at < ?", p.id, l.marker, takenAt - 9 * 3_600_000, takenAt + 15 * 3_600_000));
    if (fresh.length) {
      const last = get<{ m: number | null }>("SELECT MAX(id) AS m FROM labs")?.m ?? 0;
      enterLabs(p.id, fresh, takenAt, userId, t);
      run("UPDATE labs SET document_id = ? WHERE patient_id = ? AND id > ?", docId, p.id, last); // so deleting the document can take these along
      labs += fresh.length;
    }
  }
  const texts = textsIn.length ? enterTexts(p.id, textsIn, Math.min(at, t), userId, docId) : 0;
  const readings = edit.skipReadings ? 0 : enterReadings(p.id, x.readings ?? [], userId, docId, t);
  let visits = 0;
  for (const v of visitsIn) {
    if (v.kind !== "outside") continue; // the treating doctor's visits are entered on the visit form (they set the care plan)
    saveDocumentVisit(p.id, userId, docId, { ...v, date: v.date!, medChanges: v.medChanges }, t);
    visits++;
  }
  audit(t, userId, "DOCUMENT_AUTOFILED", "patient", p.id, { document: docId, category: x.category, labs, texts, visits, readings, edited });
  return { filed: title, labs, texts, visits, readings };
}

/**
 * Files a document's dated home readings (a BP / sugar / weight diary, a vitals history) with the readings history,
 * so they chart alongside readings sent on WhatsApp. A reading already on record at that moment isn't entered twice.
 * No alerts are raised: these are past readings. Returns how many were new.
 */
export function enterReadings(pid: string, list: NonNullable<DocExtract["readings"]>, userId: string, docId: number, t: number): number {
  let n = 0;
  for (const h of cleanReadings(list)) {
    const at = Math.min(Date.parse(`${h.date}T${h.time ?? "08:00"}:00+05:30`), t);
    if (!Number.isFinite(at) || get("SELECT 1 FROM observations WHERE patient_id = ? AND type = ? AND observed_at = ? AND v1 = ?", pid, h.type, at, h.v1)) continue;
    run("INSERT INTO observations(patient_id, type, v1, v2, observed_at, logged_by, parser, document_id) VALUES(?,?,?,?,?,?,?,?)", pid, h.type, h.v1, h.v2 ?? null, at, userId, "document", docId);
    n++;
  }
  return n;
}

/** When a report's values were taken: its own date (never in the future), else now. */
export function reportTime(date: string | null | undefined, t: number): number {
  const at = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T09:00:00+05:30`) : NaN;
  return Number.isFinite(at) ? Math.min(at, t) : t;
}

/**
 * A report read and charted from the "Read with AI" window: keep the file under Documents, already filed by the
 * person who reviewed the values, with what was read attached. Returns the document id.
 */
export function keepChartedDocument(pid: string, userId: string, r: OCROutput, mime: string, base64: string, t: number): number {
  if (Buffer.byteLength(base64.replace(/^data:[^;]+;base64,/, ""), "base64") > MAX_DOC_BYTES) throw new Error(`Files are limited to ${MAX_DOC_LABEL}`);
  const category = DOC_TYPE_CATEGORY[r.documentType] ?? "other";
  const date = r.documentDate && /^\d{4}-\d{2}-\d{2}$/.test(r.documentDate) ? r.documentDate : null;
  const docId = addDocument(pid, { title: (r.documentTypeName || "Medical document").slice(0, 120), category, mime, base64, notes: r.doctorNotes?.slice(0, 300) || undefined }, t, userId);
  const x: DocExtract = { category, title: r.documentTypeName, date, prescriber: r.prescriber, labs: r.extracted.labs.map((l) => ({ marker: l.marker, value: l.value, unit: l.unit })), texts: cleanTexts(r.extracted.texts), meds: r.extracted.medications.length, note: r.doctorNotes ?? null, done: true };
  run("UPDATE patient_documents SET extract = ?, filed_at = ?, filed_by = ? WHERE id = ?", JSON.stringify(x), t, userId, docId);
  if (x.texts?.length) enterTexts(pid, x.texts, reportTime(date, t), userId, docId);
  audit(t, userId, "DOCUMENT_READ_AND_CHARTED", "patient", pid, { document: docId, labs: x.labs.length });
  return docId;
}
