import { now } from "@/lib/clock";
import { getPatient, startCarePlan } from "@/lib/engine";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// "Start care plan": after visits were entered from past records, reminders and check-ins from the latest visit's
// plan start now and the plan is sent on WhatsApp. The days between that visit and now are left without data.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !getPatient(id) || !canView(user!, id)) return err("Only the care team can start the care plan", 403);
  const b = (await req.json().catch(() => ({}))) as { action?: string };
  if (b.action !== "start") return err("Unknown action");
  try {
    return json({ ok: true, ...startCarePlan(id, now(), user!.id) });
  } catch (e) {
    return err((e as Error).message);
  }
}
