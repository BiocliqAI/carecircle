import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-batch3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;

const { all, get, run, setSetting } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const mc = await import("../lib/medcheck");
const da = await import("../lib/docauto");
const br = await import("../lib/briefs");
const av = await import("../lib/aftervisit");
const { paToday } = await import("../lib/patasks");
const { addDocument } = await import("../lib/records");
const { now } = await import("../lib/clock");
const { DAY, HOUR, dayKey } = await import("../lib/time");

const M = (key: string, name: string, dose = "10 mg") => ({ key, name, dose, times: ["08:00"] });
const base = (plan: unknown[] = [], over: Partial<import("../lib/medcheck").Ctx> = {}): import("../lib/medcheck").Ctx => ({
  plan: { medications: plan, thresholds: { sysLow: 100 } } as never, allergies: null, conditions: null, potassium: null, creatinine: null, egfr: null, minSys3d: null, now: Date.now(), ...over,
});
const chk = (name: string, change: string, ctx: import("../lib/medcheck").Ctx, dose?: string, key?: string) => mc.checkChange({ med_name: name, change, new_dose: dose, med_key: key }, ctx);

describe("advisory checks on another doctor's change (pure)", () => {
  it("flags the same type as a medicine already in the plan", () => {
    const w = chk("Metoprolol", "started", base([M("concor", "Concor (bisoprolol)", "2.5 mg")]));
    assert.match(w.join(" "), /Same type as Concor.*beta blocker/);
  });
  it("flags the same drug under another brand", () => {
    assert.match(chk("Telmisartan", "started", base([M("telma", "Telma (telmisartan)", "40 mg")])).join(" "), /already in the plan/);
  });
  it("flags an allergy that names the drug, a brand, or the same type", () => {
    assert.match(chk("Ecosprin", "started", base([], { allergies: "aspirin" })).join(" "), /Allergy on file \(aspirin\).*same type/);
    assert.match(chk("Augmentin", "started", base([], { allergies: "Augmentin rash" })).join(" "), /names augmentin/);
    assert.equal(chk("Ecosprin", "started", base([], { allergies: "None" })).length, 0);
  });
  it("flags potassium and kidney results against the medicine type", () => {
    const k = { v: 5.4, at: Date.now() - 3 * DAY };
    assert.match(chk("Aldactone", "started", base([], { potassium: k })).join(" "), /Potassium was 5.4/);
    assert.match(chk("Metformin", "started", base([], { egfr: { v: 24, at: Date.now() } })).join(" "), /Kidney function is reduced \(eGFR 24\)/);
    assert.equal(chk("Aldactone", "stopped", base([], { potassium: k })).length, 0, "stopping is not flagged");
  });
  it("flags a painkiller with a blood thinner, and recent low BP before another BP tablet", () => {
    assert.match(chk("Diclofenac", "started", base([M("eliquis", "Eliquis (apixaban)", "5 mg")])).join(" "), /bleeding risk/);
    assert.match(chk("Amlodipine", "started", base([], { minSys3d: 104 })).join(" "), /BP readings have been low/);
  });
  it("flags a dose that more than doubles or halves, but not a small change", () => {
    const plan = [M("lasix", "Lasix (furosemide)", "40 mg")];
    assert.match(chk("Lasix (furosemide)", "dose_changed", base(plan), "20 mg", "lasix").join(" "), /less than half/);
    assert.match(chk("Lasix (furosemide)", "dose_changed", base(plan), "80 mg", "lasix").join(" "), /more than double/);
    assert.equal(chk("Lasix (furosemide)", "dose_changed", base(plan), "30 mg", "lasix").length, 0);
  });
  it("flags stopping a blood thinner in atrial fibrillation", () => {
    assert.match(chk("Eliquis", "stopped", base([M("eliquis", "Eliquis (apixaban)")], { conditions: "Atrial fibrillation on apixaban" })).join(" "), /Stopping a blood thinner/);
  });
});

describe("documents read on arrival", () => {
  before(async () => { await seedDemo(); });
  const mk = (title: string) => addDocument("p_ramesh", { title, category: "other", mime: "image/jpeg", base64: Buffer.from("fake").toString("base64"), source: "whatsapp" }, now(), "u_lakshmi");
  const tasks = () => paToday(now(), "u_pa_priya").tasks.filter((t) => t.kind === "document");

  it("shows an unread document as before", () => {
    const id = mk("IMG_1.jpg");
    const t = tasks().find((x) => x.id === `doc:${id}`)!;
    assert.equal(t.label, "Document to file");
    assert.ok(!t.actions.some((a) => a.api));
  });
  it("shows what was read and offers a one-tap confirm", () => {
    const id = mk("IMG_2.jpg");
    run("UPDATE patient_documents SET extract = ? WHERE id = ?", JSON.stringify({ category: "lab", title: "Renal Function Test", date: "2026-10-03", prescriber: null, labs: [{ marker: "creatinine", value: 2.4, unit: "mg/dL" }, { marker: "potassium", value: 4.6, unit: "mmol/L" }], meds: 0, note: null }), id);
    const t = tasks().find((x) => x.id === `doc:${id}`)!;
    assert.equal(t.label, "Document read, confirm to file");
    assert.match(t.detail, /Renal Function Test.*Values: Creatinine 2.4/);
    assert.ok(t.actions[0].api, "primary action files it");
  });
  it("files it and enters the lab values only on confirm, once", () => {
    const id = mk("IMG_3.jpg");
    run("UPDATE patient_documents SET extract = ? WHERE id = ?", JSON.stringify({ category: "lab", title: "Renal Function Test", date: "2026-10-03", prescriber: null, labs: [{ marker: "creatinine", value: 2.4, unit: "mg/dL" }], meds: 0, note: null }), id);
    assert.equal(get("SELECT 1 FROM labs WHERE patient_id = 'p_ramesh' AND value = 2.4"), undefined, "nothing entered before confirm");
    const r = da.autoFile(id, "u_pa_priya", now());
    assert.equal(r.labs, 1);
    const d = get<{ category: string; filed_at: number | null; title: string }>("SELECT category, filed_at, title FROM patient_documents WHERE id = ?", id)!;
    assert.equal(d.category, "lab");
    assert.ok(d.filed_at);
    assert.match(d.title, /Renal Function Test · 3 Oct 2026/);
    assert.ok(get("SELECT 1 FROM labs WHERE patient_id = 'p_ramesh' AND marker = 'creatinine' AND value = 2.4"));
    const id2 = mk("IMG_4.jpg");
    run("UPDATE patient_documents SET extract = ? WHERE id = ?", JSON.stringify({ category: "lab", title: "Renal Function Test", date: "2026-10-03", prescriber: null, labs: [{ marker: "creatinine", value: 2.4, unit: "mg/dL" }], meds: 0, note: null }), id2);
    assert.equal(da.autoFile(id2, "u_pa_priya", now()).labs, 0, "same report twice does not duplicate the lab values");
  });
  it("refuses to auto-file a document that was never read", () => {
    assert.throws(() => da.autoFile(mk("IMG_5.jpg"), "u_pa_priya", now()), /not been read/);
  });
});

describe("brief prepared before the visit", () => {
  it("is generated in the background for a visit in the next two days, and found when the chart opens", async () => {
    const t = now();
    const v = engine.latestVisit("p_ramesh", t)!;
    run("UPDATE visits SET next_visit_at = ? WHERE id = ?", t + DAY, v.id);
    assert.equal(br.freshBrief("p_ramesh", t), null);
    br.queueBriefs(t);
    await new Promise((r) => setTimeout(r, 400));
    const b = br.freshBrief("p_ramesh", t)!;
    assert.ok(b, "stored");
    assert.ok(b.summary.executiveSummary.length > 10);
    const first = b.at;
    br.queueBriefs(t + 15 * 60_000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(br.freshBrief("p_ramesh", t)!.at, first, "not regenerated every tick");
    assert.match(paToday(t, "u_pa_priya").tasks.find((x) => x.id === "visit:p_ramesh")?.detail ?? "", /The AI brief is ready/);
  });
});

describe("after-visit summary", () => {
  it("turns schedule codes into words", async () => {
    const { plainSchedule } = av;
    assert.equal(plainSchedule("1-0-1"), "morning and night");
    assert.equal(plainSchedule("0-0-1"), "once a day, at night");
    assert.equal(plainSchedule("1-1-1"), "3 times a day");
    assert.equal(plainSchedule("SOS"), "only if needed");
  });
  const built = {
    at: 1, medications: [
      { id: "m1", name: "Lasix", dose: "20 mg", schedule: "1-0-0", change: "changed", was: "40 mg", instructions: "", purpose: "", durationDays: null, sources: [], quote: null, confidence: "high" },
      { id: "m2", name: "Nifedipine", dose: "10 mg", schedule: "1-1-1", change: "new", was: null, instructions: "", purpose: "", durationDays: null, sources: [], quote: null, confidence: "high" },
      { id: "m3", name: "Zincovit", dose: "1 tab", schedule: "0-0-1", change: "stopped", was: null, instructions: "not needed now", purpose: "", durationDays: null, sources: [], quote: null, confidence: "high" },
      { id: "m4", name: "Eliquis", dose: "5 mg", schedule: "1-0-1", change: "same", was: null, instructions: "", purpose: "", durationDays: null, sources: [], quote: null, confidence: "high" },
    ],
    monitoring: [], advice: [], warningSigns: { keys: [], text: "more swelling, breathlessness or dizziness", sources: [] }, answers: [], labs: null, nextVisit: null, diagnosis: "", note: "Fluid has settled, so the water tablet can be reduced. Continue the rest.", conflicts: [],
  } as never;
  it("writes a plain, sourced summary without AI", async () => {
    const r = await av.draftFamilySummary(built, "2026-10-27");
    assert.equal(r.via, "rules");
    assert.match(r.text, /Lasix is now 20 mg.*\(was 40 mg\)/);
    assert.match(r.text, /Lasix is now 20 mg, once a day, in the morning/);
    assert.match(r.text, /New: Nifedipine 10 mg, 3 times a day/);
    assert.doesNotMatch(r.text, /\d-\d-\d/, "no schedule codes in a family message");
    assert.match(r.text, /Stop Zincovit/);
    assert.doesNotMatch(r.text, /Eliquis/, "unchanged medicines are not repeated");
    assert.match(r.text, /Why: Fluid has settled/);
    assert.match(r.text, /Watch for: more swelling/);
    assert.match(r.text, /Next visit: Tue, 27 Oct/);
  });
  it("suggests a sooner visit after many changes and a later one when stable", () => {
    const t = now();
    const busy = av.suggestNextVisit("p_ramesh", t, 4);
    assert.ok(busy.days <= 21, `sooner (${busy.days})`);
    assert.match(busy.why, /4 medicine changes/);
    run("DELETE FROM escalations WHERE patient_id = 'p_gopal'");
    const calm = av.suggestNextVisit("p_gopal", t, 0);
    assert.ok(calm.days >= 14);
    assert.ok(calm.date > dayKey(t));
  });
  it("sends the approved summary with the plan to the patient and the care circle", () => {
    const t = now() + HOUR;
    const v = engine.latestVisit("p_ramesh", t)!;
    engine.createVisit("p_ramesh", "u_dr_rao", { vitals: v.vitals, diagnosis: "x", notes: "", plan: v.plan, next_visit_at: null, familySummary: "• Lasix is now 20 mg" }, t);
    const msgs = (u: string) => all<{ body: string }>("SELECT body FROM messages WHERE user_id = ? AND created_at >= ? AND direction = 'OUT'", u, t).map((m) => m.body);
    assert.ok(msgs("u_ramesh").some((b) => /📝 In short:\n• Lasix is now 20 mg/.test(b)));
    assert.ok(msgs("u_lakshmi").some((b) => /care plan was updated[\s\S]*Lasix is now 20 mg/.test(b)));
  });
});
void setSetting;
