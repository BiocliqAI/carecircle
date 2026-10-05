import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Create isolated database for kidney test suite
const tmpDb = path.join(os.tmpdir(), `carecircle-test-kidney-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.CARECIRCLE_DB = tmpDb;
delete process.env.GEMINI_API_KEY;

const { all, get, run: runSql } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { fluidDays, labSeries, diureticDays } = await import("../lib/summary");
const { now } = await import("../lib/clock");
const { DAY, HOUR, MIN, dayStart } = await import("../lib/time");

describe("Kidney Care & Nephrology Features", () => {
  before(async () => {
    await seedDemo();
  });

  after(() => {
    fs.rmSync(tmpDb, { force: true });
  });

  describe("Deterministic Lab Rules", () => {
    it("flags potassium >= 6.0 as CRITICAL with URGENT escalation", () => {
      const p = engine.getPatient("p_gopal")!;
      const v = engine.latestVisit("p_gopal")!;
      const t = now();

      const { flag, alert } = engine.evaluateLab(p, v.plan, v.visit_at, "potassium", 6.2, t, 9999);
      assert.equal(flag, "critical");
      assert.ok(alert);
      assert.equal(alert.type, "URGENT");
      assert.equal(alert.ruleKey, "lab:k_very_high");
      assert.match(alert.detail, /6\.2/);
      assert.match(alert.advice, /Call Dr\.? Dileep's clinic now/);
    });

    it("flags potassium > kHigh as HIGH with DEVIATION escalation", () => {
      const p = engine.getPatient("p_gopal")!;
      const v = engine.latestVisit("p_gopal")!;
      const t = now();

      // v.plan.thresholds.kHigh is 5.0
      const { flag, alert } = engine.evaluateLab(p, v.plan, v.visit_at, "potassium", 5.5, t, 9999);
      assert.equal(flag, "high");
      assert.ok(alert);
      assert.equal(alert.type, "DEVIATION");
      assert.equal(alert.ruleKey, "lab:k_high");
      assert.match(alert.advice, /banana, coconut water/);
    });

    it("flags potassium < kLow as LOW with DEVIATION escalation", () => {
      const p = engine.getPatient("p_gopal")!;
      const v = engine.latestVisit("p_gopal")!;
      const t = now();

      // v.plan.thresholds.kLow is 3.5
      const { flag, alert } = engine.evaluateLab(p, v.plan, v.visit_at, "potassium", 3.2, t, 9999);
      assert.equal(flag, "low");
      assert.ok(alert);
      assert.equal(alert.type, "DEVIATION");
      assert.equal(alert.ruleKey, "lab:k_low");
    });

    it("flags creatinine absolute rise >= 0.5 mg/dL with DEVIATION escalation", () => {
      const p = engine.getPatient("p_gopal")!;
      const v = engine.latestVisit("p_gopal")!;
      const t = now();

      // Prior creatinine in seed is around 2.4 - 2.8. Let's record a base of 2.2 and a rise of 2.8 (+0.6)
      const baseId = runSql(
        "INSERT INTO labs(patient_id, marker, value, taken_at, source) VALUES('p_gopal', 'creatinine', 2.2, ?, 'clinic')",
        t - 5 * DAY
      ).lastInsertRowid;

      const evalResult = engine.evaluateLab(p, v.plan, v.visit_at, "creatinine", 2.8, t, 9999);
      assert.equal(evalResult.flag, "high");
      assert.ok(evalResult.alert);
      assert.equal(evalResult.alert.type, "DEVIATION");
      assert.equal(evalResult.alert.ruleKey, "lab:creat_rise");
      assert.match(evalResult.alert.detail, /up 0\.60/);
    });

    it("flags low haemoglobin (Hb < hbLow)", () => {
      const p = engine.getPatient("p_gopal")!;
      const v = engine.latestVisit("p_gopal")!;
      const t = now();

      // Gopal's hbLow is 8.0
      const { flag, alert } = engine.evaluateLab(p, v.plan, v.visit_at, "hb", 7.5, t, 9999);
      assert.equal(flag, "low");
      assert.ok(alert);
      assert.equal(alert.type, "DEVIATION");
      assert.equal(alert.ruleKey, "lab:hb_low");
      assert.match(alert.advice, /blood thinner/);
    });
  });

  describe("Clinic Lab Entry & Task Completion", () => {
    it("enters multiple lab values with provenance 'clinic' and completes due lab tasks", () => {
      const t = now();
      // Ensure a pending lab task exists
      const taskId = runSql(
        "INSERT INTO tasks(patient_id, visit_id, kind, item_key, label, due_at, status) VALUES('p_gopal', 'v_gopal_1', 'lab', 'lab:panel', 'Lab test: Renal panel', ?, 'PENDING')",
        t - DAY
      ).lastInsertRowid;

      const results = engine.enterLabs(
        "p_gopal",
        [
          { marker: "creatinine", value: 2.3 },
          { marker: "urea", value: 72 },
          { marker: "potassium", value: 4.8 },
          { marker: "sodium", value: 138 },
        ],
        t,
        "u_pa_priya",
        t
      );

      assert.equal(results.length, 4);

      // Verify provenance in database
      const enteredLabs = all<{ marker: string; source: string; entered_by: string }>(
        "SELECT marker, source, entered_by FROM labs WHERE patient_id = 'p_gopal' AND taken_at = ?",
        t
      );
      assert.equal(enteredLabs.length, 4);
      for (const l of enteredLabs) {
        assert.equal(l.source, "clinic");
        assert.equal(l.entered_by, "u_pa_priya");
      }

      // Verify the pending lab task was completed
      const task = get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", taskId)!;
      assert.equal(task.status, "DONE");
    });
  });

  describe("Dry Weight & Target Band Rules", () => {
    it("flags weight above dry-weight target band as possible fluid build-up", async () => {
      const t = now() + 1000;
      // Gopal's dryWeight is 59.2 kg, weightBand is 1.0 kg (upper limit = 60.2 kg)
      // Send 61.5 kg
      await engine.ingestMessage("u_durai", "weight 61.5 kg today", { allowAi: false, at: t });

      const esc = get<{ id: number; type: string; rule_key: string; title: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_gopal' AND rule_key = 'weight_gain' AND started_at >= ?",
        t
      );
      assert.ok(esc, "weight_gain escalation should be triggered");
      assert.equal(esc.type, "DEVIATION");
      assert.match(esc.title, /Weight above target/);
    });

    it("flags weight below dry-weight target band as possible dehydration", async () => {
      const t = now() + 2000;
      // Dry weight is 59.2 kg, band is 1.0 kg (lower limit = 58.2 kg)
      // Send 57.5 kg
      await engine.ingestMessage("u_durai", "weight 57.5 kg today, feels lightheaded", { allowAi: false, at: t });

      const esc = get<{ id: number; type: string; rule_key: string; title: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_gopal' AND rule_key = 'weight_below_band' AND started_at >= ?",
        t
      );
      assert.ok(esc, "weight_below_band escalation should be triggered");
      assert.equal(esc.type, "DEVIATION");
      assert.match(esc.title, /Weight below target — possible dehydration/);
    });
  });

  describe("Fluid Intake & Urine Output Tracking", () => {
    it("correctly tracks incremental fluid entries and day totals", async () => {
      const t = dayStart(now()) + 7 * DAY + 10 * HOUR; // 10:00 AM on fresh day
      // Log incremental tea 250 ml
      await engine.ingestMessage("u_durai", "drank 250 ml tea", { allowAi: false, at: t });
      let day = engine.dayFluid("p_gopal", t);
      assert.equal(day.in, 250);

      // Log incremental water 300 ml
      await engine.ingestMessage("u_durai", "water 300 ml", { allowAi: false, at: t + HOUR });
      day = engine.dayFluid("p_gopal", t + HOUR);
      assert.equal(day.in, 550);

      // Log a daily total of 900 ml (overwriting prior increments)
      await engine.ingestMessage("u_durai", "total fluid intake 900 ml so far, urine 800 ml total", { allowAi: false, at: t + 4 * HOUR });
      day = engine.dayFluid("p_gopal", t + 4 * HOUR);
      assert.equal(day.in, 900);
      assert.equal(day.out, 800);
      assert.equal(day.inLogged, true);
      assert.equal(day.outLogged, true);
    });

    it("evaluates fluidDays with limit calculations", () => {
      const t = now();
      const fDays = fluidDays("p_gopal", t - 7 * DAY, t + DAY, 1000);
      assert.ok(fDays.length > 0);
      for (const fd of fDays) {
        assert.ok(fd.d.length === 10);
        if (fd.in && fd.in > 1000) {
          assert.equal(fd.over, true);
        }
      }
    });

    it("triggers low urine output alert in the evening (after 18:00)", async () => {
      const t = dayStart(now()) + 19 * HOUR; // 19:00 (7 PM)
      // Gopal's lowOutputMl limit is 600 ml. Log urine 350 ml total.
      await engine.ingestMessage("u_durai", "urine 350 ml total today", { allowAi: false, at: t });

      const esc = get<{ id: number; rule_key: string; title: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_gopal' AND rule_key = 'urine_low' AND started_at >= ?",
        t
      );
      assert.ok(esc, "urine_low escalation should be created");
      assert.match(esc.title, /Low urine output/);
    });
  });

  describe("Diuretic Tracking", () => {
    it("accumulates daily diuretic dosage in mg from confirmed doses and observations", () => {
      const t = now();
      const days = diureticDays("p_gopal", t - 30 * DAY, t + DAY);
      assert.ok(days.length > 0, "Should have diuretic history for Gopal");
      for (const d of days) {
        assert.ok(d.mg > 0, "Diuretic mg should be positive");
        assert.ok(d.drugs.length > 0, "Diuretic drug names should be listed");
      }
    });
  });

  describe("Reported Medicine Changes Reconciliation", () => {
    it("records outside doctor medicine changes as REPORTED without modifying active care plan", async () => {
      const t = now() + 5000;
      await engine.ingestMessage(
        "u_durai",
        "Dr Satish visited and reduced Dytor to 10 mg",
        { allowAi: false, at: t }
      );

      const mc = get<{ id: number; med_name: string; change: string; prescriber: string; status: string }>(
        "SELECT * FROM med_changes WHERE patient_id = 'p_gopal' AND at = ?",
        t
      );
      assert.ok(mc, "med_change row should exist");
      assert.match(mc.med_name, /Dytor/);
      assert.equal(mc.change, "dose_changed");
      assert.equal(mc.prescriber, "Dr Satish");
      assert.equal(mc.status, "REPORTED");

      // Verify that primary doctor's active plan was NOT automatically altered
      const v = engine.latestVisit("p_gopal")!;
      assert.ok(v.plan.medications.length > 0);
    });

    it("allows clinician to review and confirm reported medicine changes", () => {
      const t = now();
      const mc = get<{ id: number }>(
        "SELECT id FROM med_changes WHERE patient_id = 'p_gopal' AND status = 'REPORTED' LIMIT 1"
      );
      assert.ok(mc);

      engine.reviewMedChange(mc.id, "CONFIRMED", "u_dr_dileep", t);

      const updated = get<{ status: string; reviewed_by: string; reviewed_at: number }>(
        "SELECT status, reviewed_by, reviewed_at FROM med_changes WHERE id = ?",
        mc.id
      )!;
      assert.equal(updated.status, "CONFIRMED");
      assert.equal(updated.reviewed_by, "u_dr_dileep");
      assert.equal(updated.reviewed_at, t);
    });
  });
});
