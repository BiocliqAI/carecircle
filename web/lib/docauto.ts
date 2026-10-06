// Documents sent on WhatsApp are read as soon as they arrive, so the assistant's "Document to file" task comes
// pre-filled (what it is, its date, any lab values) and filing is one tap. Nothing reaches the record until the
// assistant (or doctor) confirms: lab values enter the lab history only on "Confirm & file".
import { get, run } from "./db";
import { audit } from "./db";
import { enterLabs, getPatient } from "./engine";
import { analyzeDocumentOCR, isGeminiConfigured } from "./gemini";
import { fmtDate } from "./time";
import { LAB_META } from "./types";

export interface DocExtract {
  category: string; // prescription | lab | discharge | other
  title: string;
  date: string | null; // YYYY-MM-DD
  prescriber: string | null;
  labs: { marker: string; value: number; unit: string }[];
  meds: number;
  note: string | null;
}
const CAT: Record<string, string> = { handwritten_prescription: "prescription", lab_report: "lab", discharge_summary: "discharge", vitals_diary: "other", other: "other" };

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
export async function extractDocument(docId: number): Promise<DocExtract | null> {
  if (!isGeminiConfigured()) return null;
  const d = get<{ patient_id: string; mime: string; data: Uint8Array; category: string }>("SELECT patient_id, mime, data, category FROM patient_documents WHERE id = ?", docId);
  if (!d || !/^image\//.test(d.mime)) return null;
  try {
    const r = await analyzeDocumentOCR({ imageBase64: Buffer.from(d.data).toString("base64"), mimeType: d.mime, patientId: d.patient_id });
    if (!r.source || /sample/i.test(r.source)) return null; // never present the simulated reader's output as a real reading
    const labs = r.extracted.labs.filter((l) => LAB_META[l.marker] && Number.isFinite(l.value)).map((l) => ({ marker: l.marker, value: l.value, unit: l.unit }));
    const date = r.documentDate && /^\d{4}-\d{2}-\d{2}$/.test(r.documentDate) ? r.documentDate : null;
    const x: DocExtract = { category: CAT[r.documentType] ?? "other", title: (r.documentTypeName || "Medical document").slice(0, 90), date, prescriber: r.prescriber, labs, meds: r.extracted.medications.length, note: r.doctorNotes?.slice(0, 300) ?? null };
    run("UPDATE patient_documents SET extract = ? WHERE id = ?", JSON.stringify(x), docId);
    return x;
  } catch {
    return null;
  }
}

/** The assistant confirms: file the document with the read title and category, and enter its lab values. */
export function autoFile(docId: number, userId: string, t: number): { filed: string; labs: number } {
  const d = get<{ patient_id: string; extract: string | null }>("SELECT patient_id, extract FROM patient_documents WHERE id = ?", docId);
  if (!d) throw new Error("Document not found");
  const x = readExtract(d.extract);
  if (!x) throw new Error("This document has not been read yet. Review and file it by hand.");
  const p = getPatient(d.patient_id);
  if (!p) throw new Error("Patient not found");
  const title = `${x.title}${x.date ? ` · ${fmtDate(Date.parse(`${x.date}T12:00:00+05:30`), { day: "numeric", month: "short", year: "numeric" })}` : ""}`.slice(0, 120);
  run("UPDATE patient_documents SET title = ?, category = ?, notes = COALESCE(notes, ?), filed_at = COALESCE(filed_at, ?) WHERE id = ?", title, x.category, x.note, t, docId);
  let labs = 0;
  if (x.labs.length) {
    const at = x.date ? Date.parse(`${x.date}T09:00:00+05:30`) : t;
    const fresh = x.labs.filter((l) => !get("SELECT 1 FROM labs WHERE patient_id = ? AND marker = ? AND taken_at = ?", p.id, l.marker, at));
    if (fresh.length) { enterLabs(p.id, fresh.map((l) => ({ marker: l.marker, value: l.value })), Math.min(at, t), userId, t); labs = fresh.length; }
  }
  audit(t, userId, "DOCUMENT_AUTOFILED", "patient", p.id, { document: docId, category: x.category, labs });
  return { filed: title, labs };
}
