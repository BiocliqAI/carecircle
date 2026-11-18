// Two safety fixes from the end-to-end test report (docs/E2E_TEST_REPORT.md):
//  D1 — a caregiver who declined consent receives no alerts or care-circle messages, and the escalation chain skips
//       them (WA-CON-05, WA-CON-11, ESC-16).
//  D2 — "I can't breathe" (and similar) is severe breathlessness, an URGENT alert, whichever parser read it (RULE-18).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-safety-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { all, get } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { userByPhone } = await import("../lib/whatsapp");
const { now } = await import("../lib/clock");
const { severeBreathingIn, applySevereBreathing, parseRules } = await import("../lib/parser");
const { MIN } = await import("../lib/time");

type Msg = { body: string; kind: string; quick: string | null };
const lastId = () => get<{ m: number | null }>("SELECT MAX(id) AS m FROM messages")?.m ?? 0;
const sentTo = (uid: string, after: number) => all<Msg>("SELECT body, kind, quick FROM messages WHERE user_id = ? AND direction = 'OUT' AND id > ? ORDER BY id", uid, after);
const alertsTo = (uid: string, after: number) => sentTo(uid, after).filter((m) => m.kind === "escalation");
const uidOf = (phone: string) => userByPhone(`whatsapp:${phone}`)!.id;

let doc = "";
let seq = 0;
/** A new patient (no care plan yet: the fixed emergency rules apply) with two caregivers who answer as given. */
async function circle(l1: "YES" | "NO" | null, l2: "YES" | "NO" | null) {
  const n = ++seq;
  const t = now();
  const pPhone = `+9198100${String(n).padStart(2, "0")}001`, c1 = `+9198100${String(n).padStart(2, "0")}002`, c2 = `+9198100${String(n).padStart(2, "0")}003`;
  const pid = engine.onboardPatient({ name: `Safety Patient ${n}`, age: 70, sex: "M", phone: pPhone, conditions: "", address: "", doctorId: doc, caregivers: [
    { name: `First Carer ${n}`, relation: "Son", phone: c1, level: 1 },
    { name: `Backup Carer ${n}`, relation: "Daughter", phone: c2, level: 2 },
  ] }, t, doc);
  const ids = { pid, patient: uidOf(pPhone), l1: uidOf(c1), l2: uidOf(c2) };
  await engine.ingestMessage(ids.patient, "YES", { allowAi: false });
  if (l1) await engine.ingestMessage(ids.l1, l1, { allowAi: false });
  if (l2) await engine.ingestMessage(ids.l2, l2, { allowAi: false });
  return ids;
}
const openEsc = (pid: string) => get<{ id: number; level: number; state: string }>("SELECT id, level, state FROM escalations WHERE patient_id = ? ORDER BY id DESC LIMIT 1", pid)!;

describe("D1: a caregiver who declined consent is left out of alerts and care-circle messages", () => {
  before(async () => {
    await seedDemo();
    doc = all<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR'")[0].id;
  });

  it("declined first caregiver: the alert starts with the backup, who agreed; the decliner hears nothing", async () => {
    const c = await circle("NO", "YES");
    const m = lastId();
    await engine.ingestMessage(c.patient, "BP 190/115", { allowAi: false });
    assert.equal(alertsTo(c.l1, m).length, 0, "declined L1 gets no alert");
    assert.equal(alertsTo(c.l2, m).length, 1, "consented L2 gets it straight away");
    assert.equal(openEsc(c.pid).level, 2);
    assert.match(sentTo(c.patient, m).map((x) => x.body).join("\n"), /Alerting your care circle now \(Backup Carer/);
  });

  it("declined backup: when the first caregiver doesn't answer, the backup is skipped and the alert is closed as unanswered", async () => {
    const c = await circle("YES", "NO");
    const m = lastId();
    await engine.ingestMessage(c.patient, "BP 190/115", { allowAi: false });
    const first = alertsTo(c.l1, m);
    assert.equal(first.length, 1);
    assert.doesNotMatch(first[0].quick ?? "", /Pass to/, "no 'Pass to' button for a backup who declined");
    const esc = openEsc(c.pid);
    engine.timeoutCaregiver(esc.id, now() + 16 * MIN, "timer");
    assert.equal(openEsc(c.pid).state, "EXHAUSTED");
    assert.equal(alertsTo(c.l2, m).length, 0, "declined L2 gets neither the alert nor the 'nobody acknowledged' message");
    assert.match(sentTo(c.patient, m).map((x) => x.body).join("\n"), /couldn't reach your care circle/);
  });

  it("a caregiver who hasn't answered the invitation yet still gets emergency alerts", async () => {
    const c = await circle(null, "YES");
    const m = lastId();
    await engine.ingestMessage(c.patient, "BP 190/115", { allowAi: false });
    assert.equal(alertsTo(c.l1, m).length, 1);
    assert.equal(openEsc(c.pid).level, 1);
  });

  it("everyone declined: the patient is told at once that the circle can't be reached", async () => {
    const c = await circle("NO", "NO");
    const m = lastId();
    await engine.ingestMessage(c.patient, "BP 190/115", { allowAi: false });
    assert.equal(alertsTo(c.l1, m).length + alertsTo(c.l2, m).length, 0);
    assert.equal(openEsc(c.pid).state, "EXHAUSTED");
    assert.match(sentTo(c.patient, m).map((x) => x.body).join("\n"), /couldn't reach your care circle/);
  });

  it("passing an alert on goes to the next caregiver who agreed, and the message says it was passed on", async () => {
    const c = await circle("YES", "YES");
    const m = lastId();
    await engine.ingestMessage(c.patient, "BP 190/115", { allowAi: false });
    const first = alertsTo(c.l1, m)[0];
    assert.match(first.quick ?? "", /Pass to Backup/);
    engine.timeoutCaregiver(openEsc(c.pid).id, now(), "whatsapp");
    assert.equal(alertsTo(c.l2, m).length, 1);
    assert.match(sentTo(c.l1, m).map((x) => x.body).join("\n"), /Passed on: Backup Carer \d+ now has the alert/);
  });

  it("care-plan updates are not sent to a caregiver who declined", async () => {
    const c = await circle("YES", "NO");
    const m = lastId();
    const plan = engine.latestVisit("p_ramesh")!.plan;
    engine.createVisit(c.pid, doc, { vitals: {}, diagnosis: "Hypertension", notes: "", plan, next_visit_at: null }, now(), now(), { start: true });
    assert.ok(sentTo(c.l1, m).some((x) => /care plan/i.test(x.body)), "consented caregiver told about the plan");
    assert.equal(sentTo(c.l2, m).filter((x) => /care plan/i.test(x.body)).length, 0, "declined caregiver not told");
  });
});

describe("D2: 'I can't breathe' is an emergency", () => {
  it("recognises breathing-is-failing words, but not negations or milder wording", () => {
    for (const s of ["I can't breathe", "i cant breathe properly", "He cannot breathe", "unable to breathe", "gasping for air", "struggling to breathe", "can’t catch my breath", "she is choking"]) assert.ok(severeBreathingIn(s), s);
    for (const s of ["I can breathe fine now", "no gasping", "slightly breathless on stairs", "breathing is better today", "BP 130/80"]) assert.equal(severeBreathingIn(s), null, s);
  });

  it("upgrades breathlessness read as moderate (as an AI parser might) to severe, and adds it if missing", () => {
    const p = parseRules("feeling breathless", []);
    p.symptoms = [{ key: "breathlessness", severity: "moderate", text: "breathless" }];
    applySevereBreathing(p, "I can't breathe");
    assert.equal(p.symptoms[0].severity, "severe");
    const q = parseRules("hello", []);
    q.symptoms = [];
    applySevereBreathing(q, "gasping for air");
    assert.deepEqual(q.symptoms.map((s) => [s.key, s.severity]), [["breathlessness", "severe"]]);
  });

  it("on WhatsApp: 'I can't breathe' raises the URGENT severe-breathlessness alert; milder wording does not", async () => {
    const c = await circle("YES", "YES");
    let m = lastId();
    await engine.ingestMessage(c.patient, "I can't breathe", { allowAi: false });
    const esc = get<{ type: string; rule_key: string }>("SELECT type, rule_key FROM escalations WHERE patient_id = ? ORDER BY id DESC LIMIT 1", c.pid)!;
    assert.equal(esc.type, "URGENT");
    assert.equal(esc.rule_key, "sx:breathlessness_severe");
    assert.match(alertsTo(c.l1, m)[0].body, /URGENT/);

    const d = await circle("YES", "YES");
    m = lastId();
    await engine.ingestMessage(d.patient, "slightly breathless on the stairs", { allowAi: false });
    assert.equal(get("SELECT 1 FROM escalations WHERE patient_id = ? AND type = 'URGENT'", d.pid), undefined);
  });
});
