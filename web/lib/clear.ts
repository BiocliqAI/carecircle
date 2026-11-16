// Clearing a patient's records while keeping the patient: profile, care circle, consents and care team always stay.
// Used when records were entered wrongly or a test run needs a fresh start. Logged in the audit trail; can't be undone.
import { all, audit, get, run, tx, type Param } from "./db";
import { getCaregivers, getPatient } from "./engine";

export const RECORD_PARTS = {
  visits: "Treating doctor's visits and care plan (stops reminders; the plan goes back to 'not started')",
  labs: "Lab values and other lab results",
  readings: "Readings, symptoms and fluid logs",
  documents: "Documents",
  outside: "Visits to other doctors and medicine changes",
  notes: "Notes",
  alerts: "Alerts and pattern warnings",
  baseline: "Baseline",
  whatsapp: "WhatsApp conversation",
} as const;
export type RecordPart = keyof typeof RECORD_PARTS;
export const isPart = (p: unknown): p is RecordPart => typeof p === "string" && p in RECORD_PARTS;

const n = (sql: string, ...args: Param[]) => get<{ n: number }>(sql, ...args)?.n ?? 0;

/** How many records of each kind the patient has (shown next to each choice). */
export function countRecords(pid: string): Record<RecordPart, number> {
  return {
    visits: n("SELECT COUNT(*) AS n FROM visits WHERE patient_id = ?", pid),
    labs: n("SELECT COUNT(*) AS n FROM labs WHERE patient_id = ?", pid) + n("SELECT COUNT(*) AS n FROM lab_texts WHERE patient_id = ?", pid),
    readings: n("SELECT COUNT(*) AS n FROM observations WHERE patient_id = ?", pid),
    documents: n("SELECT COUNT(*) AS n FROM patient_documents WHERE patient_id = ?", pid),
    outside: n("SELECT COUNT(*) AS n FROM outside_visits WHERE patient_id = ?", pid) + n("SELECT COUNT(*) AS n FROM med_changes WHERE patient_id = ? AND outside_visit_id IS NULL", pid),
    notes: n("SELECT COUNT(*) AS n FROM patient_notes WHERE patient_id = ?", pid),
    alerts: n("SELECT COUNT(*) AS n FROM escalations WHERE patient_id = ?", pid) + n("SELECT COUNT(*) AS n FROM watches WHERE patient_id = ?", pid),
    baseline: n("SELECT COUNT(*) AS n FROM patient_baseline WHERE patient_id = ?", pid),
    whatsapp: n("SELECT COUNT(*) AS n FROM messages WHERE patient_id = ?", pid),
  };
}

/** Deletes the chosen kinds of records. Returns how many of each were removed. */
export function clearRecords(pid: string, parts: RecordPart[], t: number, actor: string): Partial<Record<RecordPart, number>> {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  const want = new Set(parts.filter(isPart));
  if (!want.size) throw new Error("Choose at least one kind of record to clear");
  const before = countRecords(pid);
  const del = (table: string, where = "patient_id = ?", ...args: Param[]) => run(`DELETE FROM ${table} WHERE ${where}`, ...(args.length ? args : [pid]));
  tx(() => {
    if (want.has("visits")) {
      for (const tb of ["tasks", "visits", "plan_drafts", "visit_prep", "patient_reviews"]) del(tb);
      for (const k of [`gen:${pid}`, `paused:${pid}`, `digest:${pid}`, `weekly:${pid}`, `fluidEval:${pid}`]) run("DELETE FROM settings WHERE key = ?", k);
    }
    if (want.has("labs")) { del("labs"); del("lab_texts"); }
    if (want.has("readings")) del("observations");
    if (want.has("documents")) del("patient_documents");
    if (want.has("outside")) {
      del("med_changes");
      run("UPDATE patient_documents SET outside_visit_id = NULL WHERE patient_id = ?", pid);
      del("outside_visits");
    }
    if (want.has("notes")) del("patient_notes");
    if (want.has("alerts")) {
      for (const e of all<{ id: number }>("SELECT id FROM escalations WHERE patient_id = ?", pid)) {
        run("DELETE FROM escalation_events WHERE escalation_id = ?", e.id);
        run("DELETE FROM settings WHERE key = ?", `loop:${e.id}`);
      }
      del("escalations");
      del("watches");
      run("DELETE FROM settings WHERE key LIKE ?", `recheck:${pid}:%`);
    }
    if (want.has("baseline")) {
      del("patient_baseline");
      run("DELETE FROM labs WHERE patient_id = ? AND source = 'BASELINE'", pid);
    }
    if (want.has("whatsapp")) {
      del("messages");
      // Half-finished conversations (an alert follow-up, a symptom question) belong to the cleared thread.
      for (const u of [p.user_id, ...getCaregivers(pid).map((c) => c.user_id)]) if (u) run("DELETE FROM convo_state WHERE user_id = ?", u);
    }
    // Saved answers and summaries were built from the old record.
    del("record_questions");
    run("DELETE FROM settings WHERE key = ?", `aisum:${pid}`);
  });
  const after = countRecords(pid);
  const removed = Object.fromEntries([...want].map((k) => [k, before[k] - after[k]])) as Partial<Record<RecordPart, number>>;
  audit(t, actor, "RECORDS_CLEARED", "patient", pid, removed);
  return removed;
}
