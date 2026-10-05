import { now } from "@/lib/clock";
import { get, run } from "@/lib/db";
import { getUser, ingestMessage, runScheduler } from "@/lib/engine";
import { transcribeAudio } from "@/lib/gemini";
import { addDocument } from "@/lib/records";
import { err, json, ready } from "@/lib/server";
import { sendWhatsApp } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// WhatsApp simulator: a patient or caregiver sends a document or a voice note.
// Files are kept in the patient's documents (source "whatsapp"). Voice notes with a transcript
// (typed for the demo, or transcribed by Gemini) are logged like a text message, so readings are parsed.
export async function POST(req: Request) {
  await ready();
  const b = (await req.json()) as { userId?: string; kind?: "document" | "voice"; base64?: string; mime?: string; filename?: string; durationSec?: number; transcript?: string; transcriptSource?: "browser" | "typed" };
  const user = b.userId ? getUser(b.userId) : undefined;
  if (!user || (user.role !== "PATIENT" && user.role !== "CAREGIVER")) return err("Unknown WhatsApp user", 404);
  if (!b.base64) return err("Nothing to send");
  const pid = user.role === "PATIENT"
    ? get<{ id: string }>("SELECT id FROM patients WHERE user_id = ?", user.id)?.id
    : get<{ patient_id: string }>("SELECT patient_id FROM caregivers WHERE user_id = ? ORDER BY level LIMIT 1", user.id)?.patient_id;
  if (!pid) return err("This number isn't linked to a patient");
  const t = now();
  try {
    if (b.kind === "voice") {
      const dur = Math.max(1, Math.round(Number(b.durationSec) || 1));
      let transcript = b.transcript?.trim() || null;
      let via: string | null = transcript ? (b.transcriptSource === "browser" ? "live speech recognition" : "typed") : null;
      if (!transcript) {
        transcript = await transcribeAudio(b.base64, b.mime || "audio/webm");
        if (transcript) via = "gemini";
      }
      const docId = addDocument(pid, { title: `Voice note ${fmtDur(dur)} from ${user.name}`, category: "voice", mime: b.mime || "audio/webm", base64: b.base64, notes: transcript ? `Transcript (${via}): ${transcript}` : undefined, source: "whatsapp" }, t, user.id);
      if (transcript) {
        await ingestMessage(user.id, `🎤 ${transcript}`, { at: t });
      } else {
        run("INSERT INTO messages(patient_id, user_id, direction, body, created_at, kind) VALUES(?,?,?,?,?,?)", pid, user.id, "IN", `🎤 Voice note (${fmtDur(dur)})`, t, "voice");
        sendWhatsApp({ userId: user.id, patientId: pid, at: t + 1000, kind: "reply", body: "🎧 Got your voice note. It's saved for your care team to listen to.\nTo log readings automatically, you can also type them, e.g. “BP 140/90”." });
      }
      runScheduler();
      return json({ ok: true, document: docId, transcript, via });
    }
    const name = (b.filename || "Document").slice(0, 100);
    const msgId = run("INSERT INTO messages(patient_id, user_id, direction, body, created_at, kind) VALUES(?,?,?,?,?,?)", pid, user.id, "IN", `📎 ${name}`, t, "document").lastInsertRowid;
    const category = /lab|report|test/i.test(name) ? "lab" : /rx|prescri/i.test(name) ? "prescription" : /discharge/i.test(name) ? "discharge" : "other";
    const docId = addDocument(pid, { title: name, category, mime: b.mime || "application/octet-stream", base64: b.base64, source: "whatsapp", messageId: msgId }, t, user.id);
    sendWhatsApp({ userId: user.id, patientId: pid, at: t + 1000, kind: "reply", body: `📄 Received “${name}”. It's been added to the record for your care team to review.` });
    return json({ ok: true, document: docId });
  } catch (e) {
    return err((e as Error).message, 400);
  }
}
