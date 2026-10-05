import { now } from "@/lib/clock";
import { setCareCircle, type CaregiverInput } from "@/lib/records";
import { canView, err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Replace the care circle (order = escalation order, max 2). Doctor / PA on the care team.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || (user.role !== "DOCTOR" && user.role !== "PA") || !canView(user, id)) return err("Only the care team can change the care circle", 403);
  const body = (await req.json()) as { caregivers?: CaregiverInput[] };
  try {
    return json({ caregivers: setCareCircle(id, body.caregivers ?? [], now(), user.id) });
  } catch (e) {
    return err((e as Error).message, 409);
  }
}
