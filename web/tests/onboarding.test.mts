import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

// A stand-in for the Anthropic Messages API that returns a scripted patient history and records what it was asked.
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
process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-onb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

const { all, get, run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { addDocument } = await import("../lib/records");
const onb = await import("../lib/onboarding");
const { getBaseline } = await import("../lib/clinic");
const { HISTORY, cleanHistory, historySchemaText, listOf, fieldsOf } = await import("../lib/historyspec");

const T = Date.parse("2026-11-10T11:00:00+05:30");

describe("onboarding from past records", () => {
  after(() => server.close());

  it("the history follows the template's 13 sections, and tidies what it's given", () => {
    assert.deepEqual([...new Set(HISTORY.map((s) => s.n))], ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"]);
    const txt = historySchemaText();
    for (const k of ["snapshot", "alerts", "conditions", "medChanges", "studies", "immunisations", "pending", "social", "inferences"]) assert.match(txt, new RegExp(`"${k}"`));
    const h = cleanHistory({ conditions: [{ name: "  CKD   4 ", junk: "x", sources: [1, 99, "2"] }, { name: "" }], alerts: { allergies: "Sulfa" }, bogus: [1] }, new Set([1, 2]));
    assert.deepEqual(listOf(h, "conditions"), [{ sources: [1, 2], name: "CKD 4", diagnosed: "", status: "", treatment: "", advice: "" }]);
    assert.equal(fieldsOf(h, "alerts").allergies.text, "Sulfa");
    assert.equal(fieldsOf(h, "alerts").implants.text, "");
    assert.equal(h.bogus, undefined);
  });

  it("builds a draft, goes to the doctor, and the confirmation fills the record", async () => {
    await seedDemo();
    const doctor = get<{ id: string; name: string }>("SELECT id, name FROM users WHERE role = 'DOCTOR' ORDER BY name LIMIT 1")!;
    const pa = engine.getUser(get<{ id: string }>("SELECT id FROM users WHERE role = 'PA' LIMIT 1")!.id)!;
    const pid = engine.onboardPatient({ name: "Test Onb", age: 74, sex: "M", phone: "+91 90000 11122", conditions: "", address: "", doctorId: doctor.id, caregivers: [{ name: "Ravi", relation: "Son", phone: "+91 90000 11123", level: 1, dashboard: true }] }, T, pa.id);
    onb.startOnboarding(pid, pa.id, T);
    const o = onb.currentOnboarding(pid)!;
    const doc = (title: string, pile: string, x: object) => {
      const id = addDocument(pid, { title, category: "other", mime: "application/pdf", base64: "data:application/pdf;base64,JVBERi0=" }, T, pa.id);
      run("UPDATE patient_documents SET onboarding_id = ?, pile = ?, extract = ? WHERE id = ?", o.id, pile, JSON.stringify({ category: "other", title, prescriber: null, meds: 0, note: null, labs: [], ...x }), id);
      return id;
    };
    const note = doc("Cardiology note", "clinical", { date: "2026-03-04", kind: "consultation", text: "Dr E Satish Kumar. CAD, stent 2019. Ecosprin 75 OD.", visits: [{ date: "2026-03-04", doctorName: "Dr E Satish Kumar", kind: "outside" }], medList: ["Ecosprin 75 mg OD"] });
    const copy = doc("Cardiology note (copy)", "clinical", { date: "2026-03-04", kind: "consultation", text: "Same visit, photocopy.", visits: [{ date: "2026-03-04", doctorName: "Dr. E Satish Kumar", specialty: "Cardiology", findings: "Stable", kind: "outside" }] });
    const lab1 = doc("Blood test Feb", "lab", { date: "2026-02-01", kind: "lab_report", labs: [{ marker: "creatinine", value: 2.1, unit: "mg/dL" }], text: "Creatinine 2.1" });
    const lab2 = doc("Blood test Sep", "lab", { date: "2026-09-01", kind: "lab_report", labs: [{ marker: "creatinine", value: 6.0, unit: "mg/dL" }], readings: [{ type: "bp", v1: 150, v2: 90, date: "2026-09-02", time: "07:30" }] });
    reply = JSON.stringify({
      history: {
        snapshot: { oneGlance: { text: "74 M, CAD with stent, CKD.", sources: [note] }, bloodGroup: { text: "B positive", sources: [note] } },
        alerts: { allergies: { text: "Sulfa: rash", sources: [note] }, implants: { text: "Coronary stent (2019)", sources: [note] }, anticoagulants: { text: "Ecosprin 75", sources: [note] } },
        conditions: [{ name: "Coronary artery disease", diagnosed: "2019", status: "stable", treatment: "Ecosprin", advice: "", sources: [note] }],
        medicines: [{ name: "Ecosprin 75 mg", dose: "1-0-0", indication: "CAD", started: "2019", prescriber: "Dr E Satish Kumar", sources: [note, 999] }],
        labNotes: [{ parameter: "Creatinine", reference: "0.7–1.3", trend: "2.1 (Feb) → 6.0 (Sep)", latest: "2026-09-01", comment: "rising", sources: [lab1, lab2] }],
        visits: [{ date: "2026-03-04", doctor: "Dr E Satish Kumar", specialty: "Cardiology", hospital: "Heart Clinic", takeaway: "Stable", sources: [note] }],
        social: { family: { text: "Father: diabetes", sources: [note] } },
      },
      doctors: [{ name: "Dr E Satish Kumar", specialty: "Cardiology", hospital: "Heart Clinic", role: "consultant", seen: 1, aliases: [] }, { name: doctor.name, role: "treating", seen: 0 }],
      merges: [],
      points: [{ title: "Stent year", detail: "2019 or 2018?", sources: [note] }],
    });
    const draft = await onb.buildDraft(o.id);

    // The AI got the clinical record in full and the lab pile as reports and trends.
    const input = JSON.parse(((asked.at(-1)!.messages as { content: { text: string }[] }[])[0].content[0]).text);
    assert.deepEqual(input.documents.map((d: { id: number }) => d.id), [note, copy]);
    assert.deepEqual(input.reports.map((d: { id: number }) => d.id), [lab1, lab2]);
    assert.deepEqual(input.labTrends.Creatinine, ["2026-02-01: 2.1 mg/dL", "2026-09-01: 6 mg/dL"]);
    assert.equal(input.patient.caregivers[0].name, "Ravi");
    assert.match(String(asked.at(-1)!.system), /immunisations/);
    assert.equal(asked.at(-1)!.max_tokens, 128000, "the history may use the model's full answer length");
    assert.doesNotMatch(String(asked.at(-1)!.system), /"visits": \[\{/, "the AI isn't asked to list consultations");
    const visits = listOf(draft.summary, "visits");
    assert.equal(visits.length, 1, "the same visit in two records is one row");
    assert.deepEqual(visits[0].sources, [note, copy]);
    assert.equal(visits[0].specialty, "Cardiology");
    assert.equal(visits[0].takeaway, "Stable");

    assert.equal(fieldsOf(draft.summary, "alerts").implants.text, "Coronary stent (2019)");
    assert.deepEqual(listOf(draft.summary, "medicines")[0].sources, [note], "unknown document ids are dropped");
    assert.equal(listOf(draft.summary, "immunisations").length, 0);
    assert.ok(draft.labs.find((l) => l.value === 6)?.check?.includes("Big change"), "a big jump is flagged");
    assert.equal(draft.homes.length, 1);
    assert.equal(onb.currentOnboarding(pid)!.status, "REVIEW");

    // The assistant corrects a field and sends it; the open point goes to the doctor.
    const edited = structuredClone(draft);
    (edited.summary.immunisations as Record<string, unknown>[]).push({ vaccine: "Influenza", dates: "Oct 2025", status: "due Oct 2026", sources: [] });
    onb.saveDraftEdits(pid, { summary: edited.summary }, pa, T);
    assert.throws(() => onb.confirmOnboarding(pid, pa, T), /Only the patient's doctor/);
    onb.sendToDoctor(pid, pa, T);
    const sent = onb.currentOnboarding(pid)!;
    assert.equal(sent.status, "SENT");
    assert.equal(onb.draftOf(sent)!.points[0].status, "doctor");
    const docUser = engine.getUser(doctor.id)!;
    assert.equal(onb.onboardingTasks(docUser).filter((x) => x.patientId === pid).length, 1);
    assert.equal(onb.onboardingTasks(pa).find((x) => x.patientId === pid)?.status, "SENT");

    const counts = onb.confirmOnboarding(pid, docUser, T);
    assert.equal(onb.currentOnboarding(pid)!.status, "CONFIRMED");
    assert.equal(counts.doctors, 1);
    assert.equal(counts.visits, 1);
    assert.ok(get("SELECT 1 FROM outside_visits WHERE patient_id = ? AND reviewed_at IS NOT NULL", pid), "the confirmed visit is not shown as new");
    assert.equal(counts.labs, 2);
    assert.equal(counts.homes, 1);
    assert.ok(get("SELECT 1 FROM care_team WHERE patient_id = ? AND name LIKE '%Satish%'", pid));
    const b = getBaseline(pid)!;
    assert.deepEqual(b.conditions, ["Coronary artery disease"]);
    assert.equal(b.allergies, "Sulfa: rash");
    assert.equal(b.bloodGroup, "B+");
    assert.match(b.familyHistory, /Father: diabetes/);
    assert.match(b.history, /Coronary stent/);
    assert.match(b.history, /Influenza/);
    assert.equal(b.currentMeds[0].frequency, "OD");
    assert.equal(b.currentMeds[0].purpose, "CAD");
    assert.equal(all("SELECT 1 FROM patient_documents WHERE onboarding_id = ? AND filed_at IS NULL", o.id).length, 0);
    assert.equal(onb.onboardingTasks(docUser).filter((x) => x.patientId === pid).length, 0);
  });
});
