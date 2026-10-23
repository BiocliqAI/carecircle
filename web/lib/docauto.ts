// Documents sent on WhatsApp are read as soon as they arrive, so the assistant's "Document to file" task comes
// pre-filled (what it is, its date, any lab values) and filing is one tap. Nothing reaches the record until the
// assistant (or doctor) confirms: lab values enter the lab history only on "Confirm & file".
import { get, run } from "./db";
import { audit } from "./db";
import { enterLabs, getPatient } from "./engine";
import { analyzeDocumentOCR, isGeminiConfigured, type OCROutput } from "./gemini";
import { addDocument, MAX_DOC_BYTES } from "./records";
import { fmtDate } from "./time";
import { LAB_META } from "./types";

export interface DocExtract {
  category: string; // prescription | lab | discharge | other
  title: string;
  date: string | null; // YYYY-MM-DD
  prescriber: string | null;
  labs: { marker: string; value: number; unit: string }[];
  meds: number;
  medList?: string[]; // names and doses, shown to the checker (medicines are never entered from here)
  note: string | null;
  reread?: boolean; // read again on request (e.g. a document filed before it could be read); shown for confirmation even if filed
  done?: boolean; // the checker has confirmed or rejected this reading
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
  if (!isGeminiConfigured()) return null;
  const d = get<{ patient_id: string; mime: string; data: Uint8Array; category: string }>("SELECT patient_id, mime, data, category FROM patient_documents WHERE id = ?", docId);
  if (!d || !/^(image\/|application\/pdf$)/.test(d.mime)) return null;
  try {
    const r = await analyzeDocumentOCR({ imageBase64: Buffer.from(d.data).toString("base64"), mimeType: d.mime, patientId: d.patient_id });
    if (!r.source || /sample|simulator/i.test(r.source)) return null; // never present the simulated reader's output as a real reading (it is what a failed AI call falls back to)
    const labs = r.extracted.labs.filter((l) => LAB_META[l.marker] && Number.isFinite(l.value)).map((l) => ({ marker: l.marker, value: l.value, unit: l.unit }));
    const date = r.documentDate && /^\d{4}-\d{2}-\d{2}$/.test(r.documentDate) ? r.documentDate : null;
    const x: DocExtract = { category: DOC_TYPE_CATEGORY[r.documentType] ?? "other", title: (r.documentTypeName || "Medical document").slice(0, 90), date, prescriber: r.prescriber, labs, meds: r.extracted.medications.length, medList: r.extracted.medications.slice(0, 12).map((m) => `${m.name} ${m.dose ?? ""}`.trim().slice(0, 80)), note: r.doctorNotes?.slice(0, 300) ?? null, ...(opts.reread ? { reread: true } : {}) };
    run("UPDATE patient_documents SET extract = ? WHERE id = ?", JSON.stringify(x), docId);
    return x;
  } catch {
    return null;
  }
}

/** Whether a reading is still waiting for a person to confirm or reject it. */
export const awaitingCheck = (filedAt: number | null, x: DocExtract | null) => !!x && !x.done && (!filedAt || !!x.reread);

export interface ReadEdit {
  labs?: { marker: string; value: number }[]; // the checker's corrected values; replaces what was read
  date?: string | null; // YYYY-MM-DD the samples were taken
  reject?: boolean; // the reading is wrong: file the document and enter nothing
}

/**
 * The checker confirms the reading, optionally corrected, and the lab values enter the lab history; or rejects it
 * and nothing is entered. A document that was already filed keeps its title and category.
 */
export function autoFile(docId: number, userId: string, t: number, edit: ReadEdit = {}): { filed: string; labs: number } {
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
  let labsIn = x.labs.map((l) => ({ marker: l.marker, value: l.value }));
  if (edit.labs) {
    const seen = new Set<string>();
    labsIn = [];
    for (const l of edit.labs) {
      if (!LAB_META[l.marker]) throw new Error(`Unknown lab test: ${l.marker}`);
      if (!Number.isFinite(l.value) || l.value < 0) throw new Error(`Enter a valid number for ${LAB_META[l.marker].label}`);
      if (seen.has(l.marker)) throw new Error(`${LAB_META[l.marker].label} is listed twice`);
      seen.add(l.marker);
      labsIn.push({ marker: l.marker, value: l.value });
    }
  }
  let date = x.date;
  if (edit.date !== undefined) {
    if (edit.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(edit.date)) throw new Error("Enter the report date as a date");
    date = edit.date;
  }
  const at = date ? Date.parse(`${date}T09:00:00+05:30`) : t;
  if (date && (!Number.isFinite(at) || at > t + 86_400_000)) throw new Error("The report date can't be in the future");
  const edited = !!edit.labs || (edit.date !== undefined && edit.date !== x.date);
  const kept: DocExtract = { ...x, date, labs: labsIn.map((l) => ({ ...l, unit: x.labs.find((o) => o.marker === l.marker)?.unit ?? LAB_META[l.marker].unit })), done: true };
  const title = d.filed_at ? d.title : `${x.title}${date ? ` · ${fmtDate(Date.parse(`${date}T12:00:00+05:30`), { day: "numeric", month: "short", year: "numeric" })}` : ""}`.slice(0, 120);
  run("UPDATE patient_documents SET title = ?, category = ?, notes = COALESCE(notes, ?), extract = ?, filed_at = COALESCE(filed_at, ?), filed_by = COALESCE(filed_by, ?) WHERE id = ?", title, d.filed_at ? d.category : x.category, x.note, JSON.stringify(kept), t, userId, docId);
  let labs = 0;
  if (labsIn.length) {
    const takenAt = Math.min(at, t);
    const fresh = labsIn.filter((l) => !get("SELECT 1 FROM labs WHERE patient_id = ? AND marker = ? AND taken_at = ?", p.id, l.marker, takenAt));
    if (fresh.length) { enterLabs(p.id, fresh, takenAt, userId, t); labs = fresh.length; }
  }
  audit(t, userId, "DOCUMENT_AUTOFILED", "patient", p.id, { document: docId, category: x.category, labs, edited });
  return { filed: title, labs };
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
  if (Buffer.byteLength(base64.replace(/^data:[^;]+;base64,/, ""), "base64") > MAX_DOC_BYTES) throw new Error("Files are limited to 5 MB");
  const category = DOC_TYPE_CATEGORY[r.documentType] ?? "other";
  const date = r.documentDate && /^\d{4}-\d{2}-\d{2}$/.test(r.documentDate) ? r.documentDate : null;
  const docId = addDocument(pid, { title: (r.documentTypeName || "Medical document").slice(0, 120), category, mime, base64, notes: r.doctorNotes?.slice(0, 300) || undefined }, t, userId);
  const x: DocExtract = { category, title: r.documentTypeName, date, prescriber: r.prescriber, labs: r.extracted.labs.map((l) => ({ marker: l.marker, value: l.value, unit: l.unit })), meds: r.extracted.medications.length, note: r.doctorNotes ?? null, done: true };
  run("UPDATE patient_documents SET extract = ?, filed_at = ?, filed_by = ? WHERE id = ?", JSON.stringify(x), t, userId, docId);
  audit(t, userId, "DOCUMENT_READ_AND_CHARTED", "patient", pid, { document: docId, labs: x.labs.length });
  return docId;
}
