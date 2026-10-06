import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-batch4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;

const { all, get, run, getSetting } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const ins = await import("../lib/insights");
const { buildDigest } = await import("../lib/digest");
const lang = await import("../lib/lang");
const { sendWhatsApp } = await import("../lib/whatsapp");
const { medMarkers } = await import("../components/charts");
const ask = await import("../lib/askrecord");
const { now } = await import("../lib/clock");
const { DAY, MIN, HOUR, dayStart, atLocal, localDow } = await import("../lib/time");

const out = (u: string, since: number) => all<{ body: string; quick: string | null }>("SELECT body, quick FROM messages WHERE user_id = ? AND direction = 'OUT' AND created_at >= ? ORDER BY created_at, id", u, since);

describe("digest: what changed (pure)", () => {
  const base = { weights: [], sysToday: null, sysPrior: [], sugarToday: null, sugarPrior: [], medStreak: 0 };
  it("says weight moved when it moved at least half a kilo over the days", () => {
    const l = ins.digestInsights({ ...base, weights: [{ day: "a", v: 59.2 }, { day: "b", v: 59.6 }, { day: "c", v: 60.0 }] });
    assert.deepEqual(l, ["⚖️ Weight 60 kg, up 0.8 kg over 2 days"]);
    assert.deepEqual(ins.digestInsights({ ...base, weights: [{ day: "a", v: 59.2 }, { day: "b", v: 59.3 }, { day: "c", v: 59.4 }] }), []);
  });
  it("says BP or sugar is off the week's usual, only with enough history", () => {
    assert.match(ins.digestInsights({ ...base, sysToday: 142, sysPrior: [126, 128, 124, 130] })[0], /Top BP number 142, higher than the usual 127/);
    assert.deepEqual(ins.digestInsights({ ...base, sysToday: 142, sysPrior: [126, 128] }), []);
    assert.match(ins.digestInsights({ ...base, sugarToday: 160, sugarPrior: [110, 105, 115] })[0], /Sugar 160, higher than the usual 110/);
  });
  it("offers a streak only when nothing else needs a word, and caps at two lines", () => {
    assert.match(ins.digestInsights({ ...base, medStreak: 5 })[0], /All medicines taken 5 days in a row/);
    const l = ins.digestInsights({ weights: [{ day: "a", v: 59 }, { day: "b", v: 60 }, { day: "c", v: 61 }], sysToday: 150, sysPrior: [120, 120, 120], sugarToday: 200, sugarPrior: [100, 100, 100], medStreak: 6 });
    assert.equal(l.length, 2);
    assert.ok(!l.some((x) => /in a row/.test(x)));
  });
  it("puts the lines into the digest", () => {
    const t = buildDigest({ patientFirst: "Ramesh", medsDue: 4, medsTaken: 4, missed: [], readings: ["BP 130/80"], openAlerts: 0, nextVisit: null, insights: ["⚖️ Weight 60 kg, up 0.8 kg over 2 days"] });
    assert.match(t, /BP 130\/80\n⚖️ Weight 60 kg/);
  });
});

describe("weekly summary", () => {
  const s = { name: "Ramesh", medDaysOk: 6, medDays: 7, dosesDone: 26, dosesDue: 28, sys: 131.4, dia: 82.2, sysPrev: 138, diaPrev: 85, weightFrom: 77.8, weightTo: 77.2, sugar: 118, sugarPrev: 124, alerts: 2, alertsClosed: 2, openNow: 0, nextVisit: "Sun, 11 Oct" };
  it("reads well for the family and for the patient", () => {
    const f = ins.buildWeekly(s, false);
    assert.match(f, /Ramesh's week/);
    assert.match(f, /fully on track on 6 of 7 days \(26 of 28 doses\)/);
    assert.match(f, /BP average 131\/82 \(week before 138\/85\) · weight 77.8 → 77.2 kg · sugar average 118 \(week before 124\)/);
    assert.match(f, /2 alerts this week, 2 closed/);
    assert.match(ins.buildWeekly(s, true), /Your week/);
    assert.match(ins.buildWeekly({ ...s, alerts: 0 }, false), /No alerts this week/);
    assert.match(ins.buildWeekly({ ...s, medDaysOk: 7 }, true), /Great job keeping up/);
  });
  describe("on Sunday evening", () => {
    before(async () => { await seedDemo(); });
    it("goes once to the circle and the patient", () => {
      let t = dayStart(now()) + 20 * DAY;
      while (localDow(t + 12 * HOUR) !== 0) t += DAY;
      const at = atLocal(t, "19:30");
      const v = engine.latestVisit("p_ramesh", at);
      assert.ok(v);
      engine.tick(at);
      engine.tick(at + 15 * MIN);
      const family = out("u_lakshmi", at - HOUR).filter((m) => /Ramesh's week/.test(m.body));
      assert.equal(family.length, 1, "once, not every tick");
      assert.equal(out("u_ramesh", at - HOUR).filter((m) => /Your week/.test(m.body)).length, 1);
    });
  });
});

describe("annotated timeline markers", () => {
  it("turns medicine changes into labelled markers, skipping rejected and out-of-range ones", () => {
    const t = Date.now();
    const m = medMarkers([
      { at: t - 3 * DAY, med_name: "Lasix (furosemide)", change: "dose_changed", new_dose: "20 mg", prescriber: "Dr Ezhilan", status: "CONFIRMED" },
      { at: t - 2 * DAY, med_name: "Nifedipine", change: "started", status: "REPORTED" },
      { at: t - 1 * DAY, med_name: "Zincovit", change: "stopped", status: "REJECTED" },
      { at: t - 90 * DAY, med_name: "Old", change: "started", status: "CONFIRMED" },
    ], t - 10 * DAY, t);
    assert.deepEqual(m.map((x) => x.label), ["Lasix ↕", "+Nifedipine"]);
    assert.match(m[0].title!, /Lasix \(furosemide\): dose changed → 20 mg · Dr Ezhilan/);
    assert.deepEqual(m.map((x) => x.row), [1, 2], "labels are staggered so they do not overlap");
    const same = medMarkers([
      { at: t - DAY, med_name: "Aldactone", change: "started", status: "CONFIRMED" },
      { at: t - DAY + HOUR, med_name: "Zurig", change: "started", status: "CONFIRMED" },
      { at: t - DAY + 2 * HOUR, med_name: "Betaloc", change: "stopped", status: "CONFIRMED" },
    ], t - 5 * DAY, t);
    assert.equal(same.length, 1, "several changes on one day are one marker");
    assert.equal(same[0].label, "+Aldactone +2");
    assert.match(same[0].title!, /Aldactone[\s\S]*Zurig[\s\S]*Betaloc/);
  });
});

describe("replying in the person's language", () => {
  before(async () => { await seedDemo(); });
  after(() => lang.setTranslator(null));

  it("reads Indian scripts and explicit requests", () => {
    assert.equal(lang.detectScript("இன்று மாத்திரை சாப்பிட்டேன்"), "ta");
    assert.equal(lang.detectScript("दवा ले ली"), "hi");
    assert.equal(lang.detectScript("took tablets"), null);
    assert.equal(lang.explicitLang("Please reply in Tamil"), "ta");
    assert.equal(lang.explicitLang("hindi mein reply karo"), "hi");
    assert.equal(lang.explicitLang("english please"), "en");
    assert.equal(lang.explicitLang("BP 130/80"), null);
    assert.equal(lang.explicitLang("he speaks in the evening"), null);
  });
  it("needs two romanised messages in a row, but one in script", () => {
    lang.setLang("u_abdul", "en");
    assert.equal(lang.recordLang("u_abdul", "hi", 4, false), "en", "one romanised message is not enough");
    assert.equal(lang.recordLang("u_abdul", "hi", 4, false), "hi");
    assert.equal(lang.recordLang("u_abdul", "ta", 3, true), "ta", "a script is a clear signal");
  });
  it("goes back to English after three longer English messages, not one", () => {
    lang.setLang("u_abdul", "hi");
    assert.equal(lang.recordLang("u_abdul", null, 6, false), "hi");
    assert.equal(lang.recordLang("u_abdul", null, 6, false), "hi");
    assert.equal(lang.recordLang("u_abdul", null, 6, false), "en");
    assert.equal(lang.recordLang("u_abdul", null, 1, false), "en", "a short message never changes it");
  });
  it("translates what we send, keeps the English, and maps a tapped button back", async () => {
    lang.setTranslator(async (body, quick) => ({ body: `[ta] ${body}`, quick: quick.map((q) => (q === "YES" ? "ஆம்" : q)) }));
    lang.setLang("u_ramesh", "ta");
    const t = now() + 5 * MIN;
    const id = sendWhatsApp({ userId: "u_ramesh", patientId: "p_ramesh", body: "Did you take your medicines? Reply *YES* or *NO*.", quick: ["YES", "NO"], kind: "info", at: t });
    await lang.settled();
    const row = get<{ body: string; quick: string; body_en: string; quick_en: string }>("SELECT body, quick, body_en, quick_en FROM messages WHERE id = ?", id)!;
    assert.match(row.body, /^\[ta\] Did you take/);
    assert.deepEqual(JSON.parse(row.quick), ["ஆம்", "NO"]);
    assert.equal(row.body_en, "Did you take your medicines? Reply *YES* or *NO*.");
    assert.equal(lang.mapButtonReply("u_ramesh", "ஆம்"), "YES");
    assert.equal(lang.mapButtonReply("u_ramesh", "something else"), null);
    lang.setTranslator(null);
  });
  it("leaves the English message alone when translation fails or changes the buttons", async () => {
    lang.setTranslator(async () => null);
    const id = sendWhatsApp({ userId: "u_ramesh", patientId: "p_ramesh", body: "Hello there friend", quick: ["OK"], kind: "info", at: now() + 6 * MIN });
    await lang.settled();
    assert.equal(get<{ body: string }>("SELECT body FROM messages WHERE id = ?", id)!.body, "Hello there friend");
    lang.setTranslator(async (b) => ({ body: `[x] ${b}`, quick: [] })); // wrong number of buttons
    const id2 = sendWhatsApp({ userId: "u_ramesh", patientId: "p_ramesh", body: "Second message here", quick: ["OK"], kind: "info", at: now() + 7 * MIN });
    await lang.settled();
    assert.equal(get<{ body: string }>("SELECT body FROM messages WHERE id = ?", id2)!.body, "Second message here");
    lang.setTranslator(null);
  });
  it("understands yes/no in other languages for consent", async () => {
    lang.setLang("u_ramesh", "en");
    run("DELETE FROM consents WHERE patient_id = 'p_ramesh' AND user_id = 'u_ramesh'");
    run("INSERT INTO consents(patient_id, user_id, role, status, requested_at) VALUES('p_ramesh','u_ramesh','PATIENT','PENDING',?)", now());
    await engine.ingestMessage("u_ramesh", "हाँ", { allowAi: false, at: now() + 8 * MIN });
    assert.equal(get<{ status: string }>("SELECT status FROM consents WHERE patient_id = 'p_ramesh' AND user_id = 'u_ramesh'")!.status, "GIVEN");
  });
  it("says so when asked for a language it cannot write right now, and switches to English on request", async () => {
    await engine.ingestMessage("u_ramesh", "please reply in Tamil", { allowAi: false, at: now() + 9 * MIN });
    assert.match(out("u_ramesh", now() + 9 * MIN).at(-1)!.body, /can't reply in Tamil right now/);
    assert.equal(lang.langOf("u_ramesh"), "en");
    lang.setLang("u_ramesh", "hi");
    await engine.ingestMessage("u_ramesh", "english please", { allowAi: false, at: now() + 10 * MIN });
    assert.equal(lang.langOf("u_ramesh"), "en");
    assert.match(out("u_ramesh", now() + 10 * MIN).at(-1)!.body, /reply in English/);
    assert.equal(getSetting("langvote:u_ramesh"), undefined);
  });
});

describe("ask the record", () => {
  before(async () => { await seedDemo(); });
  it("picks series and a period from the words", () => {
    assert.deepEqual(ask.questionSeries("When did creatinine start rising?"), ["creatinine"]);
    assert.deepEqual(ask.questionSeries("weight against BP and sugar"), ["weight", "bp", "glucose"]);
    assert.deepEqual(ask.questionSeries("how is she doing"), []);
    assert.equal(ask.questionDays("BP over the last 2 months"), 60);
    assert.equal(ask.questionDays("creatinine in the last 2 years"), 730);
  });
  it("only accepts chart plans that name real series", () => {
    assert.deepEqual(ask.cleanSpec({ series: ["creatinine", "made_up", "weight"], days: 90 }), { series: ["creatinine", "weight"], days: 90 });
    assert.equal(ask.cleanSpec({ series: ["nonsense"] }), null);
    assert.equal(ask.cleanSpec(null), null);
    assert.equal(ask.cleanSpec({ series: ["bp"], days: 99999 })!.days, 730);
  });
  it("plots numbers from the database, with medicine changes alongside", () => {
    const c = ask.buildChart("p_gopal", ["creatinine", "weight"], 730, now())!;
    assert.deepEqual(c.panels.map((p) => p.name), ["creatinine", "weight"]);
    const stored = all<{ value: number }>("SELECT value FROM labs WHERE patient_id = 'p_gopal' AND marker = 'creatinine' AND taken_at > ? AND taken_at <= ?", now() - 730 * DAY, now()).map((r) => r.value);
    assert.deepEqual(c.panels[0].points.map((p) => p.v1).sort(), [...stored].sort(), "every plotted creatinine is a stored value");
    assert.ok(c.changes.length > 0, "other doctors' medicine changes are included");
    assert.equal(ask.buildChart("p_gopal", ["nothing_here"], 30, now()), null);
  });
  it("without AI, answers with statistics and the chart for what was named", async () => {
    const r = await ask.askRecord("p_gopal", "When did creatinine start rising over the last 2 years?", now());
    assert.equal(r.via, "rules");
    assert.match(r.answer, /AI is off/);
    assert.match(r.facts[0], /^Creatinine: [\d.]+ \(.*\) → [\d.]+ \(.*\) over \d+ readings; highest/);
    assert.equal(r.chart!.panels[0].name, "creatinine");
  });
  it("without AI and with nothing to chart, says how to ask", async () => {
    const r = await ask.askRecord("p_gopal", "how is he doing overall?", now());
    assert.equal(r.chart, null);
    assert.match(r.answer, /naming a reading/);
  });
});
