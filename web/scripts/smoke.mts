// End-to-end smoke test of the engine (no browser): seeds the demo into a temp DB and exercises
// parsing, deviation escalation, L1->L2 timeout, ACK/outcome flow, a new visit and the visit diff.
// Run: npm test
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";

const tmp = path.join(os.tmpdir(), `carecircle-smoke-${Date.now()}.db`);
process.env.CARECIRCLE_DB = tmp;
delete process.env.GEMINI_API_KEY;

const { parseRules } = await import("../lib/parser");
const { all, get } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { intervalSummary, visitDiff } = await import("../lib/summary");
const { now, advanceClock } = await import("../lib/clock");
const { RAMESH_PLAN } = await import("../lib/seed");

let pass = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  pass++;
  console.log("  ✓", name);
};

console.log("Parser");
const meds = RAMESH_PLAN.medications.map((m) => ({ key: m.key, name: m.name }));
ok("bundle message", () => {
  const p = parseRules("BP 142/92. Weight 72.8. Sugar 126. Ankles slightly more swollen today. Took all tablets.", meds);
  assert.deepEqual(p.vitals.find((v) => v.type === "bp"), { type: "bp", v1: 142, v2: 92 });
  assert.equal(p.vitals.find((v) => v.type === "weight")?.v1, 72.8);
  assert.equal(p.vitals.find((v) => v.type === "glucose")?.v1, 126);
  assert.equal(p.meds.allTaken, true);
  assert.equal(p.symptoms[0].key, "edema");
});
ok("negation + except", () => {
  const p = parseRules("took all tablets except metformin, no swelling, walked 20 min", meds);
  assert.deepEqual(p.meds.missed, ["metformin"]);
  assert.equal(p.symptoms.length, 0);
  assert.equal(p.noSymptoms, true);
  assert.equal(p.physio, "done");
});
ok("pain score not BP", () => {
  const p = parseRules("Pain 5/10, exercises done", meds);
  assert.equal(p.vitals.length, 1);
  assert.equal(p.vitals[0].type, "pain");
});
ok("red flag", () => {
  const p = parseRules("having chest pain since 10 min", meds);
  assert.equal(p.symptoms[0].key, "chest_pain");
});
ok("kidney fluids + labs + med change parsing", () => {
  const p = parseRules("Drank 250 ml tea, urine 700 ml, creat 2.1 urea 68 K 4.9. Dr Manoj Shah reduced Prizide to 30 mg.", meds);
  assert.equal(p.fluids.length, 2);
  assert.equal(p.fluids.find((f) => f.kind === "in")?.ml, 250);
  assert.equal(p.fluids.find((f) => f.kind === "out")?.ml, 700);
  assert.equal(p.labs.find((l) => l.marker === "creatinine")?.value, 2.1);
  assert.equal(p.labs.find((l) => l.marker === "potassium")?.value, 4.9);
  assert.equal(p.medChanges.length, 1);
  assert.equal(p.medChanges[0].medName, "Prizide");
  assert.equal(p.medChanges[0].prescriber, "Dr Manoj Shah");
});

console.log("Seed (replays weeks of WhatsApp activity)");
const t0 = Date.now();
await seedDemo();
console.log(`  seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const count = (sql: string) => (get<{ n: number }>(sql)!.n);
console.log(`  messages=${count("SELECT COUNT(*) n FROM messages")} observations=${count("SELECT COUNT(*) n FROM observations")} tasks=${count("SELECT COUNT(*) n FROM tasks")} escalations=${count("SELECT COUNT(*) n FROM escalations")}`);
for (const e of all<{ patient_id: string; type: string; rule_key: string; state: string; level: number; outcome_code: string | null }>("SELECT patient_id, type, rule_key, state, level, outcome_code FROM escalations ORDER BY started_at"))
  console.log(`    ${e.patient_id.padEnd(10)} ${e.type.padEnd(10)} ${e.rule_key.padEnd(22)} ${e.state.padEnd(12)} L${e.level} ${e.outcome_code ?? ""}`);

ok("Ramesh weight-gain escalated L1 -> L2 and resolved via clinic contact", () => {
  const e = get<{ id: number; state: string; level: number; outcome_code: string }>("SELECT * FROM escalations WHERE patient_id='p_ramesh' AND rule_key='weight_gain'");
  assert.ok(e, "weight_gain escalation exists");
  assert.equal(e!.state, "RESOLVED");
  assert.equal(e!.level, 2);
  assert.equal(e!.outcome_code, "2");
});
ok("Ramesh compliance escalation from missed evening doses", () => {
  assert.ok(count("SELECT COUNT(*) n FROM escalations WHERE patient_id='p_ramesh' AND type='COMPLIANCE'") >= 1);
});
ok("Abdul has a live unacknowledged escalation at Level 2", () => {
  const e = get<{ state: string; level: number }>("SELECT * FROM escalations WHERE patient_id='p_abdul' AND state='NOTIFIED'");
  assert.ok(e, "open escalation");
  assert.equal(e!.level, 2);
});
ok("Doctor received no WhatsApp messages", () => {
  assert.equal(count("SELECT COUNT(*) n FROM messages WHERE user_id IN ('u_dr_rao','u_pa_priya','u_dr_dileep')"), 0);
});
ok("Doctor isolation: Dr Dileep sees only p_gopal, Dr Rao does not see Gopal", () => {
  const dileepPts = engine.patientIdsForUser({ id: "u_dr_dileep", role: "DOCTOR" });
  assert.deepEqual(dileepPts, ["p_gopal"]);
  const raoPts = engine.patientIdsForUser({ id: "u_dr_rao", role: "DOCTOR" });
  assert.ok(!raoPts.includes("p_gopal"));
  const priyaPts = engine.patientIdsForUser({ id: "u_pa_priya", role: "PA" });
  assert.ok(priyaPts.includes("p_gopal") && priyaPts.includes("p_ramesh"));
});
ok("Gopal kidney seed state: overdue lab, reported med change, kidney summary", () => {
  const labTask = get<{ due_at: number; status: string }>("SELECT due_at, status FROM tasks WHERE patient_id='p_gopal' AND kind='lab' AND due_at < ?", now());
  assert.ok(labTask, "overdue lab task exists");
  const medChange = get<{ med_name: string; prescriber: string; status: string }>("SELECT med_name, prescriber, status FROM med_changes WHERE patient_id='p_gopal' AND status='REPORTED'");
  assert.ok(medChange, "reported med change exists");
  assert.ok(medChange.med_name.includes("Prizide"));
  assert.equal(medChange.prescriber, "Dr Manoj Shah");

  const vGopal = engine.latestVisit("p_gopal")!;
  const sGopal = intervalSummary("p_gopal", vGopal.visit_at, now());
  assert.ok(sGopal.kidney, "kidney summary exists");
  assert.equal(sGopal.kidney.limit, 1000);
  assert.ok(sGopal.kidney.labs.some((l) => l.marker === "creatinine"));
  assert.ok(sGopal.kidney.weightBand);
  assert.equal(sGopal.kidney.weightBand.dry, 59.2);
});

console.log("Interval summary (Ramesh since visit 1)");
const v1 = engine.latestVisit("p_ramesh")!;
const s = intervalSummary("p_ramesh", v1.visit_at, now());
for (const h of s.highlights) console.log(`    [${h.tone}] ${h.text}`);
ok("adherence + vitals computed", () => {
  assert.ok(s.overall.meds! > 70 && s.overall.meds! < 100);
  assert.ok(s.vitals.find((v) => v.type === "bp")!.count >= 20);
});

console.log("Live flow");
const t = now();
await engine.ingestMessage("u_ramesh", "BP 172/104, pulse 88, feeling dizzy", { allowAi: false, at: t });
ok("deviation escalation created and L1 notified", () => {
  const e = get<{ id: number; level: number }>("SELECT * FROM escalations WHERE patient_id='p_ramesh' AND rule_key='bp_high' AND state='NOTIFIED'");
  assert.ok(e);
  assert.ok(get("SELECT 1 FROM messages WHERE user_id='u_lakshmi' AND kind='escalation' AND created_at >= ?", t));
});
advanceClock(65 * 60_000);
engine.runScheduler(now());
ok("timeout escalates to L2 (Arjun)", () => {
  const e = get<{ level: number }>("SELECT * FROM escalations WHERE patient_id='p_ramesh' AND rule_key='bp_high'");
  assert.equal(e!.level, 2);
});
await engine.ingestMessage("u_arjun", "ACK", { allowAi: false, at: now() });
await engine.ingestMessage("u_arjun", "2", { allowAi: false, at: now() + 60_000 });
await engine.ingestMessage("u_arjun", "Clinic said recheck in 1 hr and come in tomorrow if still high", { allowAi: false, at: now() + 120_000 });
ok("ACK + outcome recorded", () => {
  const e = get<{ state: string; outcome_code: string; outcome_note: string; ack_by: string }>("SELECT * FROM escalations WHERE patient_id='p_ramesh' AND rule_key='bp_high' ORDER BY id DESC");
  assert.equal(e!.state, "RESOLVED");
  assert.equal(e!.ack_by, "u_arjun");
  assert.equal(e!.outcome_code, "2");
  assert.match(e!.outcome_note, /recheck/);
});

const vid = engine.createVisit("p_ramesh", "u_dr_rao", {
  vitals: { sys: 138, dia: 86, weight: 77.4, hr: 72, glucose: 132 },
  diagnosis: v1.diagnosis,
  notes: "Improving.",
  plan: { ...v1.plan, medications: [...v1.plan.medications.filter((m) => m.key !== "metformin"), { key: "empagliflozin", name: "Empagliflozin", dose: "10 mg", times: ["08:00"] }] },
  next_visit_at: null,
}, now() + 5 * 60_000);
ok("visit diff", () => {
  const d = visitDiff(v1, engine.getVisit(vid)!);
  assert.ok(d.meds.some((m) => m.change === "added" && m.name === "Empagliflozin"));
  assert.ok(d.meds.some((m) => m.change === "removed" && m.name === "Metformin"));
  assert.equal(d.vitals.find((v) => v.key === "bp")!.delta, -20);
});

fs.rmSync(tmp, { force: true });
console.log(`\n${pass} checks passed`);
