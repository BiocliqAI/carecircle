import { generateClinicalSummary } from "@/lib/gemini";
import { getPatient } from "@/lib/engine";
import { canView, err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !getPatient(id) || !canView(user, id)) return err("No access", 403);

  try {
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
    return json({ ok: true, summary });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}
