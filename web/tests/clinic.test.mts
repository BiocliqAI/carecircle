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

after(() => fs.rmSync(tmpDb, { force: true }));

describe("Live clinic onboarding", () => {
  let drId = "";
  let paId = "";
  let drB = "";
  let pid = "";

  it("starts empty: nothing is seeded in live mode", async () => {
    await ensureSeeded();
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n, 0);
    assert.equal(clinic.getClinic(), null);
  });

  it("sets up the clinic with its first doctor", () => {
    drId = clinic.setupClinic({ name: "Sunrise Clinic", address: "Jayanagar", phone: "+91 80 1234 5678" }, { name: "Anita Menon", title: "MD (Nephrology)", phone: "+91 90000 00001", email: "anita@example.com", regNo: "KMC 1" }, now());
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

  it("reset erases the clinic but keeps Gemini settings", async () => {
    const { setSetting, getSetting } = await import("../lib/db");
    setSetting("gemini_model", "gemini-test");
    clinic.resetClinic();
    assert.equal(clinic.getClinic(), null);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n, 0);
    assert.equal(getSetting("gemini_model"), "gemini-test");
  });
});
