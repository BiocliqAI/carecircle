import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Live-clinic mode on an isolated, empty database.
const tmpDb = path.join(os.tmpdir(), `carecircle-test-clinic-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.CARECIRCLE_DB = tmpDb;
process.env.CARECIRCLE_MODE = "live";
delete process.env.GEMINI_API_KEY;

const { all, get } = await import("../lib/db");
const { ensureSeeded } = await import("../lib/seed");
const clinic = await import("../lib/clinic");
const engine = await import("../lib/engine");
const { now } = await import("../lib/clock");
const { canView } = await import("../lib/server");
const { EMPTY_BASELINE } = await import("../lib/types");
const records = await import("../lib/records");

after(() => fs.rmSync(tmpDb, { force: true }));

describe("Live clinic onboarding", () => {
  let drId = "";
  let paId = "";
  let drB = "";
  let pid = "";

  it("starts empty: only the admin persona exists in live mode", async () => {
    await ensureSeeded();
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role != 'ADMIN'")!.n, 0);
    assert.equal(engine.getUser("u_admin")!.role, "ADMIN");
    assert.equal(clinic.getClinic(), null);
  });

  it("sets up the clinic with its first doctor", () => {
    drId = clinic.setupClinic({ name: "Sunrise Clinic", address: "Jayanagar", phone: "+91 80 1234 5678" }, { name: "Anita Menon", title: "MD (Nephrology)", phone: "+91 90000 00001", email: "anita@example.com", regNo: "KMC 1" }, now())!;
    assert.equal(clinic.getClinic()!.name, "Sunrise Clinic");
    const u = engine.getUser(drId)!;
    assert.equal(u.role, "DOCTOR");
    assert.equal(u.name, "Dr. Anita Menon", "doctors get the Dr. prefix");
    assert.throws(() => clinic.setupClinic({ name: "Again", address: "", phone: "" }, { name: "X", title: "", phone: "+91 90000 00009", email: "", regNo: "" }, now()), /already set up/);
  });

  it("adds staff and rejects duplicate phone numbers", () => {
    paId = clinic.addStaff({ name: "Rahul Verma", role: "PA", title: "", phone: "+91 90000 00002", email: "", regNo: "" }, now(), drId);
    drB = clinic.addStaff({ name: "Dr. Kiran Rao", role: "DOCTOR", title: "Cardiology", phone: "+91 90000 00003", email: "", regNo: "" }, now(), drId);
    assert.throws(() => clinic.addStaff({ name: "Dup", role: "PA", title: "", phone: "+91-90000-00002", email: "", regNo: "" }, now(), drId), /already exists/);
    assert.throws(() => clinic.addStaff({ name: "Bad", role: "PA", title: "", phone: "123", email: "", regNo: "" }, now(), drId), /phone/);
    assert.deepEqual(clinic.listStaff().map((s) => s.role), ["DOCTOR", "DOCTOR", "PA"]);
  });

  it("validates baseline input", () => {
    const t = now();
    assert.match(String(clinic.cleanBaseline({ ...EMPTY_BASELINE, dob: "2999-01-01" }, t)), /past date/);
    assert.match(String(clinic.cleanBaseline({ ...EMPTY_BASELINE, heightCm: 5 }, t)), /Height/);
    assert.match(String(clinic.cleanBaseline({ ...EMPTY_BASELINE, labs: [{ marker: "unobtainium", value: 1, date: "2026-01-01" }] }, t)), /Unknown lab/);
    assert.match(String(clinic.cleanBaseline({ ...EMPTY_BASELINE, vitals: { sys: 400 } }, t)), /out of range/);
  });

  it("onboards a patient with care circle, baseline and consent requests", () => {
    const t = now();
    pid = engine.onboardPatient(
      {
        name: "Kamala Iyer", age: 68, sex: "F", phone: "+91 98000 11111", conditions: "", address: "", doctorId: drId,
        caregivers: [
          { name: "Meena Iyer", relation: "Daughter", phone: "+91 98000 22222", level: 1 },
          { name: "Suresh Iyer", relation: "Son", phone: "+91 98000 33333", level: 2, dashboard: false },
        ],
      },
      t,
      paId,
    );
    const b = clinic.cleanBaseline(
      {
        ...EMPTY_BASELINE,
        dob: "1958-03-14",
        heightCm: 158,
        vitals: { sys: 148, dia: 90, weight: 64.5 },
        conditions: ["Hypertension", "Chronic kidney disease"],
        allergies: "Sulfa drugs",
        currentMeds: [{ name: "Amlodipine", dose: "5 mg", frequency: "OD" }],
        labs: [{ marker: "creatinine", value: 1.8, date: "2026-09-20" }, { marker: "potassium", value: 6.4, date: "2026-09-20" }],
      },
      t,
    );
    assert.notEqual(typeof b, "string");
    clinic.saveBaseline(pid, b as Exclude<typeof b, string>, t, paId);

    const stored = clinic.getBaseline(pid)!;
    assert.equal(stored.currentMeds[0].name, "Amlodipine");
    assert.equal(stored.capturedBy, "Rahul Verma");
    assert.equal(engine.getPatient(pid)!.conditions, "Hypertension, Chronic kidney disease");
    const labs = all<{ marker: string; source: string }>("SELECT marker, source FROM labs WHERE patient_id = ?", pid);
    assert.equal(labs.length, 2);
    assert.ok(labs.every((l) => l.source === "BASELINE"));
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM escalations WHERE patient_id = ?", pid)!.n, 0, "baseline labs never raise alerts, even a critical potassium");

    const cgs = engine.getCaregivers(pid);
    assert.deepEqual(cgs.map((c) => c.dashboard), [1, 0]);
    const consents = engine.getConsents(pid);
    assert.equal(consents.length, 3);
    assert.ok(consents.every((c) => c.status === "PENDING"));
    const welcome = get<{ body: string }>("SELECT body FROM messages WHERE user_id = ? AND direction = 'OUT'", engine.getPatient(pid)!.user_id!)!.body;
    assert.match(welcome, /Sunrise Clinic/);
  });

  it("re-saving the baseline replaces baseline labs instead of duplicating them", () => {
    const b = clinic.getBaseline(pid)!;
    clinic.saveBaseline(pid, { ...b, labs: [{ marker: "creatinine", value: 1.7, date: "2026-09-20" }] }, now(), drId);
    const labs = all<{ value: number }>("SELECT value FROM labs WHERE patient_id = ? AND source = 'BASELINE'", pid);
    assert.deepEqual(labs.map((l) => l.value), [1.7]);
    assert.equal(clinic.getBaseline(pid)!.capturedBy, "Rahul Verma", "original capturer is kept");
  });

  it("records consent replies from WhatsApp", async () => {
    const p = engine.getPatient(pid)!;
    const [l1, l2] = engine.getCaregivers(pid);
    await engine.ingestMessage(p.user_id!, "YES", { allowAi: false });
    await engine.ingestMessage(l1.user_id!, "yes", { allowAi: false });
    await engine.ingestMessage(l2.user_id!, "No", { allowAi: false });
    const by = Object.fromEntries(engine.getConsents(pid).map((c) => [c.user_id, c.status]));
    assert.equal(by[p.user_id!], "GIVEN");
    assert.equal(by[l1.user_id!], "GIVEN");
    assert.equal(by[l2.user_id!], "DECLINED");
    assert.ok(get("SELECT 1 FROM audit WHERE action = 'CONSENT_DECLINED' AND actor = ?", l2.user_id!));
  });

  it("keeps doctor isolation for clinic staff", () => {
    const a = engine.getUser(drId)!;
    const b = engine.getUser(drB)!;
    const pa = engine.getUser(paId)!;
    assert.equal(canView(a, pid), true);
    assert.equal(canView(b, pid), false, "another doctor in the clinic can't see the patient");
    assert.equal(canView(pa, pid), true);
  });

  it("checklist reflects progress", () => {
    const c = clinic.checklist();
    assert.equal(c.doctors, 2);
    assert.equal(c.pas, 1);
    assert.equal(c.patients, 1);
    assert.equal(c.baselines, 1);
    assert.equal(c.consentsGiven, 2);
    assert.equal(c.withVisit, 0);
  });

  it("staff never receive automated messages", () => {
    const n = get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'OUT' AND user_id IN (SELECT id FROM users WHERE role IN ('DOCTOR','PA'))")!.n;
    assert.equal(n, 0);
  });

  it("saves, updates, lists and deletes onboarding drafts", () => {
    const t = now();
    const id = clinic.saveDraft(null, 1, { f: { name: "Ravi Shankar" }, cgs: [] }, t, paId);
    assert.equal(clinic.listDrafts().length, 1);
    assert.equal(clinic.listDrafts()[0].created_by_name, "Rahul Verma");
    const same = clinic.saveDraft(id, 2, { f: { name: "Ravi S." }, cgs: [{ name: "Asha" }] }, t + 1000, drId);
    assert.equal(same, id, "re-saving keeps the same draft");
    const d = clinic.getDraft(id)!;
    assert.equal(d.step, 2);
    assert.equal(d.name, "Ravi S.");
    assert.equal(d.updated_by, drId);
    assert.deepEqual((d.data as { cgs: { name: string }[] }).cgs[0].name, "Asha");
    const clamped = clinic.saveDraft(null, 99, {}, t, paId);
    assert.equal(clinic.getDraft(clamped)!.step, 3, "step is clamped to the last wizard step");
    assert.equal(clinic.getDraft(clamped)!.name, "Unnamed patient");
    for (const x of clinic.listDrafts()) clinic.deleteDraft(x.id);
    assert.equal(clinic.listDrafts().length, 0);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND direction = 'OUT' AND body LIKE '%Ravi%'", t)!.n, 0, "drafts never message anyone");
  });

  it("edits patient details and rejects a caregiver's number", () => {
    records.updatePatient(pid, { name: "Kamala R. Iyer", age: 69, address: "Basavanagudi" }, now(), paId);
    const p = engine.getPatient(pid)!;
    assert.equal(p.name, "Kamala R. Iyer");
    assert.equal(p.age, 69);
    assert.equal(engine.getUser(p.user_id!)!.name, "Kamala R. Iyer", "the WhatsApp user follows the patient");
    assert.throws(() => records.updatePatient(pid, { phone: "+91 98000 22222" }, now(), paId), /caregiver/);
    records.updatePatient(pid, { doctorId: drB }, now(), paId);
    assert.equal(engine.getPatient(pid)!.doctor_id, drB);
    records.updatePatient(pid, { doctorId: drId }, now(), paId);
  });

  it("edits the care circle: reorder, replace, max two", () => {
    const [l1, l2] = engine.getCaregivers(pid);
    const t = now();
    // swap order: backup becomes primary
    records.setCareCircle(pid, [
      { id: l2.id, name: l2.name, relation: l2.relation!, phone: l2.phone, dashboard: true },
      { id: l1.id, name: l1.name, relation: l1.relation!, phone: l1.phone, dashboard: true },
    ], t, paId);
    const swapped = engine.getCaregivers(pid);
    assert.deepEqual(swapped.map((c) => c.name), ["Suresh Iyer", "Meena Iyer"]);
    assert.equal(swapped[0].user_id, l2.user_id, "existing people keep their account");
    // replace the backup with a new person: consent requested + welcome sent; removed person told
    records.setCareCircle(pid, [
      { id: swapped[0].id, name: "Suresh Iyer", relation: "Son", phone: "+91 98000 33333", dashboard: true },
      { name: "Lata Rao", relation: "Neighbour", phone: "+91 98000 44444", dashboard: false },
    ], t + 1000, paId);
    const now2 = engine.getCaregivers(pid);
    assert.equal(now2[1].name, "Lata Rao");
    assert.equal(now2[1].dashboard, 0);
    assert.ok(engine.getConsents(pid).some((c) => c.user_id === now2[1].user_id && c.status === "PENDING"));
    assert.ok(get("SELECT 1 FROM messages WHERE user_id = ? AND body LIKE '%removed from%'", l1.user_id!));
    assert.throws(() => records.setCareCircle(pid, [
      { name: "A", relation: "", phone: "+91 98000 50001", dashboard: true },
      { name: "B", relation: "", phone: "+91 98000 50002", dashboard: true },
      { name: "C", relation: "", phone: "+91 98000 50003", dashboard: true },
    ], t, paId), /at most 2/);
    assert.throws(() => records.setCareCircle(pid, [], t, paId), /at least one/);
  });

  it("keeps notes per author", () => {
    const id = records.addNote(pid, "Advised low-salt diet.", "clinical", now(), drId);
    assert.equal(records.listNotes(pid)[0].author_name, "Dr. Anita Menon");
    assert.throws(() => records.editNote(id, "changed", now(), paId), /own notes/);
    records.editNote(id, "Advised low-salt diet; review in 2 weeks.", now(), drId);
    assert.match(records.listNotes(pid)[0].body, /review in 2 weeks/);
    records.editNote(id, null, now(), drId);
    assert.equal(records.listNotes(pid).length, 0);
  });

  it("stores, edits and deletes documents", () => {
    const png = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");
    const id = records.addDocument(pid, { title: "RFT report", category: "lab", mime: "image/png", base64: png }, now(), paId);
    const list = records.listDocuments(pid);
    assert.equal(list[0].title, "RFT report");
    assert.equal(list[0].size, "fake-png-bytes".length);
    assert.equal(Buffer.from(records.getDocumentFile(id)!.data).toString(), "fake-png-bytes");
    records.updateDocument(id, { title: "RFT Sept", category: "nonsense" }, now(), paId);
    assert.equal(records.listDocuments(pid)[0].title, "RFT Sept");
    assert.equal(records.listDocuments(pid)[0].category, "lab", "unknown categories are ignored");
    assert.throws(() => records.addDocument(pid, { title: "big", category: "lab", mime: "image/png", base64: Buffer.alloc(6 * 1024 * 1024).toString("base64") }, now(), paId), /5 MB/);
    records.deleteDocument(id, now(), paId);
    assert.equal(records.listDocuments(pid).length, 0);
  });

  it("before Visit 1: logs readings and alerts the care circle only for emergencies", async () => {
    const p = engine.getPatient(pid)!;
    assert.equal(engine.latestVisit(pid, now()), undefined, "no visit yet");
    const t = now() + 2000;
    await engine.ingestMessage(p.user_id!, "BP 152/96", { allowAi: false, at: t });
    assert.ok(get("SELECT 1 FROM observations WHERE patient_id = ? AND type = 'bp' AND v1 = 152", pid), "reading recorded");
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM escalations WHERE patient_id = ? AND started_at >= ?", pid, t)!.n, 0, "no doctor's limits yet, so no deviation alert");
    const reply = get<{ body: string }>("SELECT body FROM messages WHERE user_id = ? AND direction = 'OUT' ORDER BY id DESC LIMIT 1", p.user_id!)!.body;
    assert.match(reply, /Logged/);
    assert.match(reply, /care plan starts after the first visit/);
    await engine.ingestMessage(p.user_id!, "BP 186/114, chest pain since morning", { allowAi: false, at: t + 60_000 });
    const urgent = get<{ type: string; level: number }>("SELECT type, level FROM escalations WHERE patient_id = ? AND started_at >= ? AND type = 'URGENT'", pid, t + 60_000);
    assert.ok(urgent, "emergency rules still alert the care circle");
    const primary = engine.getCaregivers(pid)[0];
    assert.ok(get("SELECT 1 FROM messages WHERE user_id = ? AND kind = 'escalation' AND created_at >= ?", primary.user_id!, t + 60_000), "primary caregiver alerted");
  });

  it("SOS raises an urgent alert to the primary caregiver", () => {
    const p = engine.getPatient(pid)!;
    const t = now() + 5000;
    const r = records.raiseSos(p.user_id!, t);
    assert.equal(r.calling, "Suresh Iyer");
    const esc = get<{ type: string; level: number; state: string }>("SELECT type, level, state FROM escalations WHERE patient_id = ? AND rule_key = 'sos'", pid)!;
    assert.equal(esc.type, "URGENT");
    assert.equal(esc.state, "NOTIFIED");
    const primary = engine.getCaregivers(pid)[0];
    assert.ok(get("SELECT 1 FROM messages WHERE user_id = ? AND kind = 'escalation' AND created_at >= ?", primary.user_id!, t));
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'OUT' AND user_id IN (SELECT id FROM users WHERE role IN ('DOCTOR','PA'))")!.n, 0, "the clinic is still never messaged");
  });

  it("edits and removes staff", () => {
    clinic.updateStaff(paId, { name: "Rahul V.", phone: "+91 90000 00002", title: "Senior PA" }, now(), drId);
    assert.equal(engine.getUser(paId)!.name, "Rahul V.");
    assert.throws(() => clinic.removeStaff(drId, now(), "u_admin"), /Reassign/);
    const tmp = clinic.addStaff({ name: "Temp PA", role: "PA", title: "", phone: "+91 90000 00099", email: "", regNo: "" }, now(), drId);
    clinic.removeStaff(tmp, now(), drId);
    assert.equal(engine.getUser(tmp), undefined);
  });

  it("reset erases the clinic but keeps Gemini settings", async () => {
    const { setSetting, getSetting } = await import("../lib/db");
    setSetting("gemini_model", "gemini-test");
    clinic.resetClinic();
    assert.equal(clinic.getClinic(), null);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role != 'ADMIN'")!.n, 0);
    assert.ok(engine.getUser("u_admin"), "the admin persona survives a reset");
    assert.equal(clinic.listDrafts().length, 0);
    assert.equal(getSetting("gemini_model"), "gemini-test");
  });
});
