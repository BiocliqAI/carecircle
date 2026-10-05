import { now } from "@/lib/clock";
import { cleanBaseline, deleteDraft, saveBaseline } from "@/lib/clinic";
import { getUser, onboardPatient, type OnboardInput } from "@/lib/engine";
import { get } from "@/lib/db";
import { err, isClinician, json, ready, sessionUser } from "@/lib/server";
import { MAX_CAREGIVERS, ageFromDob, type Baseline } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  await ready();
  const user = await sessionUser();
  if (!isClinician(user)) return err("Doctor / PA only", 403);
  const body = (await req.json()) as Partial<OnboardInput> & { baseline?: Partial<Baseline>; draftId?: string };
  if (!body.name?.trim()) return err("Name is required");
  if (!body.phone || !/^\+?[\d\s-]{8,}$/.test(body.phone)) return err("A valid WhatsApp number is required");
  const cgs = (body.caregivers || []).filter((c) => c.name?.trim() && c.phone?.trim());
  if (!cgs.length) return err("Add at least one caregiver (Level 1) for the care circle");
  if (cgs.length > MAX_CAREGIVERS) return err(`A care circle has at most ${MAX_CAREGIVERS} caregivers (primary and backup)`);
  if (cgs.some((c) => c.phone.replace(/\D/g, "") === body.phone!.replace(/\D/g, ""))) return err("A caregiver can't use the patient's own WhatsApp number");
  const t = now();
  const baseline = body.baseline ? cleanBaseline(body.baseline, t) : null;
  if (typeof baseline === "string") return err(baseline);

  // Doctors onboard their own patients; a PA picks the treating doctor.
  const doctorId = user!.role === "DOCTOR" ? user!.id : body.doctorId || get<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR' ORDER BY name")?.id;
  if (!doctorId || getUser(doctorId)?.role !== "DOCTOR") return err("Choose the treating doctor");
  try {
    const id = onboardPatient(
      {
        name: body.name.trim(),
        age: body.age ? Number(body.age) : ageFromDob(baseline?.dob, t),
        sex: body.sex || "",
        phone: body.phone.trim(),
        conditions: body.conditions || baseline?.conditions.join(", ") || "",
        address: body.address || "",
        doctorId,
        caregivers: cgs.map((c, i) => ({ name: c.name.trim(), relation: c.relation || "Family", phone: c.phone.trim(), level: i + 1, dashboard: c.dashboard !== false })),
      },
      t,
      user!.id,
    );
    if (baseline) saveBaseline(id, baseline, t, user!.id);
    if (body.draftId) deleteDraft(body.draftId);
    return json({ id });
  } catch (e) {
    return err((e as Error).message, 409);
  }
}
