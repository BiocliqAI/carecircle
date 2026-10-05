import { now } from "@/lib/clock";
import { familyToday } from "@/lib/family";
import { canView, err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !canView(user, id)) return err("No access", 403);
  return json(familyToday(id, user.id, now()));
}
