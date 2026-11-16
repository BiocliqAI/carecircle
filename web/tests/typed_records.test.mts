import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-typed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { get } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const onb = await import("../lib/onboarding");
const { readExtract } = await import("../lib/docauto");
const { LAB_META } = await import("../lib/types");

const T = Date.parse("2026-11-10T11:00:00+05:30");
describe("typing records in at onboarding", () => {
  it("files typed lab values as typed, learns new tests and keeps non-numeric results", async () => {
    await seedDemo();
    const doctor = get<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR' LIMIT 1")!;
    const pid = engine.onboardPatient({ name: "Typed In", age: 70, sex: "M", phone: "+91 90000 66611", conditions: "", address: "", doctorId: doctor.id, caregivers: [{ name: "A", relation: "Son", phone: "+91 90000 66619", level: 1, dashboard: true }] }, T, doctor.id);
    onb.startOnboarding(pid, doctor.id, T);

    assert.throws(() => onb.addTypedRecord(pid, doctor.id, { kind: "values", values: [{ test: "Creatinine", value: "2" }] }, T), /date/);
    assert.throws(() => onb.addTypedRecord(pid, doctor.id, { kind: "values", date: "2026-12-30", values: [{ test: "Creatinine", value: "2" }] }, T), /future/);
    assert.throws(() => onb.addTypedRecord(pid, doctor.id, { kind: "values", date: "2026-10-12", values: [{ test: "", value: "" }] }, T), /at least one/);

    const id = onb.addTypedRecord(pid, doctor.id, { kind: "values", date: "2026-10-12", values: [
      { test: "creatinine", value: "2,1", unit: "mg/dL" },
      { test: "Serum zinc", value: "80", unit: "ug/dL" },
      { test: "Urine albumin", value: "Positive (++)" },
    ] }, T);
    const doc = get<{ title: string; mime: string; pile: string; extract: string; onboarding_id: number }>("SELECT title, mime, pile, extract, onboarding_id FROM patient_documents WHERE id = ?", id)!;
    assert.equal(doc.mime, "text/plain");
    assert.equal(doc.pile, "lab");
    assert.match(doc.title, /^Lab values typed in, /);
    const x = readExtract(doc.extract)!;
    assert.deepEqual(x.labs.map((l) => [l.marker, l.value, l.date]), [["creatinine", 2.1, "2026-10-12"], ["serum_zinc", 80, "2026-10-12"]]);
    assert.equal(LAB_META.serum_zinc?.label, "Serum zinc", "a new test is learned");
    assert.deepEqual(x.texts, [{ test: "Urine albumin", result: "Positive (++)" }]);

    // With nothing else to read, the draft is put together straight away (no AI needed for lab values).
    for (let i = 0; i < 50 && onb.currentOnboarding(pid)!.status !== "REVIEW"; i++) await new Promise((r) => setTimeout(r, 50));
    const d = onb.draftOf(onb.currentOnboarding(pid))!;
    assert.deepEqual(d.labs.map((l) => [l.marker, l.value, l.date]), [["creatinine", 2.1, "2026-10-12"], ["serum_zinc", 80, "2026-10-12"]]);
    assert.equal(d.texts[0].result, "Positive (++)");
    assert.equal(d.texts[0].date, "2026-10-12");

    // A note is kept as a text record and read like any document (here the AI isn't set up, so it says so).
    const note = onb.addTypedRecord(pid, doctor.id, { kind: "note", date: "2026-09-02", text: "Seen by Dr J Ezhilan, cardiology. Lasix increased to 40 mg." }, T);
    const n = get<{ title: string; mime: string; data: Uint8Array }>("SELECT title, mime, data FROM patient_documents WHERE id = ?", note)!;
    assert.equal(n.mime, "text/plain");
    assert.match(Buffer.from(n.data).toString("utf8"), /Date of this record: 2026-09-02[\s\S]*Lasix increased/);
    assert.equal(onb.currentOnboarding(pid)!.status, "COLLECTING", "a note sends the onboarding back to reading");
  });
});
