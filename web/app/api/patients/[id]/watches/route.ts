import { now } from "@/lib/clock";
import { getPatient } from "@/lib/engine";
import { dismissWatch, setWatchOff } from "@/lib/watch";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";
import { get } from "@/lib/db";

export const dynamic = "force-dynamic";

// Pattern watches (slow drifts under the limits). The care team can dismiss one or turn a pattern off for a patient.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !getPatient(id) || !canView(user, id)) return err("No access", 403);
  if (!isClinician(user)) return err("Doctor / PA only", 403);
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: number; key?: string };
  const t = now();
  try {
    if (b.action === "dismiss") {
      if (!get("SELECT 1 FROM watches WHERE id = ? AND patient_id = ?", Number(b.id), id)) return err("Not found", 404);
      dismissWatch(Number(b.id), user.id, t);
    } else if (b.action === "off" || b.action === "on") setWatchOff(id, String(b.key), b.action === "off", user.id, t);
    else return err("Unknown action");
    return json({ ok: true });
  } catch (e) {
    return err((e as Error).message, 400);
  }
}
