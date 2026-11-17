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
    h.conditions = [{ name: "CKD stage 4", status: "worsening", sources: [] }];
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
    assert.deepEqual(r.conditions, [{ name: "CKD stage 4", status: "worsening" }]);
    assert.equal(r.lastVisit?.date, "2026-09-12");
    assert.equal(r.lastVisit?.treating, true);
    assert.deepEqual(r.lastVisit?.changes, ["Furosemide increased to 40 mg BD (oedema)"]);
  });
});
