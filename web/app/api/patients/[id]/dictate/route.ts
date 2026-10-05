import { latestVisit, getPatient } from "@/lib/engine";
import { lastTranscribeError, transcribeDictation } from "@/lib/gemini";
import { now } from "@/lib/clock";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Clinician dictation → text for the note box. Returned for review; the clinician saves it themselves.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !canView(user!, id)) return err("Care team only", 403);
  const b = (await req.json()) as { base64?: string; mime?: string; hint?: string };
  if (!b.base64) return err("No audio");
  if (b.base64.length > 14_000_000) return err("Dictation is too long; keep it under about 5 minutes");
  const p = getPatient(id);
  const meds = latestVisit(id, now())?.plan.medications.map((m) => `${m.name} ${m.dose}`) ?? [];
  const text = await transcribeDictation(b.base64, b.mime || "audio/webm", { meds, conditions: p?.conditions ?? "", hint: b.hint ?? null });
  if (text) return json({ text, via: "Gemini" });
  // No AI: fall back to the browser's live transcript so the clinician can still edit and save.
  return json({ text: b.hint?.trim() || "", via: b.hint?.trim() ? "live speech recognition" : null, aiError: lastTranscribeError });
}
