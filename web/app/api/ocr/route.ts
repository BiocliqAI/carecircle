import { analyzeDocumentOCR } from "@/lib/gemini";
import { addLab, addMedChange, getPatient, runScheduler } from "@/lib/engine";
import { get, run } from "@/lib/db";
import { now } from "@/lib/clock";
import { keepChartedDocument, reportTime } from "@/lib/docauto";
import { LIVE } from "@/lib/mode";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  await ready();
  const body = (await req.json().catch(() => ({}))) as {
    imageBase64?: string;
    mimeType?: string;
    patientId?: string;
    userId?: string;
    commit?: boolean;
    sampleId?: string;
  };

  if (!body.imageBase64 && !body.sampleId) {
    return err("imageBase64 or sampleId required");
  }

  let patientId = body.patientId;
  if (!patientId && body.userId) {
    const pt = get<{ id: string }>("SELECT id FROM patients WHERE user_id = ?", body.userId);
    if (pt) {
      patientId = pt.id;
    } else {
      const cg = get<{ patient_id: string }>("SELECT patient_id FROM caregivers WHERE user_id = ? ORDER BY level LIMIT 1", body.userId);
      if (cg) patientId = cg.patient_id;
    }
  }

  // Who is asking. The live clinic only lets the care team read documents into a record. The demo's WhatsApp
  // simulator sends its sample documents without a clinic login, so the demo keeps allowing that.
  const user = await sessionUser();
  if (patientId && user && !canView(user, patientId)) return err("No access to this patient", 403);
  if (LIVE && (!isClinician(user) || !patientId)) return err("Only the care team can read documents into a record", 403);

  const sample = !body.imageBase64; // one of the demo's built-in sample documents
  const base64 = body.imageBase64 || `SAMPLE_${body.sampleId || "DEFAULT"}`;
  const mimeType = body.mimeType || "image/png";

  try {
    const ocrResult = await analyzeDocumentOCR({
      imageBase64: base64,
      mimeType,
      patientId,
    });
    // A failed AI read falls back to the demo reader, whose values are made up. Never show or chart them for a real file.
    if (!sample && /sample|simulator/i.test(ocrResult.source)) {
      return err("Couldn't read this document: the AI reader is unavailable (check the Gemini key in Settings). Nothing was charted.", 422);
    }

    const committed = { labs: 0, observations: 0, medChanges: 0, documentId: null as number | null };

    if (body.commit && patientId) {
      const p = getPatient(patientId);
      if (p) {
        const t = now();
        const labsAt = reportTime(ocrResult.documentDate, t); // the day the report was taken, not the day it was uploaded

        // Keep the file itself in the patient's documents, filed by the person who reviewed and charted it.
        if (!sample && user && isClinician(user)) committed.documentId = keepChartedDocument(p.id, user.id, ocrResult, mimeType, body.imageBase64!, t);

        // 1. Commit Labs
        for (const l of ocrResult.extracted.labs) {
          addLab(p.id, l.marker, l.value, labsAt, "ocr", user?.id || null, null);
          committed.labs++;
        }

        // 2. Commit Vitals
        for (const v of ocrResult.extracted.vitals) {
          run(
            "INSERT INTO observations(patient_id, type, v1, v2, observed_at, logged_by, parser, flag) VALUES(?,?,?,?,?,?,?,?)",
            p.id,
            v.type,
            v.v1,
            v.v2 ?? null,
            t,
            user?.id || p.user_id,
            "gemini_vision_ocr",
            null
          );
          committed.observations++;
        }

        // 3. Commit Prescriptions / Med Changes
        for (const m of ocrResult.extracted.medications) {
          addMedChange(
            p.id,
            t,
            {
              medName: m.name,
              change: m.change || "started",
              detail: `${m.dose} ${m.instructions || ""}`.trim(),
              prescriber: m.prescriber || ocrResult.prescriber || null,
            },
            user?.id || p.user_id,
            null,
            "ocr",
            "REPORTED"
          );
          committed.medChanges++;
        }

        // 4. If triggered from WhatsApp, insert messages to simulator chat
        if (body.userId) {
          run(
            "INSERT INTO messages(user_id, direction, body, quick, created_at, kind, parser) VALUES(?,?,?,?,?,?,?)",
            body.userId,
            "IN",
            `📷 [Document Attached] ${ocrResult.documentTypeName}`,
            null,
            t,
            "user",
            ocrResult.source
          );

          const replyLines = [
            `✅ *Document Received & Analyzed (Gemini Vision OCR)*`,
            ``,
            `*Type:* ${ocrResult.documentTypeName}`,
          ];
          if (ocrResult.prescriber) replyLines.push(`*Prescriber:* ${ocrResult.prescriber}`);
          if (ocrResult.extracted.labs.length) {
            replyLines.push(`*Labs Charted:* ${ocrResult.extracted.labs.map((l) => `${l.label} ${l.value} ${l.unit}`).join(", ")}`);
          }
          if (ocrResult.extracted.vitals.length) {
            replyLines.push(`*Vitals Charted:* ${ocrResult.extracted.vitals.map((v) => `${v.label} ${v.v1}${v.v2 ? `/${v.v2}` : ""} ${v.unit}`).join(", ")}`);
          }
          if (ocrResult.extracted.medications.length) {
            replyLines.push(`*Medication Charted:* ${ocrResult.extracted.medications.map((m) => `${m.name} ${m.dose} (${m.change || "started"})`).join(", ")}`);
          }
          replyLines.push(``, `All clinical information has been charted to your electronic medical record.`);

          run(
            "INSERT INTO messages(user_id, direction, body, quick, created_at, kind, parser) VALUES(?,?,?,?,?,?,?)",
            body.userId,
            "OUT",
            replyLines.join("\n"),
            null,
            t + 500,
            "bot",
            ocrResult.source
          );

          runScheduler();
        }
      }
    }

    return json({ ok: true, ocr: ocrResult, committed });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}
