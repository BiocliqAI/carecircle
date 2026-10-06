import { extractBaselineAI, lastTranscribeError } from "@/lib/gemini";
import { baselineFromExtraction } from "@/lib/clinic";
import { LAB_META } from "@/lib/types";
import { now } from "@/lib/clock";
import { err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const OK_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

// Old documents (photos or PDFs) -> suggested baseline fields. Nothing is saved: the PA reviews the form and saves it.
export async function POST(req: Request) {
  await ready();
  const user = await sessionUser();
  if (!isClinician(user)) return err("Only the care team can read documents into a baseline", 403);
  const b = (await req.json().catch(() => ({}))) as { files?: { base64?: string; mime?: string }[] };
  const files = (b.files ?? []).filter((f) => f?.base64 && OK_MIME.test((f.mime || "").split(";")[0]));
  if (!files.length) return err("Add at least one photo (JPG, PNG) or PDF");
  if (files.length > 10) return err("Add up to 10 documents at a time");
  if (files.reduce((n, f) => n + f.base64!.length, 0) > 28_000_000) return err("Those files are too large together; add fewer or smaller ones");
  const raw = await extractBaselineAI(files.map((f) => ({ base64: f.base64!, mime: f.mime! })), Object.keys(LAB_META));
  if (!raw) return err(lastTranscribeError === "Gemini is not configured" ? "AI is not set up. Add the Gemini key in Settings, or fill the form by hand." : `Couldn't read the documents${lastTranscribeError ? `: ${lastTranscribeError}` : ""}`, 502);
  return json({ ok: true, ...baselineFromExtraction(raw, now()) });
}
