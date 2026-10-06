import { now } from "@/lib/clock";
import { get, run } from "@/lib/db";
import { getPatient, getUser, ingestMessage, latestVisit, runScheduler } from "@/lib/engine";
import { isGeminiConfigured, lastTranscribeError, readDeviceAI, transcribeAudio } from "@/lib/gemini";
import { deviceText, type DeviceRead } from "@/lib/quality";
import { fixHealthWords } from "@/lib/speechfix";
import { addDocument } from "@/lib/records";
import { FROM_VISIT_BUTTON, outsideVisitDocument } from "@/lib/outside";
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
      // Gemini (when configured) transcribes the audio with medical context and replaces the browser's
      // rough live text. Without Gemini, the browser text gets a health-word correction pass.
      const typed = b.transcript?.trim() || null;
      const meds = latestVisit(pid, t)?.plan.medications.map((m) => m.name) ?? [];
      let transcript: string | null = null;
      let via: string | null = null;
      const fromAi = b.transcriptSource === "typed" && typed ? null : await transcribeAudio(b.base64, b.mime || "audio/webm", { meds, hint: typed });
      if (fromAi) { transcript = fromAi; via = "Gemini"; }
      else if (typed) {
        transcript = b.transcriptSource === "browser" ? fixHealthWords(typed) : typed;
        via = b.transcriptSource === "browser" ? "live speech recognition" : "typed";
      }
      const docId = addDocument(pid, { title: `Voice note ${fmtDur(dur)} from ${user.name}`, category: "voice", mime: b.mime || "audio/webm", base64: b.base64, notes: transcript ? `Transcript (${via}): ${transcript}` : undefined, source: "whatsapp" }, t, user.id);
      if (transcript) {
        await ingestMessage(user.id, `🎤 ${transcript}`, { at: t });
      } else {
        run("INSERT INTO messages(patient_id, user_id, direction, body, created_at, kind) VALUES(?,?,?,?,?,?)", pid, user.id, "IN", `🎤 Voice note (${fmtDur(dur)})`, t, "voice");
        sendWhatsApp({ userId: user.id, patientId: pid, at: t + 1000, kind: "reply", body: "🎧 Got your voice note. It's saved for your care team to listen to.\nTo log readings automatically, you can also type them, e.g. “BP 140/90”." });
      }
      runScheduler();
      return json({ ok: true, document: docId, transcript, via, ...(via === "Gemini" ? {} : { aiError: lastTranscribeError }) });
    }
    const name = (b.filename || "Document").slice(0, 100);
    const msgId = run("INSERT INTO messages(patient_id, user_id, direction, body, created_at, kind) VALUES(?,?,?,?,?,?)", pid, user.id, "IN", `📎 ${name}`, t, "document").lastInsertRowid;
    const category = /lab|report|test/i.test(name) ? "lab" : /rx|prescri/i.test(name) ? "prescription" : /discharge/i.test(name) ? "discharge" : "other";
    const docId = addDocument(pid, { title: name, category, mime: b.mime || "application/octet-stream", base64: b.base64, source: "whatsapp", messageId: msgId }, t, user.id);
    // Mid-conversation about another doctor's visit, the file joins that visit and is read for its details.
    const ov = await outsideVisitDocument(user, getPatient(pid)!, { id: docId, base64: b.base64, mime: b.mime || "application/octet-stream", title: name }, t);
    if (ov.handled) sendWhatsApp({ userId: user.id, patientId: pid, at: t + 1000, kind: "reply", body: ov.reply ?? "📄 Added to the visit.", quick: ov.quick });
    else if (await readDevicePhoto(user.id, pid, docId, b.base64, b.mime || "", t)) { /* replied: asked to confirm the reading */ }
    else sendWhatsApp({ userId: user.id, patientId: pid, at: t + 1000, kind: "reply", body: `📄 Received “${name}”. It's been added to the record for your care team to review.${!isGeminiConfigured() && /^image\//.test(b.mime || "") && category !== "lab" && category !== "prescription" ? "\nIf this shows a reading from your BP machine, glucometer or scale, please also type it, e.g. “BP 138/86”." : ""}${category === "lab" ? "" : "\nIf it's from a visit to another doctor, tap below and I'll note the visit too."}`, quick: category === "lab" ? undefined : [FROM_VISIT_BUTTON] });
    return json({ ok: true, document: docId });
  } catch (e) {
    return err((e as Error).message, 400);
  }
}

/**
 * A photo of a BP monitor, glucometer, scale, oximeter or thermometer: read the display and ask the sender to confirm
 * before it is logged (their "Yes" is processed exactly like typing the reading). Returns true when it replied.
 */
async function readDevicePhoto(userId: string, pid: string, docId: number, base64: string, mime: string, t: number): Promise<boolean> {
  if (!/^image\//.test(mime) || !isGeminiConfigured()) return false;
  const raw = await readDeviceAI(base64, mime).catch(() => null);
  if (!raw || raw.isDevice !== true) return false;
  const read = deviceText(raw as unknown as DeviceRead);
  run("UPDATE patient_documents SET filed_at = ?, title = ? WHERE id = ?", t, `Device photo${read ? `: ${read.label}` : ""}`.slice(0, 120), docId); // nothing for the assistant to file
  if (!read) {
    sendWhatsApp({ userId, patientId: pid, at: t + 1000, kind: "reply", body: "📷 I can see a health device, but I can't read the numbers clearly. Please type them, for example “BP 138/86” or “sugar 110”." });
    return true;
  }
  if (!get("SELECT 1 FROM convo_state WHERE user_id = ?", userId)) run("INSERT INTO convo_state(user_id, state, data) VALUES(?, 'clarify', ?)", userId, JSON.stringify([{ label: "Yes, log it", text: read.text }]));
  sendWhatsApp({ userId, patientId: pid, at: t + 1000, kind: "reply", body: `📷 I read this as: *${read.label}*.\nIs that right?`, quick: ["Yes, log it", "No"] });
  return true;
}
