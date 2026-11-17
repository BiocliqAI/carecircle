import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-ovsum-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const { getPatient, getUser } = await import("../lib/engine");
const { recordSummary } = await import("../lib/onboarding");
const { emptyHistory } = await import("../lib/historyspec");
const { getPrep, savePrep } = await import("../lib/prep");
const { now } = await import("../lib/clock");
const { keyVitals } = await import("../lib/keyvitals");

describe("patient overview summary", () => {
  before(async () => { await seedDemo(); });

  it("keeps a short reason for the visit with the preparation", () => {
    savePrep("p_gopal", { reason: "  Leg   swelling for 3 days " }, now(), "u_dr_dileep");
    assert.equal(getPrep("p_gopal").reason, "Leg swelling for 3 days");
    savePrep("p_gopal", { questions: "Can he travel?" }, now(), "u_dr_dileep");
    assert.equal(getPrep("p_gopal").reason, "Leg swelling for 3 days", "other edits leave it alone");
  });

  it("is empty until a history from the records has been confirmed", () => {
    assert.equal(recordSummary("p_gopal"), null);
  });

  it("gives the one-glance summary and the most recent visit to the treating doctor", () => {
    const treating = getUser(getPatient("p_gopal")!.doctor_id)!.name;
    const h = emptyHistory();
    (h.snapshot as Record<string, { text: string; sources: number[] }>).oneGlance = { text: "68-year-old man with CKD stage 4.", sources: [] };
    h.conditions = [{ name: "Anaemia", status: "stable", sources: [] }, { name: "Hypertension", diagnosed: "since 2010", sources: [] }, { name: "CKD stage 4", status: "Worsening, creatinine 2.85", diagnosed: "2019", treatment: "furosemide", sources: [] }, { name: "Gout", diagnosed: "March 2024", sources: [] }];
    h.visits = [
      { date: "2026-10-20", doctor: "Dr Other Person", specialty: "Cardiology", hospital: "", takeaway: "Echo reviewed", sources: [] },
      { date: "2026-09-12", doctor: treating, specialty: "Nephrology", hospital: "City Clinic", takeaway: "Leg swelling · Creatinine 2.6 · Increase furosemide", sources: [] },
      { date: "2026-06-01", doctor: treating, specialty: "Nephrology", hospital: "City Clinic", takeaway: "Routine review", sources: [] },
    ];
    h.medChanges = [{ date: "2026-09-12", drug: "Furosemide", change: "increased to 40 mg BD", reason: "oedema", by: treating, sources: [] }];
    const t = now();
    run("INSERT INTO onboardings(patient_id, status, draft, created_at, updated_at, confirmed_at) VALUES(?,?,?,?,?,?)", "p_gopal", "CONFIRMED",
      JSON.stringify({ summary: h, doctors: [], points: [], merges: [], labs: [], texts: [], homes: [] }), t, t, t);
    const r = recordSummary("p_gopal")!;
    assert.equal(r.oneGlance, "68-year-old man with CKD stage 4.");
    assert.deepEqual(r.conditions.map((c) => c.name), ["Gout", "CKD stage 4", "Hypertension", "Anaemia"], "newest diagnosis first, undated last");
    assert.deepEqual(r.conditions[1], { name: "CKD stage 4", status: "Worsening, creatinine 2.85", diagnosed: "2019", treatment: "furosemide", detail: "CKD stage 4 is worsening, creatinine 2.85. Diagnosed 2019. Current treatment: furosemide." });
    assert.equal(r.lastVisit?.date, "2026-09-12");
    assert.equal(r.lastVisit?.treating, true);
    assert.deepEqual(r.lastVisit?.changes, ["Furosemide increased to 40 mg BD (oedema)"]);
  });

  it("lists the most recent measurement of each vital, from home readings or the clinic", () => {
    const t = now();
    run("DELETE FROM observations WHERE patient_id = 'p_gopal' AND type = 'spo2'");
    run("INSERT INTO observations(patient_id, type, v1, v2, observed_at, flag) VALUES('p_gopal','bp',171,99,?,?)", t + 1000, "high");
    const rows = keyVitals("p_gopal");
    const bp = rows.find((x) => x.type === "bp")!;
    assert.deepEqual([bp.v1, bp.v2, bp.flag, bp.source], [171, 99, "high", "home"]);
    assert.equal(new Set(rows.map((x) => x.type)).size, rows.length, "one row per vital");
    assert.ok(rows.every((x) => x.source === "home" || x.source === "clinic" || x.source === "baseline"));
  });
});
