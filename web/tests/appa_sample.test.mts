import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-appa-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.CARECIRCLE_MODE = "live";
delete process.env.GEMINI_API_KEY;
delete process.env.CARECIRCLE_SAMPLE_PATIENT;

const { all, get, run } = await import("../lib/db");
const { ensureSeeded } = await import("../lib/seed");

const count = (sql: string) => get<{ n: number }>(sql)!.n;

describe("live clinic: the sample kidney patient (A Gopal)", () => {
  it("waits until the clinic has a doctor", async () => {
    await ensureSeeded();
    assert.equal(count("SELECT COUNT(*) AS n FROM patients"), 0);
  });

  it("is added once, with the history from the 13 Aug 2025 baseline, and nothing is sent", async () => {
    run("INSERT INTO users(id, name, role, phone, title) VALUES('u_doc','Dr Dileep','DOCTOR','+91 90000 10001','Nephrology')");
    (globalThis as { __ccAppaDone?: boolean }).__ccAppaDone = false;
    await ensureSeeded();
    const p = get<{ id: string; doctor_id: string }>("SELECT id, doctor_id FROM patients WHERE name = 'A Gopal'");
    assert.equal(p?.doctor_id, "u_doc");
    assert.equal(count("SELECT COUNT(*) AS n FROM visits WHERE patient_id = 'p_appa'"), 7);
    assert.ok(count("SELECT COUNT(*) AS n FROM observations WHERE patient_id = 'p_appa'") > 1000);
    assert.ok(count("SELECT COUNT(*) AS n FROM labs WHERE patient_id = 'p_appa'") > 300);
    assert.ok(get("SELECT 1 FROM patient_baseline WHERE patient_id = 'p_appa'"));
    assert.equal(count("SELECT COUNT(*) AS n FROM messages"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM escalations"), 0);

    (globalThis as { __ccAppaDone?: boolean }).__ccAppaDone = false;
    await ensureSeeded();
    assert.equal(count("SELECT COUNT(*) AS n FROM patients"), 1, "never added twice");
  });

  it("fills in an A Gopal created by hand instead of adding a second one", async () => {
    run("DELETE FROM settings WHERE key = 'sample:appa'");
    run("DELETE FROM audit WHERE action = 'HISTORY_IMPORTED'");
    run("INSERT INTO users(id, name, role, phone, title) VALUES('u_hand','A Gopal','PATIENT','+91 98000 00001','Patient')");
    run("INSERT INTO patients(id, user_id, name, phone, doctor_id, created_at) VALUES('p_hand','u_hand','A Gopal','+91 98000 00001','u_doc',0)");
    (globalThis as { __ccAppaDone?: boolean }).__ccAppaDone = false;
    await ensureSeeded();
    assert.equal(count("SELECT COUNT(*) AS n FROM visits WHERE patient_id = 'p_hand'"), 7);
    assert.equal(count("SELECT COUNT(*) AS n FROM patients"), 2, "the earlier sample stays, no third patient");
  });

  it("tops up fluid days missing from an earlier import, once, without touching other days", async () => {
    const { topUpAppaFluids } = await import("../lib/import_appa");
    const fluidDays = () => count("SELECT COUNT(DISTINCT date(observed_at / 1000, 'unixepoch', '+330 minutes')) AS n FROM observations WHERE patient_id = 'p_hand' AND type IN ('fluid_in','urine_out')");
    const full = fluidDays();
    run("DELETE FROM observations WHERE patient_id = 'p_hand' AND type IN ('fluid_in','urine_out') AND observed_at < ?", Date.parse("2025-09-01T00:00:00+05:30")); // as imported before the fluid IO sheet
    run("DELETE FROM settings WHERE key = 'sample:appa:fluids-v2'");
    assert.ok(fluidDays() < full);
    assert.ok(topUpAppaFluids() > 0);
    assert.equal(fluidDays(), full);
    assert.equal(topUpAppaFluids(), 0, "runs once");
  });

  it("Ask the record can chart and read fluid intake, urine output and water-tablet doses", async () => {
    const ask = await import("../lib/askrecord");
    assert.deepEqual(ask.questionSeries("How has fluid input and output been?"), ["fluid_in", "urine_out"]);
    assert.deepEqual(ask.questionSeries("weight against the Lasix dose"), ["diuretic", "weight"]);
    const t = Date.parse("2026-09-15T12:00:00+05:30");
    const chart = ask.buildChart("p_hand", ["fluid_in", "urine_out", "diuretic"], 730, t)!;
    assert.deepEqual(chart.panels.map((p) => p.name), ["fluid_in", "urine_out", "diuretic"]);
    assert.ok(chart.panels[0].points.length > 200);
    const ctx = ask.buildContext("p_hand", t) as { fluidPerDay: [string, number | null, number | null][]; diureticPerDay: unknown[] };
    assert.ok(ctx.fluidPerDay.length > 30);
    assert.deepEqual(ctx.fluidPerDay.at(-1), ["2026-09-10", 850, 650]);
  });

  it("keeps the lab sheet's colours (red / yellow) on imported values, and adds them to earlier imports once", async () => {
    const { topUpAppaLabMarks } = await import("../lib/import_appa");
    const marks = () => Object.fromEntries(all<{ mark: string; n: number }>("SELECT mark, COUNT(*) AS n FROM labs WHERE patient_id = 'p_hand' AND mark IS NOT NULL GROUP BY mark").map((r) => [r.mark, r.n]));
    assert.deepEqual(marks(), { red: 131, yellow: 4 });
    run("UPDATE labs SET mark = NULL WHERE patient_id = 'p_hand'"); // as imported before colours were carried over
    run("DELETE FROM settings WHERE key = 'sample:appa:labmarks'");
    assert.ok(topUpAppaLabMarks() >= 135);
    assert.deepEqual(marks(), { red: 131, yellow: 4 });
    assert.equal(topUpAppaLabMarks(), 0, "runs once");
  });
});
