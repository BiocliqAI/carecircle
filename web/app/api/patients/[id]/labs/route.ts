import { now } from "@/lib/clock";
import { audit, get, run } from "@/lib/db";
import { enterLabs, getPatient } from "@/lib/engine";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";
import { LAB_META } from "@/lib/types";
import { atLocal, dayStart } from "@/lib/time";

export const dynamic = "force-dynamic";

// Lab entry by the clinic (doctor / PA). Same deterministic rules as WhatsApp; alerts go to the care circle only.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !getPatient(id) || !canView(user!, id)) return err("Care team only", 403);
  const body = (await req.json().catch(() => ({}))) as { action?: string; kind?: string; labId?: number; date?: string; values?: Record<string, unknown> };
  // One wrong value: removed from the lab history (logged).
  if (body.action === "delete") {
    const table = body.kind === "text" ? "lab_texts" : "labs";
    const row = get<{ id: number }>(`SELECT id FROM ${table} WHERE id = ? AND patient_id = ?`, Number(body.labId), id);
    if (!row) return err("Lab value not found", 404);
    run(`DELETE FROM ${table} WHERE id = ?`, row.id);
    audit(now(), user!.id, "LAB_VALUE_DELETED", "patient", id, { table, id: row.id });
    return json({ ok: true });
  }
  const t = now();
  let takenAt = t;
  if (body.date) {
    const d = Date.parse(body.date + "T12:00:00+05:30");
    if (!Number.isFinite(d)) return err("Bad date");
    takenAt = Math.min(t, atLocal(dayStart(d), "09:00"));
  }
  const values = Object.entries(body.values || {})
    .map(([marker, v]) => ({ marker, value: Number(v) }))
    .filter((x) => x.marker in LAB_META && Number.isFinite(x.value) && x.value > 0);
  if (!values.length) return err("Enter at least one value");
  return json({ ok: true, results: enterLabs(id, values, takenAt, user!.id, t) });
}
