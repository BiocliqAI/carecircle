import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-realdate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { get, getSetting } = await import("../lib/db");
const { seedDemo, simulateDays } = await import("../lib/seed");
const { now } = await import("../lib/clock");
const { syncToRealDate } = await import("../lib/realtime");
const { DAY } = await import("../lib/time");

const max = (sql: string) => get<{ m: number | null }>(sql)!.m ?? 0;

describe("back to the real date after the demo clock was fast-forwarded", () => {
  before(async () => { await seedDemo(); await simulateDays(3); });

  it("clears the offset and moves everything logged after now back to now, keeping planned future visits", () => {
    assert.ok(Number(getSetting("clock_offset_ms")) >= 3 * DAY - 1000);
    const nextVisits = max("SELECT MAX(next_visit_at) AS m FROM visits");
    const t = Date.now();
    assert.ok(max("SELECT MAX(created_at) AS m FROM messages") > t + DAY);
    assert.ok(syncToRealDate(t) > 0);
    assert.equal(getSetting("clock_offset_ms"), "0");
    assert.ok(Math.abs(now() - Date.now()) < 5000);
    for (const [tb, c] of [["messages", "created_at"], ["observations", "observed_at"], ["escalations", "started_at"], ["audit", "at"], ["labs", "taken_at"]])
      assert.ok(max(`SELECT MAX(${c}) AS m FROM ${tb}`) <= t, `${tb}.${c}`);
    assert.ok(max("SELECT MAX(due_at) AS m FROM tasks WHERE status != 'PENDING'") <= t);
    assert.ok(Number(getSetting("last_tick")) <= t);
    assert.equal(max("SELECT MAX(next_visit_at) AS m FROM visits"), nextVisits);
    assert.equal(syncToRealDate(), 0); // nothing left to do
  });
});
