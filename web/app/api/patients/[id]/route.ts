import { all } from "@/lib/db";
import { now } from "@/lib/clock";
import { dayFluid, getConsents, getCaregivers, getPatient, getUser, getVisits, latestVisit, type EscalationRow } from "@/lib/engine";
import { intervalSummary, longRange, medChanges, type EscalationView } from "@/lib/summary";
import { canView, err, json, ready, sessionUser } from "@/lib/server";
import { getBaseline } from "@/lib/clinic";
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
    labDue: labTask ? { ...labTask, overdue: labTask.due_at < t } : null,
    fluidToday: current?.plan.fluid ? { ...dayFluid(id, t), limit: current.plan.fluid.limitMl } : null,
    kidney: hasKidney ? longRange(id) : null,
    baseline: getBaseline(id),
    consents: getConsents(id),
  });
}
