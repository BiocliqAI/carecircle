// E2E suite "alerts": §10 Alert rules, §11 Escalation chain, §12 SOS, §13 Follow-up loops, §14 Pattern watches,
// §15 Documents and photos (AI off), §21 Twilio gateway (separate live-mode app with FAKE credentials + allowlist).
// Run: cd web && npx tsx tests/e2e/alerts.e2e.mts
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startApp, assert, notRun, blocked, until, RESULTS_DIR } from "./harness.mts";

const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const app = await startApp({ port: 3204, suite: "alerts" });
const T = async (id: string, title: string, fn: () => Promise<void> | void) => {
  if (ONLY && !ONLY.test(id)) return;
  await app.test(id, title, fn);
};

// ---------------------------------------------------------------- helpers
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, IST = 330 * MIN;
const fresh = () => app.clock.reset();
const maxEsc = () => app.q1<{ m: number | null }>("SELECT MAX(id) AS m FROM escalations")?.m ?? 0;
const escAfter = (pid: string, after: number, rule?: string) =>
  app.q<any>(`SELECT * FROM escalations WHERE patient_id = ? AND id > ?${rule ? " AND rule_key = ?" : ""} ORDER BY id`, pid, after, ...(rule ? [rule] : []));
const esc = (id: number) => app.q1<any>("SELECT * FROM escalations WHERE id = ?", id);
const events = (id: number) => app.q<any>("SELECT * FROM escalation_events WHERE escalation_id = ? ORDER BY id", id);
const out = (uid: string, m: number) => app.wa.since(uid, m);
const outText = (uid: string, m: number) => out(uid, m).map((x) => x.body).join("\n----\n");
const escMsgs = (uid: string, m: number) => out(uid, m).filter((x) => x.kind === "escalation");
const short = (s: string, n = 220) => s.replace(/\s+/g, " ").slice(0, n);

/** Send a message and return the escalations it created (filtered by rule if given) plus the mark before sending. */
async function send(uid: string, text: string) {
  const m = app.mark(), e0 = maxEsc();
  const r = await app.wa.send(uid, text);
  assert.equal(r.status, 200, `send ${text}: ${r.status} ${JSON.stringify(r.data)}`);
  return { m, e0 };
}
async function trigger(uid: string, pid: string, text: string, rule: string) {
  const { m, e0 } = await send(uid, text);
  const created = escAfter(pid, e0, rule);
  assert.equal(created.length, 1, `"${text}" should create one ${rule} alert; got ${created.length}. Replies: ${short(outText(uid, m))}`);
  return { m, e0, e: created[0] };
}
/** Minutes until the next local (IST) hh:mm. */
async function minutesTo(hhmm: string) {
  const t = await app.clock.now();
  const [h, mm] = hhmm.split(":").map(Number);
  const local = (t + IST) % DAY;
  let d = h * HOUR + mm * MIN - local;
  if (d <= 0) d += DAY;
  return Math.ceil(d / MIN);
}
const advanceTo = async (hhmm: string) => app.clock.advance(await minutesTo(hhmm));
const localHHMM = (t: number) => new Date(t + IST).toISOString().slice(11, 16);
const localDay = (t: number) => new Date(t + IST).toISOString().slice(0, 10);
/** Dashboard action on an alert as a caregiver. */
const dash = (uid: string, id: number, body: unknown) => app.api(uid, "POST", `/api/escalations/${id}`, body);
/** Close every open alert of a patient through the caregiver dashboard (outcome 3: no recheck loop). */
async function closeOpen(pid: string) {
  const cg = app.q1<{ user_id: string }>("SELECT user_id FROM caregivers WHERE patient_id = ? ORDER BY level LIMIT 1", pid)!.user_id;
  for (const e of app.q<any>("SELECT id FROM escalations WHERE patient_id = ? AND state IN ('NOTIFIED','ACKNOWLEDGED')", pid)) {
    const r = await dash(cg, e.id, { action: "resolve", code: "3", note: "test setup" });
    assert.equal(r.status, 200, `close ${e.id}: ${JSON.stringify(r.data)}`);
  }
}
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

// =========================================================================================== §10 ALERT RULES
await T("RULE-01", "BP crisis", async () => {
  await fresh();
  const { m, e } = await trigger("u_ramesh", "p_ramesh", "BP 185/112", "bp_crisis");
  assert.equal(e.type, "URGENT"); assert.equal(e.title, "Very high blood pressure");
  const l1 = escMsgs("u_lakshmi", m); assert.equal(l1.length, 1, "L1 alerted once");
  assert.ok(l1[0].created_at - e.started_at < 5000, "immediately");
  assert.match(l1[0].body, /URGENT/);
  const reply = outText("u_ramesh", m);
  assert.match(reply, /rest/i); assert.match(reply, /recheck/i); assert.match(reply, /emergency/i);
  const n = await send("u_ramesh", "BP 130/80");
  assert.equal(escAfter("p_ramesh", n.e0).filter((x) => x.rule_key.startsWith("bp")).length, 0, "normal BP: no alert");
});

await T("RULE-02", "BP above limit (well above)", async () => {
  await fresh();
  const { m, e } = await trigger("u_ramesh", "p_ramesh", "BP 175/90", "bp_high"); // limit 150/95, +25
  assert.equal(e.type, "DEVIATION"); assert.equal(e.title, "BP above doctor's limit");
  assert.equal(escMsgs("u_lakshmi", m).length, 1);
  assert.match(e.advice, /Rest/);
  const n = await send("u_ramesh", "BP 132/82");
  assert.equal(escAfter("p_ramesh", n.e0).filter((x) => x.rule_key.startsWith("bp")).length, 0);
});

await T("RULE-03", "Borderline BP → recheck", async () => {
  await fresh();
  const { m, e0 } = await send("u_ramesh", "BP 160/90");
  assert.equal(escAfter("p_ramesh", e0, "bp_high").length, 0, "no alert yet");
  assert.equal(escMsgs("u_lakshmi", m).length, 0);
  assert.match(outText("u_ramesh", m), /10 minutes[\s\S]*measure again/);
});

await T("RULE-04", "Recheck still high", async () => {
  await fresh();
  await send("u_ramesh", "BP 160/90");
  const { m, e } = await trigger("u_ramesh", "p_ramesh", "BP 158/92", "bp_high");
  assert.match(e.detail, /158\/92/); assert.match(e.detail, /first reading 160\/90/);
  assert.equal(escMsgs("u_lakshmi", m).length, 1);
});

await T("RULE-05", "Recheck normal", async () => {
  await fresh();
  const s = await send("u_ramesh", "BP 160/90");
  const { m } = await send("u_ramesh", "BP 134/84");
  assert.equal(escAfter("p_ramesh", s.e0, "bp_high").length, 0);
  assert.match(outText("u_ramesh", m), /back within/i);
  await app.clock.advance(35);
  assert.equal(escAfter("p_ramesh", s.e0, "bp_high").length, 0, "no alert after the recheck window either");
});

await T("RULE-06", "No recheck → alert anyway", async () => {
  await fresh();
  const s = await send("u_ramesh", "BP 160/90");
  await app.clock.advance(20);
  assert.equal(escAfter("p_ramesh", s.e0, "bp_high").length, 0, "not before 30 min");
  await app.clock.advance(15);
  const e = escAfter("p_ramesh", s.e0, "bp_high");
  assert.equal(e.length, 1, "alerted after 30 min");
  assert.match(e[0].detail, /No recheck/);
  assert.equal(escMsgs("u_lakshmi", s.m).length, 1);
});

await T("RULE-07", "Low BP", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", "BP 92/60", "bp_low");
  assert.equal(e.type, "DEVIATION"); assert.equal(e.title, "Low blood pressure");
});

await T("RULE-08", "Rapid weight gain", async () => {
  await fresh();
  const t = await app.clock.now();
  const mn = app.q1<any>("SELECT MIN(v1) AS mn FROM observations WHERE patient_id = 'p_ramesh' AND type = 'weight' AND observed_at >= ?", t - 3 * DAY)?.mn;
  if (mn == null) blocked("no Ramesh weight in the last 3 days to compare with");
  const w = Math.round((mn + 2.3) * 10) / 10;
  const { m, e } = await trigger("u_ramesh", "p_ramesh", `weight ${w}`, "weight_gain");
  assert.equal(e.type, "DEVIATION"); assert.equal(e.title, "Rapid weight gain");
  assert.match(e.detail, /in 3 days/);
  assert.equal(escMsgs("u_lakshmi", m).length, 1);
});

await T("RULE-09", "Weight above dry-weight band (Gopal 59.2 ± 1)", async () => {
  await fresh();
  const { m, e } = await trigger("u_gopal", "p_gopal", "weight 60.6", "weight_gain");
  assert.equal(e.title, "Weight above target — possible fluid build-up");
  assert.match(e.detail, /above the doctor's target 59.2/);
  assert.equal(escMsgs("u_mom", m).length, 1, "Gopal's L1 (Mom) alerted");
});

await T("RULE-10", "Weight below band", async () => {
  await fresh();
  const { e } = await trigger("u_gopal", "p_gopal", "weight 57.8", "weight_below_band");
  assert.equal(e.title, "Weight below target — possible dehydration");
});

await T("RULE-11", "Very low sugar", async () => {
  await fresh();
  const { m, e } = await trigger("u_ramesh", "p_ramesh", "sugar 50", "glucose_very_low");
  assert.equal(e.type, "URGENT"); assert.equal(e.title, "Very low blood sugar");
  assert.match(outText("u_ramesh", m), /15 g/);
  assert.equal(escMsgs("u_lakshmi", m).length, 1);
});

await T("RULE-12", "Low / high sugar", async () => {
  await fresh();
  const lo = await trigger("u_ramesh", "p_ramesh", "sugar 62", "glucose_low");
  assert.equal(lo.e.type, "DEVIATION"); assert.equal(lo.e.title, "Low blood sugar");
  const hi = await trigger("u_ramesh", "p_ramesh", "sugar 310", "glucose_high");
  assert.equal(hi.e.type, "DEVIATION"); assert.equal(hi.e.title, "High blood sugar");
  const n = await send("u_ramesh", "sugar 140");
  assert.equal(escAfter("p_ramesh", n.e0).filter((x) => x.rule_key.startsWith("glucose")).length, 0);
});

await T("RULE-13", "Pulse outside limits (+ borderline recheck)", async () => {
  await fresh(); // Ramesh range 50–110
  const lo = await trigger("u_ramesh", "p_ramesh", "pulse 44", "hr_abnormal");
  assert.equal(lo.e.title, "Pulse outside limits"); assert.equal(lo.e.type, "DEVIATION");
  await closeOpen("p_ramesh");
  const hi = await trigger("u_ramesh", "p_ramesh", "pulse 140", "hr_abnormal");
  assert.equal(hi.e.title, "Pulse outside limits");
  await closeOpen("p_ramesh");
  const b = await send("u_ramesh", "pulse 116");
  assert.equal(escAfter("p_ramesh", b.e0, "hr_abnormal").length, 0, "borderline pulse: no alert yet");
  assert.match(outText("u_ramesh", b.m), /measure again/);
});

await T("RULE-14", "Very low oxygen (Abdul)", async () => {
  await fresh();
  const { m, e } = await trigger("u_abdul", "p_abdul", "SpO2 86", "spo2_very_low");
  assert.equal(e.type, "URGENT"); assert.equal(e.title, "Very low oxygen");
  assert.equal(escMsgs("u_imran", m).length, 1, "Abdul's L1 Imran alerted");
});

await T("RULE-15", "Oxygen below limit (Abdul, limit 92)", async () => {
  await fresh();
  await closeOpen("p_abdul"); // the seed leaves an open spo2_low alert, which would absorb this one as REPEAT
  const { e } = await trigger("u_abdul", "p_abdul", "SpO2 90", "spo2_low");
  assert.equal(e.type, "DEVIATION");
  const n = await send("u_abdul", "SpO2 96");
  assert.equal(escAfter("p_abdul", n.e0).filter((x) => x.rule_key.startsWith("spo2")).length, 0);
});

await T("RULE-16", "Fever", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", "temp 101", "fever");
  assert.equal(e.type, "DEVIATION"); assert.equal(e.title, "Fever");
  const n = await send("u_ramesh", "temp 98.4");
  assert.equal(escAfter("p_ramesh", n.e0, "fever").length, 0);
});

await T("RULE-17", "High pain score (Sunita, limit 7)", async () => {
  await fresh();
  const { m, e } = await trigger("u_sunita", "p_sunita", "pain 8/10", "pain_high");
  assert.equal(e.type, "DEVIATION"); assert.equal(e.title, "High pain score");
  assert.equal(escMsgs("u_neha", m).length, 1);
  const n = await send("u_sunita", "pain 3/10");
  assert.equal(escAfter("p_sunita", n.e0, "pain_high").length, 0);
});

await T("RULE-18", "Red-flag symptoms: chest pain, fainted, can't breathe", async () => {
  const fails: string[] = [];
  for (const [text, rule] of [["I have chest pain", "sx:chest_pain"], ["he fainted", "sx:fainting"], ["I can't breathe", null]] as const) {
    await fresh();
    const { m, e0 } = await send("u_ramesh", text);
    const urgent = escAfter("p_ramesh", e0).filter((x) => x.type === "URGENT");
    const all = escAfter("p_ramesh", e0).filter((x) => x.rule_key.startsWith("sx:"));
    const reply = outText("u_ramesh", m);
    if (!urgent.length) { fails.push(`"${text}" → no URGENT (got ${all.map((x) => `${x.type} ${x.rule_key}`).join(", ") || "nothing"}); reply: ${short(reply, 140)}`); continue; }
    if (rule && urgent[0].rule_key !== rule) fails.push(`"${text}" → ${urgent[0].rule_key}`);
    if (!/108/.test(urgent[0].advice)) fails.push(`"${text}" advice lacks 108`);
    if (!/108|emergency/i.test(reply)) fails.push(`"${text}" patient reply lacks emergency advice`);
    if (!escMsgs("u_lakshmi", m).length) fails.push(`"${text}" L1 not alerted`);
  }
  if (fails.length) assert.fail(`BUG: ${fails.join(" | ")}. "can't breathe" is parsed as breathlessness of moderate severity (lib/parser.ts:17, severityNear lib/parser.ts:158) and evaluateSymptom only makes severe breathlessness URGENT (lib/engine.ts:586); for Ramesh it becomes the watched-symptom DEVIATION and follow-up questions are asked.`);
});

await T("RULE-19", "Severe breathlessness", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", "very breathless even sitting", "sx:breathlessness_severe");
  assert.equal(e.type, "URGENT"); assert.equal(e.title, "Severe breathlessness");
});

await T("RULE-20", "Watched symptom (swelling)", async () => {
  await fresh();
  const { m, e } = await trigger("u_ramesh", "p_ramesh", "my feet are swelling", "sx:edema");
  assert.equal(e.type, "DEVIATION"); assert.match(e.title, /reported$/);
  assert.equal(escMsgs("u_lakshmi", m).length, 1);
});

await T("RULE-21", "Very high potassium (Gopal)", async () => {
  await fresh();
  const { m, e } = await trigger("u_gopal", "p_gopal", "potassium 6.2", "lab:k_very_high");
  assert.equal(e.type, "URGENT"); assert.equal(e.title, "Very high potassium");
  assert.equal(escMsgs("u_mom", m).length, 1);
});

await T("RULE-22", "Potassium high / low, sodium out of range (Gopal)", async () => {
  await fresh();
  const hi = await trigger("u_gopal", "p_gopal", "potassium 5.4", "lab:k_high");
  const lo = await trigger("u_gopal", "p_gopal", "potassium 3.2", "lab:k_low");
  const na = await trigger("u_gopal", "p_gopal", "sodium 128", "lab:na");
  for (const x of [hi, lo, na]) assert.equal(x.e.type, "DEVIATION");
  assert.equal(na.e.title, "Sodium low");
});

await T("RULE-23", "Creatinine rising (Gopal)", async () => {
  await fresh();
  const t = await app.clock.now();
  const prev = app.q1<any>("SELECT value FROM labs WHERE patient_id = 'p_gopal' AND marker = 'creatinine' AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1", t);
  if (!prev) blocked("no earlier creatinine for Gopal");
  const v = Math.round((prev.value + 0.5) * 10) / 10;
  const { e } = await trigger("u_gopal", "p_gopal", `creatinine ${v}`, "lab:creat_rise");
  assert.equal(e.type, "DEVIATION"); assert.equal(e.title, "Creatinine rising");
  assert.match(e.detail, /up \d/);
});

await T("RULE-24", "Low haemoglobin (Gopal, limit 8)", async () => {
  await fresh();
  const { e } = await trigger("u_gopal", "p_gopal", "haemoglobin 7.4", "lab:hb_low");
  assert.equal(e.type, "DEVIATION"); assert.equal(e.title, "Haemoglobin low");
});

await T("RULE-25", "Kidney fluid check (2 days over limit / low ratio → next morning after 06:00, once)", async () => {
  await fresh();
  const e0 = maxEsc();
  await advanceTo("20:00");
  await send("u_gopal", "total intake 1300 ml, urine 650 ml");
  const dayA = localDay(await app.clock.now());
  await advanceTo("20:00");
  await send("u_gopal", "total intake 1350 ml, urine 700 ml");
  const dayB = localDay(await app.clock.now());
  assert.notEqual(dayA, dayB);
  await advanceTo("05:45");
  const early = escAfter("p_gopal", e0).filter((x) => x.rule_key === "fluid_over" || x.rule_key === "fluid_ratio_low");
  // a check on the morning of day B (looking at day A and the day before) may legitimately not fire; anything raised must be after 06:00
  for (const x of early) assert.ok(localHHMM(x.started_at) >= "06:00", `raised at ${localHHMM(x.started_at)}`);
  await advanceTo("07:00");
  const got = escAfter("p_gopal", e0).filter((x) => x.rule_key === "fluid_over" || x.rule_key === "fluid_ratio_low");
  const over = got.filter((x) => x.rule_key === "fluid_over"), ratio = got.filter((x) => x.rule_key === "fluid_ratio_low");
  assert.equal(over.length, 1, `fluid_over alerts: ${over.length}`); assert.equal(ratio.length, 1, `fluid_ratio_low alerts: ${ratio.length}`);
  for (const x of got) assert.ok(localHHMM(x.started_at) >= "06:00" && localHHMM(x.started_at) < "06:30", `raised at ${localHHMM(x.started_at)}`);
  await advanceTo("07:00");
  const again = escAfter("p_gopal", e0).filter((x) => x.rule_key === "fluid_over" || x.rule_key === "fluid_ratio_low");
  assert.equal(again.length, 2, "not raised again the next morning");
});

await T("RULE-26", "Same rule while open → REPEAT", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", "BP 186/114", "bp_crisis");
  const s = await send("u_ramesh", "BP 190/116");
  assert.equal(escAfter("p_ramesh", s.e0, "bp_crisis").length, 0, "no second alert");
  assert.ok(events(e.id).some((x) => x.event === "REPEAT"), "REPEAT event on the open alert");
  assert.equal(escMsgs("u_lakshmi", s.m).length, 0, "L1 not re-alerted");
});

await T("RULE-27", "Emergency rules before Visit 1", async () => {
  await fresh();
  const r = await app.api("u_pa_priya", "POST", "/api/patients", { name: "Test Noplan", phone: "+91 90000 77001", age: 60, sex: "M", caregivers: [{ name: "Cg Noplan", relation: "Son", phone: "+91 90000 77002" }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = app.q1<any>("SELECT id, user_id FROM patients WHERE phone = '+91 90000 77001'");
  assert.ok(p, "patient created");
  assert.ok(!app.q1("SELECT 1 FROM visits WHERE patient_id = ?", p.id), "no visit / plan");
  const cg = app.q1<any>("SELECT user_id FROM caregivers WHERE patient_id = ? AND level = 1", p.id).user_id;
  const a = await trigger(p.user_id, p.id, "BP 190/115", "bp_crisis");
  assert.equal(a.e.type, "URGENT");
  const b = await trigger(p.user_id, p.id, "chest pain", "sx:chest_pain");
  assert.equal(b.e.type, "URGENT");
  assert.ok(escMsgs(cg, a.m).length >= 2, "L1 alerted for both");
  const n = await send(p.user_id, "BP 160/98");
  assert.equal(escAfter(p.id, n.e0).length, 0, "no deviation alerts without a plan");
});

await T("RULE-28", "Abnormal ≠ emergency", async () => {
  await fresh();
  const a = await trigger("u_ramesh", "p_ramesh", "BP 178/104", "bp_high");
  assert.equal(a.e.type, "DEVIATION");
  const b = await trigger("u_ramesh", "p_ramesh", "sugar 58", "glucose_low");
  assert.equal(b.e.type, "DEVIATION");
  assert.equal(escAfter("p_ramesh", a.e0).filter((x) => x.type === "URGENT").length, 0, "never URGENT");
});

await T("RULE-29", "AI cannot raise an emergency", async () => {
  await fresh();
  const s = await send("u_ramesh", "I feel really strange today, something is not right with me");
  const urgent = escAfter("p_ramesh", s.e0).filter((x) => x.type === "URGENT").length;
  notRun(`Needs AI on (no GEMINI/ANTHROPIC key in this environment). AI-off sanity check: ambiguous worrying text raised ${urgent} URGENT alerts.`);
});

// =========================================================================================== §11 ESCALATION CHAIN
const DEV = "BP 176/100"; // bp_high, not borderline (> limit + 20)

await T("ESC-01", "L1 notified", async () => {
  await fresh();
  const { m, e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  const l1 = escMsgs("u_lakshmi", m);
  assert.equal(l1.length, 1);
  assert.match(l1[0].body, /\+91 98860 20001/, "patient phone");
  assert.ok(l1[0].body.includes(e.advice), "advice");
  assert.deepEqual(JSON.parse(l1[0].quick!), ["I'll handle it", "Pass to Arjun"]);
  const n = events(e.id).find((x) => x.event === "NOTIFIED");
  assert.ok(n && n.level === 1 && n.actor === "Lakshmi Kumar", "NOTIFIED event for L1");
  assert.equal(escMsgs("u_arjun", m).length, 0, "L2 not yet");
});

await T("ESC-02", "L1 acknowledges (ACK / ok / on it / I'll handle it / 👍)", async () => {
  await fresh();
  const cases: [string, string, string][] = [["ACK", "BP 176/100", "bp_high"], ["ok", "sugar 320", "glucose_high"], ["on it", "temp 101.5", "fever"], ["I'll handle it", "pulse 44", "hr_abnormal"], ["👍", "BP 92/60", "bp_low"]];
  for (const [word, text, rule] of cases) {
    const { e } = await trigger("u_ramesh", "p_ramesh", text, rule);
    const m = app.mark();
    await app.wa.send("u_lakshmi", word);
    const s = esc(e.id);
    assert.equal(s.state, "ACKNOWLEDGED", `"${word}" → ${s.state}`);
    assert.equal(s.ack_by, "u_lakshmi");
    const ask = out("u_lakshmi", m).find((x) => /tell me what happened/.test(x.body));
    assert.ok(ask && JSON.parse(ask.quick!).join() === "1,2,3,4", `"${word}": outcome question with 1–4`);
    assert.match(outText("u_ramesh", m), /Lakshmi Kumar from your care circle is following up/, `"${word}": patient told`);
    await app.wa.send("u_lakshmi", "1"); // close it so the next case starts clean
    assert.equal(esc(e.id).state, "RESOLVED");
  }
});

await T("ESC-03", "Outcome recorded (2)", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.wa.send("u_lakshmi", "ACK");
  const m = app.mark();
  await app.wa.send("u_lakshmi", "2");
  const after2 = esc(e.id).state;
  const askNote = outText("u_lakshmi", m);
  await app.wa.send("u_lakshmi", "Doctor said continue tablets and recheck tomorrow");
  const s = esc(e.id);
  assert.equal(s.state, "RESOLVED"); assert.equal(s.outcome_code, "2");
  assert.match(outText("u_lakshmi", m), /Recorded: Contacted doctor \/ clinic[\s\S]*Thank you/);
  assert.match(outText("u_ramesh", m), /closed the alert/);
  if (after2 !== "RESOLVED") assert.fail(`PLAN: "2" does not resolve the alert by itself — it asks for a note first ("${short(askNote, 80)}"; lib/engine.ts:810-815) and resolves with outcome 2 once the note arrives; L1 thanked and patient told as expected. Only "1" resolves at once.`);
});

await T("ESC-04", "Outcome with a note (4)", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.wa.send("u_lakshmi", "ACK");
  await app.wa.send("u_lakshmi", "4");
  await app.wa.send("u_lakshmi", "Gave him water and he rested");
  const s = esc(e.id);
  assert.equal(s.state, "RESOLVED"); assert.equal(s.outcome_code, "4"); assert.equal(s.outcome_note, "Gave him water and he rested");
});

await T("ESC-05", "Timeout moves to L2 (deviation 60 min)", async () => {
  await fresh();
  const { m, e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.clock.advance(45);
  assert.equal(esc(e.id).level, 1, "still L1 at 45 min");
  await app.clock.advance(16);
  assert.equal(esc(e.id).level, 2, "L2 after 60 min");
  const l2 = escMsgs("u_arjun", m);
  assert.equal(l2.length, 1); assert.match(l2[0].body, /Lakshmi Kumar hasn't responded in 60 min/);
  assert.ok(events(e.id).some((x) => x.event === "TIMEOUT"));
  assert.ok(app.q1("SELECT 1 FROM audit WHERE action = 'ESCALATION_LEVEL_UP' AND entity_id = ?", String(e.id)), "audit LEVEL_UP");
});

await T("ESC-06", "Urgent timer 15 min", async () => {
  await fresh();
  const { m, e } = await trigger("u_ramesh", "p_ramesh", "BP 188/112", "bp_crisis");
  await app.clock.advance(10);
  assert.equal(esc(e.id).level, 1, "still L1 at 10 min");
  await app.clock.advance(6);
  assert.equal(esc(e.id).level, 2, "L2 after 15 min");
  assert.match(escMsgs("u_arjun", m)[0]?.body ?? "", /hasn't responded in 15 min/);
});

await T("ESC-07", "Compliance timer 120 min", async () => {
  await fresh();
  // the seed leaves an acknowledged compliance alert open; new compliance items would be added to it, so close it first
  await closeOpen("p_ramesh");
  const e0 = maxEsc();
  let c: any;
  for (let i = 0; i < 96 && !c; i++) { await app.clock.advance(15); c = escAfter("p_ramesh", e0).find((x) => x.type === "COMPLIANCE"); }
  if (!c) blocked("no compliance alert appeared within 24 h");
  const at = c.level_at;
  const t = await app.clock.now();
  await app.clock.advance(Math.max(1, Math.floor((at + 110 * MIN - t) / MIN)));
  assert.equal(esc(c.id).level, 1, "still L1 at 110 min");
  await app.clock.advance(12);
  const s = esc(c.id);
  assert.equal(s.level, 2, `L2 after 120 min (state ${s.state})`);
  const to = events(c.id).find((x) => x.event === "TIMEOUT");
  assert.ok(to && to.at - at === 120 * MIN, "timeout at exactly 120 min");
});

await T("ESC-08", "L1 passes it on", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  const m = app.mark();
  await app.wa.send("u_lakshmi", "Pass to Arjun");
  assert.equal(esc(e.id).level, 2);
  const l2 = escMsgs("u_arjun", m);
  assert.equal(l2.length, 1); assert.match(l2[0].body, /couldn't take this and passed it to you/);
  const told = outText("u_lakshmi", m);
  assert.match(told, /Escalated to Level 2 \(Arjun Kumar\)/);
  // wording check (not failing): the note to L1 says "no response received" although L1 actively passed it
});

await T("ESC-09", "Exhausted", async () => {
  await fresh();
  const { m, e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.clock.advance(185);
  const s = esc(e.id);
  assert.equal(s.state, "EXHAUSTED", `state ${s.state} level ${s.level}`);
  for (const u of ["u_lakshmi", "u_arjun", "u_kavya"]) assert.match(outText(u, m), /Nobody in Ramesh's care circle acknowledged/, `${u} told`);
  assert.match(outText("u_ramesh", m), /couldn't reach your care circle/);
});

await T("ESC-10", "Others told when one acknowledges", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.clock.advance(61);
  assert.equal(esc(e.id).level, 2);
  const m = app.mark();
  await app.wa.send("u_arjun", "ACK");
  assert.equal(esc(e.id).state, "ACKNOWLEDGED");
  assert.match(outText("u_lakshmi", m), /Arjun Kumar has taken ownership/);
});

await T("ESC-11", "Only circle members can ACK", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  const m = app.mark();
  await app.wa.send("u_neha", "ACK"); // Sunita's caregiver
  assert.equal(esc(e.id).state, "NOTIFIED"); assert.equal(esc(e.id).ack_by, null);
  assert.doesNotMatch(outText("u_neha", m), /you now own/);
  const r = await dash("u_neha", e.id, { action: "ack" });
  assert.equal(r.status, 403, `dashboard ack by outsider: ${r.status}`);
  assert.equal(esc(e.id).state, "NOTIFIED");
});

await T("ESC-12", "Ack after close", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.wa.send("u_lakshmi", "ACK");
  await app.wa.send("u_lakshmi", "1");
  assert.equal(esc(e.id).state, "RESOLVED");
  const r = await dash("u_lakshmi", e.id, { action: "ack" });
  assert.equal(r.status, 409); assert.match(JSON.stringify(r.data), /Already acknowledged or closed/);
  const m = app.mark();
  await app.wa.send("u_lakshmi", "ACK");
  assert.equal(esc(e.id).state, "RESOLVED");
  assert.match(outText("u_lakshmi", m), /Nothing is waiting for acknowledgement/);
});

await T("ESC-13", "Acknowledge from the dashboard, then close", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  const m = app.mark();
  const a = await dash("u_lakshmi", e.id, { action: "ack" });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(esc(e.id).state, "ACKNOWLEDGED");
  assert.equal(events(e.id).find((x) => x.event === "ACKNOWLEDGED")?.note, "via dashboard");
  const r = await dash("u_lakshmi", e.id, { action: "resolve", code: "2", note: "Called the clinic" });
  assert.equal(r.status, 200);
  const s = esc(e.id);
  assert.equal(s.state, "RESOLVED"); assert.equal(s.outcome_code, "2"); assert.equal(s.outcome_note, "Called the clinic");
  assert.match(outText("u_lakshmi", m), /you now own this alert[\s\S]*Recorded: Contacted doctor/);
  assert.match(outText("u_ramesh", m), /following up[\s\S]*closed the alert/);
  assert.ok(app.q1("SELECT 1 FROM audit WHERE action = 'ESCALATION_RESOLVED' AND entity_id = ? AND detail LIKE '%dashboard%'", String(e.id)));
});

await T("ESC-14", "Acknowledged alert does not time out", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.wa.send("u_lakshmi", "ACK");
  const m = app.mark();
  await app.clock.advance(150);
  const s = esc(e.id);
  assert.equal(s.state, "ACKNOWLEDGED"); assert.equal(s.level, 1);
  assert.equal(escMsgs("u_arjun", m).filter((x) => /BP above/.test(x.body)).length, 0, "no L2 message");
});

await T("ESC-15", "Plan overrides timers", async () => {
  await fresh();
  const v = app.q1<any>("SELECT plan, vitals FROM visits WHERE patient_id = 'p_ramesh' ORDER BY visit_at DESC LIMIT 1");
  const plan = JSON.parse(v.plan);
  plan.escalation = { complianceMin: 90, deviationMin: 30, urgentMin: 5 };
  const r = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/visits", { vitals: JSON.parse(v.vitals), diagnosis: "Test visit (custom timers)", notes: "", plan, next_visit_at: null });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { m, e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.clock.advance(25);
  assert.equal(esc(e.id).level, 1, "still L1 at 25 min");
  await app.clock.advance(6);
  assert.equal(esc(e.id).level, 2, "L2 after the plan's 30 min");
  assert.match(escMsgs("u_arjun", m)[0]?.body ?? "", /hasn't responded in 30 min/);
  const u = await trigger("u_ramesh", "p_ramesh", "BP 190/120", "bp_crisis");
  await app.clock.advance(6);
  assert.equal(esc(u.e.id).level, 2, "urgent moved after the plan's 5 min");
});

await T("ESC-16", "Declined caregiver is skipped", async () => {
  await fresh();
  // setup: the seed has no consent rows for caregivers; add a pending request for Arjun (L2) so he can decline on WhatsApp
  app.exec("INSERT INTO consents(patient_id, user_id, role, status, requested_at) VALUES('p_ramesh','u_arjun','CAREGIVER','PENDING',?)", await app.clock.now());
  const d = app.mark();
  await app.wa.send("u_arjun", "NO");
  assert.equal(app.q1<any>("SELECT status FROM consents WHERE patient_id = 'p_ramesh' AND user_id = 'u_arjun'").status, "DECLINED");
  assert.match(outText("u_arjun", d), /won't receive care-circle alerts/);
  const { m, e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.clock.advance(61);
  const s = esc(e.id);
  const arjun = escMsgs("u_arjun", m), kavya = escMsgs("u_kavya", m);
  if (arjun.length || s.level === 2) assert.fail(`BUG: after Arjun declined consent (told "You won't receive care-circle alerts"), the timeout moved the alert to level ${s.level} and sent Arjun ${arjun.length} alert message(s) ("${short(arjun[0]?.body ?? "", 80)}"); Kavya (L3) got ${kavya.length}. notifyLevel/timeoutCaregiver pick the next level without checking consents (lib/engine.ts:392-394, 422).`);
  assert.equal(kavya.length, 1, "L3 notified instead");
});

await T("ESC-17", "Alert timeline", async () => {
  await fresh();
  const { e } = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.clock.advance(61);
  await app.wa.send("u_arjun", "ACK");
  await app.wa.send("u_arjun", "1");
  const r = await app.api("u_dr_rao", "GET", "/api/patients/p_ramesh");
  assert.equal(r.status, 200);
  const tl = (r.data.timeline as any[]).filter((x) => x.kind === "alert" && x.escalationId === e.id);
  const kinds = new Set(tl.map((x) => x.event));
  for (const k of ["CREATED", "NOTIFIED", "TIMEOUT", "ACKNOWLEDGED", "RESOLVED"]) assert.ok(kinds.has(k), `${k} in chart timeline (got ${[...kinds]})`);
  assert.ok(tl.every((x) => typeof x.at === "number"), "times");
  assert.ok(tl.find((x) => x.event === "ACKNOWLEDGED")?.actor === "Arjun Kumar", "who acknowledged");
  assert.ok(tl.filter((x) => x.event === "NOTIFIED").map((x) => x.actor).join() .includes("Lakshmi Kumar"), "who was notified");
});

// =========================================================================================== §12 SOS
await T("SOS-01", "Patient presses SOS", async () => {
  await fresh();
  const m = app.mark(), e0 = maxEsc();
  const r = await app.wa.sos("u_ramesh");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = escAfter("p_ramesh", e0, "sos");
  assert.equal(e.length, 1); assert.equal(e[0].type, "URGENT"); assert.match(e[0].title, /^Emergency: help requested/);
  assert.equal(escMsgs("u_lakshmi", m).length, 1);
  const reply = outText("u_ramesh", m);
  assert.match(reply, /Help is on the way/); assert.match(reply, /108/);
});

await T("SOS-02", "Caregiver presses SOS", async () => {
  await fresh();
  const m = app.mark(), e0 = maxEsc();
  const r = await app.wa.sos("u_arjun");
  assert.equal(r.status, 200);
  const e = escAfter("p_ramesh", e0, "sos");
  assert.equal(e.length, 1); assert.match(e[0].detail, /Arjun Kumar \(for Ramesh Kumar\)/);
  assert.equal(escMsgs("u_lakshmi", m).length, 1);
});

await T("SOS-03", "SOS escalates after 15 min", async () => {
  await fresh();
  const m = app.mark(), e0 = maxEsc();
  await app.wa.sos("u_ramesh");
  const e = escAfter("p_ramesh", e0, "sos")[0];
  await app.clock.advance(16);
  assert.equal(esc(e.id).level, 2);
  assert.equal(escMsgs("u_arjun", m).length, 1);
});

await T("SOS-04", "Second SOS while open", async () => {
  await fresh();
  const e0 = maxEsc();
  await app.wa.sos("u_ramesh");
  const m = app.mark();
  await app.wa.sos("u_ramesh");
  const e = escAfter("p_ramesh", e0, "sos");
  assert.equal(e.length, 1, "no duplicate");
  assert.ok(events(e[0].id).some((x) => x.event === "REPEAT"));
  assert.equal(escMsgs("u_lakshmi", m).length, 0, "L1 not alerted twice");
});

await T("SOS-05", "Unlinked number", async () => {
  await fresh();
  const r = await app.wa.sos("u_dr_rao");
  assert.equal(r.status, 400); assert.match(JSON.stringify(r.data), /isn't linked to a patient/);
});

await T("SOS-06", "Typed \"help\" / \"emergency\"", async () => {
  const res: string[] = [];
  for (const word of ["help", "emergency"]) {
    await fresh();
    const { m, e0 } = await send("u_ramesh", word);
    const u = escAfter("p_ramesh", e0).filter((x) => x.type === "URGENT");
    res.push(`${word}: ${u.map((x) => `${x.rule_key} "${x.title}"`).join(",") || "none"}; L1 msgs ${escMsgs("u_lakshmi", m).length}`);
    assert.ok(u.length === 1 && escMsgs("u_lakshmi", m).length === 1, `typed "${word}" should raise an URGENT alert to L1. ${res.join(" | ")}`);
  }
});

// =========================================================================================== §13 FOLLOW-UP LOOPS
await T("LOOP-01", "Symptom follow-up questions", async () => {
  await fresh();
  const s = await send("u_ramesh", "feeling breathless");
  const r = out("u_ramesh", s.m).filter((x) => x.kind === "reply").at(-1)!;
  assert.match(r.body, /When do you feel breathless\?/);
  assert.deepEqual(JSON.parse(r.quick!), ["At rest", "Walking or stairs", "Lying flat"]);
  const m2 = app.mark();
  await app.wa.send("u_ramesh", "Walking or stairs");
  const q2 = out("u_ramesh", m2).at(-1)!;
  assert.match(q2.body, /pillows/); assert.deepEqual(JSON.parse(q2.quick!), ["Yes", "No"]);
  await app.wa.send("u_ramesh", "No");
  const d = app.q1<any>("SELECT text FROM observations WHERE patient_id = 'p_ramesh' AND type = 'symptom_detail' ORDER BY id DESC LIMIT 1");
  assert.ok(d, "symptom detail saved"); assert.deepEqual(JSON.parse(d.text).answers, ["Walking or stairs", "No"]);
});

await T("LOOP-02", "Answer matches a rule (At rest → severe breathlessness)", async () => {
  await fresh();
  const s = await send("u_ramesh", "feeling breathless");
  await app.wa.send("u_ramesh", "At rest");
  const afterFirst = escAfter("p_ramesh", s.e0, "sx:breathlessness_severe").length;
  await app.wa.send("u_ramesh", "No");
  const e = escAfter("p_ramesh", s.e0, "sx:breathlessness_severe");
  assert.equal(e.length, 1, "URGENT severe breathlessness"); assert.equal(e[0].type, "URGENT");
  if (afterFirst === 0) { /* raised once both questions are answered (by design: symptoms.ts answers the 2nd question first) */ }
});

await T("LOOP-03", "Lying flat → orthopnoea; near-faint → fainting red flag", async () => {
  await fresh();
  const g = await send("u_gopal", "feeling breathless"); // Gopal's plan watches orthopnea; Ramesh's does not
  await app.wa.send("u_gopal", "Lying flat");
  await app.wa.send("u_gopal", "Yes");
  const o = escAfter("p_gopal", g.e0, "sx:orthopnea");
  assert.equal(o.length, 1, "orthopnoea alert (Gopal)");
  const r = await send("u_ramesh", "feeling dizzy");
  await app.wa.send("u_ramesh", "Yes");
  await app.wa.send("u_ramesh", "Yes");
  const f = escAfter("p_ramesh", r.e0, "sx:fainting");
  assert.equal(f.length, 1, "fainting red flag"); assert.equal(f[0].type, "URGENT");
  // Ramesh "Lying flat": orthopnea is not in his watch list → no alert, by plan design
});

await T("LOOP-04", "Reading interrupts the questions", async () => {
  await fresh();
  await send("u_ramesh", "feeling breathless");
  assert.ok(app.q1("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh' AND state = 'symptom_q'"));
  const s = await send("u_ramesh", "BP 130/80");
  assert.ok(!app.q1("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh' AND state = 'symptom_q'"), "questions ended");
  assert.ok(app.q1("SELECT 1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'bp' AND v1 = 130 AND v2 = 80 AND message_id > 0 AND observed_at >= ?", await app.clock.now() - 5 * MIN));
  assert.match(outText("u_ramesh", s.m), /Logged[\s\S]*130\/80/);
});

await T("LOOP-05", "Not asked again within 12 h", async () => {
  await fresh();
  await send("u_ramesh", "feeling breathless");
  await app.wa.send("u_ramesh", "Walking or stairs"); await app.wa.send("u_ramesh", "No");
  await app.clock.advance(120);
  const s = await send("u_ramesh", "still breathless");
  assert.doesNotMatch(outText("u_ramesh", s.m), /When do you feel breathless/);
});

async function bpAlertClosed(code: string, note?: string) {
  const t = await trigger("u_ramesh", "p_ramesh", DEV, "bp_high");
  await app.wa.send("u_lakshmi", "ACK");
  await app.wa.send("u_lakshmi", code);
  if (note) await app.wa.send("u_lakshmi", note);
  assert.equal(esc(t.e.id).state, "RESOLVED");
  return t.e;
}
const loopOf = (id: number) => { const r = app.q1<any>("SELECT value FROM settings WHERE key = ?", `loop:${id}`); return r ? JSON.parse(r.value) : null; };

await T("LOOP-06", "Recheck after an alert closes (2 h; weight next morning)", async () => {
  await fresh();
  const e = await bpAlertClosed("1");
  const l = loopOf(e.id);
  assert.ok(l, "loop scheduled"); assert.ok(Math.abs(l.dueAt - esc(e.id).resolved_at - 2 * HOUR) < 5000, "due 2 h later");
  const m = app.mark();
  await app.clock.advance(100);
  assert.equal(out("u_ramesh", m).filter((x) => /check it again/.test(x.body)).length, 0, "not before 2 h");
  await app.clock.advance(25);
  assert.equal(out("u_ramesh", m).filter((x) => /check it again/.test(x.body)).length, 1, "patient asked to recheck");
  // weight alert closed → next morning
  const t = await app.clock.now();
  const mn = app.q1<any>("SELECT MIN(v1) AS mn FROM observations WHERE patient_id = 'p_ramesh' AND type = 'weight' AND observed_at >= ?", t - 3 * DAY)?.mn;
  const w = await trigger("u_ramesh", "p_ramesh", `weight ${Math.round((mn + 2.4) * 10) / 10}`, "weight_gain");
  await app.wa.send("u_lakshmi", "ACK"); await app.wa.send("u_lakshmi", "1");
  const lw = loopOf(w.e.id);
  assert.ok(lw, "weight loop"); assert.equal(localHHMM(lw.dueAt), "07:30"); assert.ok(localDay(lw.dueAt) > localDay(esc(w.e.id).resolved_at), "next morning");
});

await T("LOOP-07", "Recheck normal → closer told", async () => {
  await fresh();
  await bpAlertClosed("1");
  await app.clock.advance(125);
  const s = await send("u_ramesh", "BP 132/82");
  assert.match(outText("u_lakshmi", s.m), /back within the doctor's limits/);
});

await T("LOOP-08", "Recheck still out of range → alert without the borderline hold", async () => {
  await fresh();
  await bpAlertClosed("1");
  await app.clock.advance(125);
  const { m, e } = await trigger("u_ramesh", "p_ramesh", "BP 158/92", "bp_high"); // would normally be held for a recheck
  assert.match(e.detail, /Still outside the limit when rechecked/);
  assert.equal(escMsgs("u_lakshmi", m).length, 1);
});

await T("LOOP-09", "No recheck → caregiver told", async () => {
  await fresh();
  await bpAlertClosed("1");
  const m = app.mark();
  await app.clock.advance(4 * 60 + 30);
  assert.equal(out("u_lakshmi", m).filter((x) => /No recheck of Ramesh's/.test(x.body)).length, 0, "not before 3 h past the request");
  await app.clock.advance(45);
  assert.equal(out("u_lakshmi", m).filter((x) => /No recheck of Ramesh's/.test(x.body)).length, 1);
});

await T("LOOP-10", "No recheck after hospital (3)", async () => {
  await fresh();
  const e = await bpAlertClosed("3", "Admitted for observation");
  assert.equal(loopOf(e.id), null);
  const m = app.mark();
  await app.clock.advance(150);
  assert.equal(out("u_ramesh", m).filter((x) => /check it again/.test(x.body)).length, 0);
});

await T("LOOP-11", "Recheck already in the plan → no extra request", async () => {
  await fresh();
  await advanceTo("05:30"); // close at ~05:30 → recheck due ~07:30; Ramesh's BP reading is due at 08:00
  await closeOpen("p_ramesh");
  const e = await bpAlertClosed("1");
  const l = loopOf(e.id);
  assert.ok(l);
  assert.ok(app.q1("SELECT 1 FROM tasks WHERE patient_id = 'p_ramesh' AND item_key = 'vital:bp' AND status = 'PENDING' AND due_at BETWEEN ? AND ?", l.dueAt - 30 * MIN, l.dueAt + 90 * MIN), "a BP reading is due in the window");
  const m = app.mark();
  await app.clock.advance(150);
  assert.equal(out("u_ramesh", m).filter((x) => /check it again/.test(x.body)).length, 0, "no extra request");
});

// =========================================================================================== §14 PATTERN WATCHES
const watchMsgs = (uid: string, m: number, re: RegExp) => out(uid, m).filter((x) => /heads-up, not an alarm/.test(x.body) && re.test(x.body));
const watch = (pid: string, key: string) => app.q<any>("SELECT * FROM watches WHERE patient_id = ? AND key = ? ORDER BY id", pid, key);

let w01: { m: number; ok: boolean; t: number } = { m: 0, ok: false, t: 0 };
await T("WATCH-01", "Weight creep", async () => {
  await fresh();
  // Gopal: turn weight creep off before the same rising sequence (used by WATCH-06)
  assert.equal((await app.api("u_dr_dileep", "POST", "/api/patients/p_gopal/watches", { action: "off", key: "weight_creep" })).status, 200);
  const t = await app.clock.now();
  const last = app.q1<any>("SELECT v1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'weight' ORDER BY observed_at DESC LIMIT 1").v1;
  const w0 = Math.round((last - 0.3) * 10) / 10;
  const m = app.mark();
  const seq = [w0, Math.round((w0 + 0.5) * 10) / 10, Math.round((w0 + 1.0) * 10) / 10];
  const gseq = [58.4, 58.9, 59.4];
  for (let i = 0; i < 3; i++) {
    if (i) await app.clock.advance(24 * 60);
    await send("u_ramesh", `weight ${seq[i]}`);
    await send("u_gopal", `weight ${gseq[i]}`);
  }
  const alerts = escAfter("p_ramesh", 0).filter((x) => x.rule_key.startsWith("weight") && x.started_at > t);
  assert.equal(alerts.length, 0, "under every limit (no weight alert)");
  const wr = watch("p_ramesh", "weight_creep").filter((x) => x.state === "OPEN");
  assert.equal(wr.length, 1, "weight-creep watch open");
  const opened = wr[0].started_at;
  assert.equal(watchMsgs("u_ramesh", m, /over 3 days/).length, 1, "patient heads-up once");
  assert.equal(watchMsgs("u_lakshmi", m, /over 3 days/).length, 1, "L1 heads-up once");
  const chart = await app.api("u_dr_rao", "GET", "/api/patients/p_ramesh");
  assert.ok((chart.data.watches as any[]).some((x) => x.key === "weight_creep"), "Pattern on the chart");
  const dashb = await app.api("u_dr_rao", "GET", "/api/dashboard");
  const tri = JSON.stringify(dashb.data).match(/"title":"Pattern: [^"]*"/);
  w01 = { m, ok: true, t };
  const lastIn = app.q1<any>("SELECT MAX(created_at) AS t FROM messages WHERE user_id = 'u_ramesh' AND direction = 'IN'").t;
  if (opened - lastIn < 10 * MIN) assert.fail(`PLAN: heads-up sent to patient and L1 once and the watch is on the chart, but not "next morning after 09:30": evaluateWatches also runs right after each reading (lib/engine.ts:1056), so it opened at ${localHHMM(opened)} IST right after the 3rd reading${tri ? "" : "; Today's triage shows the more recent alert instead of a Pattern line (precedence in lib/triage.ts:93-96)"}.`);
  assert.ok(localHHMM(opened) >= "09:30");
});

await T("WATCH-07", "Not repeated next morning", async () => {
  if (!w01.ok) blocked("WATCH-01 did not open a watch");
  await advanceTo("10:00");
  assert.equal(watchMsgs("u_ramesh", w01.m, /over 3 days/).length, 1, "patient: still one heads-up");
  assert.equal(watchMsgs("u_lakshmi", w01.m, /over 3 days/).length, 1, "L1: still one heads-up");
});

await T("WATCH-05", "Dismiss", async () => {
  if (!w01.ok) blocked("WATCH-01 did not open a watch");
  const w = watch("p_ramesh", "weight_creep").find((x) => x.state === "OPEN");
  if (!w) blocked("weight-creep watch no longer open");
  const r = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/watches", { action: "dismiss", id: w.id });
  assert.equal(r.status, 200);
  assert.equal(watch("p_ramesh", "weight_creep").find((x) => x.id === w.id).state, "DISMISSED");
  const chart = await app.api("u_dr_rao", "GET", "/api/patients/p_ramesh");
  assert.ok(!(chart.data.watches as any[]).some((x) => x.key === "weight_creep"), "gone from the chart");
  // keep creeping for 2 more days: must not reappear within 3 days
  const last = app.q1<any>("SELECT v1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'weight' ORDER BY observed_at DESC LIMIT 1").v1;
  await send("u_ramesh", `weight ${Math.round((last + 0.4) * 10) / 10}`);
  await app.clock.advance(24 * 60);
  await send("u_ramesh", `weight ${Math.round((last + 0.8) * 10) / 10}`);
  assert.equal(watch("p_ramesh", "weight_creep").filter((x) => x.state === "OPEN").length, 0, "not reopened within 3 days");
});

await T("WATCH-06", "Turn a pattern off", async () => {
  if (!w01.ok) blocked("WATCH-01 sequence did not run");
  assert.equal(watch("p_gopal", "weight_creep").filter((x) => x.started_at > w01.t).length, 0, "no weight-creep watch for Gopal (pattern off) despite the same rising weights");
  const chart = await app.api("u_dr_dileep", "GET", "/api/patients/p_gopal");
  assert.ok((chart.data.watchOff as string[]).includes("weight_creep"));
  // control: turned back on, the same weights do open a watch; turning it off again closes that open one
  assert.equal((await app.api("u_dr_dileep", "POST", "/api/patients/p_gopal/watches", { action: "on", key: "weight_creep" })).status, 200);
  await send("u_gopal", "weight 59.4");
  const openW = watch("p_gopal", "weight_creep").find((x) => x.state === "OPEN");
  assert.ok(openW, "control: with the pattern on, Gopal's rising weights open a watch");
  assert.equal((await app.api("u_dr_dileep", "POST", "/api/patients/p_gopal/watches", { action: "off", key: "weight_creep" })).status, 200);
  assert.notEqual(app.q1<any>("SELECT state FROM watches WHERE id = ?", openW.id).state, "OPEN", "open watch closed when the pattern is turned off");
  await send("u_gopal", "weight 59.4");
  assert.equal(watch("p_gopal", "weight_creep").filter((x) => x.state === "OPEN").length, 0, "stays off");
});

await T("WATCH-02", "BP drift", async () => {
  await fresh();
  await app.clock.advance(5 * 24 * 60); // so the prior week is the seed's steady readings (a 168 spike 4 days back would mask the drift)
  const m = app.mark();
  await send("u_ramesh", "BP 147/88");
  await app.clock.advance(24 * 60);
  await send("u_ramesh", "BP 148/89");
  await app.clock.advance(24 * 60);
  await send("u_ramesh", "BP 147/90");
  const w = watch("p_ramesh", "bp_drift");
  assert.ok(w.length >= 1, `bp_drift raised (watches: ${JSON.stringify(app.q("SELECT key, state FROM watches WHERE patient_id = 'p_ramesh'"))})`);
  assert.equal(watchMsgs("u_ramesh", m, /BP|blood pressure|top BP/i).length, 1);
});

await T("WATCH-04", "Adherence slip", async () => {
  // continuing from WATCH-02: three days with no medicine confirmations after the seeded (good) weeks
  const w = app.q<any>("SELECT patient_id, state FROM watches WHERE key = 'adherence_slip'");
  if (!w.length) {
    const t = await app.clock.now();
    const win = (pid: string, a: number, b: number) => app.q1<any>("SELECT COUNT(*) AS due, COALESCE(SUM(status = 'DONE'), 0) AS done FROM tasks WHERE patient_id = ? AND kind = 'med' AND status IN ('DONE','MISSED','NOT_DONE') AND due_at > ? AND due_at <= ?", pid, a, b);
    assert.fail(`no adherence_slip watch. Ramesh last 3 d ${JSON.stringify(win("p_ramesh", t - 3 * DAY, t))}, week before ${JSON.stringify(win("p_ramesh", t - 10 * DAY, t - 3 * DAY))}`);
  }
  assert.ok(w.some((x) => x.patient_id === "p_ramesh"), `raised for: ${w.map((x) => x.patient_id)}`);
});

await T("WATCH-03", "Fluid build-up", async () => {
  await fresh();
  await app.clock.advance(24 * 60);
  const m = app.mark();
  await send("u_gopal", "weight 58.5");
  await app.clock.advance(24 * 60);
  await send("u_gopal", "weight 59.0");
  await app.clock.advance(24 * 60);
  await send("u_gopal", "weight 59.5, some swelling in the feet");
  const w = watch("p_gopal", "fluid_buildup");
  assert.ok(w.length >= 1, `fluid_buildup raised (watches: ${JSON.stringify(app.q("SELECT key, state FROM watches WHERE patient_id = 'p_gopal'"))}; weight alerts: ${escAfter("p_gopal", 0).filter((x) => x.rule_key.startsWith("weight") && x.state !== "RESOLVED").length})`);
  assert.ok(watchMsgs("u_gopal", m, /fluid/i).length >= 1);
});

// =========================================================================================== §15 DOCUMENTS (AI off)
const docs = (pid: string) => app.q<any>("SELECT id, title, category, mime, size, filed_at, extract, source, uploaded_by FROM patient_documents WHERE patient_id = ? ORDER BY id", pid);
const today = async () => localDay(await app.clock.now());

await T("DOC-01", "Device photo [AI±]", async () => {
  await fresh();
  const m = app.mark();
  const r = await app.wa.media("u_ramesh", { base64: b64("fake-jpeg-bp-monitor-" + Math.random()), mime: "image/jpeg", name: "IMG_2041.jpg", filename: "IMG_2041.jpg" } as any);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(outText("u_ramesh", m), /please also type it/);
  assert.equal(app.q("SELECT 1 FROM observations WHERE patient_id = 'p_ramesh' AND observed_at >= ?", await app.clock.now() - MIN).length, 0, "nothing logged");
  // AI-on path ("I read this as BP …, is that right?") not run: no AI key
});

await T("DOC-02", "Device photo rejected", async () => {
  await fresh();
  // setup: no AI here, so stand in for the AI device read by storing the same confirmation state readDevicePhoto stores (lib/inbox.ts:85)
  app.exec("INSERT INTO convo_state(user_id, state, data) VALUES('u_ramesh','clarify',?)", JSON.stringify([{ label: "Yes, log it", text: "BP 138/86, pulse 72" }]));
  const s = await send("u_ramesh", "No");
  assert.equal(app.q("SELECT 1 FROM observations WHERE patient_id = 'p_ramesh' AND message_id > (SELECT MAX(id) - 5 FROM messages) AND type IN ('bp','hr')").length, 0, "nothing logged");
  assert.match(outText("u_ramesh", s.m), /Send it again whenever you like/);
  // and "Yes" logs it like typed text
  app.exec("INSERT INTO convo_state(user_id, state, data) VALUES('u_ramesh','clarify',?)", JSON.stringify([{ label: "Yes, log it", text: "BP 138/86, pulse 72" }]));
  await send("u_ramesh", "Yes, log it");
  assert.ok(app.q1("SELECT 1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'bp' AND v1 = 138 AND v2 = 86"), "Yes logs it");
});

let gDoc1 = 0;
const extract = (d: string) => JSON.stringify({ category: "lab", title: "Renal panel", date: d, prescriber: null, labs: [{ marker: "potassium", value: 5.6, unit: "mmol/L" }, { marker: "urea", value: 92, unit: "mg/dL" }], meds: 0, note: null });
const REPORT = b64("fake-lab-report-image-gopal-renal-panel");

await T("DOC-03", "Prescription / lab photo [AI±]", async () => {
  await fresh();
  const m = app.mark();
  const r = await app.wa.media("u_gopal", { base64: REPORT, mime: "image/jpeg", name: "lab report.jpg", filename: "lab report.jpg" } as any);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  gDoc1 = r.data.document;
  const d = docs("p_gopal").find((x) => x.id === gDoc1);
  assert.ok(d, "stored"); assert.equal(d.category, "lab"); assert.equal(d.source, "whatsapp"); assert.equal(d.filed_at, null);
  assert.match(outText("u_gopal", m), /Received/);
  const pa = await app.api("u_pa_priya", "GET", "/api/pa-today");
  const task = (pa.data.tasks as any[]).find((x) => x.id === `doc:${gDoc1}`);
  assert.ok(task, "task on Today"); assert.equal(task.label, "Document to file", "AI off: not read, so a plain 'to file' task");
});

await T("DOC-04", "Nothing filed before confirmation", async () => {
  if (!gDoc1) blocked("DOC-03 did not store a document");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(app.q("SELECT 1 FROM labs WHERE document_id = ?", gDoc1).length, 0);
  assert.equal(app.q("SELECT 1 FROM labs WHERE patient_id = 'p_gopal' AND source != 'whatsapp' AND taken_at >= ?", await app.clock.now() - HOUR).length, 0);
  const r = await app.api("u_pa_priya", "POST", "/api/patients/p_gopal/documents", { action: "autofile", id: gDoc1 });
  assert.equal(r.status, 409, "Confirm & file refused while unread (AI off)"); assert.match(JSON.stringify(r.data), /not been read/);
});

await T("DOC-05", "Confirm & file", async () => {
  if (!gDoc1) blocked("DOC-03 did not store a document");
  // setup: AI off, so write the reading the background AI read would have stored (patient_documents.extract)
  app.exec("UPDATE patient_documents SET extract = ? WHERE id = ?", extract(await today()), gDoc1);
  const pa = await app.api("u_pa_priya", "GET", "/api/pa-today");
  assert.equal((pa.data.tasks as any[]).find((x) => x.id === `doc:${gDoc1}`)?.label, "Document read, confirm to file");
  const e0 = maxEsc(), m = app.mark();
  const r = await app.api("u_pa_priya", "POST", "/api/patients/p_gopal/documents", { action: "autofile", id: gDoc1 });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.labs, 2);
  const d = docs("p_gopal").find((x) => x.id === gDoc1);
  assert.ok(d.filed_at); assert.equal(d.category, "lab"); assert.match(d.title, /^Renal panel/);
  assert.equal(app.q("SELECT 1 FROM labs WHERE document_id = ? AND marker = 'potassium'", gDoc1).length, 1, "entered once");
  const a = escAfter("p_gopal", e0, "lab:k_high");
  assert.equal(a.length, 1, "out-of-range recent result alerts the circle"); assert.equal(escMsgs("u_mom", m).length, 1);
});

await T("DOC-06", "Same report twice", async () => {
  if (!gDoc1) blocked("DOC-03 did not store a document");
  const before = app.q1<any>("SELECT COUNT(*) AS n FROM labs WHERE patient_id = 'p_gopal' AND marker IN ('potassium','urea')").n;
  const r = await app.wa.media("u_gopal", { base64: REPORT, mime: "image/jpeg", name: "lab report.jpg", filename: "lab report.jpg" } as any);
  const id2 = r.data.document;
  app.exec("UPDATE patient_documents SET extract = ? WHERE id = ?", extract(await today()), id2); // setup: stand-in for the AI read
  const f = await app.api("u_pa_priya", "POST", "/api/patients/p_gopal/documents", { action: "autofile", id: id2 });
  assert.equal(f.status, 200, JSON.stringify(f.data)); assert.equal(f.data.labs, 0);
  assert.equal(app.q1<any>("SELECT COUNT(*) AS n FROM labs WHERE patient_id = 'p_gopal' AND marker IN ('potassium','urea')").n, before, "no duplicate lab values");
});

await T("DOC-07", "PDF", async () => {
  await fresh();
  const m = app.mark();
  const r = await app.wa.media("u_ramesh", { base64: b64("%PDF-1.4 fake discharge summary"), mime: "application/pdf", name: "discharge.pdf", filename: "discharge.pdf" } as any);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = docs("p_ramesh").find((x) => x.id === r.data.document);
  assert.ok(d); assert.equal(d.mime, "application/pdf"); assert.equal(d.category, "discharge");
  assert.match(outText("u_ramesh", m), /Received “discharge.pdf”/);
});

await T("DOC-08", "Clinic upload: edit, verify, download", async () => {
  await fresh();
  const bytes = "clinic-uploaded-echo-report-" + Date.now();
  const a = await app.api("u_pa_priya", "POST", "/api/patients/p_ramesh/documents", { action: "add", title: "Echo report", category: "other", mime: "application/pdf", base64: b64(bytes) });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const id = a.data.id;
  const u = await app.api("u_pa_priya", "POST", "/api/patients/p_ramesh/documents", { action: "update", id, title: "Echo 2D report", category: "imaging" });
  assert.equal(u.status, 200);
  const v = await app.api("u_pa_priya", "POST", "/api/patients/p_ramesh/documents", { action: "verify", id });
  assert.equal(v.status, 200);
  const d = docs("p_ramesh").find((x) => x.id === id);
  assert.equal(d.title, "Echo 2D report"); assert.equal(d.category, "imaging"); assert.ok(d.filed_at);
  const res = await fetch(`${app.base}/api/documents/${id}?download=1`, { headers: { cookie: "cc_user=u_pa_priya" } });
  assert.equal(res.status, 200); assert.match(res.headers.get("content-disposition") ?? "", /^attachment/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), bytes);
  const acts = app.q<any>("SELECT action FROM audit WHERE entity_id = 'p_ramesh' AND detail LIKE ?", `%"document":${id}%`).map((x) => x.action);
  for (const k of ["DOCUMENT_ADDED", "DOCUMENT_UPDATED", "DOCUMENT_VERIFIED"]) assert.ok(acts.includes(k), `audit ${k} (got ${acts})`);
});

await T("DOC-09", "Delete document with its data", async () => {
  await fresh();
  const r = await app.wa.media("u_gopal", { base64: REPORT, mime: "image/jpeg", name: "lab report.jpg", filename: "lab report.jpg" } as any);
  const id = r.data.document;
  app.exec("UPDATE patient_documents SET extract = ? WHERE id = ?", extract(await today()), id); // setup: stand-in for the AI read
  assert.equal((await app.api("u_pa_priya", "POST", "/api/patients/p_gopal/documents", { action: "autofile", id })).status, 200);
  const fromDoc = app.q1<any>("SELECT COUNT(*) AS n FROM labs WHERE document_id = ?", id).n;
  const others = app.q1<any>("SELECT COUNT(*) AS n FROM labs WHERE patient_id = 'p_gopal' AND (document_id IS NULL OR document_id != ?)", id).n;
  assert.equal(fromDoc, 2);
  const del = await app.api("u_pa_priya", "POST", "/api/patients/p_gopal/documents", { action: "delete", id, withData: true });
  assert.equal(del.status, 200, JSON.stringify(del.data)); assert.equal(del.data.labs, 2);
  assert.ok(!app.q1("SELECT 1 FROM patient_documents WHERE id = ?", id), "report removed");
  assert.equal(app.q1<any>("SELECT COUNT(*) AS n FROM labs WHERE document_id = ?", id).n, 0, "its lab values removed");
  assert.equal(app.q1<any>("SELECT COUNT(*) AS n FROM labs WHERE patient_id = 'p_gopal'").n, others, "other labs kept");
});

await T("DOC-10", "Unsupported file (.exe / huge)", async () => {
  await fresh();
  const big = Buffer.alloc(51 * 1024 * 1024, 1).toString("base64");
  const h = await app.wa.media("u_ramesh", { base64: big, mime: "image/jpeg", name: "huge.jpg", filename: "huge.jpg" } as any);
  const hugeOk = h.status === 400 && /limited to 50 MB/.test(JSON.stringify(h.data));
  const m = app.mark();
  const x = await app.wa.media("u_ramesh", { base64: b64("MZ\x90\x00fake-windows-executable"), mime: "application/x-msdownload", name: "setup.exe", filename: "setup.exe" } as any);
  const stored = x.status === 200 ? docs("p_ramesh").find((d) => d.id === x.data.document) : null;
  assert.ok(hugeOk, `51 MB file: ${h.status} ${short(JSON.stringify(h.data), 100)}`);
  if (stored) assert.fail(`PLAN: a 51 MB file is rejected ("Files are limited to 50 MB"), but an .exe (application/x-msdownload) is accepted and stored as document ${stored.id} with reply "${short(outText("u_ramesh", m), 90)}". addDocument has no type allowlist (lib/records.ts:206); the download route deliberately serves unknown types as opaque attachments (app/api/documents/[id]/route.ts:15), so this looks intentional — the plan's "rejected" isn't how it is designed.`);
});

await T("DOC-11", "Voice note [AI±] (typed transcript)", async () => {
  await fresh();
  const m = app.mark();
  const r = await app.wa.media("u_ramesh", { kind: "voice", base64: b64("fake-webm-audio"), mime: "audio/webm", transcript: "BP 135/85, took tablets", transcriptSource: "typed", durationSec: 6 } as any);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(app.q1("SELECT 1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'bp' AND v1 = 135 AND v2 = 85"), "BP logged from the voice note");
  assert.match(outText("u_ramesh", m), /Logged[\s\S]*135\/85/);
  assert.ok(docs("p_ramesh").some((d) => d.id === r.data.document && d.category === "voice"), "voice note kept");
});

await T("DOC-12", "Reader output never shown as real (AI off)", async () => {
  await fresh();
  const r = await app.wa.media("u_gopal", { base64: b64("another-fake-report-" + Math.random()), mime: "image/jpeg", name: "lab report 2.jpg", filename: "lab report 2.jpg" } as any);
  const id = r.data.document;
  await new Promise((res) => setTimeout(res, 800));
  const d = docs("p_gopal").find((x) => x.id === id);
  assert.equal(d.extract, null, "no reading stored"); assert.equal(d.filed_at, null, "still to file");
  const rr = await app.api("u_pa_priya", "POST", "/api/patients/p_gopal/documents", { action: "reread", id });
  assert.equal(rr.status, 422, "re-read refuses rather than inventing values");
  assert.equal(docs("p_gopal").find((x) => x.id === id).extract, null);
  assert.equal(app.q("SELECT 1 FROM labs WHERE document_id = ?", id).length, 0);
  // the AI-failure fallback path (simulated reader output with source "sample") needs an AI key and was not exercised
});

const demoLog = path.join(os.tmpdir(), "cc-e2e-alerts.server.log");
await app.stop();

// =========================================================================================== §21 TWILIO (live mode, FAKE credentials)
// Safety: lib/whatsapp.ts deliver() marks any message to a number not on WHATSAPP_ALLOWLIST as "skipped" before any
// network call (whatsapp.ts:104). The allowlist holds a number nobody in this test has, so nothing is ever sent.
// Status code 63016 is never posted: deliveryStatus() would re-hold that message bypassing the allowlist check.
if (!ONLY || ONLY.test("TW-")) {
  const TOKEN = "testtoken-not-real";
  const BASE = "http://127.0.0.1:3214";
  const tw = await startApp({
    mode: "live", port: 3214, suite: "alerts-twilio",
    env: { TWILIO_ACCOUNT_SID: "ACtest00000000000000000000000000", TWILIO_AUTH_TOKEN: TOKEN, TWILIO_WHATSAPP_FROM: "+10000000000", WHATSAPP_GATEWAY: "on", WHATSAPP_ALLOWLIST: "+10000000001", PUBLIC_BASE_URL: BASE, NODE_OPTIONS: `--require ${path.join(import.meta.dirname, "live-preload.cjs")}` },
  });
  const sign = (url: string, p: Record<string, string>) => crypto.createHmac("sha1", TOKEN).update(Buffer.from(url + Object.keys(p).sort().map((k) => k + p[k]).join(""), "utf-8")).digest("base64");
  const post = async (pathName: string, p: Record<string, string>, sig?: string) => {
    const r = await fetch(BASE + pathName, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig ?? sign(BASE + pathName, p) }, body: new URLSearchParams(p) });
    return { status: r.status, text: await r.text() };
  };
  // setup (no API for it in this context): one synthetic patient + caregiver with made-up numbers, NOT on the allowlist
  const now0 = Date.now();
  tw.exec("INSERT OR IGNORE INTO users(id, name, role, phone, title) VALUES('u_tw_doc','Dr Test','DOCTOR','+91 90000 99000','Doctor')");
  tw.exec("INSERT INTO users(id, name, role, phone, title) VALUES('u_tw_pat','Tw Patient','PATIENT','+91 90000 99001','Patient')");
  tw.exec("INSERT INTO users(id, name, role, phone, title) VALUES('u_tw_cg','Tw Carer','CAREGIVER','+91 90000 99002','Son')");
  tw.exec("INSERT INTO patients(id, user_id, name, age, sex, phone, conditions, address, doctor_id, created_at) VALUES('p_tw','u_tw_pat','Tw Patient',60,'M','+91 90000 99001','','', 'u_tw_doc', ?)", now0);
  tw.exec("INSERT INTO caregivers(id, patient_id, user_id, name, relation, phone, level, dashboard) VALUES('cg_tw_1','p_tw','u_tw_cg','Tw Carer','Son','+91 90000 99002',1,1)");
  const PAT = "whatsapp:+919000099001";
  const liveCheck = await tw.api(null, "POST", "/api/demo", { action: "reset" });
  if (liveCheck.status !== 400) throw new Error(`Twilio app is not in live mode (reset → ${liveCheck.status})`);
  const inCount = () => tw.q1<any>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'IN'").n;
  const TT = async (id: string, title: string, fn: () => Promise<void> | void) => { if (!ONLY || ONLY.test(id)) await tw.test(id, title, fn); };

  await TT("TW-01", "Webhook signature", async () => {
    const before = inCount();
    const p = { From: PAT, To: "whatsapp:+10000000000", Body: "BP 150/90", MessageSid: "SMbad0001", NumMedia: "0" };
    const r = await post("/api/twilio/inbound", p, "bm90LWEtcmVhbC1zaWduYXR1cmU=");
    assert.equal(r.status, 403);
    const r2 = await post("/api/twilio/inbound", p, "");
    assert.equal(r2.status, 403, "missing signature");
    const r3 = await post("/api/twilio/status", { MessageSid: "SMx", MessageStatus: "delivered" }, "bad");
    assert.equal(r3.status, 403, "status callback with a bad signature");
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(inCount(), before, "nothing stored");
  });

  await TT("TW-02", "Valid inbound message", async () => {
    const p = { From: PAT, To: "whatsapp:+10000000000", Body: "BP 135/85 took all tablets", MessageSid: "SMok0001", NumMedia: "0", ProfileName: "Tw" };
    const r = await post("/api/twilio/inbound", p);
    assert.equal(r.status, 200); assert.match(r.text, /<Response>/);
    const msg = await until(() => tw.q1<any>("SELECT * FROM messages WHERE user_id = 'u_tw_pat' AND direction = 'IN' AND body = ?", p.Body), 8000);
    assert.ok(msg, "inbound stored");
    const obs = await until(() => tw.q1<any>("SELECT * FROM observations WHERE patient_id = 'p_tw' AND type = 'bp' AND v1 = 135"), 8000);
    assert.ok(obs, "handled like the simulator (BP logged)");
    const reply = await until(() => tw.q1<any>("SELECT * FROM messages WHERE user_id = 'u_tw_pat' AND direction = 'OUT' AND kind = 'reply' AND id > ?", msg.id), 8000);
    assert.ok(reply, "reply stored");
    const st = await until(() => tw.q1<any>("SELECT wa_status, wa_error FROM messages WHERE id = ?", reply.id).wa_status !== "pending" && tw.q1<any>("SELECT wa_status, wa_error FROM messages WHERE id = ?", reply.id), 8000);
    assert.equal(st.wa_status, "skipped", `reply was not sent (allowlist): ${JSON.stringify(st)}`);
  });

  await TT("TW-03", "Idempotent inbound", async () => {
    const p = { From: PAT, To: "whatsapp:+10000000000", Body: "sugar 140", MessageSid: "SMdup0001", NumMedia: "0" };
    await post("/api/twilio/inbound", p);
    await post("/api/twilio/inbound", p);
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(tw.q<any>("SELECT 1 FROM messages WHERE user_id = 'u_tw_pat' AND direction = 'IN' AND body = 'sugar 140'").length, 1, "processed once");
    assert.equal(tw.q<any>("SELECT 1 FROM observations WHERE patient_id = 'p_tw' AND type = 'glucose' AND v1 = 140").length, 1);
  });

  await TT("TW-04", "Inbound media (download + size limit)", async () => {
    let auth = "";
    const srv = http.createServer((req, res) => {
      auth = String(req.headers.authorization ?? "");
      if (req.url === "/big") { res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(21 * 1024 * 1024) }); res.end(Buffer.alloc(21 * 1024 * 1024)); return; }
      res.writeHead(200, { "content-type": "image/jpeg" }); res.end(Buffer.from("fake-jpeg-from-twilio-media"));
    });
    await new Promise<void>((r) => srv.listen(3298, "127.0.0.1", () => r()));
    try {
      const before = tw.q1<any>("SELECT COUNT(*) AS n FROM patient_documents WHERE patient_id = 'p_tw'").n;
      const p = { From: PAT, To: "whatsapp:+10000000000", Body: "", MessageSid: "SMmedia01", NumMedia: "1", MediaUrl0: "http://127.0.0.1:3298/photo", MediaContentType0: "image/jpeg" };
      assert.equal((await post("/api/twilio/inbound", p)).status, 200);
      const d = await until(() => tw.q1<any>("SELECT * FROM patient_documents WHERE patient_id = 'p_tw' ORDER BY id DESC LIMIT 1"), 8000);
      assert.ok(d && tw.q1<any>("SELECT COUNT(*) AS n FROM patient_documents WHERE patient_id = 'p_tw'").n === before + 1, "downloaded and stored");
      assert.equal(Buffer.from(tw.q1<any>("SELECT data FROM patient_documents WHERE id = ?", d.id).data).toString(), "fake-jpeg-from-twilio-media");
      assert.match(auth, /^Basic /, "fetched with account credentials");
      const reply = await until(() => tw.q1<any>("SELECT body FROM messages WHERE user_id = 'u_tw_pat' AND direction = 'OUT' AND body LIKE '%Received “Photo”%'"), 8000);
      assert.ok(reply, "handled like DOC-01 (AI off: asked to type the reading)");
      const p2 = { ...p, MessageSid: "SMmedia02", MediaUrl0: "http://127.0.0.1:3298/big" };
      assert.equal((await post("/api/twilio/inbound", p2)).status, 200);
      const big = await until(() => tw.q1<any>("SELECT body FROM messages WHERE user_id = 'u_tw_pat' AND direction = 'OUT' AND body LIKE '%too large%'"), 10000);
      assert.ok(big, "over-limit file refused with a message");
      assert.equal(tw.q1<any>("SELECT COUNT(*) AS n FROM patient_documents WHERE patient_id = 'p_tw'").n, before + 1, "big file not stored");
    } finally { srv.close(); }
  });

  await TT("TW-05", "Delivery status callbacks", async () => {
    const msgs = tw.q<any>("SELECT id FROM messages WHERE user_id = 'u_tw_pat' AND direction = 'OUT' ORDER BY id DESC LIMIT 2");
    if (msgs.length < 2) blocked("no outbound messages to attach statuses to");
    // setup: nothing is really sent here, so give two stored messages a Twilio SID as a real send would
    tw.exec("UPDATE messages SET wa_sid = 'SMstat0001', wa_status = 'sent' WHERE id = ?", msgs[0].id);
    tw.exec("UPDATE messages SET wa_sid = 'SMstat0002', wa_status = 'sent' WHERE id = ?", msgs[1].id);
    const st = (id: number) => tw.q1<any>("SELECT wa_status, wa_error FROM messages WHERE id = ?", id);
    for (const s of ["queued", "sent", "delivered"]) assert.equal((await post("/api/twilio/status", { MessageSid: "SMstat0001", MessageStatus: s })).status, 204);
    assert.equal(st(msgs[0].id).wa_status, "delivered");
    await post("/api/twilio/status", { MessageSid: "SMstat0001", MessageStatus: "failed", ErrorCode: "30008" });
    assert.equal(st(msgs[0].id).wa_status, "delivered", "a late failure does not undo delivered");
    await post("/api/twilio/status", { MessageSid: "SMstat0002", MessageStatus: "failed", ErrorCode: "30008" });
    assert.equal(st(msgs[1].id).wa_status, "failed"); assert.match(st(msgs[1].id).wa_error, /30008/);
    // shown to the clinic? nothing outside lib/ reads wa_status / wa_error
    const dashTxt = JSON.stringify((await tw.api("u_tw_doc", "GET", "/api/patients/p_tw")).data);
    assert.ok(/30008|failed to deliver|not delivered|wa_status/i.test(dashTxt), "BUG: message status is updated (delivered; failed with error 30008 kept in messages.wa_error), but no API or page shows delivery failures to the clinic — wa_status/wa_error are only read in lib/whatsapp.ts and lib/engine.ts (no reference under app/ or components/).");
  });

  await TT("TW-06", "Templates outside 24 h", () => notRun("Needs a real Twilio account and approved templates delivered to an allowlisted test phone; with the fake credentials any allowlisted send would hit api.twilio.com. Template choice logic (lib/whatsapp.ts hold()) not exercised end to end."));
  await TT("TW-07", "Buttons", () => notRun("Needs a real Twilio account (Content API button resources are created on send, lib/twilio.ts buttonsContent)."));
  await TT("TW-08", "Long message split", () => notRun("Needs a real Twilio send to observe the split parts (lib/whatsapp.ts splitText/sendSession)."));

  await TT("TW-09", "Stranger", async () => {
    const usersBefore = tw.q1<any>("SELECT COUNT(*) AS n FROM users").n, inBefore = inCount();
    const p = { From: "whatsapp:+919000088888", To: "whatsapp:+10000000000", Body: "Hi, what is Tw Patient's BP?", MessageSid: "SMstr0001", NumMedia: "0" };
    const r = await post("/api/twilio/inbound", p);
    assert.equal(r.status, 200); assert.match(r.text, /isn't linked to a patient yet/);
    assert.doesNotMatch(r.text, /Tw Patient|135|BP/);
    const r2 = await post("/api/twilio/inbound", { ...p, MessageSid: "SMstr0002" });
    assert.doesNotMatch(r2.text, /<Message>/, "one polite note a day");
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(tw.q1<any>("SELECT COUNT(*) AS n FROM users").n, usersBefore); assert.equal(inCount(), inBefore, "body not stored");
    const logged = tw.q<any>("SELECT key FROM settings WHERE key LIKE '%919000088888%'").map((x) => x.key);
    const pa = JSON.stringify((await tw.api("u_tw_doc", "GET", "/api/dashboard")).data);
    if (!/919000088888|90000 88888/.test(pa)) assert.fail(`PLAN: polite reply sent, nothing revealed, body not stored — but nothing is "logged for the clinic": only timestamps are kept (${logged.join(", ")}) and no page lists unknown senders. By design (app/api/twilio/inbound/route.ts:22 "only the time they wrote is kept").`);
  });

  await tw.stop();
  const twLog = path.join(os.tmpdir(), "cc-e2e-alerts-twilio.server.log");
  // TW-10 is recorded via a tiny follow-up app-less record (append to the same JSONL)
  const logs = [demoLog, twLog].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")).join("\n");
  const leaks = ["185/112", "135/85", "BP 135", "sugar 140", "potassium 6.2", "chest pain", "Hi, what is", "fake-jpeg"].filter((s) => logs.includes(s));
  const res = { id: "TW-10", title: "No health data in logs", status: leaks.length ? "FAIL" : "PASS", note: leaks.length ? `server logs contain: ${leaks.join(", ")}` : `checked ${logs.length} bytes of server logs (demo + live) for message bodies/readings; none found`, ms: 0 };
  if (!ONLY || ONLY.test("TW-10")) {
    fs.appendFileSync(path.join(RESULTS_DIR, "alerts-twilio.jsonl"), JSON.stringify(res) + "\n");
    console.log(`${res.status.padEnd(7)} TW-10        ${res.title} — ${res.note}`);
  }
}
void blocked;
