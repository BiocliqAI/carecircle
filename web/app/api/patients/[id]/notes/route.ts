import { now } from "@/lib/clock";
import { addNote, editNote, listNotes } from "@/lib/records";
import { canView, err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

async function clinician(id: string) {
  const user = await sessionUser();
  return user && (user.role === "DOCTOR" || user.role === "PA") && canView(user, id) ? user : null;
}

// Notes are for the care team only (patients and caregivers don't see them).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  if (!(await clinician(id))) return err("Care team only", 403);
  return json({ notes: listNotes(id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await clinician(id);
  if (!user) return err("Care team only", 403);
  const body = (await req.json()) as { action: "add" | "edit" | "delete"; id?: number; body?: string };
  const t = now();
  try {
    if (body.action === "add") return json({ id: addNote(id, body.body ?? "", user.role === "DOCTOR" ? "clinical" : "general", t, user.id) });
    if (!body.id) return err("Note id is required");
    editNote(body.id, body.action === "delete" ? null : body.body ?? "", t, user.id);
    return json({ ok: true });
  } catch (e) {
    return err((e as Error).message, 409);
  }
}
