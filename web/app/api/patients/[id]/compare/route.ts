import { now } from "@/lib/clock";
import { getPatient, getVisit, getVisits } from "@/lib/engine";
import { intervalSummary, visitDiff } from "@/lib/summary";
import { canView, err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Visit-to-visit comparison: what changed in the plan + what happened in between.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user) return err("Not signed in", 401);
  if (!getPatient(id) || !canView(user, id)) return err("No access", 403);
  const visits = getVisits(id);
  if (!visits.length) return err("No visits yet", 404);
  const url = new URL(req.url);
  const aId = url.searchParams.get("a");
  const bId = url.searchParams.get("b");
  const b = bId && bId !== "now" ? getVisit(bId) : bId === "now" ? null : visits.length > 1 ? visits[visits.length - 1] : null;
  const a = aId ? getVisit(aId) : b ? visits[Math.max(0, visits.indexOf(visits.find((v) => v.id === b.id)!) - 1)] : visits[visits.length - 1];
  if (!a || a.patient_id !== id || (b && b.patient_id !== id)) return err("Visit not found", 404);
  const to = b ? b.visit_at : now();
  return json({
    patient: getPatient(id),
    visits: visits.map((v) => ({ id: v.id, visit_at: v.visit_at, diagnosis: v.diagnosis })),
    a,
    b,
    to,
    diff: b ? visitDiff(a, b) : null,
    interval: intervalSummary(id, a.visit_at, to),
  });
}
