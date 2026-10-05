// "Today in the care circles": what families and patients did, for the doctor's Today screen.
import { all } from "./db";
import { getUser } from "./engine";
import { DAY } from "./time";
import { shortName } from "./types";

export interface ActivityItem { at: number; kind: "raised" | "ack" | "closed" | "passed" | "unanswered" | "consent" | "document"; patientId: string; patient: string; text: string }

export function careActivity(patientIds: string[], t: number, limit = 8): ActivityItem[] {
  if (!patientIds.length) return [];
  const ph = patientIds.map(() => "?").join(",");
  const since = t - DAY;
  const out: ActivityItem[] = [];
  const ev = all<{ at: number; event: string; actor: string | null; note: string | null; title: string; type: string; patient_id: string; name: string }>(
    `SELECT ev.at, ev.event, ev.actor, ev.note, e.title, e.type, e.patient_id, p.name FROM escalation_events ev
       JOIN escalations e ON e.id = ev.escalation_id JOIN patients p ON p.id = e.patient_id
     WHERE e.patient_id IN (${ph}) AND ev.at > ? AND ev.event IN ('CREATED','ACKNOWLEDGED','RESOLVED','TIMEOUT','EXHAUSTED') ORDER BY ev.at DESC LIMIT 40`,
    ...patientIds, since,
  );
  for (const e of ev) {
    const who = e.actor && e.actor !== "system" ? shortName(e.actor) : null;
    const base = { at: e.at, patientId: e.patient_id, patient: e.name };
    if (e.event === "CREATED") out.push({ ...base, kind: "raised", text: `${e.type === "URGENT" ? "Urgent alert" : e.type === "DEVIATION" ? "Alert" : "Missed task"}: ${e.title}` });
    else if (e.event === "ACKNOWLEDGED") out.push({ ...base, kind: "ack", text: `${who ?? "A caregiver"} is handling “${e.title}”` });
    else if (e.event === "RESOLVED") out.push({ ...base, kind: "closed", text: `${who ?? "Family"} closed “${e.title}”${e.note ? `: ${e.note.replace(/^[^—]*—\s*/, "").slice(0, 80)}` : ""}` });
    else if (e.event === "TIMEOUT") out.push({ ...base, kind: "passed", text: `“${e.title}” moved to the backup caregiver` });
    else out.push({ ...base, kind: "unanswered", text: `No one in the care circle answered “${e.title}”` });
  }
  const cons = all<{ responded_at: number; status: string; user_id: string; patient_id: string; name: string }>(
    `SELECT c.responded_at, c.status, c.user_id, c.patient_id, p.name FROM consents c JOIN patients p ON p.id = c.patient_id WHERE c.patient_id IN (${ph}) AND c.responded_at > ? ORDER BY c.responded_at DESC LIMIT 10`,
    ...patientIds, since,
  );
  for (const c of cons) out.push({ at: c.responded_at, kind: "consent", patientId: c.patient_id, patient: c.name, text: `${shortName(getUser(c.user_id)?.name ?? "Someone")} ${c.status === "GIVEN" ? "consented on WhatsApp" : "declined consent"}` });
  const docs = all<{ uploaded_at: number; title: string; patient_id: string; name: string; uploaded_by: string | null }>(
    `SELECT d.uploaded_at, d.title, d.patient_id, p.name, d.uploaded_by FROM patient_documents d JOIN patients p ON p.id = d.patient_id WHERE d.patient_id IN (${ph}) AND d.source = 'whatsapp' AND d.uploaded_at > ? ORDER BY d.uploaded_at DESC LIMIT 10`,
    ...patientIds, since,
  );
  for (const d of docs) out.push({ at: d.uploaded_at, kind: "document", patientId: d.patient_id, patient: d.name, text: `${d.title.startsWith("Voice note") ? "Voice note" : "Report"} sent on WhatsApp${d.uploaded_by ? ` by ${shortName(getUser(d.uploaded_by)?.name ?? "")}` : ""}` });
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
