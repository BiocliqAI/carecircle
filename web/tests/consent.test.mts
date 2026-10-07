import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-consent-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;

const { get, run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { now } = await import("../lib/clock");

const consent = (uid: string) => get<{ status: string }>("SELECT status FROM consents WHERE patient_id = 'p_ramesh' AND user_id = ?", uid)?.status;
const openAlert = () => get<{ id: number; state: string; ack_by: string | null }>("SELECT id, state, ack_by FROM escalations WHERE patient_id = 'p_ramesh' AND state IN ('NOTIFIED','ACKNOWLEDGED') ORDER BY id DESC LIMIT 1");

describe("caregiver YES: joining the circle vs taking an alert", () => {
  before(async () => {
    await seedDemo();
    run("UPDATE escalations SET state = 'RESOLVED' WHERE patient_id = 'p_ramesh'");
    for (const u of ["u_lakshmi", "u_arjun"]) {
      run("INSERT INTO consents(patient_id, user_id, role, status, requested_at) VALUES('p_ramesh', ?, 'CAREGIVER', 'PENDING', ?) ON CONFLICT(patient_id, user_id) DO UPDATE SET status = 'PENDING'", u, now());
    }
    await engine.ingestMessage("u_ramesh", "BP 192/118", { allowAi: false }); // alert goes to Level 1 (Lakshmi) only
    assert.equal(openAlert()?.state, "NOTIFIED");
  });

  it("a caregiver who wasn't sent the waiting alert joins the circle with YES (the alert stays waiting)", async () => {
    await engine.ingestMessage("u_arjun", "YES", { allowAi: false, at: now() + 60_000 });
    assert.equal(consent("u_arjun"), "GIVEN");
    assert.equal(openAlert()?.state, "NOTIFIED");
  });

  it("the caregiver who was sent the alert takes it with YES", async () => {
    await engine.ingestMessage("u_lakshmi", "YES", { allowAi: false, at: now() + 120_000 });
    const a = openAlert();
    assert.equal(a?.state, "ACKNOWLEDGED");
    assert.equal(a?.ack_by, "u_lakshmi");
    assert.equal(consent("u_lakshmi"), "PENDING");
  });
});
