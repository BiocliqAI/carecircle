import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRules } from "../lib/parser";

const SAMPLE_MEDS = [
  { key: "telmisartan", name: "Telmisartan" },
  { key: "metformin", name: "Metformin" },
  { key: "atorvastatin", name: "Atorvastatin" },
  { key: "lasix", name: "Lasix" },
  { key: "prizide", name: "Prizide MR (gliclazide)" },
  { key: "concor", name: "Concor" },
  { key: "nodosis", name: "Nodosis" },
];

describe("Parser - Vitals & Measurements", () => {
  it("parses standard blood pressure formats", () => {
    const p1 = parseRules("BP 120/80, pulse 72", SAMPLE_MEDS);
    assert.deepEqual(p1.vitals.find((v) => v.type === "bp"), { type: "bp", v1: 120, v2: 80 });

    const p2 = parseRules("bp is 142 / 92 today", SAMPLE_MEDS);
    assert.deepEqual(p2.vitals.find((v) => v.type === "bp"), { type: "bp", v1: 142, v2: 92 });

    const p3 = parseRules("130/85", SAMPLE_MEDS);
    assert.deepEqual(p3.vitals.find((v) => v.type === "bp"), { type: "bp", v1: 130, v2: 85 });

    const p4 = parseRules("sys 135 dia 88", SAMPLE_MEDS);
    assert.deepEqual(p4.vitals.find((v) => v.type === "bp"), { type: "bp", v1: 135, v2: 88 });
  });
  it("parses BP written without a slash, but only right after the word BP", () => {
    for (const t of ["BP 130 80", "bp: 130-80", "Blood pressure 130,80 today", "BP 130\\80", "bp is 130 and 80"]) {
      assert.deepEqual(parseRules(t, SAMPLE_MEDS).vitals.find((v) => v.type === "bp"), { type: "bp", v1: 130, v2: 80 }, t);
    }
    const both = parseRules("BP 130 80, weight 72", SAMPLE_MEDS).vitals;
    assert.deepEqual(both.find((v) => v.type === "weight"), { type: "weight", v1: 72 });
    assert.equal(parseRules("weight 72 sugar 110", SAMPLE_MEDS).vitals.find((v) => v.type === "bp"), undefined);
    assert.equal(parseRules("BP 80 130", SAMPLE_MEDS).vitals.find((v) => v.type === "bp"), undefined); // top number must be higher
  });

  it("parses body weight accurately without false positives", () => {
    const p1 = parseRules("Weight 72.4 kg", SAMPLE_MEDS);
    assert.equal(p1.vitals.find((v) => v.type === "weight")?.v1, 72.4);

    const p2 = parseRules("wt: 59.2", SAMPLE_MEDS);
    assert.equal(p2.vitals.find((v) => v.type === "weight")?.v1, 59.2);

    const p3 = parseRules("60.5 kg weight", SAMPLE_MEDS);
    assert.equal(p3.vitals.find((v) => v.type === "weight")?.v1, 60.5);
  });

  it("parses blood glucose / sugar", () => {
    const p1 = parseRules("fasting sugar 118", SAMPLE_MEDS);
    assert.equal(p1.vitals.find((v) => v.type === "glucose")?.v1, 118);

    const p2 = parseRules("sugar 210 after lunch", SAMPLE_MEDS);
    assert.equal(p2.vitals.find((v) => v.type === "glucose")?.v1, 210);

    const p3 = parseRules("glucose: 145 mg/dl", SAMPLE_MEDS);
    assert.equal(p3.vitals.find((v) => v.type === "glucose")?.v1, 145);
  });

  it("parses pulse, spo2, temperature and pain correctly", () => {
    const p1 = parseRules("pulse 78, spo2 97%, temp 98.6 F", SAMPLE_MEDS);
    assert.equal(p1.vitals.find((v) => v.type === "hr")?.v1, 78);
    assert.equal(p1.vitals.find((v) => v.type === "spo2")?.v1, 97);
    assert.equal(p1.vitals.find((v) => v.type === "temp")?.v1, 98.6);

    const p2 = parseRules("Pain 6/10 in knee", SAMPLE_MEDS);
    assert.equal(p2.vitals.find((v) => v.type === "pain")?.v1, 6);
    // Ensure pain 6/10 is NOT misparsed as BP 6/10
    assert.equal(p2.vitals.find((v) => v.type === "bp"), undefined);
  });
});

describe("Parser - Medicines & Adherence", () => {
  it("detects all medicines taken", () => {
    const p1 = parseRules("Took all tablets today", SAMPLE_MEDS);
    assert.equal(p1.meds.allTaken, true);

    const p2 = parseRules("morning meds done ✅", SAMPLE_MEDS);
    assert.equal(p2.meds.allTaken, true);
  });

  it("detects all medicines missed", () => {
    const p = parseRules("forgot all tablets today", SAMPLE_MEDS);
    assert.equal(p.meds.allMissed, true);
  });

  it("handles exceptions and partial compliance", () => {
    const p = parseRules("Took all medicines except metformin and atorvastatin", SAMPLE_MEDS);
    assert.equal(p.meds.allTaken, false);
    assert.ok(p.meds.missed.includes("metformin"));
    assert.ok(p.meds.missed.includes("atorvastatin"));
    assert.ok(!p.meds.taken.includes("metformin"));
  });

  it("detects specific named medicines taken", () => {
    const p = parseRules("took lasix and telmisartan", SAMPLE_MEDS);
    assert.ok(p.meds.taken.includes("lasix"));
    assert.ok(p.meds.taken.includes("telmisartan"));
  });
});

describe("Parser - Symptoms & Negations", () => {
  it("extracts positive symptoms with severity", () => {
    const p = parseRules("ankles are slightly swollen, feeling very dizzy", SAMPLE_MEDS);
    assert.ok(p.symptoms.some((s) => s.key === "edema"));
    assert.ok(p.symptoms.some((s) => s.key === "dizziness"));
  });

  it("respects symptom negations and no-symptom statements", () => {
    const p1 = parseRules("no chest pain, no swelling, feeling fine", SAMPLE_MEDS);
    assert.equal(p1.symptoms.length, 0);

    const p2 = parseRules("took tablets, no symptoms today", SAMPLE_MEDS);
    assert.equal(p2.noSymptoms, true);
    assert.equal(p2.symptoms.length, 0);
  });

  it("handles symptom suppression (orthopnea suppresses breathlessness)", () => {
    const p = parseRules("breathless when lying flat at night", SAMPLE_MEDS);
    assert.ok(p.symptoms.some((s) => s.key === "orthopnea"));
    // Breathlessness should be suppressed when orthopnea is identified
    assert.ok(!p.symptoms.some((s) => s.key === "breathlessness"));
  });

  it("detects red flags and emergency words", () => {
    const p1 = parseRules("having severe chest pain since morning", SAMPLE_MEDS);
    assert.ok(p1.symptoms.some((s) => s.key === "chest_pain"));

    const p2 = parseRules("help please, patient collapsed and fainted", SAMPLE_MEDS);
    assert.equal(p2.help, true);
    assert.ok(p2.symptoms.some((s) => s.key === "fainting"));
  });
});

describe("Parser - Kidney Fluids & Urine Tracking", () => {
  it("parses incremental fluid intake and urine output", () => {
    const p = parseRules("drank 250 ml soup, urine 400 ml", SAMPLE_MEDS);
    assert.equal(p.fluids.length, 2);

    const intake = p.fluids.find((f) => f.kind === "in");
    assert.ok(intake);
    assert.equal(intake.ml, 250);
    assert.equal(intake.total, false);

    const urine = p.fluids.find((f) => f.kind === "out");
    assert.ok(urine);
    assert.equal(urine.ml, 400);
    assert.equal(urine.total, false);
  });

  it("parses daily totals accurately", () => {
    const p = parseRules("Water 950 ml total today, urine 850 ml total", SAMPLE_MEDS);
    assert.equal(p.fluids.length, 2);

    const intake = p.fluids.find((f) => f.kind === "in");
    assert.equal(intake?.ml, 950);
    assert.equal(intake?.total, true);

    const urine = p.fluids.find((f) => f.kind === "out");
    assert.equal(urine?.ml, 850);
    assert.equal(urine?.total, true);
  });

  it("resolves fluid kind based on nearest preceding keyword", () => {
    const p = parseRules("passed urine 600 ml, drank 200 ml water", SAMPLE_MEDS);
    const urine = p.fluids.find((f) => f.kind === "out");
    const intake = p.fluids.find((f) => f.kind === "in");
    assert.equal(urine?.ml, 600);
    assert.equal(intake?.ml, 200);
  });
});

describe("Parser - Kidney Labs", () => {
  it("parses multi-marker lab reports from text", () => {
    const p = parseRules("creat 2.1, urea 68, K 4.9, Na 136", SAMPLE_MEDS);
    assert.equal(p.labs.find((l) => l.marker === "creatinine")?.value, 2.1);
    assert.equal(p.labs.find((l) => l.marker === "urea")?.value, 68);
    assert.equal(p.labs.find((l) => l.marker === "potassium")?.value, 4.9);
    assert.equal(p.labs.find((l) => l.marker === "sodium")?.value, 136);
  });

  it("parses egfr, haemoglobin, and uric acid", () => {
    const p = parseRules("eGFR 28, Hb 9.2, uric acid 7.8", SAMPLE_MEDS);
    assert.equal(p.labs.find((l) => l.marker === "egfr")?.value, 28);
    assert.equal(p.labs.find((l) => l.marker === "hb")?.value, 9.2);
    assert.equal(p.labs.find((l) => l.marker === "uric_acid")?.value, 7.8);
  });
});

describe("Parser - Medicine Changes by Other Doctors", () => {
  it("parses dose reductions and prescribers", () => {
    const p = parseRules("Dr Manoj Shah reduced Prizide to 30 mg", SAMPLE_MEDS);
    assert.equal(p.medChanges.length, 1);
    const c = p.medChanges[0];
    assert.equal(c.medName, "Prizide MR (gliclazide)");
    assert.equal(c.change, "dose_changed");
    assert.match(c.detail, /30\s*mg/);
    assert.equal(c.prescriber, "Dr Manoj Shah");
    // Crucial: Prizide must NOT be added to taken/missed checklist
    assert.ok(!p.meds.taken.includes("prizide"));
    assert.ok(!p.meds.missed.includes("prizide"));
  });

  it("parses stopped medicines with prescriber", () => {
    const p = parseRules("Dr Satish stopped Dytor and started Lasix 40 mg", SAMPLE_MEDS);
    assert.ok(p.medChanges.length >= 1);
    const stopped = p.medChanges.find((c) => c.change === "stopped");
    assert.ok(stopped);
    assert.equal(stopped.prescriber, "Dr Satish");
  });
});

test("a plain 'breathless' is a symptom; 'less breathless' is improvement (the word 'breathless' contains 'less')", () => {
  assert.deepEqual(parseRules("a bit breathless today", []).symptoms.map((x) => x.key), ["breathlessness"]);
  assert.deepEqual(parseRules("breathless since morning", []).symptoms.map((x) => x.key), ["breathlessness"]);
  assert.deepEqual(parseRules("feeling less breathless now", []).symptoms.map((x) => x.key), []);
  assert.deepEqual(parseRules("breathlessness is better", []).symptoms.map((x) => x.key), []);
});
