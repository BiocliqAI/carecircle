import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

// A stand-in for the Anthropic Messages API: replies with whatever the test scripts next, and records the requests.
const asked: Record<string, unknown>[] = [];
let reply = "";
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    asked.push(JSON.parse(raw || "{}"));
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } }) +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
      ev("message_stop", {}),
    );
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-0000000000000000000000";
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-onbup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

const { all, get, run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { addDocument } = await import("../lib/records");
const onb = await import("../lib/onboarding");
const { getBaseline } = await import("../lib/clinic");
const { listOf, fieldsOf, markCounts } = await import("../lib/historyspec");
const { clearRecords } = await import("../lib/clear");

const T = Date.parse("2026-11-10T11:00:00+05:30");
const FIRST = (note: number) => JSON.stringify({
  history: {
    snapshot: { oneGlance: { text: "74 M, CAD with stent, CKD.", sources: [note] } },
    alerts: { allergies: { text: "Sulfa: rash", sources: [note] }, implants: { text: "Coronary stent (2019)", sources: [note] } },
    conditions: [{ name: "Coronary artery disease", diagnosed: "2019", status: "stable", sources: [note] }, { name: "CKD stage 3", status: "stable", sources: [note] }],
    medicines: [{ name: "Ecosprin 75 mg", dose: "1-0-0", indication: "CAD", sources: [note] }],
  },
  doctors: [{ name: "Dr E Satish Kumar", specialty: "Cardiology", role: "consultant", seen: 1, aliases: [] }],
  merges: [],
  points: [{ title: "Stent year", detail: "2019 or 2018?", sources: [note] }],
});
// An update: one new row, one changed row (index 1 = CKD), one new field, a new doctor and a new point.
const UPDATE = (nd: number) => JSON.stringify({
  add: { admissions: [{ from: "2026-10-02", to: "2026-10-06", facility: "MMM", reason: "Fluid overload", sources: [nd] }] },
  change: [{ section: "conditions", i: 1, row: { name: "CKD stage 4", diagnosed: "", status: "worsening, creatinine 3.4 (Oct 2026)", sources: [nd] }, why: "Discharge summary Oct 2026" }],
  fields: { alerts: { anticoagulants: { text: "Clopidogrel 75 OD", sources: [nd], why: "Started at discharge" } } },
  doctors: [{ name: "Dr J Ezhilan", specialty: "Cardiology", role: "consultant", seen: 1 }],
  points: [{ title: "Lasix dose", detail: "20 or 40 mg?", sources: [nd] }],
});

async function setup(name: string, phone: string) {
  const doctor = get<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR' ORDER BY name LIMIT 1")!;
  const pa = engine.getUser(get<{ id: string }>("SELECT id FROM users WHERE role = 'PA' LIMIT 1")!.id)!;
  const pid = engine.onboardPatient({ name, age: 74, sex: "M", phone, conditions: "", address: "", doctorId: doctor.id, caregivers: [{ name: "Ravi", relation: "Son", phone: phone.replace(/\d$/, "9"), level: 1, dashboard: true }] }, T, pa.id);
  onb.startOnboarding(pid, pa.id, T);
  return { pid, pa, doc: engine.getUser(doctor.id)! };
}
function addDoc(pid: string, onbId: number, by: string, title: string, pile: string, x: object) {
  const id = addDocument(pid, { title, category: "other", mime: "application/pdf", base64: "data:application/pdf;base64,JVBERi0=" }, T, by);
  run("UPDATE patient_documents SET onboarding_id = ?, pile = ?, extract = ? WHERE id = ?", onbId, pile, JSON.stringify({ category: "other", title, prescriber: null, meds: 0, note: null, labs: [], ...x }), id);
  run("UPDATE onboardings SET status = 'COLLECTING' WHERE id = ?", onbId);
  return id;
}
const discharge = { date: "2026-10-06", kind: "discharge_summary", text: "Admitted for fluid overload. CKD 4.", labs: [{ marker: "creatinine", value: 3.4, unit: "mg/dL" }], visits: [{ date: "2026-10-06", doctorName: "Dr J Ezhilan", specialty: "Cardiology", findings: "Fluid overload", kind: "outside" }] };

describe("adding records to a history", () => {
  after(() => server.close());

  it("records added while checking keep the assistant's edits and answers", async () => {
    await seedDemo();
    const { pid, pa } = await setup("Upd One", "+91 90000 22211");
    const o = onb.currentOnboarding(pid)!;
    const note = addDoc(pid, o.id, pa.id, "Cardiology note", "clinical", { date: "2026-03-04", kind: "consultation", text: "CAD", labs: [{ marker: "creatinine", value: 1.2, unit: "mg/dL" }], visits: [{ date: "2026-03-04", doctorName: "Dr E Satish Kumar", kind: "outside" }] });
    reply = FIRST(note);
    const first = await onb.buildDraft(o.id);
    assert.deepEqual(first.builtFrom, [note]);

    // The assistant edits and answers before more records turn up.
    const edited = structuredClone(first);
    (edited.summary.immunisations as Record<string, unknown>[]).push({ vaccine: "Influenza", dates: "Oct 2025", status: "", sources: [] });
    edited.points[0] = { ...edited.points[0], answer: "2019, per family", status: "resolved" };
    onb.saveDraftEdits(pid, { summary: edited.summary, points: edited.points }, pa, T);

    const nd = addDoc(pid, o.id, pa.id, "Discharge Oct 2026", "clinical", discharge);
    reply = UPDATE(nd);
    const before = asked.length;
    const d = await onb.buildDraft(o.id);
    const req = asked[before];
    const input = JSON.parse(((req.messages as { content: { text: string }[] }[])[0].content[0]).text);
    assert.deepEqual(input.documents.map((x: { id: number }) => x.id), [nd], "only the new record is sent");
    assert.equal(input.history.conditions[1].i, 1);
    assert.match(String(req.system), /NOT yet in the history/);

    assert.equal(listOf(d.summary, "immunisations")[0].vaccine, "Influenza", "the assistant's addition is kept");
    assert.equal(d.points[0].answer, "2019, per family", "the answer is kept");
    assert.equal(d.points[1].title, "Lasix dose");
    const ckd = listOf(d.summary, "conditions").find((c) => c.name === "CKD stage 4")!;
    assert.equal(ckd._changed, "Discharge summary Oct 2026");
    assert.match(String(ckd._was), /CKD stage 3/);
    assert.deepEqual(ckd.sources, [note, nd]);
    assert.equal(listOf(d.summary, "admissions")[0]._new, true);
    assert.equal(fieldsOf(d.summary, "alerts").anticoagulants._new, true);
    assert.equal(fieldsOf(d.summary, "alerts").allergies.text, "Sulfa: rash");
    assert.deepEqual(markCounts(d.summary), { added: 3, changed: 1 }, "admission, anticoagulant field and the new visit; CKD changed");
    assert.ok(d.doctors.some((x) => x.name === "Dr J Ezhilan" && x.add));
    const cr = d.labs.find((l) => l.value === 3.4)!;
    assert.equal(cr.fresh, true);
    assert.match(cr.check ?? "", /Big change from 1.2/);
    assert.deepEqual(d.builtFrom, [note, nd]);

    // Marks survive the checker's saves.
    onb.saveDraftEdits(pid, { summary: d.summary }, pa, T);
    assert.equal(markCounts(onb.draftOf(onb.currentOnboarding(pid))!.summary).changed, 1);

    // Nothing new: no AI call, nothing changes.
    run("UPDATE onboardings SET status = 'COLLECTING' WHERE id = ?", o.id);
    const n = asked.length;
    await onb.buildDraft(o.id);
    assert.equal(asked.length, n);
    assert.equal(onb.currentOnboarding(pid)!.status, "REVIEW");
  });

  it("records added after confirmation update the history for the doctor to confirm", async () => {
    const { pid, pa, doc } = await setup("Upd Two", "+91 90000 33311");
    const o = onb.currentOnboarding(pid)!;
    const note = addDoc(pid, o.id, pa.id, "Cardiology note", "clinical", { date: "2026-03-04", kind: "consultation", text: "CAD", labs: [{ marker: "creatinine", value: 1.2, unit: "mg/dL" }], visits: [{ date: "2026-03-04", doctorName: "Dr E Satish Kumar", kind: "outside" }] });
    reply = FIRST(note);
    await onb.buildDraft(o.id);
    onb.sendToDoctor(pid, pa, T);
    onb.confirmOnboarding(pid, doc, T);
    const b1 = getBaseline(pid)!;
    assert.equal(all("SELECT 1 FROM labs WHERE patient_id = ?", pid).length, 1);

    // A new record turns up later.
    const upId = onb.startUpdate(pid, pa.id, T + 1000);
    assert.notEqual(upId, o.id);
    assert.equal(onb.startUpdate(pid, pa.id, T + 1000), upId, "one update at a time");
    const up = onb.getOnboarding(upId)!;
    assert.equal(up.base_id, o.id);
    assert.equal(onb.draftOf(up)!.points[0].old, true);
    assert.equal(onb.confirmedOnboarding(pid)!.id, o.id, "the confirmed history stays until the update is confirmed");

    assert.equal(up.status, "REVIEW", "an update opens ready to correct");
    // The confirmed history is locked: changes go through the update, where they're marked.
    const confirmedDraft = onb.draftOf(onb.confirmedOnboarding(pid))!;
    const hand = structuredClone(onb.draftOf(up)!);
    (hand.summary.conditions as Record<string, unknown>[])[0].status = "stable, on Ecosprin";     // edited
    (hand.summary.snapshot as Record<string, { text: string }>).bloodGroup = { text: "O negative" } as never;
    (hand.summary.resolved as Record<string, unknown>[]).push({ name: "TB", period: "2010", outcome: "Treated", sources: [] }); // added
    (hand.summary.medicines as Record<string, unknown>[]).splice(0, 1);                           // taken out
    onb.saveDraftEdits(pid, { summary: hand.summary }, pa, T + 1500);
    const edited = onb.draftOf(onb.getOnboarding(upId))!;
    const cad = listOf(edited.summary, "conditions")[0];
    assert.match(String(cad._changed), /^Edited by /);
    assert.match(String(cad._was), /stable/);
    assert.equal(listOf(edited.summary, "resolved")[0]._new, true);
    assert.equal(listOf(edited.summary, "conditions")[1]._changed, undefined, "untouched entries stay unmarked");
    assert.deepEqual(onb.removedFrom(confirmedDraft.summary, edited.summary).map((r) => r.text), ["Ecosprin 75 mg · 1-0-0 · CAD"]);
    // Put the medicine back: no longer "taken out".
    edited.summary.medicines = confirmedDraft.summary.medicines;
    onb.saveDraftEdits(pid, { summary: edited.summary }, pa, T + 1600);
    assert.equal(onb.removedFrom(confirmedDraft.summary, onb.draftOf(onb.getOnboarding(upId))!.summary).length, 0);

    const nd = addDoc(pid, upId, pa.id, "Discharge Oct 2026", "clinical", discharge);
    reply = UPDATE(nd);
    const d = await onb.buildDraft(upId);
    // The new record would change "CKD stage 3", which the doctor confirmed: it becomes a point, not a change.
    const ckd = listOf(d.summary, "conditions").find((c) => String(c.name).startsWith("CKD"))!;
    assert.equal(ckd.name, "CKD stage 3");
    const clash = d.points.find((x) => x.title.includes("differs from the confirmed history"))!;
    assert.match(clash.detail, /Confirmed: “CKD stage 3/);
    assert.match(clash.detail, /CKD stage 4/);
    assert.deepEqual(clash.sources, [nd]);
    assert.equal(fieldsOf(d.summary, "alerts").anticoagulants._new, true, "an empty field can still be filled");
    assert.equal(listOf(d.summary, "admissions")[0]._new, true);
    assert.equal(listOf(d.summary, "conditions")[0]._changed?.startsWith("Edited by"), true, "the hand edit is kept");
    assert.equal(onb.openItems(d).points, 2, "the new point and the disagreement");
    onb.sendToDoctor(pid, pa, T + 2000);
    assert.equal(onb.draftOf(onb.getOnboarding(upId))!.points.filter((p) => p.status === "doctor" && !p.old).length, 2);
    assert.equal(onb.onboardingTasks(doc).find((x) => x.patientId === pid)!.forDoctor, 2);
    assert.equal(onb.onboardingTasks(doc).filter((x) => x.patientId === pid).length, 1);

    const counts = onb.confirmOnboarding(pid, doc, T + 3000);
    assert.deepEqual({ labs: counts.labs, visits: counts.visits }, { labs: 1, visits: 1 }, "only the new record's values and visit are filed");
    assert.equal(all("SELECT 1 FROM labs WHERE patient_id = ?", pid).length, 2);
    assert.equal(all("SELECT 1 FROM outside_visits WHERE patient_id = ?", pid).length, 2);
    assert.ok(get("SELECT 1 FROM care_team WHERE patient_id = ? AND name LIKE '%Ezhilan%'", pid));

    const conf = onb.confirmedOnboarding(pid)!;
    assert.equal(conf.id, upId);
    const final = onb.draftOf(conf)!;
    assert.deepEqual(markCounts(final.summary), { added: 0, changed: 0 }, "marks are cleared on confirmation");
    assert.ok(final.points.every((p) => p.old));
    assert.ok(final.labs.every((l) => !l.fresh));
    assert.deepEqual(final.builtFrom, [note, nd]);

    const b2 = getBaseline(pid)!;
    assert.equal(b2.bloodGroup, "O-", "a confirmed correction reaches the baseline");
    assert.deepEqual(b2.conditions.sort(), ["CKD stage 3", "Coronary artery disease"].sort());
    assert.equal((b2.history.match(/Summary: /g) ?? []).length, 1, "the history text is replaced, not added twice");
    assert.match(b2.history, /Anticoagulant \/ antiplatelet: Clopidogrel/);
    assert.match(b2.history, /Fluid overload/);
    assert.ok(b2.history.startsWith(b1.history.split("\n")[0]));

    // Both confirmed versions are kept, newest first; the first is untouched.
    const versions = onb.historyVersions(pid);
    assert.deepEqual(versions.map((v) => [v.n, v.kind, v.records]), [[2, "update", 1], [1, "first", 1]]);
    assert.equal(listOf(onb.draftOf(onb.getOnboarding(o.id))!.summary, "conditions")[0].status, "stable", "version 1 still reads as confirmed");
    assert.throws(() => onb.saveDraftEdits(pid, { summary: final.summary }, doc, T + 3500), /locked/);

    // And the next update starts from this one.
    const again = onb.startUpdate(pid, pa.id, T + 4000);
    assert.equal(onb.getOnboarding(again)!.base_id, upId);

    // Clearing documents drops only the update in progress; the confirmed history goes only when chosen.
    clearRecords(pid, ["documents"], T + 5000, doc.id);
    assert.equal(onb.historyVersions(pid).length, 2);
    assert.equal(onb.getOnboarding(again), undefined);
    clearRecords(pid, ["history"], T + 6000, doc.id);
    assert.equal(onb.historyVersions(pid).length, 0);
  });
});
