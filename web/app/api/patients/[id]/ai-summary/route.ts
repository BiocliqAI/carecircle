import { generateClinicalSummary } from "@/lib/gemini";
import { getPatient, latestVisit } from "@/lib/engine";
import { freshBrief, saveBrief } from "@/lib/briefs";
import { now } from "@/lib/clock";
import { canView, err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !getPatient(id) || !canView(user, id)) return err("No access", 403);

  try {
    // Prepared automatically before the visit? Show that, with when it was prepared.
    const auto = freshBrief(id, now());
    if (auto) return json({ ok: true, summary: auto.summary, auto: true, preparedAt: auto.at });
    if (new URL(req.url).searchParams.get("stored") === "1") return json({ ok: true, summary: null }); // preview only: never start a generation
    const summary = await generateClinicalSummary(id);
    return json({ ok: true, summary });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !getPatient(id) || !canView(user, id)) return err("No access", 403);

  try {
    const summary = await generateClinicalSummary(id);
    const next = latestVisit(id, now())?.next_visit_at;
    if (next) saveBrief(id, next, summary); // a refresh replaces the prepared brief
    return json({ ok: true, summary });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}
