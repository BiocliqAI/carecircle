// Back to the real date. The demo clock can be fast-forwarded (lib/clock.ts), and anything logged while it ran ahead
// carries a date after today. This clears the offset and brings every logged time that is later than now back to now.
// Planned future times (next visits, upcoming reminders, recheck deadlines) are left alone. Runs once per process,
// and only does work when the offset is set or something is dated after now.
import { all, get, getSetting, run, setSetting, tx } from "./db";
import { resetClockCache } from "./clock";
import { DAY, dayKey, dayStart } from "./time";

/** Columns that record when something happened (never a planned future time). */
const LOGGED: [table: string, columns: string[]][] = [
  ["users", ["created_at"]],
  ["patients", ["created_at"]],
  ["visits", ["visit_at", "created_at"]],
  ["messages", ["created_at"]],
  ["observations", ["observed_at"]],
  ["escalations", ["started_at", "level_at", "ack_at", "resolved_at"]],
  ["escalation_events", ["at"]],
  ["audit", ["at"]],
  ["labs", ["taken_at"]],
  ["lab_texts", ["taken_at"]],
  ["med_changes", ["at", "reviewed_at", "applied_at"]],
  ["patient_baseline", ["captured_at", "updated_at"]],
  ["patient_notes", ["created_at", "updated_at"]],
  ["patient_documents", ["uploaded_at", "filed_at"]],
  ["patient_reviews", ["at"]],
  ["plan_drafts", ["updated_at"]],
  ["visit_prep", ["updated_at"]],
  ["onboarding_drafts", ["created_at", "updated_at"]],
  ["onboardings", ["built_at", "created_at", "updated_at", "sent_at", "confirmed_at", "returned_at"]],
  ["outside_visits", ["visit_at", "created_at", "updated_at", "reviewed_at"]],
  ["watches", ["started_at", "updated_at", "closed_at"]],
  ["consents", ["requested_at", "responded_at"]],
  ["record_questions", ["at"]],
];

const hasColumn = (table: string, col: string) => all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === col);

function needsSync(t: number): boolean {
  if (Number(getSetting("clock_offset_ms") || 0) !== 0) return true;
  if (Number(getSetting("last_tick") || 0) > t) return true;
  return !!get("SELECT 1 FROM messages WHERE created_at > ? UNION ALL SELECT 1 FROM observations WHERE observed_at > ? LIMIT 1", t, t);
}

/** Returns the number of rows/settings changed (0 when there was nothing to do). */
export function syncToRealDate(t = Date.now()): number {
  if (!needsSync(t)) return 0;
  const today = dayKey(t);
  const horizon = dayStart(t) + 2 * DAY; // reminders are generated this far ahead (engine.ensureTasks)
  let n = 0;
  tx(() => {
    for (const [table, cols] of LOGGED) {
      for (const c of cols) if (hasColumn(table, c)) n += run(`UPDATE ${table} SET ${c} = ? WHERE ${c} > ?`, t, t).changes;
    }

    // Reminders: ones already answered "in the future" are brought to now; unanswered ones beyond the normal
    // look-ahead were made by the fast-forwarded scheduler and are dropped (the scheduler makes them again on time).
    n += run("UPDATE tasks SET completed_at = ? WHERE completed_at > ?", t, t).changes;
    n += run("UPDATE OR IGNORE tasks SET due_at = ? WHERE status != 'PENDING' AND due_at > ?", t, t).changes;
    n += run("DELETE FROM tasks WHERE status != 'PENDING' AND due_at > ?", t).changes; // same reminder twice at one time
    n += run("DELETE FROM tasks WHERE status = 'PENDING' AND due_at > ?", horizon).changes;

    // Scheduler bookkeeping kept in settings.
    for (const s of all<{ key: string; value: string }>("SELECT key, value FROM settings")) {
      const v = s.value ?? "";
      let next: string | null = null;
      if (/^\d{13}$/.test(v)) {
        const lim = s.key.startsWith("gen:") ? horizon : t;
        if (Number(v) > lim) next = String(lim);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        if (v > today) next = today; // e.g. "digest sent for" a future day: treat it as sent today
      } else if (v.startsWith("{")) {
        try {
          const o = JSON.parse(v) as Record<string, unknown>;
          let changed = false;
          for (const k of ["at", "from"]) if (typeof o[k] === "number" && (o[k] as number) > t) { o[k] = t; changed = true; }
          if (changed) next = JSON.stringify(o);
        } catch {}
      }
      if (next !== null) { setSetting(s.key, next); n++; }
    }
    setSetting("clock_offset_ms", "0");
  });
  resetClockCache();
  return n;
}

const g = globalThis as unknown as { __ccRealDate?: boolean };
export function ensureRealDate() {
  if (g.__ccRealDate) return;
  g.__ccRealDate = true;
  const n = syncToRealDate();
  if (n) console.log(`[carecircle] clock set to the real date; ${n} future-dated entries moved to now`);
}
