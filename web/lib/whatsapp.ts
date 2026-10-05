// WhatsApp gateway adapter. The MVP ships a built-in simulator: outbound messages are stored
// and rendered in the /whatsapp phone simulator. A Twilio / Meta Cloud API adapter can be added
// here later without touching the engine (send -> provider API, inbound webhook -> ingestMessage).
import { run } from "./db";

export interface OutboundMessage {
  userId: string; // recipient (patient or caregiver user)
  patientId: string | null;
  body: string;
  quick?: string[]; // quick-reply buttons (WhatsApp interactive replies)
  kind?: string; // prompt | reminder | reply | escalation | info
  at: number;
}

export function sendWhatsApp(m: OutboundMessage): number {
  const r = run(
    "INSERT INTO messages(patient_id, user_id, direction, body, quick, created_at, kind) VALUES(?,?,?,?,?,?,?)",
    m.patientId,
    m.userId,
    "OUT",
    m.body,
    m.quick && m.quick.length ? JSON.stringify(m.quick) : null,
    m.at,
    m.kind || "info",
  );
  return r.lastInsertRowid;
}
