import { all } from "@/lib/db";
import { now } from "@/lib/clock";
import { dayFluid, getConsents, getCaregivers, getPatient, getUser, getVisits, latestVisit, type EscalationRow } from "@/lib/engine";
import { outsideVisits } from "@/lib/outside";
import { WATCH_KEYS, openWatches, watchOffList } from "@/lib/watch";
import { intervalSummary, longRange, medChanges, type EscalationView } from "@/lib/summary";
import { canView, err, json, ready, sessionUser } from "@/lib/server";
import { getBaseline } from "@/lib/clinic";
import { getPrep } from "@/lib/prep";
import { deletePatient, listDocuments, listNotes, updatePatient, type PatientEdit } from "@/lib/records";
import { DAY } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user) return err("Not signed in", 401);
  if (!getPatient(id)) return err("Not found", 404);
  if (!canView(user, id)) return err("You don't have access to this patient", 403);
  const t = now();
  const p = getPatient(id)!;
  const visits = getVisits(id);
  const current = latestVisit(id, t);
  const summary = current ? intervalSummary(id, current.visit_at, t) : null;
  const caregivers = getCaregivers(id);
  const open: EscalationView[] = all<EscalationRow>("SELECT * FROM escalations WHERE patient_id = ? AND state IN ('NOTIFIED','ACKNOWLEDGED') ORDER BY started_at DESC", id).map((e) => ({
    ...e,
    ack_by_name: e.ack_by ? getUser(e.ack_by)?.name ?? null : null,
    resolved_by_name: null,
    events: all("SELECT at, event, level, actor, note FROM escalation_events WHERE escalation_id = ? ORDER BY at, id", e.id) as EscalationView["events"],
  }));

  // Timeline with provenance: every log shows the raw WhatsApp text + what was extracted from it.
  const since = t - 60 * DAY;
  const logs = all<{ id: number; user_id: string; body: string; created_at: number; parsed: string | null; parser: string | null; name: string; role: string }>(
    "SELECT m.id, m.user_id, m.body, m.created_at, m.parsed, m.parser, u.name, u.role FROM messages m JOIN users u ON u.id = m.user_id WHERE m.patient_id = ? AND m.direction = 'IN' AND m.created_at > ? ORDER BY m.created_at DESC LIMIT 400",
    id, since,
  );
  const obsByMsg = new Map<number, { type: string; v1: number | null; v2: number | null; text: string | null; flag: string | null; severity: string | null }[]>();
  for (const o of all<{ message_id: number; type: string; v1: number | null; v2: number | null; text: string | null; flag: string | null; severity: string | null }>(
    "SELECT message_id, type, v1, v2, text, flag, severity FROM observations WHERE patient_id = ? AND observed_at > ?", id, since,
  )) obsByMsg.set(o.message_id, [...(obsByMsg.get(o.message_id) || []), o]);
  const tasksByMsg = new Map<number, { label: string; status: string; late: number }[]>();
  for (const tk of all<{ message_id: number; label: string; status: string; late: number }>("SELECT message_id, label, status, late FROM tasks WHERE patient_id = ? AND message_id IS NOT NULL AND due_at > ?", id, since))
    tasksByMsg.set(tk.message_id, [...(tasksByMsg.get(tk.message_id) || []), tk]);
  const escEvents = all<{ escalation_id: number; at: number; event: string; level: number | null; actor: string | null; note: string | null; title: string; type: string }>(
    "SELECT ev.*, e.title, e.type FROM escalation_events ev JOIN escalations e ON e.id = ev.escalation_id WHERE e.patient_id = ? AND ev.at > ? AND ev.event IN ('CREATED','NOTIFIED','TIMEOUT','ACKNOWLEDGED','RESOLVED','EXHAUSTED') ORDER BY ev.at DESC",
    id, since,
  );
  const missed = all<{ label: string; due_at: number; kind: string }>("SELECT label, due_at, kind FROM tasks WHERE patient_id = ? AND status = 'MISSED' AND kind != 'lab' AND due_at > ? ORDER BY due_at DESC", id, since);
  const labsByMsg = new Map<number, { marker: string; value: number; flag: string | null }[]>();
  const clinicLabs = new Map<number, { marker: string; value: number; flag: string | null; by: string | null }[]>();
  for (const l of all<{ message_id: number | null; marker: string; value: number; flag: string | null; taken_at: number; source: string; by: string | null }>(
    "SELECT l.message_id, l.marker, l.value, l.flag, l.taken_at, l.source, u.name AS by FROM labs l LEFT JOIN users u ON u.id = l.entered_by WHERE l.patient_id = ? AND l.taken_at > ?", id, since,
  )) {
    if (l.message_id) labsByMsg.set(l.message_id, [...(labsByMsg.get(l.message_id) || []), l]);
    else clinicLabs.set(l.taken_at, [...(clinicLabs.get(l.taken_at) || []), { ...l }]);
  }
  const allChanges = medChanges(id, 0, Number.MAX_SAFE_INTEGER);
  const timeline = [
    ...logs.map((l) => ({ kind: "log" as const, at: l.created_at, id: l.id, by: l.name, role: l.role, body: l.body, parser: l.parser, obs: obsByMsg.get(l.id) || [], tasks: tasksByMsg.get(l.id) || [], labs: labsByMsg.get(l.id) || [] })),
    ...escEvents.map((e) => ({ kind: "alert" as const, at: e.at, escalationId: e.escalation_id, title: e.title, type: e.type, event: e.event, level: e.level, actor: e.actor, note: e.note })),
    ...visits.map((v) => ({ kind: "visit" as const, at: v.visit_at, id: v.id, diagnosis: v.diagnosis, notes: v.notes })),
    ...missed.map((m) => ({ kind: "missed" as const, at: m.due_at, label: m.label, taskKind: m.kind })),
    ...[...clinicLabs.entries()].map(([at, ls]) => ({ kind: "lab" as const, at, by: ls[0].by, labs: ls })),
    ...allChanges.filter((c) => c.at > since && c.source !== "whatsapp").map((c) => ({ kind: "medchange" as const, at: c.at, change: c })),
  ].sort((a, b) => b.at - a.at);

  const labTask = all<{ due_at: number; status: string; label: string }>("SELECT due_at, status, label FROM tasks WHERE patient_id = ? AND kind = 'lab' AND status IN ('PENDING','MISSED') ORDER BY due_at LIMIT 1", id)[0] ?? null;
  const careTeam = all("SELECT * FROM care_team WHERE patient_id = ? GROUP BY LOWER(TRIM(name)) ORDER BY CASE role WHEN 'PRIMARY' THEN 0 ELSE 1 END, name", id);
  const hasKidney = !!(current?.plan.fluid || current?.plan.template === "kidney" || all("SELECT 1 FROM labs WHERE patient_id = ? LIMIT 1", id).length);

  return json({
    now: t,
    viewer: { id: user.id, role: user.role, name: user.name, isCaregiverHere: caregivers.some((c) => c.user_id === user.id) },
    patient: p,
    doctor: getUser(p.doctor_id),
    caregivers: caregivers.map((c) => (user.role === "PATIENT" || user.role === "CAREGIVER" ? { ...c } : c)),
    visits,
    current,
    summary,
    open,
    timeline,
    careTeam,
    medChanges: allChanges,
    outsideVisits: outsideVisits(id),
    watches: openWatches(id),
    watchOff: watchOffList(id),
    watchCatalog: Object.entries(WATCH_KEYS).map(([key, title]) => ({ key, title })),
    symptomDetails: all<{ observed_at: number; text: string }>("SELECT observed_at, text FROM observations WHERE patient_id = ? AND type = 'symptom_detail' ORDER BY observed_at DESC LIMIT 8", id).map((r) => ({ at: r.observed_at, ...(JSON.parse(r.text) as { key: string; answers: string[]; summary: string }) })),
    labDue: labTask ? { ...labTask, overdue: labTask.due_at < t } : null,
    fluidToday: current?.plan.fluid ? { ...dayFluid(id, t), limit: current.plan.fluid.limitMl } : null,
    kidney: hasKidney ? longRange(id) : null,
    baseline: getBaseline(id),
    consents: getConsents(id),
    notes: user.role === "DOCTOR" || user.role === "PA" ? listNotes(id) : [],
    latestLabs: (() => {
      const rows = all<{ marker: string; value: number; taken_at: number; flag: string | null }>("SELECT marker, value, taken_at, flag FROM labs WHERE patient_id = ? ORDER BY taken_at DESC, id DESC", id);
      const out: { marker: string; value: number; at: number; flag: string | null; prev: number | null }[] = [];
      for (const r of rows) {
        const e = out.find((x) => x.marker === r.marker);
        if (!e) out.push({ marker: r.marker, value: r.value, at: r.taken_at, flag: r.flag, prev: null });
        else if (e.prev === null && r.taken_at < e.at) e.prev = r.value;
      }
      return out;
    })(),
    prep: user.role === "DOCTOR" || user.role === "PA" ? getPrep(id) : null,
    documents: listDocuments(id),
  });
}

// Edit patient details (doctor / PA on the care team).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || (user.role !== "DOCTOR" && user.role !== "PA") || !canView(user, id)) return err("Only the care team can edit patient details", 403);
  try {
    updatePatient(id, (await req.json()) as PatientEdit, now(), user.id);
    return json({ ok: true });
  } catch (e) {
    return err((e as Error).message, 409);
  }
}

// Deletes the patient and their whole record. Only their own doctor or the clinic admin, and the name must be typed.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  const p = getPatient(id);
  if (!p) return err("Not found", 404);
  if (!user || !(user.role === "ADMIN" || (user.role === "DOCTOR" && p.doctor_id === user.id))) return err("Only the patient's doctor or the clinic admin can delete a patient", 403);
  const { confirmName } = (await req.json().catch(() => ({}))) as { confirmName?: string };
  if ((confirmName ?? "").trim().toLowerCase() !== p.name.trim().toLowerCase()) return err(`Type the patient's name (${p.name}) to confirm`, 400);
  return json({ ok: true, ...deletePatient(id, now(), user.id) });
}
