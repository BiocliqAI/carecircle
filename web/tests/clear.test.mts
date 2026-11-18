import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-clear-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { all, get, run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const { clearRecords, countRecords, RECORD_PARTS } = await import("../lib/clear");
const { deleteDocument, documentData, listDocuments } = await import("../lib/records");
const { now } = await import("../lib/clock");

const n = (sql: string, ...a: (string | number)[]) => get<{ n: number }>(sql, ...a)!.n;

describe("clearing a patient's records, keeping the patient", () => {
  before(async () => { await seedDemo(); });

  it("clears only the ticked kinds; profile, care circle, consents and care team stay; other patients untouched", () => {
    const pid = "p_ramesh";
    const before = countRecords(pid);
    assert.ok(before.visits > 0 && before.readings > 0 && before.whatsapp > 0);
    const caregivers = n("SELECT COUNT(*) AS n FROM caregivers WHERE patient_id = ?", pid);
    const team = n("SELECT COUNT(*) AS n FROM care_team WHERE patient_id = ?", pid);
    const consents = n("SELECT COUNT(*) AS n FROM consents WHERE patient_id = ?", pid);
    const sunita = countRecords("p_sunita");

    const removed = clearRecords(pid, ["visits", "readings", "alerts"], now(), "u_dr_rao");
    assert.equal(removed.visits, before.visits);
    assert.equal(removed.readings, before.readings);
    const after = countRecords(pid);
    assert.equal(after.visits, 0);
    assert.equal(after.readings, 0);
    assert.equal(after.alerts, 0);
    assert.equal(after.whatsapp, before.whatsapp, "not ticked: kept");
    assert.equal(n("SELECT COUNT(*) AS n FROM tasks WHERE patient_id = ?", pid), 0, "no reminders left");
    assert.ok(engine.getPatient(pid), "the patient stays");
    assert.equal(n("SELECT COUNT(*) AS n FROM caregivers WHERE patient_id = ?", pid), caregivers);
    assert.equal(n("SELECT COUNT(*) AS n FROM care_team WHERE patient_id = ?", pid), team);
    assert.equal(n("SELECT COUNT(*) AS n FROM consents WHERE patient_id = ?", pid), consents);
    assert.equal(engine.planRunning(pid), false);
    assert.deepEqual(countRecords("p_sunita"), sunita);
    assert.ok(get("SELECT 1 FROM audit WHERE action = 'RECORDS_CLEARED' AND entity_id = ?", pid));

    // Nothing is scheduled or sent for the cleared patient afterwards.
    const out = n("SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND direction = 'OUT'", pid);
    engine.tick(now() + 3_600_000);
    assert.equal(n("SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND direction = 'OUT'", pid), out);
  });

  it("every kind can be cleared, and choosing none is refused", () => {
    const pid = "p_sunita";
    clearRecords(pid, Object.keys(RECORD_PARTS) as (keyof typeof RECORD_PARTS)[], now(), "u_dr_rao");
    assert.deepEqual(Object.values(countRecords(pid)).filter((x) => x > 0), []);
    assert.ok(engine.getPatient(pid));
    assert.throws(() => clearRecords(pid, [], now(), "u_dr_rao"), /at least one/);
  });

  it("deleting a document can take the values and visits filed from it along", () => {
    const pid = "p_abdul";
    const t = now();
    const doc = Number(run("INSERT INTO patient_documents(patient_id, title, category, mime, size, data, source, uploaded_by, uploaded_at) VALUES(?,?,?,?,?,?,?,?,?)", pid, "Lab report", "lab", "application/pdf", 4, new Uint8Array([37, 80, 68, 70]), "clinic", "u_dr_rao", t).lastInsertRowid);
    run("INSERT INTO labs(patient_id, marker, value, taken_at, source, document_id) VALUES(?,?,?,?,?,?)", pid, "creatinine", 2.1, t - 86_400_000, "clinic", doc);
    run("INSERT INTO lab_texts(patient_id, test, result, taken_at, source, document_id) VALUES(?,?,?,?,?,?)", pid, "Urine albumin", "Absent", t - 86_400_000, "DOCUMENT", doc);
    const ov = Number(run("INSERT INTO outside_visits(patient_id, visit_at, status, source, created_at, updated_at, document_id) VALUES(?,?,?,?,?,?,?)", pid, t - 86_400_000, "COMPLETE", "document", t, t, doc).lastInsertRowid);
    run("INSERT INTO med_changes(patient_id, at, med_name, change, source, outside_visit_id) VALUES(?,?,?,?,?,?)", pid, t, "Amlodipine", "started", "dashboard", ov);
    const other = Number(run("INSERT INTO labs(patient_id, marker, value, taken_at, source) VALUES(?,?,?,?,?)", pid, "creatinine", 1.9, t - 10 * 86_400_000, "clinic").lastInsertRowid);

    assert.deepEqual(documentData(doc), { labs: 2, visits: 1 });
    assert.equal(listDocuments(pid).find((d) => d.id === doc)!.filed_labs, 2);
    assert.deepEqual(deleteDocument(doc, t, "u_dr_rao", true), { labs: 2, readings: 0, visits: 1, keptVisits: 0 });
    assert.equal(n("SELECT COUNT(*) AS n FROM labs WHERE document_id = ?", doc), 0);
    assert.equal(n("SELECT COUNT(*) AS n FROM outside_visits WHERE id = ?", ov), 0);
    assert.equal(n("SELECT COUNT(*) AS n FROM med_changes WHERE outside_visit_id = ?", ov), 0);
    assert.ok(get("SELECT 1 FROM labs WHERE id = ?", other), "values from elsewhere stay");

    // Without "withData", only the file goes.
    const doc2 = Number(run("INSERT INTO patient_documents(patient_id, title, category, mime, size, data, source, uploaded_by, uploaded_at) VALUES(?,?,?,?,?,?,?,?,?)", pid, "Report 2", "lab", "application/pdf", 4, new Uint8Array([37, 80, 68, 70]), "clinic", "u_dr_rao", t).lastInsertRowid);
    const kept = Number(run("INSERT INTO labs(patient_id, marker, value, taken_at, source, document_id) VALUES(?,?,?,?,?,?)", pid, "urea", 60, t, "clinic", doc2).lastInsertRowid);
    deleteDocument(doc2, t, "u_dr_rao");
    assert.ok(get("SELECT 1 FROM labs WHERE id = ?", kept));
  });

  it("a visit whose medicine changes were applied to the plan is kept when its document is deleted", () => {
    const pid = "p_abdul";
    const t = now();
    const doc = Number(run("INSERT INTO patient_documents(patient_id, title, category, mime, size, data, source, uploaded_by, uploaded_at) VALUES(?,?,?,?,?,?,?,?,?)", pid, "Rx", "prescription", "application/pdf", 4, new Uint8Array([37, 80, 68, 70]), "clinic", "u_dr_rao", t).lastInsertRowid);
    const ov = Number(run("INSERT INTO outside_visits(patient_id, visit_at, status, source, created_at, updated_at, document_id) VALUES(?,?,?,?,?,?,?)", pid, t, "COMPLETE", "document", t, t, doc).lastInsertRowid);
    run("INSERT INTO med_changes(patient_id, at, med_name, change, source, outside_visit_id, status, applied_at) VALUES(?,?,?,?,?,?,?,?)", pid, t, "Lasix", "dose_changed", "dashboard", ov, "CONFIRMED", t);
    assert.deepEqual(deleteDocument(doc, t, "u_dr_rao", true), { labs: 0, readings: 0, visits: 0, keptVisits: 1 });
    assert.ok(get("SELECT 1 FROM outside_visits WHERE id = ?", ov));
    assert.equal(all("SELECT 1 FROM patient_documents WHERE id = ?", doc).length, 0);
  });
});
