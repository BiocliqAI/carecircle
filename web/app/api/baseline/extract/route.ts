import { extractBaselineAI, lastTranscribeError } from "@/lib/gemini";
import { baselineFromExtraction } from "@/lib/clinic";
import { LAB_META } from "@/lib/types";
import { readableType } from "@/lib/mimetypes";
import { now } from "@/lib/clock";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";
import { getPatient } from "@/lib/engine";
import { addDocument, MAX_DOC_BYTES } from "@/lib/records";
import { all, run } from "@/lib/db";

export const dynamic = "force-dynamic";


// Old documents (photos or PDFs) -> suggested baseline fields. The fields are only suggestions: the PA reviews the form
// and saves it. For an existing patient the files themselves are kept under Documents, filed by whoever read them in.
export async function POST(req: Request) {
  await ready();
  const user = await sessionUser();
  if (!isClinician(user)) return err("Only the care team can read documents into a baseline", 403);
  const b = (await req.json().catch(() => ({}))) as { files?: { base64?: string; mime?: string; name?: string }[]; docIds?: number[]; patientId?: string };
  if (b.patientId && (!getPatient(b.patientId) || !canView(user!, b.patientId))) return err("No access to this patient", 403);
  const files = (b.files ?? []).filter((f) => f?.base64 && readableType(f.mime, f.name));
  // Documents already on the patient's record are read from the database and not stored again.
  const ids = [...new Set((b.docIds ?? []).map(Number).filter(Number.isInteger))].slice(0, 10);
  const stored = ids.length && b.patientId
    ? all<{ title: string; mime: string; data: Uint8Array }>(`SELECT title, mime, data FROM patient_documents WHERE patient_id = ? AND id IN (${ids.map(() => "?").join(",")})`, b.patientId, ...ids)
        .filter((d) => readableType(d.mime, d.title))
        .map((d) => ({ base64: Buffer.from(d.data).toString("base64"), mime: d.mime, name: d.title }))
    : [];
  const all_ = [...stored, ...files];
  if (!all_.length) return err("Add at least one document: a photo, PDF, Word or Excel file");
  if (all_.length > 10) return err("Add up to 10 documents at a time");
  if (all_.reduce((n, f) => n + f.base64!.length, 0) > 28_000_000) {
    const big = all_.filter((f) => f.base64!.length > 8_000_000).map((f) => f.name).filter(Boolean);
    return err(`Those files are too large to read together (about 20 MB at most)${big.length ? `. Largest: ${big.join(", ")}` : ""}. Pick fewer or smaller ones`);
  }
  const raw = await extractBaselineAI(all_.map((f) => ({ base64: f.base64!, mime: f.mime!, name: f.name })), Object.keys(LAB_META));
  if (!raw) return err(lastTranscribeError === "AI is not configured" ? "AI is not set up. Add the Anthropic (or Gemini) key in Settings, or fill the form by hand." : `Couldn't read the documents${lastTranscribeError ? `: ${lastTranscribeError}` : ""}`, 502);
  const t = now();
  if (b.patientId) {
    for (const f of files) {
      if (Buffer.byteLength(f.base64!.replace(/^data:[^;]+;base64,/, ""), "base64") > MAX_DOC_BYTES) continue; // too big to keep; it was still read
      const name = (f.name || "Document").replace(/\.[^.]+$/, "").slice(0, 100);
      const category = /lab|report|test|rft|cbc/i.test(name) ? "lab" : /rx|prescri/i.test(name) ? "prescription" : /discharge/i.test(name) ? "discharge" : "other";
      const id = addDocument(b.patientId, { title: name, category, mime: f.mime!.split(";")[0], base64: f.base64!, notes: "Read into the baseline" }, t, user!.id);
      run("UPDATE patient_documents SET filed_at = ?, filed_by = ? WHERE id = ?", t, user!.id, id);
    }
  }
  return json({ ok: true, ...baselineFromExtraction(raw, t) });
}
