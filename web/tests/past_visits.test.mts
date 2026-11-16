import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-past-visits-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { all, get } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { now } = await import("../lib/clock");
const { DAY, dayKey, visitAtFrom } = await import("../lib/time");
const { DEFAULT_THRESHOLDS, DEFAULT_TIMERS } = await import("../lib/types");

const plan = (sysHigh = 140) => ({
  medications: [{ key: "lasix", name: "Lasix", dose: "40 mg", times: ["08:00"] }],
  monitoring: [{ key: "bp" as const, times: ["08:00"] }],
  physio: [],
  lifestyle: [],
  checkinTime: "21:00",
  watchSymptoms: [],
  thresholds: { ...DEFAULT_THRESHOLDS, sysHigh },
  escalation: DEFAULT_TIMERS,
});
const visit = (sysHigh?: number) => ({ vitals: { sys: 120, dia: 80 }, diagnosis: "Heart failure", notes: "", plan: plan(sysHigh), next_visit_at: null });
// Consent requests and their reminders belong to onboarding, not the care plan, so they aren't counted.
const outCount = (pid: string) => get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND direction = 'OUT' AND body NOT LIKE '%YES%'", pid)!.n;
const pending = (pid: string) => all<{ due_at: number }>("SELECT due_at FROM tasks WHERE patient_id = ? AND status = 'PENDING'", pid);

describe("visits entered from past records", () => {
  let doc = "", t = 0, pid = "", uid = "";
  before(async () => {
    await seedDemo();
    t = now();
    doc = all<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR'")[0].id;
    pid = engine.onboardPatient({ name: "Gopal Test", age: 78, sex: "M", phone: "+919811100001", conditions: "", address: "", doctorId: doc, caregivers: [{ name: "Ravi Test", relation: "Son", phone: "+919811100002", level: 1 }] }, t, doc);
    uid = engine.getPatient(pid)!.user_id!;
  });

  it("reads the visit date from the form", () => {
    assert.equal(visitAtFrom(undefined, t), t);
    assert.equal(visitAtFrom(dayKey(t), t), t);
    assert.match(String(visitAtFrom(dayKey(t + 2 * DAY), t)), /future/);
    assert.match(String(visitAtFrom("2026-13-40", t)), /valid/);
    const past = visitAtFrom(dayKey(t - 10 * DAY), t);
    assert.equal(typeof past, "number");
    assert.equal(dayKey(past as number), dayKey(t - 10 * DAY));
  });

  it("a past visit is saved silently and pauses the plan; nothing is scheduled while paused", () => {
    const sent = outCount(pid);
    const at = visitAtFrom(dayKey(t - 10 * DAY), t) as number;
    const vid = engine.createVisit(pid, doc, visit(), t, at);
    assert.equal(engine.getVisit(vid)!.visit_at, at);
    assert.ok(engine.planPausedSince(pid));
    assert.equal(outCount(pid), sent, "no WhatsApp for a past visit");
    engine.tick(t + 60_000);
    engine.tick(t + DAY);
    assert.equal(pending(pid).length, 0, "no reminders while paused");
    assert.equal(outCount(pid), sent, "no prompts, digests or plan messages while paused");
  });

  it("an older past visit slots into the history without changing the latest", () => {
    const latest = engine.latestVisit(pid)!.id;
    engine.createVisit(pid, doc, visit(), t + 2000, visitAtFrom(dayKey(t - 30 * DAY), t) as number);
    assert.equal(engine.latestVisit(pid)!.id, latest);
    assert.equal(engine.getVisits(pid).length, 2);
    assert.ok(engine.planPausedSince(pid));
  });

  it("while paused, readings are judged by the emergency rules only", async () => {
    await engine.ingestMessage(uid, "YES", { allowAi: false, at: t + 3000 });
    const reply = all<{ body: string }>("SELECT body FROM messages WHERE user_id = ? AND direction = 'OUT' ORDER BY id DESC LIMIT 1", uid);
    await engine.ingestMessage(uid, "BP 160/95", { allowAi: false, at: t + 4000 });
    assert.ok(get("SELECT 1 FROM observations WHERE patient_id = ? AND type = 'bp' AND v1 = 160", pid), "the reading is still recorded");
    assert.equal(get("SELECT 1 FROM escalations WHERE patient_id = ?", pid), undefined, "160 is over the visit's 140 limit but the plan isn't running");
    const last = all<{ body: string }>("SELECT body FROM messages WHERE user_id = ? AND direction = 'OUT' ORDER BY id DESC LIMIT 1", uid)[0];
    assert.notDeepEqual([last], reply);
    assert.match(last.body, /hasn't started yet/);
  });

  it("Start care plan begins reminders from now and sends the plan", () => {
    const start = t + 5000;
    const sent = outCount(pid);
    engine.startCarePlan(pid, start, doc);
    assert.equal(engine.planPausedSince(pid), null);
    const tasks = pending(pid);
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every((x) => x.due_at > start), "the days since the visit stay empty");
    const msgs = all<{ body: string; user_id: string }>("SELECT body, user_id FROM messages WHERE patient_id = ? AND direction = 'OUT' ORDER BY id DESC LIMIT 2", pid);
    assert.equal(outCount(pid), sent + 2, "patient + one caregiver");
    assert.ok(msgs.some((m) => m.user_id === uid && /after your visit on/.test(m.body) && /Lasix/.test(m.body)));
    assert.ok(msgs.some((m) => m.user_id !== uid && /starts today/.test(m.body)));
    assert.throws(() => engine.startCarePlan(pid, start + 1000, doc), /already running/);
  });

  it("on a running plan: a past visit older than the latest changes nothing; a newer one pauses and a visit today restarts", () => {
    const rp = "p_ramesh";
    const cur = engine.latestVisit(rp)!;
    engine.tick(t);
    const before = pending(rp).length;
    assert.ok(before > 0);
    engine.createVisit(rp, cur.doctor_id, visit(), t + 6000, cur.visit_at - 5 * DAY);
    assert.equal(engine.planPausedSince(rp), null);
    assert.equal(pending(rp).length, before);

    const yday = visitAtFrom(dayKey(t - DAY), t) as number;
    assert.ok(yday > cur.visit_at, "the demo's latest visit is older than yesterday");
    engine.createVisit(rp, cur.doctor_id, visit(), t + 7000, yday);
    assert.ok(engine.planPausedSince(rp));
    assert.equal(pending(rp).length, 0, "the old plan's reminders stop");
    const sent = outCount(rp);
    engine.createVisit(rp, cur.doctor_id, visit(), t + 8000);
    assert.equal(engine.planPausedSince(rp), null, "a visit dated today starts its plan");
    assert.ok(pending(rp).length > 0);
    assert.ok(outCount(rp) > sent);
  });

  it("a visit dated today doesn't start the plan when asked not to; starting stays a separate step", () => {
    const pid2 = engine.onboardPatient({ name: "Second Test", age: 70, sex: "M", phone: "+919811100011", conditions: "", address: "", doctorId: doc, caregivers: [] }, t + 9500, doc);
    const sent = outCount(pid2);
    engine.createVisit(pid2, doc, visit(), t + 9600, visitAtFrom(dayKey(t - 40 * DAY), t) as number);
    engine.createVisit(pid2, doc, visit(), t + 9700, t + 9700, { start: false });
    assert.equal(engine.getVisits(pid2).length, 2);
    assert.ok(engine.planPausedSince(pid2), "still waiting to be started");
    assert.equal(engine.planRunning(pid2), false);
    engine.tick(t + 9800);
    assert.equal(pending(pid2).length, 0);
    assert.equal(outCount(pid2), sent, "nothing sent");
    engine.startCarePlan(pid2, t + 9900, doc);
    assert.equal(engine.planRunning(pid2), true);
    assert.ok(outCount(pid2) > sent);
  });

  it("a visit can't be dated in the future", () => {
    assert.throws(() => engine.createVisit(pid, doc, visit(), t + 9000, t + 2 * DAY), /future/);
  });
});
