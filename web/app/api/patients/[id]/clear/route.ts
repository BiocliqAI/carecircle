import { now } from "@/lib/clock";
import { clearRecords, countRecords, isPart, RECORD_PARTS } from "@/lib/clear";
import { getPatient } from "@/lib/engine";
import { err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Clear chosen kinds of records, keeping the patient. Same people as deleting a patient: their doctor or the clinic admin.
async function guard(id: string) {
  const user = await sessionUser();
  const p = getPatient(id);
  if (!p) return { error: err("Not found", 404) };
  if (!user || !(user.role === "ADMIN" || (user.role === "DOCTOR" && p.doctor_id === user.id))) return { error: err("Only the patient's doctor or the clinic admin can clear records", 403) };
  return { user, p };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const g = await guard(id);
  if ("error" in g) return g.error;
  return json({ parts: RECORD_PARTS, counts: countRecords(id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const g = await guard(id);
  if ("error" in g) return g.error;
  const b = (await req.json().catch(() => ({}))) as { parts?: unknown[]; confirmName?: string };
  if ((b.confirmName ?? "").trim().toLowerCase() !== g.p.name.trim().toLowerCase()) return err(`Type the patient's name (${g.p.name}) to confirm`, 400);
  try {
    return json({ ok: true, removed: clearRecords(id, (b.parts ?? []).filter(isPart), now(), g.user.id) });
  } catch (e) {
    return err((e as Error).message, 400);
  }
}
