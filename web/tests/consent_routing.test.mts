import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-consent-routing-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { all, get } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { userByPhone } = await import("../lib/whatsapp");
const { now } = await import("../lib/clock");

const status = (pid: string, uid: string) => get<{ status: string }>("SELECT status FROM consents WHERE patient_id = ? AND user_id = ?", pid, uid)?.status;
const SHARED = "+919800000009";

describe("a WhatsApp YES is recorded against the right consent request", () => {
  let doc = "", t = 0, asha = "", bala = "", chitra = "", ravi = "";
  before(async () => {
    await seedDemo();
    doc = all<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR'")[0].id;
    t = now();
    const cg = [{ name: "Ravi Rao", relation: "Son", phone: SHARED, level: 1 }];
    asha = engine.onboardPatient({ name: "Asha Rao", age: 70, sex: "F", phone: "+919800000001", conditions: "", address: "", doctorId: doc, caregivers: cg }, t, doc);
    bala = engine.onboardPatient({ name: "Bala Rao", age: 72, sex: "M", phone: "+919800000002", conditions: "", address: "", doctorId: doc, caregivers: cg }, t + 1000, doc);
    ravi = userByPhone(`whatsapp:${SHARED}`)!.id;
  });

  it("a caregiver in two circles answers the one they were last asked about, then the other", async () => {
    await engine.ingestMessage(ravi, "YES", { allowAi: false, at: t + 60_000 });
    assert.equal(status(bala, ravi), "GIVEN");
    assert.equal(status(asha, ravi), "PENDING");
    await engine.ingestMessage(ravi, "YES", { allowAi: false, at: t + 120_000 });
    assert.equal(status(asha, ravi), "GIVEN");
  });

  it("a number that is both a caregiver and a patient: the reply goes to whoever was last written to", async () => {
    chitra = engine.onboardPatient({ name: "Chitra Rao", age: 40, sex: "F", phone: SHARED, conditions: "", address: "", doctorId: doc, caregivers: [] }, t + 180_000, doc);
    const who = userByPhone(`whatsapp:${SHARED}`)!;
    assert.equal(who.role, "PATIENT");
    await engine.ingestMessage(who.id, "Yes", { allowAi: false, at: t + 240_000 });
    assert.equal(status(chitra, who.id), "GIVEN");
  });

  it("a patient who said NO and then YES is shown as consented", async () => {
    const uid = engine.getPatient(asha)!.user_id!;
    await engine.ingestMessage(uid, "NO", { allowAi: false, at: t + 300_000 });
    assert.equal(status(asha, uid), "DECLINED");
    await engine.ingestMessage(uid, "YES", { allowAi: false, at: t + 360_000 });
    assert.equal(status(asha, uid), "GIVEN");
  });
});
