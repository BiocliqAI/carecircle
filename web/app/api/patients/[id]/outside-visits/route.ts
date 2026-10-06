import { now } from "@/lib/clock";
import { all } from "@/lib/db";
import { getPatient, getUser, latestVisit } from "@/lib/engine";
import { describeMed } from "@/lib/meds";
import { applyMedChanges, deleteOutsideVisit, draftWebVisit, getOutsideVisit, outsideVisits, reviewOutsideVisit, saveWebVisit, type ApplyEdit, type WebVisitInput } from "@/lib/outside";
import { addDocument } from "@/lib/records";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Visits to other doctors. Everyone with access to the patient sees them; the patient, the family and the
// care team can record them; only the doctor / PA can apply their medicine changes to the plan.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !getPatient(id) || !canView(user, id)) return err("No access", 403);
  const careTeam = all<{ name: string; specialty: string | null; hospital: string | null }>("SELECT name, specialty, hospital FROM care_team WHERE patient_id = ? AND role != 'PRIMARY' ORDER BY name", id);
  const plan = latestVisit(id, now())?.plan;
  const p = getPatient(id)!;
  return json({
    visits: outsideVisits(id),
    careTeam,
    primaryDoctor: getUser(p.doctor_id)?.name ?? null,
    planMeds: (plan?.medications ?? []).map((m) => ({ key: m.key, name: m.name, now: describeMed(m), times: m.times })),
    viewer: { id: user.id, role: user.role },
  });
}

type Body = { action?: string; id?: number; text?: string; files?: { base64: string; mime: string; filename?: string }[]; visit?: WebVisitInput; edits?: ApplyEdit[] };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !getPatient(id) || !canView(user, id)) return err("No access", 403);
  const b = (await req.json().catch(() => ({}))) as Body;
  const t = now();
  const mine = (vid: number | undefined) => {
    const v = vid ? getOutsideVisit(Number(vid)) : undefined;
    if (!v || v.patient_id !== id) throw new Error("Visit not found");
    return v;
  };
  try {
    switch (b.action) {
      case "draft":
        if (!b.text?.trim() && !b.files?.length) return err("Write what happened or add a photo of the prescription");
        return json(await draftWebVisit(id, user, (b.text ?? "").slice(0, 3000), (b.files ?? []).slice(0, 4), t));
      case "save":
        return json({ ok: true, id: saveWebVisit(id, user, { ...b.visit, files: (b.files ?? []).slice(0, 6) }, t, b.id ? mine(b.id).id : undefined) });
      case "addFiles": {
        const v = mine(b.id);
        for (const f of (b.files ?? []).slice(0, 6)) {
          const doc = addDocument(id, { title: (f.filename || "Prescription").slice(0, 100), category: "prescription", mime: f.mime, base64: f.base64, source: "whatsapp" }, t, user.id);
          (await import("@/lib/db")).run("UPDATE patient_documents SET outside_visit_id = ? WHERE id = ?", v.id, doc);
        }
        return json({ ok: true });
      }
      case "delete": {
        const v = mine(b.id);
        if (!isClinician(user) && v.reported_by !== user.id) return err("Only the person who added it or the clinic can delete it", 403);
        deleteOutsideVisit(v.id, user.id, t);
        return json({ ok: true });
      }
      case "review":
        if (!isClinician(user)) return err("Doctor / PA only", 403);
        reviewOutsideVisit(mine(b.id).id, user.id, t);
        return json({ ok: true });
      case "apply":
        if (!isClinician(user)) return err("Doctor / PA only", 403);
        if (!b.edits?.length) return err("Choose the changes to apply");
        return json({ ok: true, applied: applyMedChanges(id, b.edits, user.id, t) });
      default:
        return err("Unknown action");
    }
  } catch (e) {
    return err((e as Error).message, 400);
  }
}
