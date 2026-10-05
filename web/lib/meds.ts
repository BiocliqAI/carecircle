// Medicine schedule helpers shared by the engine (WhatsApp texts) and the UI (plan tables).
import type { Medication } from "./types";
import { DAY, atLocal, dayStart, fmtTime } from "./time";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const t12 = (hhmm: string) => fmtTime(atLocal(dayStart(Date.UTC(2026, 0, 1, 12)), hhmm));

/** Dose at the i-th scheduled time. */
export const doseAt = (m: Medication, i: number) => (m.doses && m.doses[i]) || m.dose;

/** "40 mg 8:00 am, 20 mg 4:00 pm · alternate days · 7-day course" */
export function describeMed(m: Medication): string {
  if (m.prn) return `${m.dose} · only if required`;
  const split = m.doses && m.doses.some((d) => d && d !== m.doses![0]) && m.doses.length === m.times.length;
  const times = split ? m.times.map((t, i) => `${doseAt(m, i)} ${t12(t)}`).join(", ") : `${m.dose} — ${m.times.map(t12).join(", ")}`;
  const parts = [times];
  if (m.everyNDays && m.everyNDays > 1) parts.push(m.everyNDays === 2 ? "alternate days" : m.everyNDays === 7 ? "once a week" : `every ${m.everyNDays} days`);
  if (m.days && m.days.length && m.days.length < 7) parts.push(m.days.map((d) => DOW[d]).join("/"));
  if (m.courseDays) parts.push(`${m.courseDays}-day course`);
  return parts.join(" · ");
}

/** Is the medicine scheduled on the given day (dayIdx = days since visit day, dow = 0..6)? */
export function medDueOn(m: Medication, dayIdx: number, dow: number): boolean {
  if (m.prn) return false;
  if (m.courseDays && dayIdx >= m.courseDays) return false;
  if (m.everyNDays && m.everyNDays > 1 && dayIdx % m.everyNDays !== 0) return false;
  if (m.days && m.days.length && !m.days.includes(dow)) return false;
  return true;
}

export const dayIndex = (visitAt: number, d: number) => Math.round((dayStart(d) - dayStart(visitAt)) / DAY);
