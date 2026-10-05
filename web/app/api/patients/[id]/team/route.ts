import { now } from "@/lib/clock";
import { audit, get, run } from "@/lib/db";
import { getPatient } from "@/lib/engine";
import { canView, err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Care team = all doctors involved (primary + consulting). Tracking only — they are not logins and get no messages.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !getPatient(id) || !canView(user, id)) return err("No access", 403);
  const b = (await req.json().catch(() => ({}))) as Record<string, string | number | undefined>;
  const t = now();
  const s = (k: string) => (b[k] == null || b[k] === "" ? null : String(b[k]).slice(0, 120));
  if (b.action === "delete") {
    const row = get<{ role: string }>("SELECT role FROM care_team WHERE id = ? AND patient_id = ?", Number(b.id), id);
    if (!row) return err("Not found", 404);
    if (row.role === "PRIMARY") return err("The primary doctor can't be removed here");
    run("DELETE FROM care_team WHERE id = ?", Number(b.id));
    audit(t, user.id, "CARE_TEAM_REMOVED", "patient", id, { id: b.id });
    return json({ ok: true });
  }
  if (!s("name")) return err("Name required");
  if (b.action === "update") {
    if (!get("SELECT 1 FROM care_team WHERE id = ? AND patient_id = ?", Number(b.id), id)) return err("Not found", 404);
    run("UPDATE care_team SET name = ?, specialty = ?, hospital = ?, phone = ?, notes = ? WHERE id = ?", s("name"), s("specialty"), s("hospital"), s("phone"), s("notes"), Number(b.id));
    audit(t, user.id, "CARE_TEAM_UPDATED", "patient", id, { id: b.id });
    return json({ ok: true });
  }
  const normName = s("name")!.trim();
  const existing = get<{ id: number }>("SELECT id FROM care_team WHERE patient_id = ? AND LOWER(TRIM(name)) = LOWER(?)", id, normName);
  if (existing) {
    run("UPDATE care_team SET name = ?, specialty = ?, hospital = ?, phone = ?, notes = ? WHERE id = ?", normName, s("specialty"), s("hospital"), s("phone"), s("notes"), existing.id);
    audit(t, user.id, "CARE_TEAM_UPDATED", "patient", id, { id: existing.id });
    return json({ ok: true, id: existing.id });
  }
  const r = run("INSERT INTO care_team(patient_id, name, specialty, hospital, phone, role, notes) VALUES(?,?,?,?,?,'CONSULTING',?)", id, normName, s("specialty"), s("hospital"), s("phone"), s("notes"));
  audit(t, user.id, "CARE_TEAM_ADDED", "patient", id, { name: normName });
  return json({ ok: true, id: r.lastInsertRowid });
}
