import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-askhist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;

const { get } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const ask = await import("../lib/askrecord");
const { generateClinicalSummary } = await import("../lib/gemini");
const { deletePatient } = await import("../lib/records");
const { now } = await import("../lib/clock");

describe("questions asked about a record", () => {
  before(async () => { await seedDemo(); });

  it("are kept with their answer, who asked, and the chart (redrawn when reopened)", async () => {
    const t = now();
    const a = await ask.askRecord("p_ramesh", "How has BP been over the last 2 months?", t);
    const id = ask.saveQuestion("p_ramesh", "u_dr_rao", "How has BP been over the last 2 months?", a, t);
    const [first] = ask.listQuestions("p_ramesh");
    assert.equal(first.id, id);
    assert.equal(first.by, "Dr. Meera Rao");
    assert.equal(first.answer, a.answer);
    const one = ask.getQuestion("p_ramesh", id)!;
    assert.deepEqual(one.chart?.panels.map((p) => p.name), ["bp"]);
    assert.equal(ask.getQuestion("p_sunita", id), null, "only within the same patient");
  });

  it("are removed with the patient", () => {
    deletePatient("p_ramesh", now(), "u_dr_rao");
    assert.equal(get("SELECT 1 FROM record_questions WHERE patient_id = 'p_ramesh'"), undefined);
  });
});

describe("AI summary without AI", () => {
  it("is short bullets taken from the record, with nothing made up", async () => {
    const s = await generateClinicalSummary("p_sunita");
    assert.equal(s.source, "clinical-rules-engine");
    assert.ok(s.executiveSummary.length < 160);
    assert.ok(s.bullets!.length > 0 && s.bullets!.length <= 8);
    const text = [s.executiveSummary, ...s.bullets!, ...s.consultationDiscussionPoints].join(" ");
    for (const invented of ["Manoj Shah", "Prizide", "2.85", "family gatherings", "Mom"]) assert.ok(!text.includes(invented), invented);
  });
});
