import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Create isolated database for escalations test suite
const tmpDb = path.join(os.tmpdir(), `carecircle-test-esc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.CARECIRCLE_DB = tmpDb;
delete process.env.GEMINI_API_KEY;

const { all, get } = await import("../lib/db");
const { seedDemo, RAMESH_PLAN } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { now, advanceClock, setSimNow } = await import("../lib/clock");
const { HOUR, MIN, DAY } = await import("../lib/time");

describe("Escalation Engine - Comprehensive Tests", () => {
  before(async () => {
    await seedDemo();
  });

  after(() => {
    fs.rmSync(tmpDb, { force: true });
  });

  describe("Doctor Invariant & Isolation", () => {
    it("strict safety invariant: doctors and PAs NEVER receive automated messages", () => {
      const doctorMsgs = all(
        "SELECT * FROM messages WHERE user_id IN (SELECT id FROM users WHERE role IN ('DOCTOR','PA')) AND direction = 'OUT'"
      );
      assert.equal(doctorMsgs.length, 0, "No doctor or PA should ever receive an outbound WhatsApp message");
    });

    it("doctor isolation: Dr Dileep sees only p_gopal, Dr Rao sees non-Gopal patients", () => {
      const dileepPts = engine.patientIdsForUser({ id: "u_dr_dileep", role: "DOCTOR", name: "Dr Dileep", phone: null, title: "Nephrologist" });
      assert.deepEqual(dileepPts, ["p_gopal"]);

      const raoPts = engine.patientIdsForUser({ id: "u_dr_rao", role: "DOCTOR", name: "Dr Rao", phone: null, title: "Cardiologist" });
      assert.ok(!raoPts.includes("p_gopal"), "Dr Rao must not see Dr Dileep's patient p_gopal");
      assert.ok(raoPts.includes("p_ramesh") && raoPts.includes("p_abdul") && raoPts.includes("p_sunita"));

      const paPts = engine.patientIdsForUser({ id: "u_pa_priya", role: "PA", name: "Priya", phone: null, title: "Physician Assistant" });
      assert.ok(paPts.includes("p_gopal") && paPts.includes("p_ramesh") && paPts.includes("p_abdul"));
    });
  });

  describe("Vitals Deviation Alerts", () => {
    it("triggers URGENT alert on hypertensive crisis (BP >= 180/110)", async () => {
      const t = now();
      await engine.ingestMessage("u_ramesh", "BP 185/115, feeling headache", { allowAi: false, at: t });

      const esc = get<{ id: number; type: string; rule_key: string; state: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = 'bp_crisis' AND started_at >= ?",
        t
      );
      assert.ok(esc, "bp_crisis escalation should be created");
      assert.equal(esc.type, "URGENT");
      assert.equal(esc.state, "NOTIFIED");

      // Verify Level 1 caregiver received urgent notification
      const l1Msg = get<{ body: string }>(
        "SELECT body FROM messages WHERE user_id = 'u_lakshmi' AND kind = 'escalation' AND created_at >= ?",
        t
      );
      assert.ok(l1Msg, "L1 caregiver should receive urgent alert");
      assert.match(l1Msg.body, /URGENT/);
    });

    it("triggers DEVIATION alert when BP exceeds care plan limits", async () => {
      const t = now() + 1000;
      await engine.ingestMessage("u_ramesh", "BP 155/96", { allowAi: false, at: t });
      // A borderline reading is rechecked first; a recheck that is still high alerts the care circle.
      assert.equal(get("SELECT 1 FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = 'bp_high' AND started_at >= ?", t), undefined, "held for a recheck");
      await engine.ingestMessage("u_ramesh", "BP 156/97", { allowAi: false, at: t + 10 * MIN });

      const esc = get<{ id: number; type: string; rule_key: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = 'bp_high' AND started_at >= ?",
        t
      );
      assert.ok(esc, "bp_high escalation should be created");
      assert.equal(esc.type, "DEVIATION");
    });

    it("triggers DEVIATION alert when BP is below care plan limits", async () => {
      const t = now() + 2000;
      await engine.ingestMessage("u_ramesh", "BP 88/56, feeling very weak", { allowAi: false, at: t });

      const esc = get<{ id: number; type: string; rule_key: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = 'bp_low' AND started_at >= ?",
        t
      );
      assert.ok(esc, "bp_low escalation should be created");
      assert.equal(esc.type, "DEVIATION");
    });

    it("triggers URGENT alert on severe hypoglycaemia (glucose < 54)", async () => {
      const t = now() + 3000;
      await engine.ingestMessage("u_ramesh", "sugar 46, sweating profusely", { allowAi: false, at: t });

      const esc = get<{ id: number; type: string; rule_key: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = 'glucose_very_low' AND started_at >= ?",
        t
      );
      assert.ok(esc, "glucose_very_low escalation should be created");
      assert.equal(esc.type, "URGENT");
    });

    it("triggers URGENT alert on dangerously low oxygen (SpO2 < 88)", async () => {
      const t = now() + 4000;
      await engine.ingestMessage("u_abdul", "oxygen 85%", { allowAi: false, at: t });

      const esc = get<{ id: number; type: string; rule_key: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_abdul' AND rule_key = 'spo2_very_low' AND started_at >= ?",
        t
      );
      assert.ok(esc, "spo2_very_low escalation should be created");
      assert.equal(esc.type, "URGENT");
    });

    it("triggers DEVIATION alert on high pain score (>= painHigh)", async () => {
      const t = now() + 5000;
      await engine.ingestMessage("u_sunita", "knee pain 8/10 today", { allowAi: false, at: t });

      const esc = get<{ id: number; type: string; rule_key: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_sunita' AND rule_key = 'pain_high' AND started_at >= ?",
        t
      );
      assert.ok(esc, "pain_high escalation should be created");
      assert.equal(esc.type, "DEVIATION");
    });
  });

  describe("Symptom Alerts & Red Flags", () => {
    it("raises URGENT alert for red flag symptoms: chest pain, fainting, confusion", async () => {
      const t = now() + 6000;
      await engine.ingestMessage("u_ramesh", "having chest pain since 20 mins", { allowAi: false, at: t });

      const esc = get<{ id: number; type: string; rule_key: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = 'sx:chest_pain' AND started_at >= ?",
        t
      );
      assert.ok(esc, "chest pain escalation should be created");
      assert.equal(esc.type, "URGENT");
    });

    it("raises DEVIATION alert for doctor-monitored watchSymptoms (e.g. edema)", async () => {
      const t = now() + 7000;
      await engine.ingestMessage("u_ramesh", "both feet are swollen today", { allowAi: false, at: t });

      const esc = get<{ id: number; type: string; rule_key: string }>(
        "SELECT * FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = 'sx:edema' AND started_at >= ?",
        t
      );
      assert.ok(esc, "edema escalation should be created");
      assert.equal(esc.type, "DEVIATION");
    });
  });

  describe("Alert Deduplication", () => {
    it("does not duplicate open alerts for the same rule_key, records REPEAT event instead", async () => {
      const t = now() + 8000;
      await engine.ingestMessage("u_sunita", "knee pain 9/10, hurts a lot", { allowAi: false, at: t });

      const openCount = get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM escalations WHERE patient_id = 'p_sunita' AND rule_key = 'pain_high' AND state = 'NOTIFIED'"
      )!.n;
      assert.equal(openCount, 1, "There should be exactly 1 open escalation for pain_high");

      const repeatEvent = get<{ id: number }>(
        "SELECT id FROM escalation_events WHERE event = 'REPEAT' AND actor = 'system' AND at >= ?",
        t
      );
      assert.ok(repeatEvent, "A REPEAT event should be recorded in escalation_events");
    });
  });

  describe("Caregiver ACK & Resolution Flow", () => {
    it("records ACK from caregiver and transitions to ACKNOWLEDGED", async () => {
      const t = now() + 9000;
      const openEsc = get<{ id: number }>(
        "SELECT id FROM escalations WHERE patient_id = 'p_sunita' AND rule_key = 'pain_high' AND state = 'NOTIFIED'"
      )!;
      assert.ok(openEsc);

      const err = engine.acknowledge(openEsc.id, "u_neha", t, "whatsapp");
      assert.equal(err, null);

      const updated = get<{ state: string; ack_by: string; ack_at: number }>(
        "SELECT state, ack_by, ack_at FROM escalations WHERE id = ?",
        openEsc.id
      )!;
      assert.equal(updated.state, "ACKNOWLEDGED");
      assert.equal(updated.ack_by, "u_neha");
      assert.equal(updated.ack_at, t);
    });

    it("resolves escalation with outcome code 1 (resolved at home)", async () => {
      const t = now() + 10_000;
      const openEsc = get<{ id: number }>(
        "SELECT id FROM escalations WHERE patient_id = 'p_sunita' AND rule_key = 'pain_high' AND state = 'ACKNOWLEDGED'"
      )!;

      const err = engine.resolveEscalation(openEsc.id, "u_neha", "1", "Applied ice pack, rested", t, "whatsapp");
      assert.equal(err, null);

      const resolved = get<{ state: string; outcome_code: string; outcome_note: string }>(
        "SELECT state, outcome_code, outcome_note FROM escalations WHERE id = ?",
        openEsc.id
      )!;
      assert.equal(resolved.state, "RESOLVED");
      assert.equal(resolved.outcome_code, "1");
      assert.equal(resolved.outcome_note, "Applied ice pack, rested");
    });
  });

  describe("Compliance Timeout & Auto-Resolution", () => {
    it("auto-resolves compliance escalation when missed task is completed late via WhatsApp", async () => {
      const t = now() + 11_000;
      const p = engine.getPatient("p_ramesh")!;

      // Insert a synthetic missed medication task
      const { run: runSql } = await import("../lib/db");
      const taskId = runSql(
        "INSERT INTO tasks(patient_id, visit_id, kind, item_key, label, due_at, status) VALUES('p_ramesh', 'v1', 'med', 'med:telmisartan', 'Telmisartan 40 mg', ?, 'MISSED')",
        t - 4 * HOUR
      ).lastInsertRowid;

      // Create a COMPLIANCE escalation for this missed task
      const escId = runSql(
        `INSERT INTO escalations(patient_id, type, rule_key, title, detail, advice, state, level, started_at, level_at, task_ids)
         VALUES('p_ramesh', 'COMPLIANCE', 'med', 'Medicines not logged', 'Telmisartan not confirmed', 'Please check in', 'NOTIFIED', 1, ?, ?, ?)`,
        t, t, JSON.stringify([taskId])
      ).lastInsertRowid;

      // Patient now sends message confirming Telmisartan taken
      await engine.ingestMessage("u_ramesh", "took telmisartan", { allowAi: false, at: t + 60_000 });

      // Verify the task was marked DONE (late)
      const task = get<{ status: string; late: number }>("SELECT status, late FROM tasks WHERE id = ?", taskId)!;
      assert.equal(task.status, "DONE");
      assert.equal(task.late, 1);

      // Verify the compliance escalation was auto-resolved
      const esc = get<{ state: string; outcome_code: string }>("SELECT state, outcome_code FROM escalations WHERE id = ?", escId)!;
      assert.equal(esc.state, "RESOLVED");
      assert.equal(esc.outcome_code, "AUTO");
    });
  });

  describe("Caregiver Miss / Timeout Escalation Flow", () => {
    it("offers 'Pass to <backup>' next to 'I'll handle it' and escalates from Level 1 Mom to Level 2 Durai when passed", async () => {
      const t = now() + 20_000;
      // Gopal logs significant weight spike
      await engine.ingestMessage("u_gopal", "weight 60.8 kg", { allowAi: false, at: t });

      // Find open escalation
      const esc = get<{ id: number; level: number; state: string }>(
        "SELECT id, level, state FROM escalations WHERE patient_id = 'p_gopal' AND state = 'NOTIFIED' AND started_at >= ?",
        t
      )!;
      assert.ok(esc, "Escalation should be created for Gopal's weight spike");
      assert.equal(esc.level, 1, "Should start at Level 1");

      // Verify Mom (Level 1) received WhatsApp with "I'll handle it" and "Pass to Durai" quick replies
      const momMsg = get<{ body: string; quick: string }>(
        "SELECT body, quick FROM messages WHERE user_id = 'u_mom' AND kind = 'escalation' AND created_at >= ? ORDER BY id DESC LIMIT 1",
        t
      )!;
      assert.ok(momMsg, "Mom should receive escalation message");
      const quickButtons = JSON.parse(momMsg.quick);
      assert.ok(quickButtons.includes("I'll handle it"), "Quick buttons should offer to take ownership");
      assert.ok(quickButtons.includes("Pass to Durai"), "Quick buttons should offer to pass it to the backup");

      // Mom passes the alert on
      await engine.ingestMessage("u_mom", "Pass to Durai", { allowAi: false, at: t + 1000 });

      // Verify escalation moved to Level 2 (Durai)
      const escAfterMiss = get<{ id: number; level: number; state: string }>(
        "SELECT id, level, state FROM escalations WHERE id = ?",
        esc.id
      )!;
      assert.equal(escAfterMiss.level, 2, "Escalation should move to Level 2");
      assert.equal(escAfterMiss.state, "NOTIFIED", "Should remain in NOTIFIED state for Level 2");

      // Verify Durai (Level 2) received the escalated WhatsApp
      const duraiMsg = get<{ body: string; quick: string }>(
        "SELECT body, quick FROM messages WHERE user_id = 'u_durai' AND kind = 'escalation' AND created_at >= ? ORDER BY id DESC LIMIT 1",
        t + 1000
      )!;
      assert.ok(duraiMsg, "Durai should receive escalated WhatsApp");
      assert.match(duraiMsg.body, /Mom couldn't take this and passed it to you/i);
      const duraiQuick = JSON.parse(duraiMsg.quick);
      assert.ok(duraiQuick.includes("I'll handle it"));
      assert.ok(!duraiQuick.some((q: string) => q.startsWith("Pass to")), "the last person in the circle has no one to pass to");

      // Durai also misses the alert
      await engine.ingestMessage("u_durai", "Miss", { allowAi: false, at: t + 2000 });

      // Verify escalation is now EXHAUSTED
      const escExhausted = get<{ id: number; state: string; outcome_code: string }>(
        "SELECT id, state, outcome_code FROM escalations WHERE id = ?",
        esc.id
      )!;
      assert.equal(escExhausted.state, "EXHAUSTED");
      assert.equal(escExhausted.outcome_code, "EXHAUSTED");
    });
  });
});
