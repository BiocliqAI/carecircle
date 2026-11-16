import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-keylabs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { get, run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { keyLabs } = await import("../lib/keylabs");
const { LAB_META } = await import("../lib/types");

const day = (d: string) => Date.parse(`${d}T09:00:00+05:30`);
describe("key labs on the chart", () => {
  it("takes the relevant tests from the last two lab reports, abnormal first, with the value before", async () => {
    await seedDemo();
    const doctor = get<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR' LIMIT 1")!;
    const pid = engine.onboardPatient({ name: "Key Labs", age: 70, sex: "M", phone: "+91 90000 55511", conditions: "", address: "", doctorId: doctor.id, caregivers: [{ name: "A", relation: "Son", phone: "+91 90000 55519", level: 1, dashboard: true }] }, Date.now(), doctor.id);
    LAB_META.lvidd = { label: "LV internal diameter in diastole (LVID d) — Echo", unit: "mm", learned: true };
    LAB_META.crp = { label: "CRP", unit: "mg/L", learned: true };
    LAB_META.esr_x = { label: "ESR (learned)", unit: "mm/hr", learned: true };
    const lab = (m: string, v: number, d: string, flag: string | null = null) => run("INSERT INTO labs(patient_id, marker, value, taken_at, source, flag) VALUES(?,?,?,?,?,?)", pid, m, v, day(d), "DOCUMENT", flag);
    // An old report, the previous one, the latest one, and an echo after them all.
    lab("creatinine", 1.6, "2026-01-10"); lab("sodium", 140, "2026-01-10"); lab("ldl", 90, "2026-01-10");
    lab("creatinine", 1.9, "2026-06-01"); lab("potassium", 4.6, "2026-06-01"); lab("hb", 10.8, "2026-06-01"); lab("crp", 4, "2026-06-01");
    lab("creatinine", 2.17, "2026-10-20"); lab("egfr", 30, "2026-10-20"); lab("potassium", 5.6, "2026-10-20", "high"); lab("tsh", 2.1, "2026-10-20");
    lab("crp", 40, "2026-10-20", "high"); lab("esr_x", 30, "2026-10-20");
    lab("lvidd", 49, "2026-11-13");

    const k = keyLabs(pid, 5);
    assert.equal(new Date(k.latestAt!).toISOString().slice(0, 10), "2026-10-20", "the echo isn't a lab report");
    assert.equal(new Date(k.previousAt!).toISOString().slice(0, 10), "2026-06-01");
    assert.deepEqual(k.rows.map((r) => r.marker), ["potassium", "crp", "creatinine", "egfr", "hb"], "abnormal first, then by importance");
    const cr = k.rows.find((r) => r.marker === "creatinine")!;
    assert.deepEqual([cr.value, cr.prev], [2.17, 1.9]);
    assert.equal(k.rows.find((r) => r.marker === "hb")!.prev, null, "Hb only in the previous report: shown with its own date");
    assert.ok(!k.rows.some((r) => r.marker === "lvidd" || r.marker === "esr_x" || r.marker === "ldl"), "no imaging, no unflagged learned tests, nothing older than the two reports");
    assert.equal(k.more, 1, "TSH is in the reports but past the limit");
    assert.deepEqual(keyLabs("nobody"), { latestAt: null, previousAt: null, rows: [], more: 0 });
  });
});
