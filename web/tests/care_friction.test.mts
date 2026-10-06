import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDb = path.join(os.tmpdir(), `carecircle-test-friction-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.CARECIRCLE_DB = tmpDb;
delete process.env.GEMINI_API_KEY;

const { clarify, pickOption } = await import("../lib/clarify");
const { buildDigest } = await import("../lib/digest");
const { all, get, run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { paToday } = await import("../lib/patasks");
const { now } = await import("../lib/clock");
const { DAY, dayStart, atLocal } = await import("../lib/time");

const base = { body: "", firstName: "Ramesh", forCaregiver: false, pendingVitals: [], planVitals: [], pendingMeds: [], pendingOther: [] } as Parameters<typeof clarify>[0];

describe("clarify (pure)", () => {
  it("offers the vitals the plan is waiting for, for a lone number", () => {
    const c = clarify({ ...base, body: "72.8", pendingVitals: ["weight"], planVitals: ["weight", "bp"] })!;
    assert.deepEqual(c.options, [{ label: "Weight (72.8 kg)", text: "weight 72.8" }]);
    assert.ok(c.quick.includes("None of these"));
  });
  it("offers several readings when the number fits more than one and nothing is pending", () => {
    const c = clarify({ ...base, body: "96" })!;
    assert.deepEqual(c.options!.map((o) => o.text), ["weight 96", "sugar 96", "pulse 96"]);
  });
  it("reads two numbers as a blood pressure to confirm", () => {
    const c = clarify({ ...base, body: "132 84" })!;
    assert.equal(c.options![0].text, "BP 132/84");
  });
  it("says what it is waiting for when there is nothing to guess", () => {
    const c = clarify({ ...base, body: "hello", pendingVitals: ["bp"], pendingMeds: ["Furosemide 40 mg (8:00 am)"] })!;
    assert.equal(c.options, null);
    assert.match(c.text, /waiting for/);
    assert.match(c.text, /BP/);
    assert.match(c.text, /Furosemide/);
    assert.match(c.text, /HELP/);
  });
  it("matches answers by number, label, or no", () => {
    const o = [{ label: "Weight (72 kg)", text: "weight 72" }, { label: "Sugar (72 mg/dL)", text: "sugar 72" }];
    assert.equal((pickOption(o, "2") as { text: string }).text, "sugar 72");
    assert.equal((pickOption(o, "Weight (72 kg)") as { text: string }).text, "weight 72");
    assert.equal(pickOption(o, "none of these"), null);
    assert.equal(pickOption(o, "banana"), "unclear");
    assert.equal((pickOption([o[0]], "yes") as { text: string }).text, "weight 72");
  });
});

describe("digest (pure)", () => {
  it("says all good when nothing is wrong", () => {
    const t = buildDigest({ patientFirst: "Ramesh", medsDue: 4, medsTaken: 4, missed: [], readings: ["BP 130/80"], openAlerts: 0, nextVisit: null });
    assert.match(t, /4 of 4 taken/);
    assert.match(t, /Nothing needs you/);
  });
  it("points at open alerts and misses", () => {
    const t = buildDigest({ patientFirst: "Ramesh", medsDue: 4, medsTaken: 2, missed: ["Telmisartan (8:00 am)"], readings: [], openAlerts: 1, nextVisit: "Mon, 12 Oct" });
    assert.match(t, /1 alert still open/);
    assert.match(t, /Missed: Telmisartan/);
    assert.match(t, /No readings sent today/);
    assert.match(t, /Next visit/);
  });
});

describe("engine: unclear replies, digest, consent follow-up, PA queue", () => {
  before(async () => { await seedDemo(); });
  after(() => fs.rmSync(tmpDb, { force: true }));

  it("asks which reading a lone number is, then logs the chosen one", async () => {
    const t = now() + 40 * DAY;
    await engine.ingestMessage("u_ramesh", "72.8", { allowAi: false, at: t });
    const q = get<{ body: string; quick: string }>("SELECT body, quick FROM messages WHERE user_id = 'u_ramesh' AND direction = 'OUT' ORDER BY id DESC LIMIT 1")!;
    assert.match(q.body, /Which one is it/);
    assert.ok(get("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh' AND state = 'clarify'"));
    const options = (JSON.parse(q.quick) as string[]).filter((l) => /^Weight/.test(l));
    assert.equal(options.length, 1);
    await engine.ingestMessage("u_ramesh", options[0], { allowAi: false, at: t + 60_000 });
    const obs = get<{ v1: number }>("SELECT v1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'weight' AND observed_at >= ? ORDER BY id DESC LIMIT 1", t)!;
    assert.equal(obs.v1, 72.8);
    assert.equal(get("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh'"), undefined);
  });

  it("does not log anything when the answer is 'None of these'", async () => {
    const t = now() + 41 * DAY;
    await engine.ingestMessage("u_ramesh", "85", { allowAi: false, at: t });
    await engine.ingestMessage("u_ramesh", "None of these", { allowAi: false, at: t + 60_000 });
    assert.equal(get("SELECT 1 FROM observations WHERE patient_id = 'p_ramesh' AND observed_at >= ?", t), undefined);
    assert.equal(get("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh'"), undefined);
  });

  it("sends the care circle one evening digest per day, not to people who declined", async () => {
    const day = dayStart(now()) + 45 * DAY;
    engine.tick(atLocal(day, "20:30"));
    engine.tick(atLocal(day, "20:45"));
    const sent = all<{ user_id: string; body: string }>("SELECT user_id, body FROM messages WHERE patient_id = 'p_ramesh' AND body LIKE '🌙 % today%' AND created_at >= ?", day);
    assert.ok(sent.length >= 1);
    assert.equal(new Set(sent.map((m) => m.user_id)).size, sent.length, "one digest per caregiver per day");
    assert.ok(!sent.some((m) => ["u_ramesh"].includes(m.user_id)), "patient does not get the caregiver digest");
  });

  it("reminds an unanswered consent after a day and again after three, then stops", () => {
    const pid = "p_ramesh";
    const t0 = now() + 50 * DAY;
    run("INSERT OR REPLACE INTO consents(patient_id, user_id, role, status, requested_at) VALUES(?,?,?,?,?)", pid, "u_ramesh", "PATIENT", "PENDING", t0);
    const count = () => (get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE user_id = 'u_ramesh' AND body LIKE '🔔 Reminder%' AND created_at >= ?", t0)!).n;
    engine.tick(t0 + DAY / 2);
    assert.equal(count(), 0);
    engine.tick(t0 + DAY + 1000);
    assert.equal(count(), 1);
    engine.tick(t0 + 2 * DAY);
    assert.equal(count(), 1);
    engine.tick(t0 + 3 * DAY + 1000);
    assert.equal(count(), 2);
    engine.tick(t0 + 6 * DAY);
    assert.equal(count(), 2);
    const q = paToday(t0 + 6 * DAY, "u_pa");
    assert.ok(q.tasks.some((x) => x.kind === "consent" && /automatically/.test(x.detail)));
  });
});
