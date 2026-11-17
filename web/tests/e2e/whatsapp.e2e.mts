// E2E suite "whatsapp": §7 consent (WA-CON-*), §8 readings and logging (WA-LOG-*), §9 reminders and compliance
// (WA-REM-*), §17 digests and language (DIG-*, LANG-*), §20 clock, scheduler and data integrity (TIME-*).
// Run: cd web && npx tsx tests/e2e/whatsapp.e2e.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { startApp, assert, notRun, blocked } from "./harness.mts";

const app = await startApp({ port: 3203, suite: "whatsapp" });
const { q, q1, exec, wa, api, clock } = app;

// ---------------------------------------------------------------- time helpers (clinic time = IST)
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, OFF = 330 * MIN;
const dayStart = (t: number) => Math.floor((t + OFF) / DAY) * DAY - OFF;
const atL = (t: number, hm: string) => { const [h, m] = hm.split(":").map(Number); return dayStart(t) + h * HOUR + m * MIN; };
const hm = (t: number) => new Date(t + OFF).toISOString().slice(11, 16);
const iso = (t: number) => new Date(t + OFF).toISOString().slice(0, 16).replace("T", " ");
const dow = (t: number) => new Date(t + OFF).getUTCDay();
async function advanceTo(h: string, plus = 0) {
  const n = await clock.now();
  let tg = atL(n, h);
  if (tg <= n) tg += DAY;
  await clock.advance(Math.ceil((tg - n) / MIN) + plus);
}

// ---------------------------------------------------------------- bookkeeping: exactly one result per ID
const ALL_IDS = [
  ...Array.from({ length: 12 }, (_, i) => `WA-CON-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 25 }, (_, i) => `WA-LOG-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, i) => `WA-REM-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 5 }, (_, i) => `DIG-0${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `LANG-0${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `TIME-0${i + 1}`),
];
const recorded = new Set<string>();
const phaseErr: Record<string, string> = {};
async function T(id: string, title: string, fn: () => Promise<void> | void) {
  if (recorded.has(id)) throw new Error(`duplicate result for ${id}`);
  recorded.add(id);
  return app.test(id, title, fn);
}

// ---------------------------------------------------------------- WhatsApp helpers
async function send(uid: string, body: string) {
  const mk = app.mark();
  const r = await wa.send(uid, body);
  if (r.status !== 200) throw new Error(`send ${uid} "${body.slice(0, 40)}" -> ${r.status} ${JSON.stringify(r.data)}`);
  const out = wa.since(uid, mk);
  const replies = out.filter((m) => m.kind === "reply");
  const inMsg = q1<{ id: number; body: string; patient_id: string | null; parsed: string | null }>("SELECT * FROM messages WHERE user_id = ? AND direction = 'IN' AND id > ? ORDER BY id DESC LIMIT 1", uid, mk);
  return { mk, out, reply: replies.map((m) => m.body).join("\n---\n"), quick: replies.length ? (JSON.parse(replies[replies.length - 1].quick || "[]") as string[]) : [], inMsg: inMsg! };
}
const escTo = (uid: string, mk: number) => wa.since(uid, mk).filter((m) => m.kind === "escalation");
const obsFor = (msgId: number) => q<{ id: number; type: string; v1: number; v2: number | null; logged_by: string; patient_id: string; text: string | null; flag: string | null }>("SELECT * FROM observations WHERE message_id = ?", msgId);
const short = (s: string, n = 220) => s.replace(/\s+/g, " ").slice(0, n);

let seq = 70001;
const newPhone = () => `+91 90000 ${seq++}`;
async function onboard(name: string, cgs: (string | { name: string; phone: string })[]) {
  const list = cgs.map((c) => (typeof c === "string" ? { name: c, relation: "Son", phone: newPhone() } : { ...c, relation: "Son" }));
  const r = await api("u_dr_rao", "POST", "/api/patients", { name, phone: newPhone(), caregivers: list });
  if (r.status !== 200) throw new Error(`onboard ${name}: ${r.status} ${JSON.stringify(r.data)}`);
  const pid = r.data.id as string;
  const uid = q1<{ user_id: string }>("SELECT user_id FROM patients WHERE id = ?", pid)!.user_id;
  const rows = q<{ id: string; user_id: string; phone: string; name: string }>("SELECT id, user_id, phone, name FROM caregivers WHERE patient_id = ? ORDER BY level", pid);
  return { pid, uid, cg: rows.map((x) => x.user_id), rows };
}
const consent = (pid: string, uid: string) => q1<{ status: string; requested_at: number }>("SELECT status, requested_at FROM consents WHERE patient_id = ? AND user_id = ?", pid, uid);

/** Close every open alert of a patient through the caregiver API (isolation from seeded alerts). */
async function closeOpen(pid: string) {
  for (const e of q<{ id: number; ack_by: string | null }>("SELECT id, ack_by FROM escalations WHERE patient_id = ? AND state IN ('NOTIFIED','ACKNOWLEDGED')", pid)) {
    const cg = e.ack_by ?? q1<{ user_id: string }>("SELECT user_id FROM caregivers WHERE patient_id = ? ORDER BY level LIMIT 1", pid)!.user_id;
    const r = await api(cg, "POST", `/api/escalations/${e.id}`, { action: "resolve", code: "1", note: "e2e setup: closing seeded alert" });
    if (r.status !== 200) throw new Error(`close escalation ${e.id}: ${r.status} ${JSON.stringify(r.data)}`);
  }
}
const medTasks = (pid: string, hmS: string, t: number) => q<{ id: number; item_key: string; label: string; status: string; late: number; due_at: number }>("SELECT * FROM tasks WHERE patient_id = ? AND kind = 'med' AND due_at = ?", pid, atL(t, hmS));

// =====================================================================================================
// Phase A1 — immediate replies (time of day does not matter)
// =====================================================================================================
async function phaseA1() {
  await closeOpen("p_ramesh"); // seed leaves an old ACKNOWLEDGED compliance alert that would absorb new items

  // ---------------- §7 consent
  const P1 = await onboard("Consent Yes Patient", ["Cg Alpha"]);
  await T("WA-CON-01", "Patient says YES", async () => {
    const r = await send(P1.uid, "YES");
    assert.match(r.reply, /Consent recorded/, `reply: ${short(r.reply)}`);
    assert.equal(consent(P1.pid, P1.uid)?.status, "GIVEN");
    assert.ok(q1("SELECT 1 FROM audit WHERE action = 'CONSENT_GIVEN' AND actor = ? AND entity_id = ?", P1.uid, P1.pid), "audit CONSENT_GIVEN missing");
  });

  const P2 = await onboard("Consent No Patient", ["Cg Beta"]);
  await T("WA-CON-02", "Patient says NO", async () => {
    const r = await send(P2.uid, "NO");
    assert.match(r.reply, /Nothing will be shared/, `reply: ${short(r.reply)}`);
    assert.equal(consent(P2.pid, P2.uid)?.status, "DECLINED");
    assert.ok(q1("SELECT 1 FROM audit WHERE action = 'CONSENT_DECLINED' AND actor = ?", P2.uid), "audit CONSENT_DECLINED missing");
  });
  await T("WA-CON-03", "Patient changes mind (NO then YES)", async () => {
    if (consent(P2.pid, P2.uid)?.status !== "DECLINED") blocked("WA-CON-02 did not leave consent DECLINED");
    const r = await send(P2.uid, "YES");
    assert.equal(consent(P2.pid, P2.uid)?.status, "GIVEN", `reply: ${short(r.reply)}`);
  });

  const Py = await onboard("Circle Consent Patient", ["Cg Gamma Yes", "Cg Delta No"]);
  await T("WA-CON-04", "Caregiver says YES, then receives alerts", async () => {
    const r = await send(Py.cg[0], "YES");
    assert.match(r.reply, /You're now in .*care circle/, `reply: ${short(r.reply)}`);
    assert.equal(consent(Py.pid, Py.cg[0])?.status, "GIVEN");
    await send(Py.uid, "YES");
    const mk = app.mark();
    await send(Py.uid, "BP 190/115");
    assert.ok(escTo(Py.cg[0], mk).length >= 1, "L1 (consented) got no alert for BP 190/115");
  });
  await T("WA-CON-05", "Caregiver (L2) says NO: no alerts to L2, 'Caregiver declined' task", async () => {
    const mk = app.mark();
    const r = await send(Py.cg[1], "NO");
    assert.match(r.reply, /won't receive care-circle alerts/, `reply: ${short(r.reply)}`);
    assert.equal(consent(Py.pid, Py.cg[1])?.status, "DECLINED");
    const today = await api("u_pa_priya", "GET", "/api/pa-today");
    const task = (today.data.tasks as any[]).find((x) => x.id === `declined:${Py.pid}:${Py.cg[1]}`);
    assert.ok(task && task.label === "Caregiver declined", "no 'Caregiver declined' task on Today");
    // the urgent alert raised in WA-CON-04 is still waiting at L1; let its 15-min timer run out
    const esc = q1<{ id: number; state: string; level: number }>("SELECT id, state, level FROM escalations WHERE patient_id = ? AND rule_key = 'bp_crisis' ORDER BY id DESC LIMIT 1", Py.pid);
    if (!esc) blocked("no urgent alert from WA-CON-04 to time out");
    await clock.advance(16);
    const got = escTo(Py.cg[1], mk);
    const after = q1<{ state: string; level: number }>("SELECT state, level FROM escalations WHERE id = ?", esc!.id)!;
    assert.equal(got.length, 0, `BUG: declined L2 caregiver still received ${got.length} alert message(s) after the L1 timeout (escalation ${esc!.id} now level ${after.level}, ${after.state}): "${short(got[0]?.body ?? "", 90)}". timeoutCaregiver()/notifyLevel() never check consent (lib/engine.ts:422-427, 392-394).`);
  });

  const P3 = await onboard("Consent Lang Patient", ["Cg Eps"]);
  await T("WA-CON-06", "Consent in Indian languages", async () => {
    const bad: string[] = [];
    const setPending = () => exec("UPDATE consents SET status = 'PENDING', responded_at = NULL WHERE patient_id = ? AND user_id = ?", P3.pid, P3.uid);
    for (const w of ["ஆம்", "हाँ", "ಹೌದು", "haan"]) { setPending(); await send(P3.uid, w); const s = consent(P3.pid, P3.uid)?.status; if (s !== "GIVEN") bad.push(`${w}→${s}`); }
    for (const w of ["இல்லை", "नहीं", "nahi"]) { setPending(); await send(P3.uid, w); const s = consent(P3.pid, P3.uid)?.status; if (s !== "DECLINED") bad.push(`${w}→${s}`); }
    assert.deepEqual(bad, [], `not understood: ${bad.join(", ")}`);
  });

  const P4 = await onboard("Pending Alert Patient", ["Cg Zeta"]);
  await T("WA-CON-07", "YES while an alert is waiting = ACK, not consent", async () => {
    const mk = app.mark();
    await send(P4.uid, "BP 190/115");
    if (!escTo(P4.cg[0], mk).length) blocked("pending caregiver was not sent the alert, so the precondition is missing");
    await send(P4.cg[0], "YES");
    const e = q1<{ state: string; ack_by: string }>("SELECT state, ack_by FROM escalations WHERE patient_id = ? ORDER BY id DESC LIMIT 1", P4.pid)!;
    assert.equal(e.state, "ACKNOWLEDGED", "alert not acknowledged");
    assert.equal(e.ack_by, P4.cg[0]);
    assert.equal(consent(P4.pid, P4.cg[0])?.status, "PENDING", "YES was taken as consent");
  });

  const shared = { name: "Shared Carer", phone: newPhone() };
  const P5a = await onboard("Two Circles First", [shared]);
  const P5b = await onboard("Two Circles Second", [shared]);
  await T("WA-CON-08", "Caregiver in two circles answers the latest request", async () => {
    assert.equal(P5a.cg[0], P5b.cg[0], "same phone did not map to one caregiver user");
    await send(P5a.cg[0], "YES");
    assert.equal(consent(P5b.pid, P5b.cg[0])?.status, "GIVEN", "most recent circle not answered");
    assert.equal(consent(P5a.pid, P5a.cg[0])?.status, "PENDING", "older circle was answered");
  });

  const P6 = await onboard("Declined Level Patient", ["Cg Eta Declines", "Cg Theta Accepts"]);
  await T("WA-CON-11", "Declined caregiver gets no alerts; next consented level does", async () => {
    await send(P6.cg[0], "NO");
    await send(P6.cg[1], "YES");
    await send(P6.uid, "YES");
    assert.equal(consent(P6.pid, P6.cg[0])?.status, "DECLINED");
    const mk = app.mark();
    await send(P6.uid, "BP 190/115");
    const e = q1<{ id: number; level: number }>("SELECT id, level FROM escalations WHERE patient_id = ? ORDER BY id DESC LIMIT 1", P6.pid);
    const toDeclined = escTo(P6.cg[0], mk), toNext = escTo(P6.cg[1], mk);
    assert.ok(toDeclined.length === 0 && toNext.length >= 1,
      `BUG: urgent alert (escalation ${e?.id}, level ${e?.level}) went to the DECLINED L1 caregiver (${toDeclined.length} msg: "${short(toDeclined[0]?.body ?? "", 60)}") and ${toNext.length} to the consented L2. createEscalation starts at the lowest level (lib/engine.ts:366-367) and notifyLevel never checks consent (lib/engine.ts:392-394).`);
  });

  // ---------------- §8 logging
  await T("WA-LOG-01", "Single reading", async () => {
    const r = await send("u_ramesh", "BP 132/84");
    const o = obsFor(r.inMsg.id);
    assert.ok(o.some((x) => x.type === "bp" && x.v1 === 132 && x.v2 === 84), "BP not logged/linked to the message");
    assert.match(r.reply, /Logged/, `reply: ${short(r.reply)}`);
    const p = await api("u_dr_rao", "GET", "/api/patients/p_ramesh");
    const log = (p.data.timeline as any[]).find((x) => x.kind === "log" && x.id === r.inMsg.id);
    assert.ok(log?.obs?.some((x: any) => x.type === "bp" && x.v1 === 132), "patient record/timeline does not show the reading");
  });
  await T("WA-LOG-02", "Several readings in one message (AI off)", async () => {
    const r = await send("u_ramesh", "72.8 and 146/92, sugar 140, pulse 78");
    const o = obsFor(r.inMsg.id);
    const got = o.map((x) => `${x.type}:${x.v1}${x.v2 ? "/" + x.v2 : ""}`).sort();
    const want = ["bp:146/92", "glucose:140", "hr:78", "weight:72.8"];
    const missing = want.filter((w) => !got.includes(w));
    assert.deepEqual(missing, [], `BUG: with AI off the rules parser logged only [${got.join(", ")}]; the bare "72.8" is dropped silently (no reading, no question) because the weight rule needs "weight"/"wt"/"kg" (lib/parser.ts:236) and the doubt/clarify checks only look at labelled numbers or a lone-number message. Reply: ${short(r.reply, 160)}`);
  });
  await T("WA-LOG-03", "Natural language from a caregiver (A Gopal / Mom)", async () => {
    const r = await send("u_mom", "Appa weight 60.5 kg, drank 1200 ml fluid today");
    const o = obsFor(r.inMsg.id);
    assert.ok(o.some((x) => x.type === "weight" && x.v1 === 60.5 && x.patient_id === "p_gopal" && x.logged_by === "u_mom"), `weight not logged for Gopal by Mom: ${JSON.stringify(o)}`);
    assert.ok(o.some((x) => x.type === "fluid_in" && x.v1 === 1200 && x.logged_by === "u_mom"), "fluid not logged");
    assert.match(r.reply, /Logged for/, `reply: ${short(r.reply)}`);
  });

  await T("WA-LOG-12", "Ambiguous number asks which one; chosen one logged", async () => {
    const cs = q1("SELECT state FROM convo_state WHERE user_id = 'u_ramesh'");
    if (cs) blocked(`Ramesh already has a conversation state (${JSON.stringify(cs)})`);
    const r = await send("u_ramesh", "72");
    assert.match(r.reply, /Which one is it\?/, `reply: ${short(r.reply)}`);
    assert.ok(r.quick.includes("Pulse (72 bpm)") && r.quick.includes("Weight (72 kg)"), `buttons: ${JSON.stringify(r.quick)}`);
    assert.equal(obsFor(r.inMsg.id).length, 0);
    const r2 = await send("u_ramesh", "Pulse (72 bpm)");
    assert.ok(obsFor(r2.inMsg.id).some((x) => x.type === "hr" && x.v1 === 72), `pulse not logged; reply: ${short(r2.reply)}`);
  });
  await T("WA-LOG-13", "Cancel the clarification", async () => {
    const r = await send("u_ramesh", "72");
    if (!/Which one is it/.test(r.reply)) blocked("no clarification question");
    const r2 = await send("u_ramesh", "none");
    assert.match(r2.reply, /No problem\. Send it again/, `reply: ${short(r2.reply)}`);
    assert.equal(obsFor(r.inMsg.id).length + obsFor(r2.inMsg.id).length, 0, "something was logged");
  });

  await T("WA-LOG-17", "Large but plausible jump (weight +3 kg vs yesterday)", async () => {
    const ds = dayStart(await clock.now());
    const y = q1<{ v1: number }>("SELECT v1 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'weight' AND observed_at >= ? AND observed_at < ? ORDER BY observed_at DESC LIMIT 1", ds - DAY, ds);
    if (!y) blocked("no weight yesterday in seed");
    const w = Math.round((y!.v1 + 3) * 10) / 10;
    const r = await send("u_ramesh", `weight ${w}`);
    assert.ok(obsFor(r.inMsg.id).some((x) => x.type === "weight" && x.v1 === w), "weight not logged");
    assert.match(r.reply, /typo/i, `PLAN: ${w} kg (+3.0 kg vs yesterday's ${y!.v1}) is logged and raises the "Rapid weight gain" alert, but no "was that a typo?" note: the note needs a jump of at least max(4 kg, 8% of the last weight) (lib/quality.ts:95, weightJumpNote). Reply: ${short(r.reply, 200)}`);
  });
  await T("WA-LOG-14", "Impossible weight: not logged, suggests 59.2, Yes logs it", async () => {
    const r = await send("u_ramesh", "weight 592");
    assert.ok(!obsFor(r.inMsg.id).some((x) => x.type === "weight"), "592 was logged");
    assert.match(r.reply, /Did you mean \*59\.2 kg\*/, `reply: ${short(r.reply)}`);
    const r2 = await send("u_ramesh", "Yes");
    assert.ok(obsFor(r2.inMsg.id).some((x) => x.type === "weight" && x.v1 === 59.2), `59.2 not logged; reply: ${short(r2.reply)}`);
  });
  await T("WA-LOG-15", "Impossible BP 1400/80", async () => {
    const r = await send("u_ramesh", "BP 1400/80");
    assert.ok(!obsFor(r.inMsg.id).some((x) => x.type === "bp"), "BP logged");
    assert.match(r.reply, /1400\/80/, `reply: ${short(r.reply)}`);
    assert.match(r.reply, /Did you mean \*140\/80\*/, `reply: ${short(r.reply)}`);
    if (q1("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh' AND state = 'clarify'")) await send("u_ramesh", "No");
  });
  await T("WA-LOG-16", "Sugar in mmol/L", async () => {
    const r = await send("u_ramesh", "sugar 6.5");
    assert.ok(!obsFor(r.inMsg.id).some((x) => x.type === "glucose"), "logged as 6.5");
    assert.match(r.reply, /mmol\/L/, `reply: ${short(r.reply)}`);
    if (q1("SELECT 1 FROM convo_state WHERE user_id = 'u_ramesh' AND state = 'clarify'")) await send("u_ramesh", "No");
  });
  await T("WA-LOG-18", "Correction replaces the reading and closes its alert", async () => {
    const mk0 = app.mark();
    const r = await send("u_ramesh", "BP 182/90");
    const o = obsFor(r.inMsg.id).find((x) => x.type === "bp");
    assert.ok(o, "182/90 not logged");
    const esc = q1<{ id: number }>("SELECT id FROM escalations WHERE trigger_observation_id = ?", o!.id);
    assert.ok(esc, "no alert for 182/90");
    const r2 = await send("u_ramesh", "sorry that was 128 not 182");
    const now = q1<{ v1: number; v2: number }>("SELECT v1, v2 FROM observations WHERE id = ?", o!.id)!;
    assert.deepEqual([now.v1, now.v2], [128, 90], `reading not corrected; reply: ${short(r2.reply)}`);
    const a = q1<{ detail: string }>("SELECT detail FROM audit WHERE action = 'OBSERVATION_CORRECTED' AND entity_id = ?", String(o!.id));
    assert.ok(a && /182/.test(a.detail), "old value not in audit");
    const e = q1<{ state: string; outcome_code: string }>("SELECT state, outcome_code FROM escalations WHERE id = ?", esc!.id)!;
    assert.equal(`${e.state}/${e.outcome_code}`, "RESOLVED/CORRECTED");
    assert.ok(wa.since("u_lakshmi", mk0).some((m) => /Correction/.test(m.body)), "circle (L1) not told");
  });
  await T("WA-LOG-19", "'Sorry' alone changes nothing", async () => {
    const snap = () => JSON.stringify(q("SELECT id, v1, v2 FROM observations WHERE patient_id = 'p_ramesh' ORDER BY id"));
    const before = snap();
    const nAud = q("SELECT 1 FROM audit WHERE action = 'OBSERVATION_CORRECTED'").length;
    await send("u_ramesh", "sorry");
    assert.equal(snap(), before);
    assert.equal(q("SELECT 1 FROM audit WHERE action = 'OBSERVATION_CORRECTED'").length, nAud);
  });
  await T("WA-LOG-20", "Correction outside the 36 h window", async () => {
    const t = await clock.now();
    const recent = new Set(q<{ v1: number; v2: number | null }>("SELECT v1, v2 FROM observations WHERE patient_id = 'p_ramesh' AND observed_at > ?", t - 36 * HOUR).flatMap((x) => [x.v1, x.v2]));
    const old = q<{ id: number; v1: number; v2: number }>("SELECT id, v1, v2 FROM observations WHERE patient_id = 'p_ramesh' AND type = 'bp' AND observed_at < ? AND observed_at > ? ORDER BY observed_at DESC", t - 40 * HOUR, t - 6 * DAY).find((x) => !recent.has(x.v1));
    if (!old) blocked("no suitable older BP in the seed");
    const to = old!.v1 - 12;
    const r = await send("u_ramesh", `sorry that was ${to} not ${old!.v1}`);
    const now = q1<{ v1: number }>("SELECT v1 FROM observations WHERE id = ?", old!.id)!;
    assert.equal(now.v1, old!.v1, "old reading was changed");
    assert.match(r.reply, /36|too old|older|earlier than|can't (change|correct)|cannot (change|correct)/i, `BUG: the old reading is correctly left alone, but the reply does not explain why — it is the generic "couldn't pick that up" message: "${short(r.reply, 120)}". applyCorrections() finds no target in the 36 h window and returns nothing (lib/quality.ts:127-141), so ingestMessage falls through to clarifyFor (lib/engine.ts:1026-1029).`);
  });
  await T("WA-LOG-22", "Caregiver logs for the patient; patient told of the alert", async () => {
    const r = await send("u_lakshmi", "Ramesh: BP 140/88");
    assert.ok(obsFor(r.inMsg.id).some((x) => x.type === "bp" && x.v1 === 140 && x.patient_id === "p_ramesh" && x.logged_by === "u_lakshmi"), `not logged for Ramesh by Lakshmi; reply: ${short(r.reply)}`);
    const mk = app.mark();
    await send("u_lakshmi", "Ramesh: BP 186/112");
    assert.ok(wa.since("u_ramesh", mk).some((m) => /logged a reading for you that needs attention/.test(m.body)), "patient not told of the alert");
  });
  await T("WA-LOG-24", "Message length limit", async () => {
    const long = "Feeling fine today. ".repeat(100);
    assert.equal(long.length, 2000);
    const r = await wa.send("u_ramesh", long);
    assert.equal(r.status, 200);
    const m = q1<{ body: string }>("SELECT body FROM messages WHERE user_id = 'u_ramesh' AND direction = 'IN' ORDER BY id DESC LIMIT 1")!;
    assert.equal(m.body.length, 1000);
  });

  const P8 = await onboard("Unlinked Sender Patient", ["Cg Iota Stays", "Cg Kappa Removed"]);
  await T("WA-LOG-23", "Unknown sender", async () => {
    // a caregiver removed from the only circle they were in = a number not linked to any patient
    const keep = P8.rows[0];
    const r0 = await api("u_pa_priya", "POST", `/api/patients/${P8.pid}/caregivers`, { caregivers: [{ id: keep.id, name: keep.name, relation: "Son", phone: keep.phone }] });
    assert.equal(r0.status, 200, JSON.stringify(r0.data));
    assert.equal(q("SELECT 1 FROM caregivers WHERE user_id = ?", P8.cg[1]).length, 0);
    const r = await send(P8.cg[1], "BP 140/90");
    assert.match(r.reply, /isn't linked to a patient yet/, `reply: ${short(r.reply)}`);
    assert.equal(r.inMsg.patient_id, null, "inbound stored against a patient");
    assert.equal(q("SELECT 1 FROM observations WHERE logged_by = ?", P8.cg[1]).length, 0);
    const u = await wa.send("u_not_a_user", "hello");
    assert.equal(u.status, 404);
    assert.equal(q("SELECT 1 FROM messages WHERE user_id = 'u_not_a_user'").length, 0);
  });

  const P7 = await onboard("No Plan Patient", ["Cg Lambda"]);
  await T("WA-LOG-21", "Reading before Visit 1", async () => {
    const r = await send(P7.uid, "BP 150/95");
    assert.ok(obsFor(r.inMsg.id).some((x) => x.type === "bp" && x.v1 === 150), "not recorded");
    assert.match(r.reply, /care plan starts after the first visit/, `reply: ${short(r.reply)}`);
    assert.equal(q("SELECT 1 FROM escalations WHERE patient_id = ?", P7.pid).length, 0, "alert raised without doctor limits");
    const mk = app.mark();
    await send(P7.uid, "BP 185/112");
    assert.ok(q1("SELECT 1 FROM escalations WHERE patient_id = ? AND rule_key = 'bp_crisis'", P7.pid), "emergency rule did not fire");
    assert.ok(escTo(P7.cg[0], mk).length >= 1, "caregiver not alerted");
  });

  // ---------------- §17 language (AI off)
  await T("LANG-01", "Indian script switches language [AI on]", () => notRun("Needs AI translation (GEMINI/ANTHROPIC keys are stripped in this environment); script detection alone only stores the preference."));
  await T("LANG-02", "Romanised language needs two messages [AI on]", () => notRun("Romanised language is only recognised by the AI parser (parsed.language); AI is off here."));
  await T("LANG-07", "No AI: 'reply in Tamil'", async () => {
    const r = await send("u_abdul", "reply in Tamil");
    assert.match(r.reply, /Sorry, I can't reply in Tamil right now/, `reply: ${short(r.reply)}`);
    assert.ok(!q1("SELECT 1 FROM settings WHERE key = 'lang:u_abdul' AND value != 'en'"), "language changed");
  });
  await T("LANG-04", "Ask directly: 'reply in Hindi', then 'english please'", async () => {
    const r1 = await send("u_abdul", "reply in Hindi");
    const r2 = await send("u_abdul", "english please");
    notRun(`Switching to Hindi needs AI translation (AI off: "${short(r1.reply, 60)}", by design — see LANG-07). The English half works: "${short(r2.reply, 60)}".`);
  });
  await T("LANG-05", "Per-person language", async () => {
    await send("u_sunita", "நான் நன்றாக இருக்கிறேன்");
    await send("u_neha", "Mum is doing well today");
    const ls = q1<{ value: string }>("SELECT value FROM settings WHERE key = 'lang:u_sunita'")?.value;
    const ln = q1<{ value: string }>("SELECT value FROM settings WHERE key = 'lang:u_neha'")?.value ?? "en";
    assert.equal(ls, "ta", "patient's Tamil not recorded");
    assert.equal(ln, "en", "caregiver's language changed too");
    // Note: delivery in Tamil needs the AI translator; without it the English text stands (lib/lang.ts).
  });
  await T("LANG-03", "Switch back after three longer English messages", async () => {
    if (q1<{ value: string }>("SELECT value FROM settings WHERE key = 'lang:u_sunita'")?.value !== "ta") blocked("Sunita is not in Tamil (LANG-05 setup)");
    const seen: string[] = [];
    for (const m of ["I am feeling fine today", "The weather is nice here", "Thank you for the reminder message"]) {
      await send("u_sunita", m);
      seen.push(q1<{ value: string }>("SELECT value FROM settings WHERE key = 'lang:u_sunita'")?.value ?? "en");
    }
    assert.deepEqual(seen, ["ta", "ta", "en"]);
  });
  await T("LANG-06", "Translated quick-reply button understood as English", async () => {
    const last = q1<{ id: number }>("SELECT id FROM messages WHERE user_id = 'u_ramesh' AND direction = 'OUT' ORDER BY id DESC LIMIT 1")!;
    // setup the API can't do without AI: make the latest message look translated (buttons in Tamil, English kept)
    exec("UPDATE messages SET quick = ?, quick_en = ? WHERE id = ?", JSON.stringify(["எல்லா மாத்திரைகளும் எடுத்தேன் ✅", "நலமாக இருக்கிறேன்"]), JSON.stringify(["Took all tablets ✅", "Feeling fine, no symptoms"]), last.id);
    const r = await send("u_ramesh", "எல்லா மாத்திரைகளும் எடுத்தேன் ✅");
    const parsed = JSON.parse(r.inMsg.parsed || "{}");
    assert.equal(parsed.meds?.allTaken, true, `button not understood; reply: ${short(r.reply)}`);
    assert.ok(!q1("SELECT 1 FROM settings WHERE key = 'lang:u_ramesh' AND value != 'en'"), "tapping a button switched the language");
  });
}

// =====================================================================================================
// Phase A2 — daily logging against due tasks (next morning)
// =====================================================================================================
async function phaseA2() {
  await advanceTo("07:55");
  await clock.advance(10); // ~08:05
  const t = await clock.now();
  await T("TIME-08", "Timezone: plan times and messages in IST", async () => {
    const tasks = q<{ due_at: number }>("SELECT due_at FROM tasks WHERE patient_id = 'p_ramesh' AND kind = 'med' AND due_at BETWEEN ? AND ?", dayStart(t), dayStart(t) + DAY);
    assert.ok(tasks.length && tasks.every((x) => ["08:00", "20:00"].includes(hm(x.due_at))), `med times in IST: ${tasks.map((x) => hm(x.due_at)).join(",")}`);
    assert.equal(new Date(atL(t, "08:00")).toISOString().slice(11, 16), "02:30", "08:00 IST should be 02:30 UTC");
    const p = q1<{ created_at: number; body: string }>("SELECT created_at, body FROM messages WHERE user_id = 'u_ramesh' AND kind = 'prompt' ORDER BY id DESC LIMIT 1");
    assert.ok(p && hm(p.created_at) === "08:00" && /Good morning/.test(p.body), `prompt at ${p && hm(p.created_at)} IST: ${short(p?.body ?? "", 40)}`);
    const pg = await api("u_dr_rao", "GET", "/api/patients/p_ramesh");
    assert.ok(pg.status === 200);
  });
  await T("WA-LOG-04", "Medicines taken (tap after the prompt)", async () => {
    const p = q1<{ quick: string }>("SELECT quick FROM messages WHERE user_id = 'u_ramesh' AND kind = 'prompt' AND created_at = ?", atL(t, "08:00"));
    assert.ok(p && JSON.parse(p.quick).includes("Took all tablets ✅"), "no 08:00 prompt with the button");
    await send("u_ramesh", "Took all tablets ✅");
    const m = medTasks("p_ramesh", "08:00", t);
    assert.ok(m.length >= 4 && m.every((x) => x.status === "DONE"), JSON.stringify(m.map((x) => `${x.label}:${x.status}`)));
  });
  await T("WA-LOG-05", "Medicines missed", async () => {
    const mk = app.mark();
    const r = await send("u_sunita", "Missed my tablets ❌");
    const m = medTasks("p_sunita", "08:00", t);
    assert.ok(m.length && m.every((x) => x.status === "NOT_DONE"), `${JSON.stringify(m.map((x) => `${x.label}:${x.status}`))}; reply: ${short(r.reply)}`);
    assert.ok(q1("SELECT 1 FROM escalations e JOIN escalation_events ev ON ev.escalation_id = e.id WHERE e.patient_id = 'p_sunita' AND e.type = 'COMPLIANCE' AND ev.at >= ?", t), "not counted toward compliance");
    void mk;
  });
  await T("WA-LOG-08", "Evening check-in", async () => {
    const r = await send("u_ramesh", "no symptoms, followed salt diet");
    const c = q1<{ status: string }>("SELECT status FROM tasks WHERE patient_id = 'p_ramesh' AND kind = 'checkin' AND due_at BETWEEN ? AND ?", dayStart(t), dayStart(t) + DAY);
    assert.equal(c?.status, "DONE", `reply: ${short(r.reply)}`);
    assert.ok(obsFor(r.inMsg.id).some((x) => x.type === "lifestyle" && x.text === "ok"), "lifestyle not noted");
  });
  await clock.advance(15); // ~08:20
  const physio1 = await send("u_sunita", "exercises done");
  await clock.advance(45); // ~09:05
  await T("WA-LOG-06", "One medicine missed: 'took all except amlodipine' (Abdul, 09:00 doses)", async () => {
    const r = await send("u_abdul", "took all except amlodipine");
    const m = medTasks("p_abdul", "09:00", t);
    const st = Object.fromEntries(m.map((x) => [x.item_key, x.status]));
    assert.equal(st["med:amlodipine"], "NOT_DONE", JSON.stringify(st));
    assert.ok(Object.entries(st).filter(([k]) => k !== "med:amlodipine").every(([, s]) => s === "DONE"), `BUG: only amlodipine should be NOT_DONE and the rest taken, but tasks are ${JSON.stringify(st)} — the rules parser sets allTaken=false whenever "except" appears (lib/parser.ts:289) so engine.ts:975 never marks the other doses taken; they stay PENDING and will later be MISSED and raise "Medicines not logged". Reply: ${short(r.reply, 120)}`);
  });
  await advanceTo("10:20");
  await T("WA-LOG-07", "Physio done / skipped", async () => {
    const k = q1<{ status: string }>("SELECT status FROM tasks WHERE patient_id = 'p_sunita' AND item_key = 'physio:knee' AND due_at = ?", atL(t, "09:00"));
    assert.equal(k?.status, "DONE", `"exercises done" at 08:20: knee 09:00 is ${k?.status}; reply: ${short(physio1.reply)}`);
    const r = await send("u_sunita", "skipped exercises today");
    const s = q1<{ status: string }>("SELECT status FROM tasks WHERE patient_id = 'p_sunita' AND item_key = 'physio:stairs' AND due_at = ?", atL(t, "11:00"));
    assert.equal(s?.status, "NOT_DONE", `reply: ${short(r.reply)}`);
  });
  await T("WA-LOG-25", "Rules parser with AI off (WA-LOG-01..08)", async () => {
    const ai = await api(null, "GET", "/api/demo");
    assert.equal(ai.data.ai, false, "AI is on");
    const sub = app.results.filter((r) => /^WA-LOG-0[1-8]$/.test(r.id));
    const bad = sub.filter((r) => r.status !== "PASS");
    assert.equal(bad.length, 0, `with AI off: ${bad.map((r) => `${r.id} ${r.status}`).join(", ")} (see those results)`);
  });
}

// =====================================================================================================
// Phase B — reminders, compliance, digests over several days (fresh seed)
// =====================================================================================================
async function phaseB() {
  await clock.reset();
  const R0 = app.mark();
  const T0 = await clock.now();

  await T("WA-REM-10", "Lab task: prompted on its day, missed only after 3 days (seeded history, A Gopal)", async () => {
    const v = q1<{ visit_at: number; plan: string }>("SELECT visit_at, plan FROM visits WHERE patient_id = 'p_gopal' ORDER BY visit_at DESC LIMIT 1")!;
    const every = JSON.parse(v.plan).labs?.everyDays;
    const lab = q<{ id: number; due_at: number; status: string }>("SELECT id, due_at, status FROM tasks WHERE patient_id = 'p_gopal' AND kind = 'lab'");
    if (!every || !lab.length) blocked("no lab task in the seeded history");
    for (const l of lab) {
      assert.equal(hm(l.due_at), "08:00");
      assert.equal(Math.round((dayStart(l.due_at) - dayStart(v.visit_at)) / DAY) % every, 0, "lab not on an every-N-days day");
      assert.ok(q1("SELECT 1 FROM messages WHERE user_id = 'u_gopal' AND kind = 'prompt' AND created_at = ? AND body LIKE '%Lab test%'", l.due_at), "no lab prompt on its day");
      assert.ok(!q1("SELECT 1 FROM messages WHERE user_id = 'u_gopal' AND kind = 'reminder' AND body LIKE '%Lab test%'"), "1-hour reminder sent for a lab");
      const miss = q1<{ at: number }>("SELECT at FROM audit WHERE action = 'TASK_MISSED' AND entity_id = ?", String(l.id));
      if (l.status === "MISSED") assert.ok(miss && miss.at - l.due_at >= 3 * DAY, `marked missed after ${miss && (miss.at - l.due_at) / HOUR} h`);
    }
  });
  await T("DIG-03", "Medicine streak line (seeded digests)", async () => {
    const d = q<{ body: string; user_id: string }>("SELECT body, user_id FROM messages WHERE kind = 'info' AND body LIKE '🌙%' AND body LIKE '%days in a row%'");
    assert.ok(d.length > 0, "no digest with a streak line in the seeded history");
    assert.ok(d.every((x) => !/⚖️|🩺|🍬/.test(x.body)), "streak shown alongside other changes");
  });

  await closeOpen("p_ramesh");
  const Pdig = await onboard("Digest No Plan Patient", ["Cg Mu"]);
  await send(Pdig.cg[0], "YES");
  await send(Pdig.uid, "YES");
  const Pcon = await onboard("Consent Chase Patient", ["Cg Nu"]);
  const Treq = consent(Pcon.pid, Pcon.uid)!.requested_at;
  // setup the API can't do: the seeded circle never had consent rows; give Ramesh's circle explicit answers
  const tn = await clock.now();
  exec("INSERT INTO consents(patient_id, user_id, role, status, requested_at, responded_at) VALUES ('p_ramesh','u_lakshmi','CAREGIVER','GIVEN',?,?), ('p_ramesh','u_arjun','CAREGIVER','DECLINED',?,?), ('p_ramesh','u_kavya','CAREGIVER','PENDING',?,NULL)", tn, tn, tn, tn, tn);

  // ---------------- Day 1
  await advanceTo("07:50");
  const D1 = await clock.now();
  const abdulPlan = JSON.parse(q1<{ plan: string }>("SELECT plan FROM visits WHERE patient_id = 'p_abdul' ORDER BY visit_at DESC LIMIT 1")!.plan);
  const vis = await api("u_dr_rao", "POST", "/api/patients/p_abdul/visits", { vitals: {}, diagnosis: "COPD review", notes: "e2e: plan saved, not started", plan: abdulPlan, next_visit_at: null, start_plan: false });
  const mAbdul = app.mark();
  await clock.advance(12); // 08:02
  const mPrompt = app.mark();
  await T("WA-REM-01", "Prompt at due time (Ramesh 08:00)", async () => {
    const p = q<{ body: string; quick: string; created_at: number }>("SELECT body, quick, created_at FROM messages WHERE user_id = 'u_ramesh' AND kind = 'prompt' AND created_at = ?", atL(D1, "08:00"));
    assert.equal(p.length, 1, `prompts at 08:00: ${p.length}`);
    for (const w of ["Telmisartan", "Metoprolol", "Furosemide", "Metformin", "Blood pressure", "Pulse", "Weight"]) assert.ok(p[0].body.includes(w), `prompt lacks ${w}`);
    assert.ok(JSON.parse(p[0].quick).length >= 1, "no quick buttons");
  });
  await send("u_ramesh", "BP 130/80, pulse 72");
  await clock.advance(63); // 09:05
  await T("WA-REM-02", "Reminder after 1 h lists the open items", async () => {
    const r = q<{ body: string; created_at: number }>("SELECT body, created_at FROM messages WHERE user_id = 'u_ramesh' AND kind = 'reminder' AND id > ?", mPrompt);
    assert.equal(r.length, 1, `reminders: ${r.length}`);
    assert.match(r[0].body, /Gentle reminder/);
    assert.ok(/Metformin/.test(r[0].body) && /Weight/.test(r[0].body), short(r[0].body));
    assert.ok(!/Blood pressure/.test(r[0].body), "reminded about BP already sent");
    assert.ok(r[0].created_at >= atL(D1, "09:00") && r[0].created_at <= atL(D1, "09:15"), `sent at ${iso(r[0].created_at)}`);
  });
  await send("u_sunita", "BP 128/80, took all tablets, skipped exercises today");
  await clock.advance(180); // 12:05
  const escMed = q1<{ id: number; title: string; detail: string; type: string; level: number; started_at: number }>("SELECT * FROM escalations WHERE patient_id = 'p_ramesh' AND type = 'COMPLIANCE' AND started_at > ? ORDER BY id LIMIT 1", D1);
  await T("WA-REM-03", "Tasks marked MISSED after 3 h", async () => {
    const m = medTasks("p_ramesh", "08:00", D1);
    assert.ok(m.length >= 4 && m.every((x) => x.status === "MISSED"), JSON.stringify(m.map((x) => x.status)));
    for (const x of m) assert.ok(q1("SELECT 1 FROM audit WHERE action = 'TASK_MISSED' AND entity_id = ?", String(x.id)), `no TASK_MISSED audit for ${x.label}`);
  });
  await T("WA-REM-04", "Medicines missed → compliance alert to L1", async () => {
    assert.ok(escMed, "no compliance alert");
    assert.equal(escMed!.title, "Medicines not logged");
    assert.match(escMed!.detail, /8:00\s?am/i, `detail: ${escMed!.detail}`);
    const msg = q1<{ body: string; quick: string }>("SELECT body, quick FROM messages WHERE user_id = 'u_lakshmi' AND kind = 'escalation' AND id > ? ORDER BY id LIMIT 1", mPrompt);
    assert.ok(msg && /Reply \*ACK\*/.test(msg.body) && JSON.parse(msg.quick).includes("I'll handle it"), `L1 message: ${short(msg?.body ?? "none")}`);
  });
  await T("WA-REM-05", "No doctor or PA notified", async () => {
    const n = q("SELECT m.id FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id > ? AND u.role IN ('DOCTOR','PA','ADMIN')", R0);
    assert.equal(n.length, 0);
  });
  const rem06a = q("SELECT rule_key FROM escalations WHERE patient_id = 'p_ramesh' AND rule_key LIKE 'vital:%' AND started_at > ?", T0);
  await T("WA-REM-08", "Late completion resolves the compliance alert", async () => {
    if (!escMed) blocked("no compliance alert from WA-REM-04");
    await send("u_ramesh", "took all tablets");
    const e = q1<{ state: string; outcome_code: string }>("SELECT state, outcome_code FROM escalations WHERE id = ?", escMed!.id)!;
    assert.equal(`${e.state}/${e.outcome_code}`, "RESOLVED/AUTO");
    const ev = q1<{ note: string }>("SELECT note FROM escalation_events WHERE escalation_id = ? AND event = 'RESOLVED'", escMed!.id);
    assert.match(ev?.note ?? "", /Patient completed the task/);
  });
  await send("u_gopal", "2 glasses water");
  const g1 = q1<{ body: string }>("SELECT body FROM messages WHERE user_id = 'u_gopal' AND kind = 'reply' ORDER BY id DESC LIMIT 1")!.body;
  await send("u_gopal", "tea 150 ml");
  const g2 = q1<{ body: string }>("SELECT body FROM messages WHERE user_id = 'u_gopal' AND kind = 'reply' ORDER BY id DESC LIMIT 1")!.body;
  await T("WA-LOG-09", "Fluid intake running total (A Gopal)", async () => {
    const a = g1.match(/Fluid today: (\d+) \/ 1000 ml/), b = g2.match(/Fluid today: (\d+) \/ 1000 ml/);
    assert.ok(a && b, `replies: "${short(g1, 80)}" / "${short(g2, 80)}"`);
    assert.equal(Number(b![1]) - Number(a![1]), 150);
  });
  const st = await api("u_dr_rao", "POST", "/api/patients/p_abdul/care-plan", { action: "start" });
  await clock.advance(60); // 13:05
  await send("u_sunita", "BP 128/80, skipped exercises today");
  await clock.advance(300); // 18:05
  await send("u_sunita", "skipped exercises today");
  const knee = q<{ id: number }>("SELECT id FROM escalations WHERE patient_id = 'p_sunita' AND rule_key = 'physio:knee' AND started_at > ?", D1);
  await T("WA-REM-11", "Paused plan: no prompts until started", async () => {
    assert.equal(vis.status, 200, JSON.stringify(vis.data));
    assert.equal(vis.data.paused, true);
    const before = q("SELECT id FROM messages WHERE user_id = 'u_abdul' AND kind IN ('prompt','reminder') AND id > ? AND created_at < ?", mAbdul, atL(D1, "12:05"));
    assert.equal(before.length, 0, "prompt/reminder sent while paused");
    assert.equal(st.status, 200, JSON.stringify(st.data));
    assert.ok(q1("SELECT 1 FROM messages WHERE user_id = 'u_abdul' AND kind = 'prompt' AND created_at = ?", atL(D1, "18:00")), "no 18:00 prompt after starting the plan");
  });
  await advanceTo("20:05");
  await send("u_ramesh", "took all tablets");
  await clock.advance(30); // 20:35
  const D1d = await clock.now();
  const digestsToday = (uid: string) => q<{ body: string }>("SELECT body FROM messages WHERE user_id = ? AND kind = 'info' AND body LIKE '🌙%' AND created_at >= ?", uid, dayStart(D1d));
  await T("DIG-01", "Evening digest", async () => {
    const bad: string[] = [];
    for (const pid of ["p_ramesh", "p_sunita", "p_gopal", "p_abdul"]) {
      for (const c of q<{ user_id: string }>("SELECT user_id FROM caregivers WHERE patient_id = ?", pid)) {
        const cs = consent(pid, c.user_id)?.status;
        const n = digestsToday(c.user_id).length;
        const want = !cs || cs === "GIVEN" ? 1 : 0;
        if (n !== want) bad.push(`${c.user_id}(${cs ?? "no row"}): ${n}`);
      }
    }
    assert.deepEqual(bad, [], "digest counts");
    const b = digestsToday("u_lakshmi")[0].body;
    for (const re of [/💊 Medicines: \d+ of \d+ taken/, /📏 /, /⚠️ Missed: /, /📅 Next visit/, /(🔔 \d+ alert|Nothing urgent|All good)/]) assert.match(b, re, short(b, 300));
    const insights = b.split("\n").filter((l) => /^(⚖️|🩺|🍬|💊 All medicines)/.test(l));
    assert.ok(insights.length <= 2);
  });
  await T("WA-CON-12", "Digest only to consented caregivers", async () => {
    assert.equal(digestsToday("u_lakshmi").length, 1, "GIVEN caregiver");
    assert.equal(digestsToday("u_arjun").length, 0, "DECLINED caregiver got the digest");
    assert.equal(digestsToday("u_kavya").length, 0, "PENDING caregiver got the digest");
  });
  await T("DIG-05", "No digest before the plan starts", async () => {
    assert.equal(digestsToday(Pdig.cg[0]).length + digestsToday(Pdig.uid).length, 0);
  });
  await send("u_gopal", "intake 1400 ml, urine 1100 ml today");
  await T("WA-LOG-10", "Fluid and urine day totals", async () => {
    const task = q1<{ status: string }>("SELECT status FROM tasks WHERE patient_id = 'p_gopal' AND kind = 'fluid' AND due_at = ?", atL(D1d, "21:00"));
    assert.equal(task?.status, "DONE", "fluid task not done");
    const p = await api("u_dr_rao", "GET", "/api/patients/p_gopal");
    assert.ok(p.status === 200 || p.status === 403, String(p.status));
    const f = (await api("u_dr_dileep", "GET", "/api/patients/p_gopal")).data.fluidToday ?? p.data.fluidToday;
    assert.equal(f?.out, 1100, `urine ${f?.out}`);
    assert.equal(f?.in, 1400, `BUG: the day total "intake 1400 ml … today" was added to the earlier drinks (400 + 150) instead of replacing them, so the chart shows ${f?.in} ml. parseFluids() only treats a volume as a day total when words like "total"/"so far"/"today's" are near it — "today" without "'s" does not match (lib/parser.ts:47, TOTAL) — and dayFluid() then sums 'add' rows (lib/engine.ts:595-606). The plan's own prompt asks for exactly this format.`);
  });
  await clock.advance(90); // 22:05
  await T("DIG-02", "Digest sent once", async () => {
    assert.equal(digestsToday("u_lakshmi").length, 1);
    assert.equal(digestsToday("u_neha").length, 1);
  });
  // ---------------- Day 2
  await advanceTo("08:05");
  const D2 = await clock.now();
  await send("u_ramesh", "BP 128/82, pulse 70, took all tablets");
  await T("WA-CON-10", "Consent task on Today", async () => {
    const r = await api("u_pa_priya", "GET", "/api/pa-today");
    const task = (r.data.tasks as any[]).find((x) => x.id === `consent:${Pcon.pid}`);
    assert.ok(task, "no consent task");
    assert.match(task.label, /^Consent pending · \d+ days?$/, task.label);
  });
  await clock.advance(60); // 09:05
  await send("u_sunita", "BP 126/80, took all tablets, skipped exercises today");
  await T("WA-REM-07", "Physio missed 3 times in a row → one alert, not repeated within 3 days", async () => {
    assert.equal(knee.length, 1, `physio:knee alerts after the 3rd skip on day 1: ${knee.length}`);
    const n = q("SELECT id FROM escalations WHERE patient_id = 'p_sunita' AND rule_key = 'physio:knee' AND started_at > ?", D1);
    assert.equal(n.length, 1, "repeated after a 4th skip within 3 days");
  });
  await clock.advance(120); // 11:05
  const escW = q1<{ id: number; title: string; rule_key: string }>("SELECT id, title, rule_key FROM escalations WHERE patient_id = 'p_ramesh' AND type = 'COMPLIANCE' AND started_at > ? ORDER BY id LIMIT 1", D2);
  await T("WA-REM-06", "Reading missed 2 days running (weight)", async () => {
    assert.deepEqual(rem06a, [], "alert after only one day");
    assert.ok(escW, "no compliance alert on day 2");
    assert.equal(escW!.rule_key, "vital:weight");
    assert.match(escW!.title, /Weight not logged 2 days running/);
  });
  if (escW) await api("u_lakshmi", "POST", `/api/escalations/${escW.id}`, { action: "ack" });
  await advanceTo("23:05");
  await T("WA-REM-09", "One compliance alert at a time (items ADDED)", async () => {
    if (!escW) blocked("no open compliance alert from WA-REM-06");
    const added = q("SELECT note FROM escalation_events WHERE escalation_id = ? AND event = 'ADDED'", escW!.id);
    assert.ok(added.length >= 1, "no ADDED event");
    const more = q("SELECT id FROM escalations WHERE patient_id = 'p_ramesh' AND type = 'COMPLIANCE' AND id != ? AND started_at > ?", escW!.id, D2);
    assert.equal(more.length, 0, "second compliance alert created");
  });
  await closeOpen("p_ramesh");

  // ---------------- Day 3: one 6-hour jump
  await advanceTo("06:00");
  const D3 = await clock.now();
  const mD3 = app.mark();
  await send("u_sunita", "BP 185/112");
  const urg = q1<{ id: number; started_at: number }>("SELECT id, started_at FROM escalations WHERE patient_id = 'p_sunita' AND rule_key = 'bp_crisis' AND started_at >= ? ORDER BY id DESC LIMIT 1", D3);
  await clock.advance(360); // 12:00
  await T("TIME-01", "Scheduler catches up in 15-min steps (one 6 h advance)", async () => {
    const p = q<{ created_at: number }>("SELECT created_at FROM messages WHERE user_id = 'u_ramesh' AND kind = 'prompt' AND id > ?", mD3);
    assert.ok(p.some((x) => x.created_at === atL(D3, "08:00")), `prompts at ${p.map((x) => iso(x.created_at)).join(",")}`);
    const r = q<{ created_at: number }>("SELECT created_at FROM messages WHERE user_id = 'u_ramesh' AND kind = 'reminder' AND id > ?", mD3);
    assert.ok(r.length === 1 && r[0].created_at >= atL(D3, "09:00") && r[0].created_at < atL(D3, "09:15"), `reminder at ${r.map((x) => iso(x.created_at))}`);
    const m = medTasks("p_ramesh", "08:00", D3);
    for (const x of m) {
      const a = q1<{ at: number }>("SELECT at FROM audit WHERE action = 'TASK_MISSED' AND entity_id = ?", String(x.id));
      assert.ok(a && a.at >= atL(D3, "11:00") && a.at < atL(D3, "11:15"), `missed at ${a && iso(a.at)}`);
    }
    const c = q1<{ started_at: number }>("SELECT started_at FROM escalations WHERE patient_id = 'p_ramesh' AND type = 'COMPLIANCE' AND started_at > ?", D3);
    assert.ok(c && c.started_at >= atL(D3, "11:00") && c.started_at < atL(D3, "11:15"), `compliance at ${c && iso(c.started_at)}`);
    assert.ok(urg, "no urgent alert to time out");
    const ev = q<{ event: string; at: number }>("SELECT event, at FROM escalation_events WHERE escalation_id = ? AND event IN ('TIMEOUT','EXHAUSTED') ORDER BY id", urg!.id);
    assert.deepEqual(ev.map((e) => [e.event, Math.round((e.at - urg!.started_at) / MIN)]), [["TIMEOUT", 15], ["EXHAUSTED", 30]]);
    const lt = Number(q1<{ value: string }>("SELECT value FROM settings WHERE key = 'last_tick'")!.value);
    assert.ok(Math.abs(lt - (await clock.now())) < 60_000, "last_tick not caught up");
  });

  // REM-12: the scheduler did not run for a long time (setup: last_tick moved back 15 days), then 6 h pass at once
  const D3b = await clock.now();
  exec("UPDATE settings SET value = ? WHERE key = 'last_tick'", String(D3b - 15 * DAY));
  const mGap = app.mark();
  await clock.advance(360); // ~18:00, one catch-up tick
  await T("WA-REM-12", "Old prompts not sent after a scheduler gap", async () => {
    const t = await clock.now();
    const stale = q<{ id: number; patient_id: string; due_at: number; prompted: number; kind: string; status: string }>("SELECT * FROM tasks WHERE due_at > ? AND due_at <= ?", D3b, t - 2 * HOUR);
    const fresh = q<{ id: number; patient_id: string; due_at: number; prompted: number }>("SELECT * FROM tasks WHERE due_at > ? AND due_at <= ?", t - 2 * HOUR, t);
    if (!stale.length || !fresh.length) blocked(`need tasks on both sides of the 2 h line (stale ${stale.length}, fresh ${fresh.length})`);
    const promptsAt = (due: number) => q("SELECT id FROM messages WHERE kind = 'prompt' AND id > ? AND created_at = ?", mGap, due).length;
    assert.ok(stale.every((x) => promptsAt(x.due_at) === 0), "prompt sent for a task more than 2 h old");
    assert.ok(stale.every((x) => x.prompted === 1), "stale tasks not marked prompted");
    assert.ok(fresh.some((x) => promptsAt(x.due_at) > 0), "fresh tasks not prompted");
    const shouldMiss = stale.filter((x) => !["physio", "lab"].includes(x.kind) && x.due_at <= t - 3 * HOUR);
    assert.ok(shouldMiss.every((x) => x.status !== "PENDING"), `not marked missed: ${shouldMiss.filter((x) => x.status === "PENDING").length}`);
  });

  await T("TIME-02", "No duplicates on re-run / reload", async () => {
    const before = await clock.now();
    const r0 = await api(null, "POST", "/api/demo", { action: "advance", minutes: 0 });
    assert.equal(r0.status, 200);
    const moved = Math.round(((await clock.now()) - before) / MIN);
    const mk = app.mark();
    const nT = q("SELECT 1 FROM tasks").length, nE = q("SELECT 1 FROM escalations").length;
    for (let i = 0; i < 4; i++) {
      await api("u_dr_rao", "GET", "/api/dashboard");
      await api("u_pa_priya", "GET", "/api/pa-today");
      await api(null, "GET", "/api/whatsapp?userId=u_ramesh");
      await api("u_dr_rao", "GET", "/api/patients/p_ramesh");
      await api(null, "GET", "/api/demo");
    }
    assert.equal(app.mark(), mk, "reloading pages sent messages");
    assert.equal(q("SELECT 1 FROM tasks").length, nT);
    assert.equal(q("SELECT 1 FROM escalations").length, nE);
    const dupMsg = q("SELECT user_id, kind, created_at, COUNT(*) n FROM messages WHERE direction = 'OUT' AND id > ? AND kind IN ('prompt','reminder','escalation') GROUP BY user_id, kind, body, created_at HAVING n > 1", R0);
    const dupDig = q("SELECT user_id, date((created_at + 19800000) / 1000, 'unixepoch') d, COUNT(*) n FROM messages WHERE id > ? AND kind = 'info' AND body LIKE '🌙%' GROUP BY user_id, d HAVING n > 1", R0);
    const dupEsc = q("SELECT patient_id, rule_key, COUNT(*) n FROM escalations WHERE state IN ('NOTIFIED','ACKNOWLEDGED') GROUP BY patient_id, rule_key HAVING n > 1");
    assert.deepEqual({ dupMsg, dupDig, dupEsc }, { dupMsg: [], dupDig: [], dupEsc: [] });
    console.log(`        (note: POST /api/demo {advance, minutes: 0} moved the clock ${moved} min — 0 falls back to 60 in app/api/demo/route.ts)`);
  });
  await T("TIME-05", "Clock indicator after advancing", async () => {
    const d = await api(null, "GET", "/api/demo");
    assert.ok(d.data.offsetMs > 0, "offsetMs not set");
    const chunks = path.resolve(import.meta.dirname, "..", "..", ".next", "static", "chunks");
    const files = fs.readdirSync(chunks, { recursive: true }).map(String).filter((f) => f.endsWith(".js"));
    const text = files.map((f) => fs.readFileSync(path.join(chunks, f), "utf8")).join("\n");
    assert.ok(text.includes("Demo clock") && text.includes("side-clock"), "indicator not in the built UI");
    // Rendering itself is client-side (components/AppShell.tsx, components/DemoPanel.tsx key off offsetMs); no browser here.
  });

  // ---------------- consent reminders, weekly summary
  const nudges = () => q<{ at: number }>("SELECT at FROM audit WHERE action = 'CONSENT_AUTO_REMINDER' AND entity_id = ? AND detail LIKE ?", Pcon.pid, `%${Pcon.uid}%`);
  const n1 = nudges();
  let now = await clock.now();
  const to4 = Treq + 4 * DAY + 30 * MIN;
  if (to4 > now) await clock.advance(Math.ceil((to4 - now) / MIN));
  const n2 = nudges();
  now = await clock.now();
  let tSun = atL(now, "19:05");
  while (dow(tSun) !== 0 || tSun <= now) tSun += DAY;
  const mW = app.mark();
  await clock.advance(Math.ceil((tSun - now) / MIN));
  await T("DIG-04", "Weekly summary (Sunday 19:00)", async () => {
    const w = (uid: string) => q<{ body: string }>("SELECT body FROM messages WHERE user_id = ? AND id > ? AND body LIKE '🗓%'", uid, mW);
    const pat = w("u_ramesh"), l1 = w("u_lakshmi");
    assert.equal(pat.length, 1, "patient weekly");
    assert.equal(l1.length, 1, "circle weekly");
    assert.match(pat[0].body, /^🗓 Your week/);
    assert.match(l1[0].body, /^🗓 Ramesh's week/);
    assert.equal(w("u_arjun").length + w("u_kavya").length, 0, "weekly to non-consented caregivers");
  });
  now = await clock.now();
  const to9 = Treq + 9 * DAY + 30 * MIN;
  while (now < to9) { await clock.advance(Math.min(7 * 24 * 60, Math.ceil((to9 - now) / MIN))); now = await clock.now(); }
  const n3 = nudges();
  await T("WA-CON-09", "Automatic consent reminders (day 1, then 3 days, max 2)", async () => {
    const rel = (xs: { at: number }[]) => xs.map((x) => ((x.at - Treq) / DAY).toFixed(2));
    assert.equal(n1.length, 1, `after ~1-2 days: ${n1.length} reminders (${rel(n1)})`);
    assert.ok((n1[0].at - Treq) >= DAY && (n1[0].at - Treq) < DAY + 20 * MIN, `first at day ${rel(n1)}`);
    assert.equal(n2.length, 2, `after 4 days: ${rel(n2)}`);
    assert.equal(n3.length, 2, `after 9 days: ${rel(n3)}`);
    const msgs = q("SELECT 1 FROM messages WHERE user_id = ? AND kind = 'info' AND quick LIKE '%YES%' AND id > ?", Pcon.uid, R0);
    assert.equal(msgs.length, 3, "invite + 2 reminders on the phone");
    console.log(`        (reminders at day ${rel(n3).join(", ")} after the request)`);
  });

  const before = Object.fromEntries(["p_ramesh", "p_sunita", "p_abdul", "p_gopal"].map((p) => [p, { inMsgs: q("SELECT 1 FROM messages WHERE patient_id = ? AND direction = 'IN'", p).length, obs: q("SELECT 1 FROM observations WHERE patient_id = ?", p).length }]));
  const escBefore = q1<{ m: number }>("SELECT COALESCE(MAX(id), 0) m FROM escalations")!.m;
  const t7 = await clock.now();
  await T("TIME-03", "Simulate 7 days", async () => {
    const r = await api(null, "POST", "/api/demo", { action: "simulate", days: 7 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok((await clock.now()) - t7 >= 7 * DAY - MIN, "clock not moved 7 days");
    const lag: string[] = [];
    for (const p of Object.keys(before)) {
      const inMsgs = q("SELECT 1 FROM messages WHERE patient_id = ? AND direction = 'IN'", p).length, obs = q("SELECT 1 FROM observations WHERE patient_id = ?", p).length;
      if (inMsgs <= before[p].inMsgs + 7 || obs <= before[p].obs) lag.push(`${p}: in ${before[p].inMsgs}→${inMsgs}, obs ${before[p].obs}→${obs}`);
    }
    assert.deepEqual(lag, [], "patients without simulated replies/readings");
    const esc = q<{ id: number; state: string }>("SELECT id, state FROM escalations WHERE id > ?", escBefore);
    assert.ok(esc.length >= 1, "no alerts in 7 simulated days");
    const ev = q("SELECT DISTINCT event FROM escalation_events WHERE escalation_id > ?", escBefore).map((x: any) => x.event);
    assert.ok(ev.includes("NOTIFIED") && (ev.includes("ACKNOWLEDGED") || ev.includes("TIMEOUT")), `events: ${ev}`);
  });
}

// =====================================================================================================
// Phase C — restart tests on a second server sharing one DB file
// =====================================================================================================
function cleanEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(TWILIO_|WHATSAPP_|GEMINI_|ANTHROPIC_API_KEY|APP_PASSWORD|APP_USER|PUBLIC_BASE_URL)/.test(k)) continue;
    env[k] = v;
  }
  env.WHATSAPP_GATEWAY = "off";
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]; else env[k] = v;
  return env;
}
const WEB = path.resolve(import.meta.dirname, "..", "..");
async function startServer(dbFile: string, port: number): Promise<ChildProcess> {
  const log = fs.createWriteStream(path.join(os.tmpdir(), `cc-e2e-whatsapp-restart.server.log`), { flags: "a" });
  const child = spawn(process.execPath, [path.join(WEB, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: WEB, env: cleanEnv({ CARECIRCLE_DB: dbFile, PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(log); child.stderr!.pipe(log);
  const end = Date.now() + 90_000;
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(`restart server exited ${child.exitCode}`);
    if (Date.now() > end) throw new Error("restart server did not start");
    await new Promise((r) => setTimeout(r, 400));
  }
  return child;
}
async function stopServer(c: ChildProcess) {
  if (c.exitCode !== null) return;
  const done = new Promise((r) => c.once("exit", r));
  c.kill("SIGTERM");
  await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);
}

async function phaseC() {
  const port = 3213;
  const base = `http://127.0.0.1:${port}`;
  const dbFile = path.join(os.tmpdir(), `cc-e2e-whatsapp-restart-${Date.now()}.db`);
  const call = async (method: string, url: string, body?: unknown, user?: string) => {
    const r = await fetch(base + url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(user ? { cookie: `cc_user=${user}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
    return { status: r.status, data: d };
  };
  let srv = await startServer(dbFile, port);
  try {
    await call("GET", "/api/session");
    const db = new DatabaseSync(dbFile);
    const Q = (s: string, ...p: any[]) => db.prepare(s).all(...p) as any[];
    const counts = () => Object.fromEntries(["users", "patients", "caregivers", "visits", "observations", "escalations", "escalation_events", "messages", "labs", "consents", "audit"].map((t) => [t, (Q(`SELECT COUNT(*) n FROM ${t}`)[0] as any).n]));
    const nextVisits = () => JSON.stringify(Q("SELECT id, next_visit_at FROM visits ORDER BY id"));

    // TIME-07 (plain restart)
    const c0 = counts();
    const out0 = Q("SELECT COUNT(*) n FROM messages WHERE direction = 'OUT'")[0].n;
    await stopServer(srv);
    srv = await startServer(dbFile, port);
    await call("GET", "/api/demo");
    await call("GET", "/api/dashboard", undefined, "u_dr_rao");
    const c1 = counts();
    const out1 = Q("SELECT COUNT(*) n FROM messages WHERE direction = 'OUT'")[0].n;

    // TIME-04: advance 3 days, restart
    const nv = nextVisits();
    const adv = await call("POST", "/api/demo", { action: "advance", minutes: 3 * 24 * 60 });
    const offAfter = (await call("GET", "/api/demo")).data.offsetMs;
    const c2 = counts();
    await stopServer(srv);
    srv = await startServer(dbFile, port);
    const d = (await call("GET", "/api/demo")).data;
    const realNow = Date.now();
    const c3 = counts();
    await T("TIME-04", "Back to real date on restart", async () => {
      assert.equal(adv.status, 200);
      assert.ok(offAfter >= 3 * DAY - MIN, `offset before restart ${offAfter}`);
      assert.equal(d.offsetMs, 0, "offset not cleared");
      assert.ok(Math.abs(d.now - realNow) < 60_000, `clock shows ${iso(d.now)}, real ${iso(realNow)}`);
      const later: string[] = [];
      for (const [t, c] of [["messages", "created_at"], ["observations", "observed_at"], ["escalations", "started_at"], ["escalation_events", "at"], ["audit", "at"], ["labs", "taken_at"]]) {
        const m = Q(`SELECT MAX(${c}) m FROM ${t}`)[0].m;
        if (m > realNow + 5000) later.push(`${t}.${c}=${iso(m)}`);
      }
      assert.deepEqual(later, [], "entries after now");
      assert.equal(nextVisits(), nv, "next visits changed");
    });
    // the scheduler after that restart: does it still prompt on the following mornings?
    const tNow = d.now;
    const tomorrowTasks = Q("SELECT COUNT(*) n FROM tasks WHERE patient_id = 'p_ramesh' AND due_at BETWEEN ? AND ?", dayStart(tNow) + DAY, dayStart(tNow) + 2 * DAY)[0].n;
    const mk = Q("SELECT MAX(id) m FROM messages")[0].m;
    const nAt = Date.now();
    let tg = atL(nAt, "08:05"); if (tg <= nAt) tg += DAY;
    await call("POST", "/api/demo", { action: "advance", minutes: Math.ceil((tg - nAt) / MIN) });
    const prompts = Q("SELECT created_at FROM messages WHERE user_id = 'u_ramesh' AND kind = 'prompt' AND id > ?", mk);
    await T("TIME-07", "Restart persistence: data kept, scheduler resumes without re-sending", async () => {
      assert.deepEqual(c1, c0, "plain restart changed data");
      assert.equal(out1, out0, "plain restart re-sent messages");
      const keep = ["users", "patients", "caregivers", "visits", "observations", "escalations", "escalation_events", "messages", "labs", "consents", "audit"];
      assert.deepEqual(Object.fromEntries(keep.map((k) => [k, c3[k]])), Object.fromEntries(keep.map((k) => [k, c2[k]])), "restart after fast-forward lost or added rows");
      assert.ok(prompts.length > 0, `BUG: after the restart that follows a fast-forward, the scheduler sends no morning prompt: Ramesh has ${tomorrowTasks} task(s) for the next day and 0 prompts by 08:05. syncToRealDate() moves/deletes every non-PENDING task dated after now (they were all processed during the 3-day fast-forward) and caps gen:<patient> at today+2 days (lib/realtime.ts:51-54, 63-64), so ensureTasks() (lib/engine.ts:215) never re-creates the next two days of reminders.`);
    });

    // TIME-06: reset keeps AI keys
    const ins = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    ins.run("gemini_api_key", "test-gemini-key-not-real");
    ins.run("anthropic_api_key", "test-anthropic-key-not-real");
    const mkR = Q("SELECT MAX(id) m FROM messages")[0].m;
    const rr = await call("POST", "/api/demo", { action: "reset" });
    const keys = Object.fromEntries(Q("SELECT key, value FROM settings WHERE key IN ('gemini_api_key','anthropic_api_key')").map((r) => [r.key, r.value]));
    db.prepare("DELETE FROM settings WHERE key IN ('gemini_api_key','anthropic_api_key')").run();
    await T("TIME-06", "Demo reset: fresh seeded data, AI keys kept", async () => {
      assert.equal(rr.status, 200, JSON.stringify(rr.data));
      assert.ok(Q("SELECT 1 FROM users WHERE id = 'u_mom'").length && Q("SELECT COUNT(*) n FROM patients")[0].n === 4, "not the seeded clinic");
      assert.ok(Q("SELECT MAX(id) m FROM messages")[0].m < mkR || Q("SELECT MAX(created_at) m FROM messages")[0].m <= Date.now() + 5000, "old data kept");
      assert.equal(keys.gemini_api_key, "test-gemini-key-not-real", "Gemini key lost");
      assert.equal(keys.anthropic_api_key, "test-anthropic-key-not-real", `BUG: the Anthropic (Claude) key saved under Settings is erased by Reset; only gemini_api_key/gemini_model are preserved (lib/seed.ts:329-339) before resetDb() drops the settings table (lib/db.ts:230).`);
    });
    db.close();
  } finally {
    await stopServer(srv);
  }
}

// =====================================================================================================
for (const [name, fn] of [["A1", phaseA1], ["A2", phaseA2], ["B", phaseB], ["C", phaseC]] as const) {
  try { await fn(); } catch (e) { phaseErr[name] = (e as Error).stack?.split("\n").slice(0, 3).join(" | ") ?? String(e); console.error(`phase ${name} aborted:`, e); }
}
for (const id of ALL_IDS) if (!recorded.has(id)) await T(id, "(not reached)", () => blocked(`not reached: phase error ${JSON.stringify(phaseErr)}`));
await app.stop();
