import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const tmpDb = path.join(os.tmpdir(), `carecircle-test-gemini-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.CARECIRCLE_DB = tmpDb;

const { run, get, all, resetDb } = await import("../lib/db.js");
const { seedDemo } = await import("../lib/seed.js");
const {
  getGeminiApiKey,
  setGeminiApiKey,
  isGeminiConfigured,
  getGeminiModel,
  generateClinicalSummary,
  analyzeDocumentOCR,
} = await import("../lib/gemini.js");
const { getPatient } = await import("../lib/engine.js");

describe("Gemini AI Integration & Capabilities", () => {
  before(async () => {
    resetDb();
    await seedDemo();
  });

  describe("API Key Configuration & Resolution", () => {
    it("reports configured state and supports runtime key persistence", () => {
      const origKey = getGeminiApiKey();
      setGeminiApiKey("AIzaSyTestMockKeyForCareCircle12345");
      assert.equal(isGeminiConfigured(), true);
      assert.equal(getGeminiApiKey(), "AIzaSyTestMockKeyForCareCircle12345");
      assert.equal(getGeminiModel(), "gemini-3.8-flash");

      // Reset
      if (origKey) setGeminiApiKey(origKey);
      else run("DELETE FROM settings WHERE key = 'gemini_api_key'");
    });
  });

  describe("Comprehensive Clinical AI Summary", () => {
    it("generates a medically accurate, 8-section structured clinical summary for A Gopal", async () => {
      const p = getPatient("p_gopal");
      assert.ok(p, "Patient A Gopal must exist");

      const summary = await generateClinicalSummary("p_gopal");
      assert.equal(summary.patientId, "p_gopal");
      assert.equal(summary.patientName, "A Gopal");

      // Check all 8 structured clinical sections
      assert.ok(summary.executiveSummary.length > 20, "Executive summary must be comprehensive");
      assert.ok(summary.clinicalTrajectory.length > 20, "Clinical trajectory must be present");
      assert.ok(summary.biometricAndFluidControl.length > 20, "Biometric & fluid control must be present");
      assert.ok(summary.renalMetabolicPanel.length > 20, "Renal metabolic panel must be present");
      assert.ok(summary.treatmentAdherence.length > 20, "Treatment adherence must be present");
      assert.ok(summary.careCircleEscalations.length > 20, "Care circle escalations must be present");
      assert.ok(summary.crossDoctorReconciliation.length > 20, "Cross-doctor reconciliation must be present");
      assert.ok(Array.isArray(summary.consultationDiscussionPoints), "Discussion points must be an array");
      assert.ok(summary.consultationDiscussionPoints.length >= 3, "At least 3 discussion points must be provided");

      // Check clinical content grounding
      assert.match(summary.biometricAndFluidControl, /fluid|weight|BP|kg/i);
      assert.match(summary.renalMetabolicPanel, /creatinine|potassium|eGFR|renal/i);
      assert.match(summary.crossDoctorReconciliation, /Dr\.|Prizide|Manoj Shah|medicine/i);
    });
  });

  describe("Computer Vision Document OCR & Intake", () => {
    it("extracts structured lab results from a handwritten / printed lab report", async () => {
      const result = await analyzeDocumentOCR({
        imageBase64: "SAMPLE_LAB_VIJAYA",
        mimeType: "image/png",
        patientId: "p_gopal",
      });

      assert.equal(result.documentType, "lab_report");
      assert.ok(result.transcription.includes("VIJAYA CLINICAL LABORATORIES"));
      assert.ok(result.extracted.labs.length >= 3);

      const creat = result.extracted.labs.find((l) => l.marker === "creatinine");
      assert.ok(creat, "Creatinine must be extracted");
      assert.equal(creat.value, 3.01);
      assert.equal(creat.unit, "mg/dL");
      assert.equal(creat.flag, "high");

      const k = result.extracted.labs.find((l) => l.marker === "potassium");
      assert.ok(k, "Potassium must be extracted");
      assert.equal(k.value, 4.9);
    });

    it("extracts handwritten prescription changes with doctor name and instructions", async () => {
      const result = await analyzeDocumentOCR({
        imageBase64: "SAMPLE_RX_MANOJ_SHAH",
        mimeType: "image/png",
        patientId: "p_gopal",
      });

      assert.equal(result.documentType, "handwritten_prescription");
      assert.equal(result.prescriber, "Dr. Manoj Shah");
      assert.ok(result.transcription.includes("Prizide MR 30 mg"));
      assert.ok(result.extracted.medications.length >= 1);

      const prizide = result.extracted.medications.find((m) => m.name.includes("Prizide"));
      assert.ok(prizide, "Prizide MR must be extracted");
      assert.equal(prizide.dose, "30 mg");
      assert.equal(prizide.change, "dose_changed");
      assert.equal(prizide.prescriber, "Dr. Manoj Shah");
    });

    it("extracts home monitoring diary readings (BP, weight, pulse, glucose)", async () => {
      const result = await analyzeDocumentOCR({
        imageBase64: "SAMPLE_DIARY_HOME",
        mimeType: "image/png",
        patientId: "p_gopal",
      });

      assert.equal(result.documentType, "vitals_diary");
      assert.ok(result.extracted.vitals.length >= 3);

      const bp = result.extracted.vitals.find((v) => v.type === "bp");
      assert.ok(bp, "BP must be extracted from home diary");
      assert.equal(bp.v1, 124);
      assert.equal(bp.v2, 66);

      const wt = result.extracted.vitals.find((v) => v.type === "weight");
      assert.ok(wt, "Weight must be extracted from home diary");
      assert.equal(wt.v1, 59.3);
    });
  });

  describe("Caregiver Escalation Hierarchy for A Gopal", () => {
    it("configures Mom as Level 1 caregiver and Durai as Level 2 caregiver", () => {
      const cgs = all<{ id: string; user_id: string; level: number; relation: string; name: string }>(
        `SELECT c.id, c.user_id, c.level, c.relation, u.name
         FROM caregivers c
         JOIN users u ON u.id = c.user_id
         WHERE c.patient_id = 'p_gopal'
         ORDER BY c.level ASC`
      );

      assert.equal(cgs.length, 2, "A Gopal must have exactly 2 caregivers");

      // Level 1: Mom
      assert.equal(cgs[0].level, 1, "Level 1 caregiver must be level 1");
      assert.equal(cgs[0].user_id, "u_mom", "Level 1 caregiver must be Mom");
      assert.equal(cgs[0].relation, "Wife", "Level 1 relation must be Wife");
      assert.equal(cgs[0].name, "Mom", "Level 1 name must be Mom");

      // Level 2: Durai
      assert.equal(cgs[1].level, 2, "Level 2 caregiver must be level 2");
      assert.equal(cgs[1].user_id, "u_durai", "Level 2 caregiver must be Durai");
      assert.equal(cgs[1].relation, "Caretaker", "Level 2 relation must be Caretaker");
      assert.equal(cgs[1].name, "Durai", "Level 2 name must be Durai");
    });
  });

  describe("API Endpoints: Settings & OCR Intake", () => {
    it("manages Gemini API key via /api/settings/gemini endpoint", async () => {
      const { GET, POST } = await import("../app/api/settings/gemini/route.js");
      const postReq = new Request("http://localhost/api/settings/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "AIzaSyLiveProductionTestingKey999" }),
      });
      const postRes = await POST(postReq);
      const postData = await postRes.json();
      assert.equal(postData.ok, true);

      const getReq = new Request("http://localhost/api/settings/gemini");
      const getRes = await GET(getReq);
      const getData = await getRes.json();
      assert.equal(getData.configured, true);
      assert.equal(getData.model, "gemini-3.8-flash");
      assert.ok(getData.maskedKey.startsWith("AIzaSy"));
    });

    it("processes and charts document OCR via /api/ocr for WhatsApp user", async () => {
      const { POST } = await import("../app/api/ocr/route.js");
      const req = new Request("http://localhost/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sampleId: "LAB_VIJAYA",
          userId: "u_gopal",
          commit: true,
        }),
      });

      const res = await POST(req);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.ok(data.committed.labs >= 1, "Labs must be committed to chart");

      // Verify that WhatsApp messages were inserted
      const lastMsgs = all<{ id: number; direction: string; body: string }>(
        "SELECT id, direction, body FROM messages WHERE user_id = 'u_gopal' ORDER BY id DESC LIMIT 2"
      );
      assert.equal(lastMsgs.length, 2);
      assert.equal(lastMsgs[0].direction, "OUT");
      assert.match(lastMsgs[0].body, /Document Received & Analyzed/);
      assert.equal(lastMsgs[1].direction, "IN");
      assert.match(lastMsgs[1].body, /Document Attached/);
    });
  });
});
