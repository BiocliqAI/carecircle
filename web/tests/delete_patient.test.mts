import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-delete-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;

const { all, get } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const { deletePatient } = await import("../lib/records");
const { now } = await import("../lib/clock");

const TABLES = ["visits", "observations", "labs", "tasks", "messages", "escalations", "caregivers", "consents", "care_team", "patient_documents", "med_changes"];
const rows = (pid: string) => Object.fromEntries(TABLES.map((t) => [t, get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE patient_id = ?`, pid)!.n]));

describe("deleting a patient", () => {
  before(async () => { await seedDemo(); });

  it("removes the patient's whole record, their caregivers' accounts, and leaves other patients untouched", () => {
    const before = rows("p_sunita");
    assert.ok(rows("p_ramesh").visits > 0 && rows("p_ramesh").observations > 0);
    const cgs = all<{ user_id: string }>("SELECT user_id FROM caregivers WHERE patient_id = 'p_ramesh'").map((c) => c.user_id);

    assert.deepEqual(deletePatient("p_ramesh", now(), "u_dr_rao"), { name: "Ramesh Kumar" });

    assert.equal(get("SELECT 1 FROM patients WHERE id = 'p_ramesh'"), undefined);
    assert.deepEqual(Object.values(rows("p_ramesh")).filter((n) => n > 0), []);
    for (const u of ["u_ramesh", ...cgs]) {
      assert.equal(get("SELECT 1 FROM users WHERE id = ?", u), undefined, u);
      assert.equal(get("SELECT 1 FROM messages WHERE user_id = ?", u), undefined, u);
    }
    assert.deepEqual(rows("p_sunita"), before);
    assert.ok(get("SELECT 1 FROM audit WHERE action = 'PATIENT_DELETED' AND entity_id = 'p_ramesh'"));
  });

  it("refuses an unknown patient", () => {
    assert.throws(() => deletePatient("p_nobody", now(), "u_dr_rao"), /not found/i);
  });
});
