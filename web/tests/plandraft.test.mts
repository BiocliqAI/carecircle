import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-plandraft-${Date.now()}.db`);
const pd = await import("../lib/plandraft");
const { medDueOn } = await import("../lib/meds");
const { DEFAULT_THRESHOLDS, DEFAULT_TIMERS } = await import("../lib/types");

type Built = NonNullable<import("../lib/plandraft").PlanDraft["built"]>;
const med = (o: Partial<import("../lib/plandraft").DraftMed>) => ({ id: Math.random().toString(36), name: "X", dose: "1 mg", schedule: "1-0-0", durationDays: null, instructions: "", purpose: "", change: "same" as const, was: null, sources: ["rx" as const], quote: null, confidence: "high" as const, ...o });
const built = (o: Partial<Built> = {}): Built => ({ at: 0, medications: [], monitoring: [], advice: [], warningSigns: { keys: [], text: "", sources: [] }, answers: [], labs: null, nextVisit: null, diagnosis: "", note: "", conflicts: [], ...o });
const base = { medications: [], monitoring: [{ key: "bp" as const, times: ["08:00"] }], physio: [], lifestyle: [], checkinTime: "21:00", watchSymptoms: ["dizziness"], thresholds: { ...DEFAULT_THRESHOLDS }, escalation: { ...DEFAULT_TIMERS } };

describe("Plan builder: draft → care plan", () => {
  it("turns 1-0-1 style schedules into reminder times", () => {
    assert.deepEqual(pd.scheduleToTimes("1-0-1").times, ["08:00", "21:00"]);
    assert.deepEqual(pd.scheduleToTimes("1-1-1").times, ["08:00", "14:00", "21:00"]);
    assert.deepEqual(pd.scheduleToTimes("0-0-1").times, ["21:00"]);
    assert.equal(pd.scheduleToTimes("SOS").prn, true);
    assert.deepEqual(pd.scheduleToTimes("BD").times, ["08:00", "21:00"]);
  });

  it("treats a printed 30-day supply as ongoing, but short courses as courses", () => {
    const plan = pd.draftToPlan(built({ medications: [med({ name: "Telmisartan", dose: "80 mg", durationDays: 30 }), med({ name: "Amoxicillin", dose: "500 mg", schedule: "1-1-1", durationDays: 5, change: "new" })] }), base);
    assert.equal(plan.medications.find((m) => m.name === "Telmisartan")!.courseDays, undefined);
    assert.equal(plan.medications.find((m) => m.name === "Amoxicillin")!.courseDays, 5);
  });

  it("leaves stopped medicines out and applies spoken alert limits", () => {
    const b = built({
      medications: [med({ name: "Atorvastatin", change: "stopped" }), med({ name: "Amlodipine" })],
      monitoring: [{ id: "v1", key: "bp", times: ["08:00"], alert: "above 140/90", limits: { sysHigh: 140, diaHigh: 90 }, sources: ["talk"], quote: null, confidence: "high" }],
      warningSigns: { keys: ["fainting", "edema"], text: "", sources: ["talk"] },
    });
    const plan = pd.draftToPlan(b, base);
    assert.deepEqual(plan.medications.map((m) => m.name), ["Amlodipine"]);
    assert.equal(plan.thresholds.sysHigh, 140);
    assert.equal(plan.thresholds.diaHigh, 90);
    assert.ok(plan.watchSymptoms.includes("fainting") && plan.watchSymptoms.includes("dizziness"), "new warning signs added, existing kept");
  });

  it("resolves a conflict into a taper: 40 mg for 14 days, then 20 mg", () => {
    const b = built({
      medications: [med({ name: "Furosemide", dose: "20 mg", durationDays: 30 })],
      conflicts: [{ id: "c1", field: "dose", medName: "Furosemide", chosen: null, options: [
        { label: "20 mg once daily for 30 days", value: { dose: "20 mg", schedule: "1-0-0", durationDays: 30 }, source: "rx", quote: null },
        { label: "40 mg once daily for 14 days, then 20 mg", value: { dose: "40 mg", schedule: "1-0-0", durationDays: 14 }, source: "talk", quote: "double it to forty for two weeks" },
      ] }],
    });
    assert.deepEqual(pd.blockers(b), { conflicts: 1, toConfirm: 0 });
    pd.resolveConflict(b, "c1", 1);
    assert.deepEqual(pd.blockers(b), { conflicts: 0, toConfirm: 0 });
    const plan = pd.draftToPlan(b, base);
    const furo = plan.medications.filter((m) => m.name === "Furosemide");
    assert.equal(furo.length, 2);
    const onDay = (d: number) => furo.filter((m) => medDueOn(m, d, 1)).map((m) => m.dose);
    assert.deepEqual(onDay(0), ["40 mg"]);
    assert.deepEqual(onDay(13), ["40 mg"]);
    assert.deepEqual(onDay(14), ["20 mg"]);
    assert.deepEqual(onDay(60), ["20 mg"]);
    // choosing the other option again removes the follow-on step
    pd.resolveConflict(b, "c1", 0);
    assert.equal(b.medications.filter((m) => m.name === "Furosemide").length, 1);
  });

  it("blocks sending until unclear items are confirmed", () => {
    const b = built({ advice: [{ id: "a1", text: "About 1.5 L of fluid a day", sources: ["talk"], quote: null, confidence: "low" }] });
    assert.equal(pd.blockers(b).toConfirm, 1);
    pd.confirmItem(b, "a1");
    assert.equal(pd.blockers(b).toConfirm, 0);
  });
});
