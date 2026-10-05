import { now } from "@/lib/clock";
import { get } from "@/lib/db";
import { getPrep, savePrep, type Prep } from "@/lib/prep";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !canView(user!, id)) return err("Care team only", 403);
  return json({ prep: getPrep(id) });
}

// Assistant (or doctor) updates the visit preparation. `flagMedChange` adds a reported medicine
// change to the doctor's flags; `ready: true|false` marks it ready for the doctor.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !canView(user!, id)) return err("Care team only", 403);
  const body = (await req.json()) as Partial<Prep> & { flagMedChange?: number; ready?: boolean };
  const t = now();
  const patch: Partial<Prep> = {};
  for (const k of ["attendance", "attendanceNote", "vitals", "docsChecked", "flags", "questions"] as const) if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
  if (body.flagMedChange) {
    const m = get<{ id: number; med_name: string; change: string; detail: string | null; prescriber: string | null }>("SELECT id, med_name, change, detail, prescriber FROM med_changes WHERE id = ? AND patient_id = ?", body.flagMedChange, id);
    if (!m) return err("Medicine change not found", 404);
    const cur = getPrep(id);
    if (!cur.flags.some((f) => f.medChangeId === m.id))
      patch.flags = [...cur.flags, { id: `med${m.id}`, medChangeId: m.id, text: `${m.med_name}: ${m.change.replace("_", " ")}${m.detail ? ` (${m.detail})` : ""}${m.prescriber ? `, by ${m.prescriber}` : ""}. Reported, not yet confirmed.` }];
  }
  if (body.ready !== undefined) patch.readyAt = body.ready ? t : null;
  return json({ prep: savePrep(id, patch, t, user!.id) });
}
