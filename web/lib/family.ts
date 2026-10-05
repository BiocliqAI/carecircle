// Plain-language view of a patient's day for the patient and their caregivers.
import { all, get } from "./db";
import { getCaregivers, getPatient, getUser, latestVisit, type EscalationRow } from "./engine";
import { DAY, dayKey, dayStart, fmtTime } from "./time";
import { VITAL_META, shortName, type VitalType } from "./types";

export interface PlanItem { at: number; time: string; label: string; status: "done" | "high" | "missed" | "later" | "due"; value: string | null }

export function familyToday(pid: string, viewerId: string, t: number) {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  const visit = latestVisit(pid, t);
  const plan = visit?.plan;
  const day0 = dayStart(t);

  // Today's plan: medicines due at the same time are one line.
  const tasks = all<{ id: number; kind: string; item_key: string; label: string; due_at: number; status: string; completed_at: number | null }>(
    "SELECT id, kind, item_key, label, due_at, status, completed_at FROM tasks WHERE patient_id = ? AND due_at >= ? AND due_at < ? AND kind != 'lab' ORDER BY due_at, kind", pid, day0, day0 + DAY,
  );
  const items: PlanItem[] = [];
  for (const tk of tasks) {
    const time = fmtTime(tk.due_at);
    const st: PlanItem["status"] = tk.status === "DONE" ? "done" : tk.status === "MISSED" || tk.status === "NOT_DONE" ? "missed" : tk.due_at > t ? "later" : "due";
    if (tk.kind === "med") {
      const prev = items.find((i) => i.at === tk.due_at && i.label.startsWith("Medicine"));
      if (prev) {
        prev.label += ` · ${tk.label}`;
        if (st === "missed" || (st === "due" && prev.status === "done")) prev.status = st;
        continue;
      }
      items.push({ at: tk.due_at, time, label: `Medicine: ${tk.label}`, status: st, value: st === "done" ? "Taken" : st === "missed" ? "Not taken" : null });
      continue;
    }
    let value: string | null = null;
    let status: PlanItem["status"] = st;
    if (tk.kind === "vital") {
      const type = tk.item_key.replace("vital:", "");
      const o = get<{ v1: number; v2: number | null; flag: string | null }>("SELECT v1, v2, flag FROM observations WHERE patient_id = ? AND type = ? AND observed_at >= ? ORDER BY observed_at DESC LIMIT 1", pid, type, day0);
      if (o) { value = `${o.v1}${o.v2 ? `/${o.v2}` : ""}${VITAL_META[type as VitalType] ? ` ${VITAL_META[type as VitalType].unit}` : ""}`; if (o.flag) status = "high"; }
    }
    items.push({ at: tk.due_at, time, label: tk.kind === "checkin" ? "Evening check-in: how are you feeling?" : tk.kind === "fluid" ? "Fluids and urine for the day" : tk.label, status, value });
  }
  for (const i of items) if (i.label.startsWith("Medicine: ")) i.label = i.label.replace("Medicine: ", "").replace(/ · /g, " and ");

  // Main reading: BP if monitored, else the first monitored vital.
  const mon = plan?.monitoring.map((m) => m.key) ?? [];
  const vtype: VitalType | null = mon.includes("bp") ? "bp" : (mon[0] ?? null);
  let reading: null | { type: VitalType; label: string; unit: string; latest: string; at: number; status: "ok" | "high" | "low"; message: string; points: number[]; lo: number | null; hi: number | null } = null;
  if (vtype && plan) {
    const rows = all<{ v1: number; v2: number | null; observed_at: number }>("SELECT v1, v2, observed_at FROM observations WHERE patient_id = ? AND type = ? AND observed_at > ? ORDER BY observed_at", pid, vtype, t - 14 * DAY);
    const last = rows[rows.length - 1];
    if (last) {
      const th = plan.thresholds;
      let status: "ok" | "high" | "low" = "ok", target = "", lo: number | null = null, hi: number | null = null;
      if (vtype === "bp") { target = `${th.sysHigh}/${th.diaHigh}`; lo = th.sysLow; hi = th.sysHigh; status = last.v1 > th.sysHigh || (last.v2 ?? 0) > th.diaHigh ? "high" : last.v1 < th.sysLow ? "low" : "ok"; }
      else if (vtype === "glucose") { target = `${th.glucoseLow}–${th.glucoseHigh}`; lo = th.glucoseLow; hi = th.glucoseHigh; status = last.v1 > th.glucoseHigh ? "high" : last.v1 < th.glucoseLow ? "low" : "ok"; }
      else if (vtype === "spo2") { target = `above ${th.spo2Low}%`; lo = th.spo2Low; hi = 100; status = last.v1 < th.spo2Low ? "low" : "ok"; }
      else if (vtype === "weight" && th.dryWeight) { target = `${th.dryWeight} ± ${th.weightBand ?? 1} kg`; lo = th.dryWeight - (th.weightBand ?? 1); hi = th.dryWeight + (th.weightBand ?? 1); status = last.v1 > hi ? "high" : last.v1 < lo ? "low" : "ok"; }
      const message = status === "ok" ? (target ? `Within the target (${target})` : "Recorded") : status === "high" ? `Above the target of ${target}` : `Below the target of ${target}`;
      reading = { type: vtype, label: VITAL_META[vtype].label, unit: VITAL_META[vtype].unit, latest: `${last.v1}${last.v2 ? `/${last.v2}` : ""}`, at: last.observed_at, status, message, points: rows.slice(-20).map((r) => r.v1), lo, hi };
    }
  }

  // Medicines, last 7 days.
  const week: { day: string; label: string; status: "ok" | "missed" | "none" }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d0 = day0 - i * DAY;
    const r = get<{ n: number; done: number; bad: number }>(
      "SELECT COUNT(*) AS n, SUM(status = 'DONE') AS done, SUM(status IN ('MISSED','NOT_DONE')) AS bad FROM tasks WHERE patient_id = ? AND kind = 'med' AND due_at >= ? AND due_at < ? AND due_at <= ?", pid, d0, d0 + DAY, t,
    )!;
    week.push({ day: dayKey(d0), label: new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short" }).format(d0), status: !r.n ? "none" : r.bad ? "missed" : "ok" });
  }
  const missedDays = week.filter((w) => w.status === "missed").map((w) => w.label);

  const cgs = getCaregivers(pid);
  const open = all<EscalationRow>("SELECT * FROM escalations WHERE patient_id = ? AND state IN ('NOTIFIED','ACKNOWLEDGED') ORDER BY CASE type WHEN 'URGENT' THEN 0 WHEN 'DEVIATION' THEN 1 ELSE 2 END, started_at DESC", pid);
  const me = cgs.find((c) => c.user_id === viewerId) ?? null;
  const monthAlerts = get<{ n: number; closed: number }>("SELECT COUNT(*) AS n, SUM(state IN ('RESOLVED')) AS closed FROM escalations WHERE patient_id = ? AND started_at > ?", pid, t - 30 * DAY)!;

  return {
    now: t,
    patient: { id: p.id, name: p.name, first: shortName(p.name) },
    doctor: getUser(p.doctor_id)?.name ?? null,
    hasPlan: !!visit,
    nextVisit: visit?.next_visit_at ?? null,
    plan: items,
    reading,
    week,
    weekOk: week.filter((w) => w.status === "ok").length,
    weekDue: week.filter((w) => w.status !== "none").length,
    missedDays,
    caregivers: cgs.map((c) => ({ name: c.name, relation: c.relation, level: c.level, userId: c.user_id })),
    me: me ? { level: me.level } : null,
    alerts: open.map((e) => {
      const cg = cgs.find((c) => c.level === e.level);
      const next = cgs.find((c) => c.level === e.level + 1);
      return {
        id: e.id, type: e.type, title: e.title, detail: e.detail, advice: e.advice, state: e.state, startedAt: e.started_at,
        ackBy: e.ack_by, ackByName: e.ack_by ? getUser(e.ack_by)?.name ?? null : null, ackAt: e.ack_at,
        atLevelName: cg?.name ?? null, mine: !!me && (e.ack_by === viewerId || (e.state === "NOTIFIED" && e.level === me.level)),
        nextName: next ? shortName(next.name) : null,
      };
    }),
    monthAlerts: { n: monthAlerts.n, closed: monthAlerts.closed ?? 0 },
  };
}
