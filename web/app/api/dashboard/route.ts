import { all, get } from "@/lib/db";
import { now } from "@/lib/clock";
import { dayFluid, getCaregivers, getUser, latestVisit, listPatients, type EscalationRow } from "@/lib/engine";
import { intervalSummary } from "@/lib/summary";
import { err, isClinician, json, ready, sessionUser } from "@/lib/server";
import { DAY } from "@/lib/time";
import { triage } from "@/lib/triage";
import { careActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";

// Today / Patients: pull-based visibility for Doctor/PA. Nothing here notifies the doctor.
export async function GET() {
  await ready();
  const user = await sessionUser();
  if (!isClinician(user)) return err("Doctor / PA only", 403);
  const t = now();
  const patients = listPatients()
    .filter((p) => user!.role === "PA" || p.doctor_id === user!.id)
    .map((p) => {
      const visit = latestVisit(p.id, t);
      const s = visit ? intervalSummary(p.id, visit.visit_at, t) : null;
      const open = all<EscalationRow>("SELECT * FROM escalations WHERE patient_id = ? AND state IN ('NOTIFIED','ACKNOWLEDGED') ORDER BY started_at DESC", p.id);
      const cgs = getCaregivers(p.id);
      const latest = all<{ type: string; v1: number; v2: number | null; flag: string | null; observed_at: number }>(
        `SELECT o.type, o.v1, o.v2, o.flag, o.observed_at FROM observations o
         WHERE o.patient_id = ? AND o.type NOT IN ('symptom','lifestyle','fluid_in','urine_out','diuretic')
           AND o.observed_at = (SELECT MAX(observed_at) FROM observations x WHERE x.patient_id = o.patient_id AND x.type = o.type)`,
        p.id,
      );
      const lastLog = get<{ at: number }>("SELECT MAX(created_at) AS at FROM messages WHERE patient_id = ? AND direction = 'IN'", p.id)?.at ?? null;
      const recentDev = get<{ n: number }>("SELECT COUNT(*) AS n FROM escalations WHERE patient_id = ? AND type != 'COMPLIANCE' AND started_at > ?", p.id, t - 7 * DAY)!.n;
      const status = open.some((e) => e.type === "URGENT")
        ? "urgent"
        : open.some((e) => e.type === "DEVIATION") || recentDev > 0 || (s?.overall.meds ?? 100) < 80
          ? "attention"
          : "stable";
      return {
        id: p.id,
        name: p.name,
        age: p.age,
        sex: p.sex,
        conditions: p.conditions,
        lastVisitAt: visit?.visit_at ?? null,
        nextVisitAt: visit?.next_visit_at ?? null,
        overall: s?.overall ?? null,
        alertsSinceVisit: s?.escalations.length ?? 0,
        deviationsSinceVisit: s?.escalations.filter((e) => e.type !== "COMPLIANCE").length ?? 0,
        symptoms: s?.symptoms.slice(0, 3).map((x) => x.label) ?? [],
        latest,
        lastLog,
        status,
        kidney: visit?.plan.fluid || visit?.plan.template === "kidney"
          ? {
              labOverdue: !!get("SELECT 1 FROM tasks WHERE patient_id = ? AND kind = 'lab' AND status IN ('PENDING','MISSED') AND due_at < ?", p.id, t),
              fluidYesterday: (() => {
                const f = dayFluid(p.id, t - DAY);
                return f.inLogged ? { in: f.in, out: f.outLogged ? f.out : null, limit: visit.plan.fluid?.limitMl ?? null } : null;
              })(),
              pendingMedChanges: get<{ n: number }>("SELECT COUNT(*) AS n FROM med_changes WHERE patient_id = ? AND status = 'REPORTED'", p.id)!.n,
              creatinine: get<{ value: number; flag: string | null }>("SELECT value, flag FROM labs WHERE patient_id = ? AND marker = 'creatinine' ORDER BY taken_at DESC LIMIT 1", p.id) ?? null,
            }
          : null,
        onboarding: {
          hasVisit: !!visit,
          hasBaseline: !!get("SELECT 1 FROM patient_baseline WHERE patient_id = ?", p.id),
          consentsPending: get<{ n: number }>("SELECT COUNT(*) AS n FROM consents WHERE patient_id = ? AND status = 'PENDING'", p.id)!.n,
          consentsDeclined: get<{ n: number }>("SELECT COUNT(*) AS n FROM consents WHERE patient_id = ? AND status = 'DECLINED'", p.id)!.n,
        },
        doctorName: getUser(p.doctor_id)?.name ?? null,
        triage: triage(p, visit, open, s?.overall.meds ?? null, t),
        prep: (() => {
          const r = get<{ data: string }>("SELECT data FROM visit_prep WHERE patient_id = ?", p.id);
          if (!r) return null;
          const d = JSON.parse(r.data) as { readyAt?: number | null; readyBy?: string | null };
          return { readyAt: d.readyAt ?? null, readyBy: d.readyBy ?? null };
        })(),
        open: open.map((e) => {
          const cg = cgs.find((c) => c.level === e.level);
          return { id: e.id, type: e.type, title: e.title, state: e.state, level: e.level, levelName: cg?.name ?? null, since: e.started_at, levelAt: e.level_at, ackBy: e.ack_by ? getUser(e.ack_by)?.name : null };
        }),
      };
    });
  const rank = { urgent: 0, attention: 1, stable: 2 } as Record<string, number>;
  patients.sort((a, b) => rank[a.status] - rank[b.status] || (a.nextVisitAt ?? Infinity) - (b.nextVisitAt ?? Infinity));
  return json({ now: t, patients, activity: careActivity(patients.map((p) => p.id), t) });
}
