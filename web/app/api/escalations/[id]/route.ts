import { get } from "@/lib/db";
import { now } from "@/lib/clock";
import { acknowledge, resolveEscalation, timeoutCaregiver } from "@/lib/engine";
import { err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Caregivers can acknowledge / record outcome / simulate timeout from the dashboard as well as from WhatsApp.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || user.role !== "CAREGIVER") return err("Only care-circle members act on alerts", 403);
  const esc = get<{ patient_id: string; state: string }>("SELECT patient_id, state FROM escalations WHERE id = ?", Number(id));
  if (!esc) return err("Not found", 404);
  if (!get("SELECT 1 FROM caregivers WHERE patient_id = ? AND user_id = ?", esc.patient_id, user.id)) return err("Not in this care circle", 403);
  const body = (await req.json()) as { action: "ack" | "resolve" | "miss" | "timeout"; code?: string; note?: string };
  const t = now();
  let e: string | null = null;
  if (body.action === "ack") e = acknowledge(Number(id), user.id, t, "dashboard");
  else if (body.action === "miss" || body.action === "timeout") e = timeoutCaregiver(Number(id), t, "dashboard");
  else if (body.action === "resolve") {
    if (!["1", "2", "3", "4"].includes(body.code || "")) return err("Choose an outcome");
    if (esc.state === "NOTIFIED") acknowledge(Number(id), user.id, t, "dashboard");
    e = resolveEscalation(Number(id), user.id, body.code!, body.note?.trim() || null, t + 1000, "dashboard");
  } else return err("Unknown action");
  return e ? err(e, 409) : json({ ok: true });
}
