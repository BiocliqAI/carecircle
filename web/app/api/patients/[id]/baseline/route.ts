import { now } from "@/lib/clock";
import { cleanBaseline, getBaseline, saveBaseline } from "@/lib/clinic";
import { getPatient } from "@/lib/engine";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";
import type { Baseline } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user) return err("Not signed in", 401);
  if (!getPatient(id)) return err("Not found", 404);
  if (!canView(user, id)) return err("You don't have access to this patient", 403);
  return json({ patient: getPatient(id), baseline: getBaseline(id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !canView(user!, id)) return err("Only the care team can edit the baseline", 403);
  const t = now();
  const b = cleanBaseline((await req.json()) as Partial<Baseline>, t);
  if (typeof b === "string") return err(b);
  saveBaseline(id, b, t, user!.id);
  return json({ ok: true });
}
