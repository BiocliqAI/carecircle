import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Create isolated database for summary test suite
const tmpDb = path.join(os.tmpdir(), `carecircle-test-summary-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.CARECIRCLE_DB = tmpDb;
delete process.env.GEMINI_API_KEY;

const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { intervalSummary, visitDiff, longRange } = await import("../lib/summary");
const { now } = await import("../lib/clock");
const { DAY } = await import("../lib/time");

describe("Summary & Visit-to-Visit Analytics", () => {
  before(async () => {
    await seedDemo();
  });

  after(() => {
    fs.rmSync(tmpDb, { force: true });
  });

  describe("Interval Summary - Patient Analytics", () => {
    it("computes overall adherence percentages across medicines, vitals, physio", () => {
      const v1 = engine.latestVisit("p_ramesh")!;
      const s = intervalSummary("p_ramesh", v1.visit_at, now());

      assert.ok(s.overall.meds !== null);
      assert.ok(s.overall.meds! >= 70 && s.overall.meds! <= 100);

      assert.ok(s.overall.monitoring !== null);
      assert.ok(s.overall.monitoring! >= 50);

      assert.ok(s.overall.physio !== null);
    });

    it("breaks down adherence per medication with day status mapping", () => {
      const v1 = engine.latestVisit("p_ramesh")!;
      const s = intervalSummary("p_ramesh", v1.visit_at, now());

      assert.ok(s.adherence.length > 0);
      const telmi = s.adherence.find((a) => a.key === "med:telmisartan");
      assert.ok(telmi, "Telmisartan adherence row should exist");
      assert.ok(telmi.due > 0);
      assert.ok(telmi.done > 0);
      assert.ok(telmi.pct !== null);

      // Check daily status mapping contains valid values
      const dayValues = Object.values(telmi.byDay);
      assert.ok(dayValues.length > 0);
      for (const st of dayValues) {
        assert.ok(["all", "partial", "none", "pending"].includes(st));
      }
    });

    it("aggregates vitals statistics: count, avg, min, max, and series", () => {
      const v1 = engine.latestVisit("p_ramesh")!;
      const s = intervalSummary("p_ramesh", v1.visit_at, now());

      const bp = s.vitals.find((v) => v.type === "bp");
      assert.ok(bp, "Blood pressure vital stats should exist");
      assert.ok(bp.count >= 20, "Should have regular BP readings");
      assert.ok(bp.avg !== null && bp.avg > 110 && bp.avg < 160);
      assert.ok(bp.min !== null && bp.max !== null && bp.min <= bp.max);
      assert.ok(bp.series.length === bp.count);
    });

    it("tracks symptoms, symptom-free days, and lifestyle", () => {
      const v1 = engine.latestVisit("p_ramesh")!;
      const s = intervalSummary("p_ramesh", v1.visit_at, now());

      assert.ok(Array.isArray(s.symptoms));
      assert.ok(s.symptomFreeDays >= 0);
      assert.ok(s.lifestyle.ok >= 0);
      assert.ok(s.lifestyle.notOk >= 0);
    });

    it("generates clinical highlights with appropriate tones (good/warn/bad/info)", () => {
      const v1 = engine.latestVisit("p_ramesh")!;
      const s = intervalSummary("p_ramesh", v1.visit_at, now());

      assert.ok(s.highlights.length > 0);
      for (const h of s.highlights) {
        assert.ok(["good", "warn", "bad", "info"].includes(h.tone));
        assert.ok(h.text.length > 0);
      }
    });

    it("includes kidney summary for kidney patients (A Gopal) and null for others", () => {
      const vGopal = engine.latestVisit("p_gopal")!;
      const sGopal = intervalSummary("p_gopal", vGopal.visit_at, now());
      assert.ok(sGopal.kidney !== null, "Kidney summary should be present for Gopal");
      assert.equal(sGopal.kidney!.limit, 1000);
      assert.ok(sGopal.kidney!.weightBand !== null);
      assert.equal(sGopal.kidney!.weightBand!.dry, 59.2);
      assert.ok(sGopal.kidney!.labs.length > 0);

      const vSunita = engine.latestVisit("p_sunita")!;
      const sSunita = intervalSummary("p_sunita", vSunita.visit_at, now());
      assert.equal(sSunita.kidney, null, "Sunita does not have a kidney care plan");
    });
  });

  describe("Visit-to-Visit Diff (Pre-Consultation Diff Engine)", () => {
    it("detects added, removed, changed, and unchanged medications between visits", () => {
      const v1 = engine.latestVisit("p_ramesh")!;
      const newPlan = {
        ...v1.plan,
        medications: [
          ...v1.plan.medications.filter((m) => m.key !== "metformin" && m.key !== "telmisartan"),
          { key: "telmisartan", name: "Telmisartan", dose: "80 mg", times: ["08:00"] }, // dose changed
          { key: "empagliflozin", name: "Empagliflozin", dose: "10 mg", times: ["08:00"] }, // added
        ],
      };

      const v2Id = engine.createVisit(
        "p_ramesh",
        "u_dr_rao",
        {
          vitals: { sys: 132, dia: 82, weight: 76.5, hr: 70, glucose: 125 },
          diagnosis: "Hypertension · Heart failure (EF 35%) · Type 2 diabetes — stable",
          notes: "Blood pressure and sugar controlled on new regimen.",
          plan: newPlan,
          next_visit_at: now() + 60 * DAY,
        },
        now() + 1000
      );

      const v2 = engine.getVisit(v2Id)!;
      const diff = visitDiff(v1, v2);

      // Verify medication diff
      const added = diff.meds.find((m) => m.name === "Empagliflozin");
      assert.ok(added);
      assert.equal(added.change, "added");
      assert.equal(added.before, null);
      assert.ok(added.after!.includes("10 mg"));

      const removed = diff.meds.find((m) => m.name.toLowerCase().includes("metformin"));
      assert.ok(removed);
      assert.equal(removed.change, "removed");
      assert.equal(removed.after, null);

      const changed = diff.meds.find((m) => m.name === "Telmisartan");
      assert.ok(changed);
      assert.equal(changed.change, "changed");
    });

    it("calculates clinic vitals deltas and flags improvements (lowerBetter)", () => {
      const visits = engine.getVisits("p_ramesh");
      assert.ok(visits.length >= 2);
      const diff = visitDiff(visits[0], visits[1]);

      const bpDiff = diff.vitals.find((v) => v.key === "bp");
      assert.ok(bpDiff);
      assert.ok(bpDiff.delta !== null);
      assert.equal(bpDiff.better, bpDiff.delta! < 0);

      const wtDiff = diff.vitals.find((v) => v.key === "weight");
      assert.ok(wtDiff);
      if (wtDiff.delta !== null && wtDiff.delta !== 0) {
        assert.equal(wtDiff.better, wtDiff.delta < 0);
      }
    });

    it("detects threshold changes between visits", () => {
      const v1 = engine.latestVisit("p_ramesh")!;
      const v2Id = engine.createVisit(
        "p_ramesh",
        "u_dr_rao",
        {
          vitals: v1.vitals,
          diagnosis: v1.diagnosis,
          notes: v1.notes,
          plan: {
            ...v1.plan,
            thresholds: {
              ...v1.plan.thresholds,
              sysHigh: 140, // tightened from 150
            },
          },
          next_visit_at: null,
        },
        now() + 5000
      );

      const v2 = engine.getVisit(v2Id)!;
      const diff = visitDiff(v1, v2);

      const sysDiff = diff.thresholds.find((t) => t.label === "Systolic upper limit");
      assert.ok(sysDiff);
      assert.equal(sysDiff.before, 150);
      assert.equal(sysDiff.after, 140);
    });
  });

  describe("Long Range Multi-Visit Kidney History", () => {
    it("returns complete historical trajectory of labs, dry weight, fluids, and visits", () => {
      const lr = longRange("p_gopal");
      assert.ok(lr.visits.length >= 2, "Gopal should have multiple historical visits");
      assert.ok(lr.labs.length > 0, "Gopal should have historical lab series");
      assert.ok(lr.weight.length > 0, "Gopal should have historical weights");
      assert.ok(lr.diuretic.length > 0, "Gopal should have diuretic tracking");
      assert.equal(lr.dryWeight, 59.2);
    });
  });
});
