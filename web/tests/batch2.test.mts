import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-batch2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;

const { all, get, run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const q = await import("../lib/quality");
const w = await import("../lib/watch");
const { SYMPTOM_QS } = await import("../lib/symptoms");
const { triage } = await import("../lib/triage");
const { now } = await import("../lib/clock");
const { MIN, HOUR, DAY, dayKey, dayStart, atLocal } = await import("../lib/time");

const out = (u: string, since: number) => all<{ body: string; quick: string | null }>("SELECT body, quick FROM messages WHERE user_id = ? AND direction = 'OUT' AND created_at >= ? ORDER BY created_at, id", u, since);
const last = (u: string, since: number) => out(u, since).at(-1)!;
const esc = (rule: string, since: number) => get<{ id: number; state: string }>("SELECT id, state FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = ? AND started_at >= ?", rule, since);

describe("pattern detectors (pure)", () => {
  const t = Date.parse("2026-10-06T10:00:00+05:30");
  const d = (n: number) => dayKey(t - n * DAY);
  it("weight creep needs three rising days and a real total rise", () => {
    assert.ok(w.detectWeightCreep([{ day: d(2), v: 59.2 }, { day: d(1), v: 60.1 }, { day: d(0), v: 60.9 }], t));
    assert.equal(w.detectWeightCreep([{ day: d(2), v: 59.2 }, { day: d(1), v: 59.4 }, { day: d(0), v: 59.6 }], t), null, "too small");
    assert.equal(w.detectWeightCreep([{ day: d(2), v: 59.2 }, { day: d(1), v: 60.5 }, { day: d(0), v: 60.1 }], t), null, "not rising every day");
    assert.equal(w.detectWeightCreep([{ day: d(6), v: 59.2 }, { day: d(5), v: 60.1 }, { day: d(4), v: 60.9 }], t), null, "stale");
  });
  it("BP drift needs a rise against the week before, close to but under the limit", () => {
    const days = [9, 8, 7, 6, 5, 4, 3].map((n) => ({ day: d(n), v: 126 })).concat([{ day: d(2), v: 140 }, { day: d(1), v: 142 }, { day: d(0), v: 141 }]);
    assert.ok(w.detectBpDrift(days, { sysHigh: 150 }, t));
    assert.equal(w.detectBpDrift(days, { sysHigh: 140 }, t), null, "already over the limit: the normal alert owns it");
    assert.equal(w.detectBpDrift(days.map((x) => ({ ...x, v: 126 })), { sysHigh: 150 }, t), null);
  });
  it("fluid build-up needs weight up AND a sign", () => {
    const wt = [{ day: d(2), v: 59.2 }, { day: d(1), v: 59.8 }, { day: d(0), v: 60.4 }];
    assert.match(w.detectFluid(wt, { symptom: "swelling", missedDiuretic: null }, t)!.detail, /swelling reported/);
    assert.match(w.detectFluid(wt, { symptom: null, missedDiuretic: "Lasix" }, t)!.detail, /Lasix dose missed/);
    assert.equal(w.detectFluid(wt, { symptom: null, missedDiuretic: null }, t), null);
  });
  it("adherence slip needs a good week then a bad 3 days", () => {
    assert.ok(w.detectAdherenceSlip({ due: 9, done: 5 }, { due: 28, done: 27 }));
    assert.equal(w.detectAdherenceSlip({ due: 9, done: 8 }, { due: 28, done: 27 }), null);
    assert.equal(w.detectAdherenceSlip({ due: 9, done: 5 }, { due: 28, done: 14 }), null, "was already poor");
  });
});

describe("symptom follow-up questions", () => {
  before(async () => { await seedDemo(); });
  it("has two questions with buttons for each supported symptom", () => {
    for (const k of Object.keys(SYMPTOM_QS)) assert.equal(SYMPTOM_QS[k].length, 2, k);
  });
  it("asks about breathlessness and raises the existing severe rule for 'At rest'", async () => {
    const t = now() + MIN;
    await engine.ingestMessage("u_ramesh", "a bit breathless today", { allowAi: false, at: t });
    const m = last("u_ramesh", t);
    assert.match(m.body, /When do you feel breathless\?/);
    assert.deepEqual(JSON.parse(m.quick!), ["At rest", "Walking or stairs", "Lying flat"]);
    await engine.ingestMessage("u_ramesh", "At rest", { allowAi: false, at: t + MIN });
    assert.match(last("u_ramesh", t + MIN).body, /more pillows/);
    await engine.ingestMessage("u_ramesh", "Yes", { allowAi: false, at: t + 2 * MIN });
    assert.match(last("u_ramesh", t + 2 * MIN).body, /Severe breathlessness/);
    assert.ok(esc("sx:breathlessness_severe", t), "same urgent rule as 'severe breathlessness'");
    const d = get<{ text: string }>("SELECT text FROM observations WHERE patient_id = 'p_ramesh' AND type = 'symptom_detail' ORDER BY id DESC")!;
    assert.deepEqual(JSON.parse(d.text).answers, ["At rest", "Yes"]);
  });
  it("does not ask the same question again within 12 hours", async () => {
    const t = now() + 30 * MIN;
    await engine.ingestMessage("u_ramesh", "breathless again", { allowAi: false, at: t });
    assert.doesNotMatch(last("u_ramesh", t).body, /When do you feel breathless/);
  });
  it("lets a reading in the middle go through and ends the questions", async () => {
    const t = now() + 14 * HOUR;
    await engine.ingestMessage("u_ramesh", "my feet are swollen", { allowAi: false, at: t });
    assert.match(last("u_ramesh", t).body, /Where is the swelling/);
    await engine.ingestMessage("u_ramesh", "BP 128/80", { allowAi: false, at: t + MIN });
    assert.match(last("u_ramesh", t + MIN).body, /Logged/);
    assert.equal(get("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh'"), undefined);
  });
  it("never swallows a short ordinary message as an answer", async () => {
    const t = now() + 30 * HOUR;
    await engine.ingestMessage("u_ramesh", "feet swelling a bit", { allowAi: false, at: t });
    assert.ok(get("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh' AND state = 'symptom_q'"));
    await engine.ingestMessage("u_ramesh", "took all tablets", { allowAi: false, at: t + MIN });
    assert.match(last("u_ramesh", t + MIN).body, /Medicines|tablets|Logged/);
    assert.equal(get("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh'"), undefined);
  });
  it("accepts 'not sure' and loose wording as answers", async () => {
    const t = now() + 35 * HOUR;
    run("DELETE FROM settings WHERE key LIKE 'sxq:%'");
    await engine.ingestMessage("u_ramesh", "legs swollen", { allowAi: false, at: t });
    await engine.ingestMessage("u_ramesh", "mostly my feet", { allowAi: false, at: t + MIN });
    await engine.ingestMessage("u_ramesh", "not sure", { allowAi: false, at: t + 2 * MIN });
    const d = get<{ text: string }>("SELECT text FROM observations WHERE patient_id = 'p_ramesh' AND type = 'symptom_detail' ORDER BY id DESC")!;
    assert.deepEqual(JSON.parse(d.text).answers, ["Feet or ankles", "Not sure"]);
  });
  it("saves swelling answers for the doctor without an alert", async () => {
    const t = now() + 40 * HOUR;
    run("DELETE FROM settings WHERE key LIKE 'sxq:%'");
    await engine.ingestMessage("u_ramesh", "legs swollen", { allowAi: false, at: t });
    await engine.ingestMessage("u_ramesh", "Feet or ankles", { allowAi: false, at: t + MIN });
    await engine.ingestMessage("u_ramesh", "More", { allowAi: false, at: t + 2 * MIN });
    assert.match(last("u_ramesh", t + 2 * MIN).body, /noted for the doctor/);
  });
  it("asks a caregiver by the patient's name", async () => {
    const t = now() + 60 * HOUR;
    await engine.ingestMessage("u_lakshmi", "feeling dizzy since morning", { allowAi: false, at: t });
    assert.match(last("u_lakshmi", t).body, /Does Ramesh feel dizzy when standing up/);
  });
});

describe("recheck after an alert closes", () => {
  before(() => { run("DELETE FROM settings WHERE key LIKE 'loop:%'"); run("DELETE FROM escalations WHERE patient_id = 'p_ramesh'"); run("DELETE FROM convo_state"); });
  const crisis = async (t: number) => {
    await engine.ingestMessage("u_ramesh", "BP 184/112", { allowAi: false, at: t });
    const e = esc("bp_crisis", t)!;
    engine.acknowledge(e.id, "u_lakshmi", t + MIN, "whatsapp");
    engine.resolveEscalation(e.id, "u_lakshmi", "1", null, t + 5 * MIN, "whatsapp");
    return e;
  };
  it("asks for a recheck later and tells the caregiver when it is fine", async () => {
    const t = now() + 100 * HOUR;
    await crisis(t);
    assert.equal(all("SELECT 1 FROM settings WHERE key LIKE 'loop:%'").length, 1);
    q.tickLoops(t + 60 * MIN);
    assert.ok(!out("u_ramesh", t + 60 * MIN).some((x) => /check it again/.test(x.body)), "not yet");
    q.tickLoops(t + 2 * HOUR + 10 * MIN);
    assert.match(last("u_ramesh", t + 2 * HOUR).body, /check it again now/);
    await engine.ingestMessage("u_ramesh", "BP 126/80", { allowAi: false, at: t + 2 * HOUR + 20 * MIN });
    assert.match(last("u_ramesh", t + 2 * HOUR + 20 * MIN).body, /recheck \(126\/80\) is within/);
    assert.ok(out("u_lakshmi", t + 2 * HOUR).some((x) => /rechecked: 126\/80/.test(x.body)), "caregiver told");
    assert.equal(all("SELECT 1 FROM settings WHERE key LIKE 'loop:%'").length, 0);
  });
  it("alerts again when the recheck is still high, without holding it", async () => {
    const t = now() + 130 * HOUR;
    run("DELETE FROM escalations WHERE patient_id = 'p_ramesh'");
    await crisis(t);
    await engine.ingestMessage("u_ramesh", "BP 158/98", { allowAi: false, at: t + 2 * HOUR });
    const e = get<{ detail: string }>("SELECT detail FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = 'bp_high' AND started_at >= ?", t + HOUR)!;
    assert.match(e.detail, /rechecked after the earlier alert/);
  });
  it("tells the caregiver when no recheck ever comes", async () => {
    const t = now() + 160 * HOUR;
    run("DELETE FROM escalations WHERE patient_id = 'p_ramesh'");
    await crisis(t);
    q.tickLoops(t + 2 * HOUR + 5 * MIN);
    q.tickLoops(t + 5 * HOUR + 10 * MIN);
    assert.ok(out("u_lakshmi", t + 5 * HOUR).some((x) => /No recheck of Ramesh's blood pressure/.test(x.body)));
    assert.equal(all("SELECT 1 FROM settings WHERE key LIKE 'loop:%'").length, 0);
  });
  it("does not schedule a recheck when the patient went to hospital", async () => {
    const t = now() + 190 * HOUR;
    run("DELETE FROM escalations WHERE patient_id = 'p_ramesh'");
    await engine.ingestMessage("u_ramesh", "BP 184/112", { allowAi: false, at: t });
    const e = esc("bp_crisis", t)!;
    engine.acknowledge(e.id, "u_lakshmi", t + MIN, "whatsapp");
    engine.resolveEscalation(e.id, "u_lakshmi", "3", "taken to hospital", t + 5 * MIN, "whatsapp");
    assert.equal(all("SELECT 1 FROM settings WHERE key LIKE 'loop:%'").length, 0);
  });
});

describe("pattern watches end to end", () => {
  before(() => { run("DELETE FROM escalations WHERE patient_id = 'p_ramesh'"); run("DELETE FROM settings WHERE key LIKE 'loop:%' OR key LIKE 'recheck:%'"); run("DELETE FROM convo_state"); run("DELETE FROM observations WHERE patient_id = 'p_ramesh' AND type = 'weight'"); });
  it("opens a watch from three rising weights, tells the family gently, and shows it to the doctor", async () => {
    const t = atLocal(dayStart(now() + 220 * HOUR), "13:00");
    for (const [n, v] of [[2, 71.0], [1, 71.7]] as const) run("INSERT INTO observations(patient_id, type, v1, observed_at, logged_by, parser) VALUES('p_ramesh','weight',?,?,?,?)", v, atLocal(dayStart(t) - n * DAY, "09:00"), "u_ramesh", "test");
    await engine.ingestMessage("u_ramesh", "weight 72.3", { allowAi: false, at: t });
    const open = w.openWatches("p_ramesh");
    assert.equal(open.length, 1);
    assert.equal(open[0].key, "weight_creep");
    const msgs = out("u_ramesh", t).map((x) => x.body);
    assert.ok(msgs.some((b) => /heads-up, not an alarm/.test(b)));
    assert.ok(out("u_lakshmi", t).some((x) => /heads-up, not an alarm/.test(x.body)));
    assert.equal(all("SELECT 1 FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key LIKE 'weight%' AND started_at >= ?", t).length, 0, "advisory, not an escalation");
    const p = engine.getPatient("p_ramesh")!;
    const tr = triage(p, engine.latestVisit("p_ramesh", t), [], 95, t + 3 * HOUR);
    assert.match(tr.reason.title, /^Pattern: Weight creeping up/);
    assert.equal(tr.needsReview, true);
  });
  it("does not repeat itself, and dismissing or turning off keeps it quiet", async () => {
    const t = atLocal(dayStart(now() + 220 * HOUR), "15:00");
    const before = out("u_ramesh", t - 100 * HOUR).length;
    w.evaluateWatches(engine.getPatient("p_ramesh")!, t);
    assert.equal(w.openWatches("p_ramesh").length, 1, "same watch, not a second one");
    assert.equal(out("u_ramesh", t - 100 * HOUR).length, before, "no second message");
    w.dismissWatch(w.openWatches("p_ramesh")[0].id, "u_dr_rao", t);
    w.evaluateWatches(engine.getPatient("p_ramesh")!, t + HOUR);
    assert.equal(w.openWatches("p_ramesh").length, 0, "3-day cool-down after a dismissal");
    w.setWatchOff("p_ramesh", "weight_creep", true, "u_dr_rao", t);
    assert.deepEqual(w.watchOffList("p_ramesh"), ["weight_creep"]);
  });
});
