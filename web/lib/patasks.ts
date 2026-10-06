// The assistant's work queue: everything that needs a person to act, derived from live records.
import { all, get } from "./db";
import { consentNudges, getCaregivers, getPatient, getUser, latestVisit, listPatients } from "./engine";
import { getPrep } from "./prep";
import { getBaseline, listDrafts } from "./clinic";
import { DAY, HOUR, dayStart, fmtDate, fmtTime, relDays } from "./time";
import { shortName } from "./types";

export type TaskKind = "onboarding" | "consent" | "visit" | "document" | "medchange" | "circle" | "baseline";
export interface PaTask {
  id: string;
  kind: TaskKind;
  label: string;
  patient: string;
  patientId: string | null;
  detail: string;
  at: number;
  actions: { label: string; href?: string; api?: { path: string; body: unknown }; primary?: boolean }[];
}

const STEP = ["Patient details", "Care circle", "Baseline", "Review"];
const ago = (at: number, t: number) => { const d = Math.floor((t - at) / DAY); return d <= 0 ? `${Math.max(1, Math.round((t - at) / HOUR))} h` : `${d} day${d > 1 ? "s" : ""}`; };

export function paToday(t: number, userId: string) {
  const tasks: PaTask[] = [];
  const drafts = listDrafts();
  for (const d of drafts)
    tasks.push({ id: `draft:${d.id}`, kind: "onboarding", label: "Finish onboarding", patient: d.name, patientId: null, at: d.updated_at, detail: `Draft at ${STEP[d.step] ?? "Review"} · saved ${fmtDate(d.updated_at, { day: "numeric", month: "short" })}${d.updated_by_name ? ` by ${d.updated_by === userId ? "you" : shortName(d.updated_by_name)}` : ""} · nothing sent yet`, actions: [{ label: "Resume", href: `/patients/new?draft=${d.id}`, primary: true }] });

  const pending = all<{ patient_id: string; user_id: string; role: string; requested_at: number }>("SELECT patient_id, user_id, role, requested_at FROM consents WHERE status = 'PENDING' ORDER BY requested_at");
  const byPatient = new Map<string, typeof pending>();
  for (const c of pending) byPatient.set(c.patient_id, [...(byPatient.get(c.patient_id) ?? []), c]);
  for (const [pid, cs] of byPatient) {
    const p = getPatient(pid);
    if (!p) continue;
    const cgs = getCaregivers(pid);
    const who = cs.map((c) => (c.role === "PATIENT" ? `${shortName(p.name)} (patient)` : (() => { const cg = cgs.find((x) => x.user_id === c.user_id); return cg ? `${shortName(cg.name)} (${cg.level === 1 ? "primary" : "backup"})` : getUser(c.user_id)?.name ?? "Someone"; })()));
    const oldest = cs[0];
    const phone = oldest.role === "PATIENT" ? p.phone : cgs.find((x) => x.user_id === oldest.user_id)?.phone;
    const auto = Math.max(...cs.map((c) => consentNudges(pid, c.user_id)));
    tasks.push({
      id: `consent:${pid}`, kind: "consent", label: `Consent pending · ${ago(oldest.requested_at, t)}`, patient: p.name, patientId: pid, at: oldest.requested_at,
      detail: `${who.join(" and ")} ${cs.length > 1 ? "haven’t" : "hasn’t"} replied YES on WhatsApp yet.${auto ? ` Already reminded automatically ${auto === 1 ? "once" : `${auto} times`}${auto >= 2 ? "; a phone call is the next step." : "."}` : ""}`,
      actions: [...(phone ? [{ label: "Call", href: `tel:${phone.replace(/\s/g, "")}` }] : []), { label: "Resend", api: { path: `/api/patients/${pid}/consent`, body: { action: "resend" } }, primary: true }],
    });
  }

  // Someone said NO to joining the care circle: the circle has a gap until the family picks another person.
  for (const c of all<{ patient_id: string; user_id: string; role: string; responded_at: number | null }>("SELECT patient_id, user_id, role, responded_at FROM consents WHERE status = 'DECLINED' AND role = 'CAREGIVER' ORDER BY responded_at")) {
    const p = getPatient(c.patient_id);
    const cg = p && getCaregivers(c.patient_id).find((x) => x.user_id === c.user_id);
    if (!p || !cg) continue; // already replaced or removed
    tasks.push({ id: `declined:${p.id}:${c.user_id}`, kind: "circle", label: "Caregiver declined", patient: p.name, patientId: p.id, at: c.responded_at ?? t, detail: `${shortName(cg.name)} (${cg.level === 1 ? "primary" : "backup"}) replied NO. Ask the family who else should be in the circle.`, actions: [{ label: "Manage circle", href: `/patients/${p.id}?tab=profile`, primary: true }] });
  }

  // Registered but no baseline yet: the doctor would start Visit 1 from an empty page.
  for (const p of listPatients()) {
    if (latestVisit(p.id, t) || getBaseline(p.id)) continue;
    tasks.push({ id: `baseline:${p.id}`, kind: "baseline", label: "Baseline missing", patient: p.name, patientId: p.id, at: p.created_at, detail: "No baseline yet. Add old prescriptions or reports and the form fills itself in; you just check it.", actions: [{ label: "Capture baseline", href: `/patients/${p.id}/baseline`, primary: true }] });
  }

  const visits: { id: string; name: string; at: number; ready: boolean; doctor: string | null }[] = [];
  for (const p of listPatients()) {
    const v = latestVisit(p.id, t);
    const next = v?.next_visit_at;
    if (!next || relDays(t, next) < 0 || relDays(t, next) > 7) continue;
    const prep = getPrep(p.id);
    visits.push({ id: p.id, name: p.name, at: next, ready: !!prep.readyAt, doctor: getUser(p.doctor_id)?.name ?? null });
    if (!prep.readyAt) {
      const todo = [!prep.attendance && "confirm attendance", !prep.vitalsAt && "check-in vitals", !prep.docsChecked && "file new reports"].filter(Boolean);
      tasks.push({ id: `visit:${p.id}`, kind: "visit", label: `Prepare visit · ${relDays(t, next) === 0 ? "today" : fmtDate(next, { weekday: "short", day: "numeric", month: "short" })}, ${fmtTime(next)}`, patient: p.name, patientId: p.id, at: next - 2 * DAY, detail: todo.length ? `To do: ${todo.join(", ")}.` : "Everything is in; mark it ready for the doctor.", actions: [{ label: "Prepare", href: `/patients/${p.id}/visit`, primary: true }] });
    }
  }

  for (const d of all<{ id: number; patient_id: string; title: string; uploaded_by: string | null; uploaded_at: number }>("SELECT id, patient_id, title, uploaded_by, uploaded_at FROM patient_documents WHERE source = 'whatsapp' AND filed_at IS NULL ORDER BY uploaded_at")) {
    const p = getPatient(d.patient_id);
    if (!p) continue;
    tasks.push({ id: `doc:${d.id}`, kind: "document", label: "Document to file", patient: p.name, patientId: p.id, at: d.uploaded_at, detail: `“${d.title}” sent on WhatsApp${d.uploaded_by ? ` by ${shortName(getUser(d.uploaded_by)?.name ?? "")}` : ""}, ${fmtDate(d.uploaded_at, { day: "numeric", month: "short" })} · not yet filed`, actions: [{ label: "Review & file", href: `/patients/${p.id}?tab=documents`, primary: true }] });
  }

  // Visits to other doctors with medicine changes the family reported: one item per visit.
  for (const v of all<{ id: number; patient_id: string; doctor_name: string | null; specialty: string | null; visit_at: number; created_at: number; meds: string; reported_by: string | null }>(
    `SELECT o.id, o.patient_id, o.doctor_name, o.specialty, o.visit_at, o.created_at, o.reported_by, GROUP_CONCAT(c.med_name, ', ') AS meds
       FROM outside_visits o JOIN med_changes c ON c.outside_visit_id = o.id AND c.status = 'REPORTED'
     WHERE o.status = 'COMPLETE' GROUP BY o.id ORDER BY o.created_at`,
  )) {
    const p = getPatient(v.patient_id);
    if (!p) continue;
    tasks.push({ id: `ov:${v.id}`, kind: "medchange", label: "Other doctor's changes to review", patient: p.name, patientId: p.id, at: v.created_at, detail: `${v.doctor_name ?? "Another doctor"}${v.specialty ? ` (${v.specialty})` : ""}, ${fmtDate(v.visit_at, { day: "numeric", month: "short" })}: ${v.meds}. Reported${v.reported_by ? ` by ${shortName(getUser(v.reported_by)?.name ?? "")}` : ""}; reminders stay as they are until the plan is updated.`, actions: [{ label: "Review & apply", href: `/patients/${p.id}?tab=notes`, primary: true }] });
  }

  for (const m of all<{ id: number; patient_id: string; med_name: string; change: string; detail: string | null; prescriber: string | null; at: number }>("SELECT id, patient_id, med_name, change, detail, prescriber, at FROM med_changes WHERE status = 'REPORTED' AND outside_visit_id IS NULL ORDER BY at")) {
    const p = getPatient(m.patient_id);
    if (!p) continue;
    if (getPrep(p.id).flags.some((f) => f.medChangeId === m.id)) continue;
    tasks.push({ id: `med:${m.id}`, kind: "medchange", label: "Medicine change to reconcile", patient: p.name, patientId: p.id, at: m.at, detail: `Reported: ${m.med_name} ${m.change.replace("_", " ")}${m.detail ? ` (${m.detail})` : ""}${m.prescriber ? ` by ${m.prescriber}` : ""}. Needs the doctor’s review.`, actions: [{ label: "Flag for visit", api: { path: `/api/patients/${p.id}/prep`, body: { flagMedChange: m.id } }, primary: true }] });
  }

  // Someone in the care circle who misses most of the alerts sent to them (≥3 and >60% in 2 weeks).
  for (const p of listPatients()) {
    const weak: string[] = [];
    for (const cg of getCaregivers(p.id)) {
      const c = (ev: string) => get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM escalation_events ev JOIN escalations e ON e.id = ev.escalation_id WHERE e.patient_id = ? AND ev.event = ? AND ev.level = ? AND ev.at > ?",
        p.id, ev, cg.level, t - 14 * DAY,
      )!.n;
      const sent = c("NOTIFIED"), missed = c("TIMEOUT");
      if (missed >= 3 && missed / Math.max(1, sent) > 0.6) weak.push(`${cg.level === 1 ? "primary" : "backup"} ${shortName(cg.name)} missed ${missed} of ${sent}`);
    }
    if (weak.length) tasks.push({ id: `circle:${p.id}`, kind: "circle", label: "Care circle not responding", patient: p.name, patientId: p.id, at: t - DAY, detail: `In 2 weeks, ${weak.join("; ")} alerts. Check the number or add someone else.`, actions: [{ label: "Manage circle", href: `/patients/${p.id}?tab=profile`, primary: true }] });
  }

  tasks.sort((a, b) => a.at - b.at);

  const noVisit = listPatients().filter((p) => !latestVisit(p.id, t));
  const pendingIds = new Set(byPatient.keys());
  const pipeline = [
    { label: "Details & care circle", names: drafts.filter((d) => d.step <= 1).map((d) => `${d.name} (draft)`) },
    { label: "Baseline & review", names: drafts.filter((d) => d.step >= 2).map((d) => `${d.name} (draft)`) },
    { label: "Waiting for consent", names: noVisit.filter((p) => pendingIds.has(p.id)).map((p) => p.name) },
    { label: "Ready for Visit 1", names: noVisit.filter((p) => !pendingIds.has(p.id)).map((p) => p.name) },
  ];

  const done = all<{ at: number; action: string; entity_id: string; detail: string | null }>("SELECT at, action, entity_id, detail FROM audit WHERE actor = ? AND at >= ? ORDER BY at DESC LIMIT 12", userId, dayStart(t));
  const DONE: Record<string, string> = { PATIENT_ONBOARDED: "Onboarded", BASELINE_CAPTURED: "Captured baseline for", BASELINE_UPDATED: "Updated baseline for", PATIENT_UPDATED: "Updated details for", CARE_CIRCLE_UPDATED: "Updated care circle for", NOTE_ADDED: "Added a note for", DOCUMENT_ADDED: "Uploaded a document for", DOCUMENT_UPDATED: "Filed a document for", VISIT_PREPARED: "Prepared the visit for", CONSENT_RESENT: "Resent consent for", PATIENT_REVIEWED: "Reviewed" };
  const doneToday = done.filter((d) => DONE[d.action]).map((d) => ({ at: d.at, text: `${DONE[d.action]} ${getPatient(d.entity_id)?.name ?? "a patient"}` }));

  return { now: t, tasks, pipeline, visits: visits.sort((a, b) => a.at - b.at), doneToday, counts: { tasks: tasks.length, drafts: drafts.length, consents: byPatient.size, visits: visits.filter((v) => !v.ready).length } };
}
