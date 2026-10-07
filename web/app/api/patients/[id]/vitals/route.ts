import { get } from "@/lib/db";
import { now } from "@/lib/clock";
import { getPatient, latestVisit } from "@/lib/engine";
import { intervalSummary } from "@/lib/summary";
import { canView, err, json, ready, sessionUser } from "@/lib/server";
import { DAY } from "@/lib/time";

export const dynamic = "force-dynamic";

// Readings for the Vitals & labs charts over a chosen range: ?range=visit | 90 | 365 | all.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !getPatient(id) || !canView(user, id)) return err("No access", 403);
  const t = now();
  const range = new URL(req.url).searchParams.get("range") ?? "90";
  const first = get<{ at: number | null }>("SELECT MIN(observed_at) AS at FROM observations WHERE patient_id = ?", id)?.at ?? t - 30 * DAY;
  const from = range === "visit" ? latestVisit(id, t)?.visit_at ?? t - 90 * DAY
    : range === "all" ? first - DAY
    : t - Math.max(7, Math.min(3650, Number(range) || 90)) * DAY;
  return json({ summary: intervalSummary(id, from, t) });
}
