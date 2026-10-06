// Pre-visit brief, prepared on its own 1–2 days before a visit so it is waiting for the assistant and the doctor
// instead of being generated when someone opens it. Generated in the background (Gemini, or the rules-based
// summary when AI is off) and stored; opening the chart shows it with the time it was prepared.
import { all, getSetting, setSetting } from "./db";
import { latestVisit } from "./engine";
import { generateClinicalSummary, type ClinicalSummaryResult } from "./gemini";
import { DAY } from "./time";

export interface StoredBrief { forVisit: number; at: number; summary: ClinicalSummaryResult }
const key = (pid: string) => `brief:${pid}`;

export function getBrief(pid: string): StoredBrief | null {
  const raw = getSetting(key(pid));
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredBrief; } catch { return null; }
}
export const saveBrief = (pid: string, forVisit: number, summary: ClinicalSummaryResult) =>
  setSetting(key(pid), JSON.stringify({ forVisit, at: Date.now(), summary } satisfies StoredBrief));

/** Is the stored brief for the visit that is coming up (and not older than 2 days)? */
export function freshBrief(pid: string, t: number): StoredBrief | null {
  const b = getBrief(pid);
  const next = latestVisit(pid, t)?.next_visit_at;
  return b && next && b.forVisit === next && Date.now() - b.at < 2 * DAY ? b : null;
}

/** Called from the scheduler: starts the background job once per upcoming visit. */
export function queueBriefs(t: number) {
  for (const p of all<{ id: string }>("SELECT id FROM patients")) {
    const next = latestVisit(p.id, t)?.next_visit_at;
    if (!next || next < t - 6 * 3600_000 || next > t + 2 * DAY) continue;
    const marker = `brief_q:${p.id}:${next}`;
    if (getSetting(marker)) continue;
    setSetting(marker, String(t));
    void generateClinicalSummary(p.id).then((s) => saveBrief(p.id, next, s)).catch(() => setSetting(marker, "")); // retried next tick if it failed
  }
}
