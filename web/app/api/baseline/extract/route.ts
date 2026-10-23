import { extractBaselineAI, lastTranscribeError } from "@/lib/gemini";
import { baselineFromExtraction } from "@/lib/clinic";
import { LAB_META } from "@/lib/types";
import { now } from "@/lib/clock";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";
import { getPatient } from "@/lib/engine";
import { addDocument, MAX_DOC_BYTES } from "@/lib/records";
import { run } from "@/lib/db";

export const dynamic = "force-dynamic";

const OK_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

// Old documents (photos or PDFs) -> suggested baseline fields. The fields are only suggestions: the PA reviews the form
// and saves it. For an existing patient the files themselves are kept under Documents, filed by whoever read them in.
export async function POST(req: Request) {
  await ready();
  const user = await sessionUser();
  if (!isClinician(user)) return err("Only the care team can read documents into a baseline", 403);
  const b = (await req.json().catch(() => ({}))) as { files?: { base64?: string; mime?: string; name?: string }[]; patientId?: string };
  if (b.patientId && (!getPatient(b.patientId) || !canView(user!, b.patientId))) return err("No access to this patient", 403);
  const files = (b.files ?? []).filter((f) => f?.base64 && OK_MIME.test((f.mime || "").split(";")[0]));
  if (!files.length) return err("Add at least one photo (JPG, PNG) or PDF");
  if (files.length > 10) return err("Add up to 10 documents at a time");
  if (files.reduce((n, f) => n + f.base64!.length, 0) > 28_000_000) return err("Those files are too large together; add fewer or smaller ones");
  const raw = await extractBaselineAI(files.map((f) => ({ base64: f.base64!, mime: f.mime! })), Object.keys(LAB_META));
  if (!raw) return err(lastTranscribeError === "Gemini is not configured" ? "AI is not set up. Add the Gemini key in Settings, or fill the form by hand." : `Couldn't read the documents${lastTranscribeError ? `: ${lastTranscribeError}` : ""}`, 502);
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
