// After a visit: a plain-language "in short" for the family, drafted from the doctor's own reviewed draft, and a
// suggested next-visit date from how stable the patient has been. The doctor edits and approves both in the
// builder's Send step; nothing is sent until they press Send.
import { all, get } from "./db";
import { getVisits } from "./engine";
import { familySummaryAI, isGeminiConfigured } from "./gemini";
import type { PlanDraft } from "./plandraft";
import { DAY, dayKey, fmtDate } from "./time";

type Built = NonNullable<PlanDraft["built"]>;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** "1-0-1" → "morning and night", "1-1-1" → "3 times a day", "SOS" → "only if needed". */
export function plainSchedule(s: string): string {
  const m = s.trim().match(/^([01])\s*-\s*([01])\s*-\s*([01])$/);
  if (!m) return /sos|prn|if needed|only if/i.test(s) ? "only if needed" : s;
  const parts = ["morning", "afternoon", "night"].filter((_, i) => m[i + 1] === "1");
  if (parts.length === 3) return "3 times a day";
  if (parts.length === 0) return s;
  return parts.length === 1 ? `once a day, ${parts[0] === "night" ? "at night" : `in the ${parts[0]}`}` : parts.join(" and ");
}

export function ruleSummary(b: Built, nextVisit: string | null): string {
  const lines: string[] = [];
  for (const m of b.medications) {
    if (m.change === "stopped") lines.push(`• Stop ${m.name}${m.instructions ? ` (${m.instructions})` : ""}`);
    else if (m.change === "new") lines.push(`• New: ${m.name} ${m.dose}, ${plainSchedule(m.schedule)}`);
    else if (m.change === "changed") lines.push(`• ${m.name} is now ${m.dose}, ${plainSchedule(m.schedule)}${m.was ? ` (was ${m.was})` : ""}`);
  }
  if (!lines.length) lines.push("• Your medicines stay the same.");
  const why = b.note?.split(/(?<=[.!?])\s/)[0]?.trim();
  if (why && why.length < 220) lines.push(`Why: ${why}`);
  if (b.warningSigns?.text) lines.push(`Watch for: ${b.warningSigns.text}`);
  if (nextVisit) lines.push(`📅 Next visit: ${fmtDate(Date.parse(`${nextVisit}T12:00:00+05:30`), { weekday: "short", day: "numeric", month: "short" })}`);
  return lines.join("\n");
}

export async function draftFamilySummary(b: Built, nextVisit: string | null): Promise<{ text: string; via: "ai" | "rules" }> {
  if (isGeminiConfigured()) {
    const ctx = {
      medicines: b.medications.map((m) => ({ name: m.name, dose: m.dose, schedule: plainSchedule(m.schedule), change: m.change, was: m.was, instructions: m.instructions })),
      warningSigns: b.warningSigns?.text ?? "",
      doctorNote: b.note,
      nextVisit,
    };
    const t = await Promise.race([familySummaryAI(ctx), new Promise<null>((r) => setTimeout(() => r(null), 20_000))]).catch(() => null);
    if (t && t.trim().length > 20) return { text: t.trim().slice(0, 900), via: "ai" };
  }
  return { text: ruleSummary(b, nextVisit), via: "rules" };
}

/** A next-visit date from stability: longer when things have been calm, shorter after changes or alerts. */
export function suggestNextVisit(pid: string, t: number, changes: number): { date: string; days: number; why: string } {
  const visits = getVisits(pid);
  const last = visits.at(-1);
  const prevInterval = visits.length >= 2 ? Math.round((visits[visits.length - 1].visit_at - visits[visits.length - 2].visit_at) / DAY) : 30;
  const base = clamp(prevInterval, 14, 60);
  const since = last?.visit_at ?? t - 30 * DAY;
  const alerts = get<{ n: number }>("SELECT COUNT(*) AS n FROM escalations WHERE patient_id = ? AND type != 'COMPLIANCE' AND started_at > ?", pid, since)!.n;
  const med = get<{ due: number; done: number }>("SELECT COUNT(*) AS due, COALESCE(SUM(status = 'DONE'), 0) AS done FROM tasks WHERE patient_id = ? AND kind = 'med' AND status IN ('DONE','MISSED','NOT_DONE') AND due_at > ?", pid, since)!;
  const adh = med.due >= 10 ? Math.round((med.done / med.due) * 100) : null;
  let days = base, why = `About the same gap as last time (${base} days).`;
  if (changes >= 3 || alerts >= 3 || (adh != null && adh < 75)) {
    days = clamp(Math.round(base / 2), 7, 21);
    why = `Sooner: ${[changes >= 3 && `${changes} medicine changes today`, alerts >= 3 && `${alerts} alerts since the last visit`, adh != null && adh < 75 && `medicines taken on ${adh}% of doses`].filter(Boolean).join(", ")}.`;
  } else if (alerts === 0 && (adh == null || adh >= 90) && changes <= 1) {
    days = clamp(base + 14, 14, 90);
    why = `Stable since the last visit${adh != null ? `, medicines taken on ${adh}% of doses` : ""}, with ${changes ? "one small change" : "no changes"} today.`;
  }
  return { date: dayKey(t + days * DAY), days, why };
}
void all;
