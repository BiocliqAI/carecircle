import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-appa-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.CARECIRCLE_MODE = "live";
delete process.env.GEMINI_API_KEY;
delete process.env.CARECIRCLE_SAMPLE_PATIENT;

const { get, run } = await import("../lib/db");
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
});
