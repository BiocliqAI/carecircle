import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-quality-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;

const { all, get, run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const q = await import("../lib/quality");
const { now } = await import("../lib/clock");
const { MIN } = await import("../lib/time");

describe("quality: typo check (pure)", () => {
  it("suggests the likely weight, nearest the last one", () => {
    const d = q.findDoubts("weight 592", new Set(), { weight: 61 })[0];
    assert.equal(d.fix?.text, "weight 59.2");
    assert.equal(d.why, "high");
    assert.equal(q.findDoubts("my weight today is 592", new Set())[0].fix?.text, "weight 59.2");
  });
  it("fixes an extra digit in BP and a swapped BP", () => {
    assert.equal(q.findDoubts("BP 1400/80", new Set())[0].fix?.text, "BP 140/80");
    assert.equal(q.findDoubts("bp 80/130", new Set())[0].fix?.text, "BP 130/80");
  });
  it("reads a sugar in mmol/L and an oxygen with an extra digit", () => {
    assert.equal(q.findDoubts("sugar 6.5", new Set())[0].fix?.text, "sugar 117");
    assert.equal(q.findDoubts("oxygen 970", new Set())[0].fix?.text, "spo2 97");
  });
  it("leaves ordinary messages alone", () => {
    for (const m of ["took 1/2 tablet", "pain 4/10", "weight 72.8", "BP 132/84", "sugar 110", "visit on 12/10"]) assert.equal(q.findDoubts(m, new Set()).length, 0, m);
  });
  it("skips a type the parser already took", () => {
    assert.equal(q.findDoubts("weight 592", new Set(["weight"])).length, 0);
  });
  it("flags a big weight jump but not a normal change", () => {
    const t = Date.now();
    assert.match(q.weightJumpNote({ v: 59.2, at: t - 86400000 }, 64.8, t)!, /5\.6 kg above/);
    assert.equal(q.weightJumpNote({ v: 59.2, at: t - 86400000 }, 60.0, t), null);
    assert.equal(q.weightJumpNote({ v: 59.2, at: t - 9 * 86400000 }, 70, t), null);
  });
});

describe("quality: corrections and device text (pure)", () => {
  it("reads 'X, not Y' both ways", () => {
    assert.deepEqual(q.correctionPair("Sorry, that was 128, not 182"), { to: 128, from: 182 });
    assert.deepEqual(q.correctionPair("it was not 182 but 128"), { from: 182, to: 128 });
    assert.equal(q.correctionPair("BP 130/80"), null);
  });
  it("needs a clear cue, so a polite 'sorry' never rewrites a reading", () => {
    assert.ok(!q.CORRECTION_RE.test("sorry for the late reply, BP 130/80"));
    assert.ok(q.CORRECTION_RE.test("typo: BP should be 128/82"));
  });
  it("turns a device reading into text the parser understands", () => {
    assert.equal(q.deviceText({ isDevice: true, device: "bp", readings: { sys: 138, dia: 86, pulse: 72 }, confidence: "high" })!.text, "BP 138/86, pulse 72");
    assert.equal(q.deviceText({ isDevice: true, readings: { glucose: 6.1 }, unit: "mmol/L", confidence: "high" })!.text, "sugar 110");
    assert.equal(q.deviceText({ isDevice: true, readings: { weight: 130 }, unit: "lb", confidence: "high" })!.text, "weight 59");
    assert.equal(q.deviceText({ isDevice: true, readings: { sys: 138, dia: 86 }, confidence: "low" }), null);
    assert.equal(q.deviceText({ isDevice: false }), null);
  });
});

describe("quality: in the conversation", () => {
  before(async () => { await seedDemo(); run("DELETE FROM settings WHERE key LIKE 'recheck:%'"); });
  const last = (u: string, since: number) => all<{ body: string; quick: string | null }>("SELECT body, quick FROM messages WHERE user_id = ? AND direction = 'OUT' AND created_at >= ? ORDER BY created_at, id", u, since).at(-1)!;
  const esc = (rule: string, since: number) => get<{ id: number; detail: string; state: string }>("SELECT id, detail, state FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key = ? AND started_at >= ?", rule, since);
  const th = () => engine.latestVisit("p_ramesh")!.plan.thresholds;

  it("asks 'did you mean' for an impossible weight and logs the fix on Yes", async () => {
    const t = now() + MIN;
    await engine.ingestMessage("u_ramesh", "weight 592", { allowAi: false, at: t });
    const m = last("u_ramesh", t);
    assert.match(m.body, /haven't logged weight “592 kg”/);
    assert.match(m.body, /Did you mean \*\d+(\.\d)? kg\*/);
    assert.equal(get("SELECT 1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'weight' AND v1 = 592"), undefined);
    await engine.ingestMessage("u_ramesh", "Yes, 59.2 kg", { allowAi: false, at: t + MIN });
    assert.ok(get("SELECT 1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'weight' AND v1 = 59.2"));
  });

  it("asks for a recheck on a borderline BP, and alerts if the recheck is still high", async () => {
    const t = now() + 10 * MIN;
    const s = th().sysHigh + 5, d = th().diaHigh + 2;
    await engine.ingestMessage("u_ramesh", `BP ${s}/${d}`, { allowAi: false, at: t });
    assert.match(last("u_ramesh", t).body, /Please sit quietly[\s\S]*measure again/);
    assert.equal(esc("bp_high", t), undefined, "no alert yet");
    await engine.ingestMessage("u_ramesh", `BP ${s + 2}/${d + 1}`, { allowAi: false, at: t + 12 * MIN });
    const e = esc("bp_high", t)!;
    assert.ok(e, "alerted after a still-high recheck");
    assert.match(e.detail, /Still outside the limit on recheck/);
  });

  it("does not alert when the recheck is normal", async () => {
    const t = now() + 3 * 60 * MIN;
    run("DELETE FROM escalations WHERE patient_id = 'p_ramesh'");
    await engine.ingestMessage("u_ramesh", `BP ${th().sysHigh + 4}/${th().diaHigh + 1}`, { allowAi: false, at: t });
    await engine.ingestMessage("u_ramesh", "BP 128/80", { allowAi: false, at: t + 15 * MIN });
    assert.match(last("u_ramesh", t + 15 * MIN).body, /recheck is back within/);
    assert.equal(esc("bp_high", t), undefined);
  });

  it("alerts anyway when no recheck arrives", async () => {
    const t = now() + 6 * 60 * MIN;
    run("DELETE FROM escalations WHERE patient_id = 'p_ramesh'");
    await engine.ingestMessage("u_ramesh", `BP ${th().sysHigh + 4}/${th().diaHigh + 1}`, { allowAi: false, at: t });
    q.tickRechecks(t + 10 * MIN);
    assert.equal(esc("bp_high", t), undefined, "still waiting at 10 minutes");
    q.tickRechecks(t + 31 * MIN);
    assert.match(esc("bp_high", t)!.detail, /No recheck was received/);
  });

  it("never holds an emergency reading", async () => {
    const t = now() + 9 * 60 * MIN;
    run("DELETE FROM escalations WHERE patient_id = 'p_ramesh'");
    await engine.ingestMessage("u_ramesh", "BP 186/112", { allowAi: false, at: t });
    assert.ok(esc("bp_crisis", t), "urgent alert at once");
  });

  it("corrects an earlier reading and closes the alert the typo caused", async () => {
    const t = now() + 12 * 60 * MIN;
    run("DELETE FROM escalations WHERE patient_id = 'p_ramesh'");
    await engine.ingestMessage("u_ramesh", "BP 182/96", { allowAi: false, at: t });
    const e = esc("bp_crisis", t)!;
    assert.ok(e);
    await engine.ingestMessage("u_ramesh", "Sorry, that was 128, not 182", { allowAi: false, at: t + 3 * MIN });
    assert.match(last("u_ramesh", t + 3 * MIN).body, /Corrected: Blood pressure 182\/96 → Blood pressure 128\/96/);
    assert.ok(esc("bp_high", t + 3 * MIN), "the corrected diastolic is still above the limit, so the right alert is raised");
    assert.equal(get<{ state: string }>("SELECT state FROM escalations WHERE id = ?", e.id)!.state, "RESOLVED");
    assert.equal(all("SELECT 1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'bp' AND v1 = 182").length, 0);
    assert.ok(all("SELECT 1 FROM audit WHERE action = 'OBSERVATION_CORRECTED'").length >= 1);
    assert.ok(all<{ body: string }>("SELECT body FROM messages WHERE user_id = 'u_lakshmi' AND created_at >= ?", t + 3 * MIN).some((x) => /Correction/.test(x.body)), "caregiver told");
  });
});
