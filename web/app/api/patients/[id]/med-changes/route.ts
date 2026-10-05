import { now } from "@/lib/clock";
import { addMedChange, getPatient, reviewMedChange } from "@/lib/engine";
import { get } from "@/lib/db";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Medicine changes made by other doctors between visits: logged and reconciled — never auto-applied to reminders.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !getPatient(id) || !canView(user, id)) return err("No access", 403);
  const b = (await req.json().catch(() => ({}))) as Record<string, string | number | undefined>;
  const t = now();
  if (b.action === "review") {
    if (!isClinician(user)) return err("Doctor / PA only", 403);
    const st = String(b.status);
    if (!["CONFIRMED", "REVIEWED", "REJECTED"].includes(st)) return err("Bad status");
    if (!get("SELECT 1 FROM med_changes WHERE id = ? AND patient_id = ?", Number(b.id), id)) return err("Not found", 404);
    reviewMedChange(Number(b.id), st as "CONFIRMED", user.id, t);
    return json({ ok: true });
  }
  const medName = String(b.medName || "").trim();
  if (!medName) return err("Medicine name required");
  const change = ["started", "stopped", "dose_changed", "other"].includes(String(b.change)) ? String(b.change) : "other";
  const at = b.date ? Math.min(t, Date.parse(String(b.date) + "T12:00:00+05:30")) : t;
  const nid = addMedChange(id, Number.isFinite(at) ? at : t, { medName, change, detail: String(b.detail || "").slice(0, 200), prescriber: b.prescriber ? String(b.prescriber) : null }, user.id, null, isClinician(user) ? "clinic" : "dashboard", isClinician(user) ? "CONFIRMED" : "REPORTED");
  return json({ ok: true, id: nid });
}
