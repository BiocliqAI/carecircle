import { now } from "@/lib/clock";
import { markReviewed, undoReview } from "@/lib/triage";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// "Mark reviewed" on the triage queue: the patient leaves Needs review until something new happens.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !canView(user!, id)) return err("Care team only", 403);
  const { undo } = (await req.json().catch(() => ({}))) as { undo?: boolean };
  if (undo) undoReview(id, user!.id, now());
  else markReviewed(id, user!.id, now());
  return json({ ok: true });
}
