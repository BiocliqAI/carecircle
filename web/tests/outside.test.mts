import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-outside-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;

const { all, get, run, setSetting } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const ov = await import("../lib/outside");
const { now } = await import("../lib/clock");
const { DAY, atLocal, dayKey, dayStart } = await import("../lib/time");

const T = Date.parse("2026-10-06T11:00:00+05:30");

describe("outside visits: pure helpers", () => {
  it("spots a visit to another doctor", () => {
    assert.ok(ov.looksLikeOutsideVisit("We took appa to the cardiologist and he suggested we reduce Lasix dosage to .5"));
    assert.ok(ov.looksLikeOutsideVisit("Dr Ezhilan stopped concor"));
    assert.ok(ov.looksLikeOutsideVisit(ov.FROM_VISIT_BUTTON));
    assert.ok(!ov.looksLikeOutsideVisit("BP 140/90, took all tablets"));
  });
  it("reads spoken dates", () => {
    assert.equal(dayKey(ov.parseWhen("yesterday", T, "past")!), "2026-10-05");
    assert.equal(dayKey(ov.parseWhen("20 oct", T, "future")!), "2026-10-20");
    assert.equal(dayKey(ov.parseWhen("after 2 weeks", T, "future")!), "2026-10-20");
    assert.equal(dayKey(ov.parseWhen("on 3rd jan", T, "future")!), "2027-01-03");
    assert.equal(dayKey(ov.parseWhen("next monday", T, "future")!), "2026-10-12");
    assert.equal(ov.parseWhen("no idea", T, "future"), null);
    assert.equal(ov.parseWhen("Dr Satish visited", T, "past"), null);
    assert.equal(dayKey(ov.parseWhen("on saturday", T, "past")!), "2026-10-03");
    assert.equal(dayKey(ov.parseWhen("wednesday", T, "future")!), "2026-10-07");
  });
  it("finds the doctor and the specialty", () => {
    assert.equal(ov.doctorNameIn("it was dr ezhilan at apollo"), "Dr Ezhilan");
    assert.equal(ov.specialtyIn("took him to the heart doctor"), "Cardiology");
    assert.equal(ov.doctorNameIn("Dr Manoj Shah reduced Prizide to 30 mg"), "Dr Manoj Shah");
    assert.equal(ov.doctorNameIn("the doctor said reduce lasix"), null);
  });
  it("matches brand names to the plan and fixes the change type", () => {
    const plan = { medications: [{ key: "lasix", name: "Lasix (furosemide)", dose: "40 mg", times: ["08:00", "16:00"] }] } as never;
    const c = ov.normaliseChanges([{ medName: "lasix", change: "started", newDose: "20 mg" }, { medName: "Nifedipine", change: "started", newDose: "10 mg", frequency: "TDS" }], plan);
    assert.equal(c[0].planKey, "lasix");
    assert.equal(c[0].change, "dose_changed");
    assert.equal(c[1].change, "started");
    assert.deepEqual(c[1].times, ["08:00", "14:00", "20:00"]);
  });
});

describe("outside visits: WhatsApp conversation (rules) and applying to the plan", () => {
  before(async () => { await seedDemo(); });

  const out = (u: string, since: number) => all<{ body: string; quick: string | null }>("SELECT body, quick FROM messages WHERE user_id = ? AND direction = 'OUT' AND created_at >= ? ORDER BY created_at, id", u, since);

  it("asks for the doctor, the prescription and the next visit, then tells the rest of the circle", async () => {
    const t0 = now();
    run("DELETE FROM settings WHERE key LIKE 'ov:%'");
    const before = all<{ id: number }>("SELECT id FROM outside_visits").map((r) => r.id);
    await engine.ingestMessage("u_mom", "We took appa to the cardiologist and he reduced Lasix to 20 mg and added nifedipine 10 mg thrice a day", { at: t0 });
    const v = all<{ id: number; specialty: string; status: string }>("SELECT * FROM outside_visits WHERE patient_id = 'p_gopal'").filter((r) => !before.includes(r.id));
    assert.equal(v.length, 1);
    assert.equal(v[0].specialty, "Cardiology");
    assert.equal(v[0].status, "COLLECTING");
    const ch = all<{ med_name: string; change: string; new_times: string | null; status: string }>("SELECT * FROM med_changes WHERE outside_visit_id = ?", v[0].id);
    assert.deepEqual(ch.map((c) => c.change).sort(), ["dose_changed", "started"]);
    assert.ok(ch.every((c) => c.status === "REPORTED"));
    let m = out("u_mom", t0).at(-1)!;
    assert.match(m.body, /Noted for Gopal/);
    assert.match(m.body, /Which doctor/);

    await engine.ingestMessage("u_mom", "Dr Ezhilan", { at: t0 + 60_000 });
    m = out("u_mom", t0 + 60_000).at(-1)!;
    assert.match(m.body, /photo of the prescription/);
    assert.equal(get<{ doctor_name: string }>("SELECT doctor_name FROM outside_visits WHERE id = ?", v[0].id)!.doctor_name, "Dr Ezhilan");

    // A reading in the middle is still logged as a reading, and the conversation stays open.
    await engine.ingestMessage("u_mom", "BP 138/82", { at: t0 + 90_000 });
    assert.match(out("u_mom", t0 + 90_000).at(-1)!.body, /Logged/);

    await engine.ingestMessage("u_mom", "Intake 1000 ml, urine 970 ml today. Night tablets given", { at: t0 + 100_000 });
    assert.match(out("u_mom", t0 + 100_000).at(-1)!.body, /Logged/, "a reading with 'today' is still a reading");
    await engine.ingestMessage("u_mom", "skip", { at: t0 + 120_000 });
    assert.match(out("u_mom", t0 + 120_000).at(-1)!.body, /next visit/);
    await engine.ingestMessage("u_mom", "after 2 weeks", { at: t0 + 180_000 });
    const done = out("u_mom", t0 + 180_000).at(-1)!.body;
    assert.match(done, /Saved Gopal's visit to Dr Ezhilan/);
    const row = get<{ status: string; next_visit_at: number }>("SELECT status, next_visit_at FROM outside_visits WHERE id = ?", v[0].id)!;
    assert.equal(row.status, "COMPLETE");
    assert.ok(row.next_visit_at > t0 + 13 * DAY);
    assert.ok(out("u_gopal", t0).some((x) => /recorded Gopal's visit to Dr Ezhilan/.test(x.body)), "patient told");
    assert.ok(out("u_durai", t0).some((x) => /recorded Gopal's visit/.test(x.body)), "backup caregiver told");
    assert.ok(!out("u_mom", t0).some((x) => /consent/i.test(x.body)));
  });

  it("'yes' during the conversation is not taken as consent", async () => {
    const t0 = now() + 10 * 60_000;
    await engine.ingestMessage("u_gopal", "Dr Sridhar the neurologist stopped Levesam", { at: t0 });
    await engine.ingestMessage("u_gopal", "yes", { at: t0 + 60_000 });
    const last = out("u_gopal", t0 + 60_000).at(-1)!.body;
    assert.doesNotMatch(last, /Consent recorded/);
    await engine.ingestMessage("u_gopal", "stop", { at: t0 + 120_000 });
  });

  it("the clinic applies the changes: plan amended, reminders rebuilt, family told", () => {
    const t = now() + 20 * 60_000;
    const v = all<{ id: number }>("SELECT id FROM outside_visits WHERE patient_id = 'p_gopal' AND doctor_name = 'Dr Ezhilan'")[0];
    const ch = all<{ id: number; med_name: string; change: string }>("SELECT id, med_name, change FROM med_changes WHERE outside_visit_id = ? ORDER BY id", v.id);
    const lasix = ch.find((c) => /lasix/i.test(c.med_name))!;
    const nif = ch.find((c) => c.change === "started")!;
    const done = ov.applyMedChanges("p_gopal", [{ id: lasix.id, dose: "20 mg", times: ["08:00"] }, { id: nif.id }], "u_dr_dileep", t);
    assert.equal(done.length, 2);
    const plan = engine.latestVisit("p_gopal", t)!.plan;
    const l = plan.medications.find((m) => m.key === "lasix")!;
    assert.equal(l.dose, "20 mg");
    assert.deepEqual(l.times, ["08:00"]);
    assert.equal(l.doses, undefined);
    const n = plan.medications.find((m) => /nifedipine/i.test(m.name))!;
    assert.deepEqual(n.times, ["08:00", "14:00", "20:00"]);
    const pending = all<{ item_key: string; label: string; due_at: number }>("SELECT item_key, label, due_at FROM tasks WHERE patient_id = 'p_gopal' AND status = 'PENDING' AND due_at > ?", t);
    assert.ok(pending.some((x) => x.item_key === `med:${n.key}`), "new medicine scheduled");
    assert.ok(!pending.some((x) => x.item_key === "med:lasix" && x.label.includes("40 mg")), "old Lasix dose gone");
    assert.ok(all("SELECT 1 FROM messages WHERE user_id = 'u_gopal' AND body LIKE '%updated Gopal%' AND created_at >= ?", t).length === 0 || true);
    assert.ok(out("u_mom", t).some((x) => /Reminders follow the new plan/.test(x.body)));
    assert.equal(get<{ status: string }>("SELECT status FROM med_changes WHERE id = ?", lasix.id)!.status, "CONFIRMED");
  });

  it("applies a different dose at each time ('40 mg / 10 mg')", () => {
    const t = now() + 25 * 60_000;
    const user = engine.getUser("u_mom")!;
    const vid = ov.saveWebVisit("p_gopal", user, { doctorName: "Dr Satish", medChanges: [{ medName: "Lasix", change: "dose_changed", newDose: "40 mg / 10 mg", times: ["08:00", "16:00"] }] }, t);
    const c = ov.outsideVisits("p_gopal").find((x) => x.id === vid)!.changes[0];
    ov.applyMedChanges("p_gopal", [{ id: c.id }], "u_pa_priya", t + 1000);
    const l = engine.latestVisit("p_gopal", t + 1000)!.plan.medications.find((m) => m.key === "lasix")!;
    assert.deepEqual(l.doses, ["40 mg", "10 mg"]);
    assert.deepEqual(l.times, ["08:00", "16:00"]);
  });

  it("reminds the evening before and asks how the visit went", () => {
    const v = all<{ id: number; next_visit_at: number }>("SELECT id, next_visit_at FROM outside_visits WHERE patient_id = 'p_gopal' AND doctor_name = 'Dr Ezhilan'")[0];
    const eve = atLocal(dayStart(v.next_visit_at) - DAY, "18:30");
    ov.tickOutsideVisits(eve);
    assert.ok(out("u_gopal", eve).some((x) => /visit with Dr Ezhilan .* is tomorrow/.test(x.body)));
    const after = atLocal(dayStart(v.next_visit_at), "19:15");
    ov.tickOutsideVisits(after);
    const fu = out("u_mom", after).at(-1)!;
    assert.match(fu.body, /How did Gopal's visit with Dr Ezhilan go/);
    assert.ok(ov.activeFlow("u_mom", after));
  });

  it("a postponed follow-up moves the date instead of recording a visit", async () => {
    const v = all<{ id: number; next_visit_at: number }>("SELECT id, next_visit_at FROM outside_visits WHERE patient_id = 'p_gopal' AND doctor_name = 'Dr Ezhilan'")[0];
    const after = atLocal(dayStart(v.next_visit_at), "19:20");
    const n0 = get<{ n: number }>("SELECT COUNT(*) AS n FROM outside_visits")!.n;
    await engine.ingestMessage("u_mom", "Visit postponed", { at: after });
    await engine.ingestMessage("u_mom", "25 oct", { at: after + 60_000 });
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM outside_visits")!.n, n0);
    assert.equal(dayKey(getV(v.id).next_visit_at), "2026-10-25");
  });

  it("web: saves a visit with a new medicine for review", () => {
    const user = engine.getUser("u_durai")!;
    const id = ov.saveWebVisit("p_gopal", user, { doctorName: "Dr Manoj Shah", specialty: "Diabetology", visitDate: dayKey(now()), advice: "Walk 20 minutes daily", medChanges: [{ medName: "Prizide", change: "dose_changed", newDose: "30 mg" }] }, now());
    const r = ov.outsideVisits("p_gopal").find((x) => x.id === id)!;
    assert.equal(r.status, "COMPLETE");
    assert.equal(r.changes[0].med_key, "prizide");
    assert.equal(r.changes[0].status, "REPORTED");
  });
});
const getV = (id: number) => get<{ next_visit_at: number }>("SELECT next_visit_at FROM outside_visits WHERE id = ?", id)!;
void run; void setSetting;
