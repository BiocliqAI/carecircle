import { analyzeDocumentOCR } from "@/lib/gemini";
import { addLab, addMedChange, getPatient, runScheduler } from "@/lib/engine";
import { get, run } from "@/lib/db";
import { now } from "@/lib/clock";
import { canView, err, json, ready, sessionUser } from "@/lib/server";

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

  const base64 = body.imageBase64 || `SAMPLE_${body.sampleId || "DEFAULT"}`;
  const mimeType = body.mimeType || "image/png";

  try {
    const ocrResult = await analyzeDocumentOCR({
      imageBase64: base64,
      mimeType,
      patientId,
    });

    const committed = { labs: 0, observations: 0, medChanges: 0 };

    if (body.commit && patientId) {
      const user = await sessionUser();
      const p = getPatient(patientId);
      if (p && (!user || canView(user, patientId))) {
        const t = now();

        // 1. Commit Labs
        for (const l of ocrResult.extracted.labs) {
          addLab(p.id, l.marker, l.value, t, "ocr", user?.id || null, null);
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
