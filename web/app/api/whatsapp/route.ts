import { all } from "@/lib/db";
import { now } from "@/lib/clock";
import { getUser, ingestMessage, runScheduler } from "@/lib/engine";
import { err, json, ready } from "@/lib/server";

export const dynamic = "force-dynamic";

// WhatsApp simulator endpoints (presenter tool). In production this is replaced by the provider
// webhook (inbound) and provider API (outbound) behind lib/whatsapp.ts.
export async function GET(req: Request) {
  await ready();
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  if (!userId) {
    const contacts = all<{
      id: string;
      name: string;
      role: string;
      title: string;
      phone: string;
      last_at: number | null;
      last_body: string | null;
      n: number;
      peer_user_id: string | null;
      peer2_user_id: string | null;
      caregiver_level: number | null;
    }>(
      `SELECT u.id, u.name, u.role, u.title, u.phone,
         (SELECT MAX(created_at) FROM messages m WHERE m.user_id = u.id) AS last_at,
         (SELECT body FROM messages m WHERE m.user_id = u.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS n,
         CASE WHEN u.role = 'PATIENT' THEN (SELECT c.user_id FROM caregivers c JOIN patients p ON p.id = c.patient_id WHERE p.user_id = u.id ORDER BY c.level LIMIT 1)
              WHEN u.role = 'CAREGIVER' THEN (SELECT p.user_id FROM patients p JOIN caregivers c ON c.patient_id = p.id WHERE c.user_id = u.id LIMIT 1)
         END AS peer_user_id,
         CASE WHEN u.role = 'PATIENT' THEN (SELECT c.user_id FROM caregivers c JOIN patients p ON p.id = c.patient_id WHERE p.user_id = u.id AND c.level = 2 LIMIT 1)
              WHEN u.role = 'CAREGIVER' THEN (
                SELECT c2.user_id FROM caregivers c1
                JOIN caregivers c2 ON c2.patient_id = c1.patient_id AND c2.level = CASE WHEN c1.level = 1 THEN 2 ELSE 1 END
                WHERE c1.user_id = u.id LIMIT 1
              )
         END AS peer2_user_id,
         CASE WHEN u.role = 'CAREGIVER' THEN (SELECT c.level FROM caregivers c WHERE c.user_id = u.id LIMIT 1)
              ELSE NULL
         END AS caregiver_level
       FROM users u WHERE u.role IN ('PATIENT','CAREGIVER') ORDER BY u.name`,
    );
    return json({ now: now(), contacts });
  }
  const user = getUser(userId);
  if (!user) return err("Unknown user", 404);
  const limit = Number(url.searchParams.get("limit") || 120);
  const msgs = all<{ id: number; direction: string; body: string; quick: string | null; created_at: number; kind: string; parser: string | null }>(
    "SELECT id, direction, body, quick, created_at, kind, parser FROM messages WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    userId, limit,
  ).reverse();
  return json({ now: now(), user, messages: msgs.map((m) => ({ ...m, quick: m.quick ? JSON.parse(m.quick) : null })) });
}

export async function POST(req: Request) {
  await ready();
  const { userId, body } = (await req.json()) as { userId?: string; body?: string };
  if (!userId || !body?.trim()) return err("userId and body required");
  if (!getUser(userId)) return err("Unknown user", 404);
  await ingestMessage(userId, body.trim().slice(0, 1000));
  runScheduler();
  return json({ ok: true });
}
