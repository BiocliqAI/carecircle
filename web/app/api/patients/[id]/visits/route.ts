import { now } from "@/lib/clock";
import { createVisit, getPatient } from "@/lib/engine";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";
import type { CarePlan, ClinicVitals } from "@/lib/types";
import { DEFAULT_THRESHOLDS, DEFAULT_TIMERS, VITAL_META } from "@/lib/types";

export const dynamic = "force-dynamic";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validPlan(raw: CarePlan): CarePlan | string {
  const plan: CarePlan = {
    medications: (raw.medications || []).filter((m) => m.name?.trim()).map((m, i) => ({
      key: (m.key || m.name.toLowerCase().replace(/[^a-z]+/g, "_")).slice(0, 30) || `med${i}`,
      name: m.name.trim(),
      dose: (m.dose || "").trim(),
      times: (m.times || []).map((x) => x.trim()).filter(Boolean),
      instructions: m.instructions?.trim() || undefined,
    })),
    monitoring: (raw.monitoring || []).filter((m) => m.key in VITAL_META).map((m) => ({ key: m.key, times: (m.times || []).filter(Boolean), days: m.days && m.days.length && m.days.length < 7 ? m.days : undefined })),
    physio: (raw.physio || []).filter((p) => p.name?.trim()).map((p, i) => ({ key: p.key || `ex${i}_${p.name.toLowerCase().replace(/[^a-z]+/g, "").slice(0, 10)}`, name: p.name.trim(), detail: (p.detail || "").trim(), times: (p.times || []).filter(Boolean) })),
    lifestyle: (raw.lifestyle || []).filter((l) => l.text?.trim()).map((l, i) => ({ key: l.key || `l${i}`, text: l.text.trim() })),
    checkinTime: raw.checkinTime && HHMM.test(raw.checkinTime) ? raw.checkinTime : "21:00",
    watchSymptoms: raw.watchSymptoms || [],
    thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds || {}) },
    escalation: { ...DEFAULT_TIMERS, ...(raw.escalation || {}) },
  };
  // de-duplicate medication keys
  const seen = new Set<string>();
  for (const m of plan.medications) {
    while (seen.has(m.key)) m.key += "_2";
    seen.add(m.key);
  }
  for (const item of [...plan.medications, ...plan.monitoring, ...plan.physio]) {
    if (!item.times.length) return `Add at least one time for ${"name" in item ? item.name : VITAL_META[item.key].label}`;
    const bad = item.times.find((x) => !HHMM.test(x));
    if (bad) return `Invalid time "${bad}" — use HH:MM (24h)`;
  }
  for (const [k, v] of Object.entries(plan.thresholds)) if (!Number.isFinite(Number(v))) return `Invalid threshold ${k}`;
  return plan;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !canView(user!, id)) return err("Only the care team can record visits", 403);
  if (!getPatient(id)) return err("Not found", 404);
  const body = (await req.json()) as { vitals: ClinicVitals; diagnosis: string; notes: string; plan: CarePlan; next_visit_at: number | null };
  const plan = validPlan(body.plan);
  if (typeof plan === "string") return err(plan);
  const vitals: ClinicVitals = {};
  for (const [k, v] of Object.entries(body.vitals || {})) if (v !== null && v !== undefined && String(v) !== "" && Number.isFinite(Number(v))) (vitals as Record<string, number>)[k] = Number(v);
  const doctorId = user!.role === "DOCTOR" ? user!.id : getPatient(id)!.doctor_id;
  const vid = createVisit(id, doctorId, { vitals, diagnosis: body.diagnosis || "", notes: body.notes || "", plan, next_visit_at: body.next_visit_at || null }, now());
  return json({ id: vid });
}
