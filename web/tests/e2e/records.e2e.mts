// E2E suite "records": §4 Patient onboarding and care circle (ONB-*), §5 Baseline and past records (BASE-*),
// §6 Visits and care plans (VIS-*), §16 Visits to other doctors (OUT-*). Demo mode, port 3202, AI off (rules).
// Run: cd web && npx tsx tests/e2e/records.e2e.mts
import { startApp, assert, until, notRun, type App } from "./harness.mts";
import { killPort } from "./_killport.mts";

const PORT = 3202;
killPort(PORT);
const app: App = await startApp({ mode: "demo", port: PORT, suite: "records" });
await app.api("u_dr_rao", "GET", "/api/dashboard"); // make sure the seed has run before reading the DB

// ---------------------------------------------------------------- helpers
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, IST = 330 * MIN;
const dayKey = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const dayStart = (ms: number) => Math.floor((ms + IST) / DAY) * DAY - IST;
const atIST = (ms: number, hh: number, mm = 0) => dayStart(ms) + hh * HOUR + mm * MIN;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
async function advanceTo(target: number) {
  const n = await app.clock.now();
  if (target > n) await app.clock.advance(Math.ceil((target - n) / MIN));
}
let phoneSeq = 10000 + Math.floor(Math.random() * 80000);
const newPhone = () => `+91 93${String(phoneSeq++).padStart(3, "0").slice(-3)} ${String(phoneSeq++).padStart(5, "0").slice(-5)}`;
const digits = (s: string) => s.replace(/\D/g, "");
const ok = (r: { status: number; data: any }, what: string) => assert.equal(r.status, 200, `${what}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
const cnt = (sql: string, ...p: (string | number)[]) => Number(app.q1<{ n: number }>(sql, ...p)?.n ?? 0);
const audits = (action: string, entityId: string) => app.q("SELECT * FROM audit WHERE action = ? AND entity_id = ?", action, entityId);

// Tiny synthetic files.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64");
const CORRUPT = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256)).toString("base64");

interface Cg { name: string; relation?: string; phone: string }
async function onboard(actor: string, name: string, cgs: Cg[], extra: Record<string, unknown> = {}) {
  const phone = newPhone();
  const r = await app.api(actor, "POST", "/api/patients", { name, age: 60, sex: "F", phone, conditions: "Hypertension", address: "1 Test Street", caregivers: cgs.map((c) => ({ relation: "Daughter", ...c })), ...extra });
  return { r, phone, id: r.data?.id as string };
}
const userOf = (pid: string) => app.q1<{ user_id: string }>("SELECT user_id FROM patients WHERE id = ?", pid)!.user_id;
const cgsOf = (pid: string) => app.q<{ id: string; user_id: string; name: string; level: number; phone: string; relation: string; dashboard: number }>("SELECT * FROM caregivers WHERE patient_id = ? ORDER BY level", pid);

// A care plan for the visit form (POST /api/patients/:id/visits).
function fullPlan() {
  return {
    medications: [
      { key: "amlodipine", name: "Amlodipine", dose: "5 mg", times: ["08:00"] },
      { key: "metformin", name: "Metformin", dose: "500 mg", times: ["08:00", "20:00"], instructions: "after food" },
    ],
    monitoring: [{ key: "bp", times: ["08:00"] }, { key: "weight", times: ["07:00"] }],
    physio: [{ key: "walk", name: "Brisk walk", detail: "20 minutes", times: ["17:00"] }],
    lifestyle: [{ key: "salt", text: "Salt under 5 g a day" }],
    checkinTime: "21:00",
    watchSymptoms: ["breathless"],
    thresholds: { sysHigh: 150, diaHigh: 95 },
    escalation: {},
    fluid: { limitMl: 1500, checkTime: "20:00", lowOutputMl: 500, ratioLow: 0.5 },
    labs: { panel: "RFT + electrolytes", everyDays: 30 },
  };
}

// Playwright (global install) for page tests.
async function browserPage(userId: string) {
  const pw = await import("/opt/node-tools/node_modules/playwright/index.mjs" as string);
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "cc_user", value: userId, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  return { browser, page };
}

// ================================================================= §4 Patient onboarding and care circle
await app.clock.reset();
let onb1 = { id: "", phone: "", cg: [] as Cg[] };

await app.test("ONB-01", "Add a new patient", async () => {
  const cg: Cg[] = [{ name: "Asha Test", phone: newPhone() }, { name: "Bala Test", relation: "Son", phone: newPhone() }, { name: "Chitra Test", relation: "Niece", phone: newPhone() }];
  const three = await onboard("u_dr_rao", "Onb One", cg, { conditions: "Hypertension, Diabetes", address: "12 MG Road" });
  // The app caps the circle at two (primary + backup). Check that, then onboard with two.
  const threeRejected = three.r.status !== 200;
  const two = await onboard("u_dr_rao", "Onb One", cg.slice(0, 2), { conditions: "Hypertension, Diabetes", address: "12 MG Road" });
  ok(two.r, "onboard with 2 caregivers");
  onb1 = { id: two.id, phone: two.phone, cg: cg.slice(0, 2) };
  const p = app.q1<any>("SELECT * FROM patients WHERE id = ?", two.id);
  assert.ok(p, "patient row");
  assert.equal(p.name, "Onb One"); assert.equal(p.age, 60); assert.equal(p.sex, "F"); assert.equal(p.address, "12 MG Road"); assert.equal(p.doctor_id, "u_dr_rao");
  assert.match(p.conditions, /Diabetes/);
  const cgs = cgsOf(two.id);
  assert.deepEqual(cgs.map((c) => [c.name, c.level]), [["Asha Test", 1], ["Bala Test", 2]], "caregivers saved with levels");
  const dash = await app.api("u_dr_rao", "GET", "/api/dashboard");
  assert.ok(dash.data.patients.some((x: any) => x.id === two.id), "appears in Patients (dashboard)");
  assert.ok(audits("PATIENT_ONBOARDED", two.id).length === 1, "audit entry");
  if (threeRejected) throw new Error(`PLAN: the plan asks for caregivers L1–L3, but a care circle holds at most 2 by design (lib/types.ts:6 MAX_CAREGIVERS = 2; app/api/patients/route.ts:21). Sending 3 gave HTTP ${three.r.status} "${three.r.data?.error}". With 2 caregivers everything else passed: patient created with all fields, caregivers saved as levels 1–2, listed in Patients, PATIENT_ONBOARDED audited.`);
});

await app.test("ONB-02", "Consent requests sent on WhatsApp", async () => {
  if (!onb1.id) throw new Error("precondition: ONB-01 patient missing");
  const users = [userOf(onb1.id), ...cgsOf(onb1.id).map((c) => c.user_id)];
  for (const u of users) {
    const msgs = app.wa.since(u, 0);
    const consent = msgs.find((m) => /Reply \*YES\*/.test(m.body) && m.quick && JSON.parse(m.quick).join() === "YES,NO");
    assert.ok(consent, `${u} got a consent message with YES/NO buttons; got ${JSON.stringify(msgs.map((m) => m.body.slice(0, 60)))}`);
    assert.equal(app.q1<any>("SELECT status FROM consents WHERE patient_id = ? AND user_id = ?", onb1.id, u)?.status, "PENDING", `${u} consent PENDING`);
  }
  const contacts = await app.wa.contacts();
  assert.ok(JSON.stringify(contacts).includes(userOf(onb1.id)), "new patient listed in the simulator contacts");
});

await app.test("ONB-03", "Duplicate WhatsApp number", async () => {
  const before = cnt("SELECT COUNT(*) AS n FROM patients");
  const same = await app.api("u_dr_rao", "POST", "/api/patients", { name: "Dup Exact", phone: "+91 98860 20001", caregivers: [{ name: "X", phone: newPhone() }] });
  assert.notEqual(same.status, 200, "exact duplicate of Ramesh's number rejected");
  assert.match(String(same.data?.error), /already exists/i);
  // Same number written differently (no spaces): still the same WhatsApp number.
  const fmt = await app.api("u_dr_rao", "POST", "/api/patients", { name: "Dup Format", phone: "+919886020001", caregivers: [{ name: "Y", phone: newPhone() }] });
  const after = cnt("SELECT COUNT(*) AS n FROM patients");
  const sameDigits = app.q<{ id: string; phone: string }>("SELECT id, phone FROM patients").filter((p) => digits(p.phone) === "919886020001");
  assert.ok(fmt.status !== 200 && after === before,
    `BUG: the same number written without spaces ("+919886020001") was accepted (HTTP ${fmt.status}, new patient ${fmt.data?.id}); patients with digits 919886020001 now: ${sameDigits.map((p) => `${p.id} "${p.phone}"`).join(", ")}. onboardPatient checks duplicates with an exact string match: lib/engine.ts:1302 "SELECT 1 FROM patients WHERE phone = ?" (updatePatient in lib/records.ts:29 compares digits only, onboarding does not).`);
});

await app.test("ONB-04", "Required fields and validation", async () => {
  const cg = [{ name: "V Cg", phone: newPhone() }];
  const noName = await app.api("u_pa_priya", "POST", "/api/patients", { name: " ", phone: newPhone(), doctorId: "u_dr_rao", caregivers: cg });
  assert.equal(noName.status, 400); assert.match(noName.data.error, /Name is required/);
  const badPhone = await app.api("u_pa_priya", "POST", "/api/patients", { name: "Val Test", phone: "12ab", doctorId: "u_dr_rao", caregivers: cg });
  assert.equal(badPhone.status, 400); assert.match(badPhone.data.error, /valid WhatsApp number/);
  const badDoc = await app.api("u_pa_priya", "POST", "/api/patients", { name: "Val Test", phone: newPhone(), doctorId: "u_pa_priya", caregivers: cg });
  assert.equal(badDoc.status, 400); assert.match(badDoc.data.error, /treating doctor/);
  const tomorrow = dayKey((await app.clock.now()) + DAY);
  const futDob = await app.api("u_pa_priya", "POST", "/api/patients", { name: "Val Test", phone: newPhone(), doctorId: "u_dr_rao", caregivers: cg, baseline: { dob: tomorrow } });
  assert.equal(futDob.status, 400); assert.match(futDob.data.error, /Date of birth/);
  assert.equal(cnt("SELECT COUNT(*) AS n FROM patients WHERE name = 'Val Test'"), 0, "nothing created");
  // The page: messages shown and values kept.
  const { browser, page } = await browserPage("u_pa_priya");
  try {
    await page.goto(`${app.base}/patients/new`);
    await page.getByText("Onboard a patient").waitFor();
    const name = page.locator("input").first();
    const phone = page.locator("input").nth(1);
    await phone.fill("+91 12");
    await page.getByRole("button", { name: /Continue|Next/ }).click();
    await page.getByText("Enter the patient's full name").waitFor({ timeout: 5000 });
    await name.fill("Kept Name");
    await page.getByRole("button", { name: /Continue|Next/ }).click();
    await page.getByText(/WhatsApp number with country code/).waitFor({ timeout: 5000 });
    assert.equal(await name.inputValue(), "Kept Name", "name kept after error");
    assert.equal(await phone.inputValue(), "+91 12", "phone kept after error");
    const docSel = await page.locator("select").last().inputValue();
    assert.equal(docSel, "u_dr_dileep" < "u_dr_rao" ? docSel : docSel, "doctor select has a value");
    assert.ok(docSel, "a treating doctor is always selected on the page (the select can't be empty)");
  } finally { await browser.close(); }
});

let draftId = "";
await app.test("ONB-05", "Draft saved and resumed", async () => {
  const data = { f: { name: "Draft Person", age: "70", sex: "M", phone: "+91 94444 12121", address: "Draft Lane", doctorId: "u_dr_rao", language: "", hospitalId: "" }, cgs: [{ name: "Draft Cg", relation: "Son", phone: "+91 94444 13131", dashboard: true }], baseline: {} };
  const s = await app.api("u_pa_priya", "POST", "/api/drafts", { action: "save", id: null, step: 1, data });
  ok(s, "save draft"); draftId = s.data.id;
  const today = await app.api("u_pa_priya", "GET", "/api/pa-today");
  const task = today.data.tasks.find((t: any) => t.id === `draft:${draftId}`);
  assert.ok(task, "draft on Today");
  assert.equal(task.label, "Finish onboarding"); assert.equal(task.patient, "Draft Person"); assert.match(task.detail, /Draft at Care circle/);
  const g = await app.api("u_dr_rao", "GET", `/api/drafts?id=${draftId}`);
  ok(g, "get draft (other clinician)");
  assert.equal(g.data.draft.step, 1); assert.deepEqual(g.data.draft.data, data);
  assert.equal(cnt("SELECT COUNT(*) AS n FROM patients WHERE name = 'Draft Person'"), 0, "nothing created, nothing sent");
  const { browser, page } = await browserPage("u_pa_priya");
  try {
    await page.goto(`${app.base}${task.actions[0].href}`);
    await page.getByText("Care circle", { exact: false }).first().waitFor();
    await page.locator('input[value="Draft Cg"]').waitFor({ timeout: 8000 });
    assert.equal(await page.locator('input[value="+91 94444 13131"]').count(), 1, "caregiver phone restored");
  } finally { await browser.close(); }
});

await app.test("ONB-06", "Draft deleted", async () => {
  if (!draftId) throw new Error("precondition: ONB-05 draft missing");
  ok(await app.api("u_pa_priya", "POST", "/api/drafts", { action: "discard", id: draftId }), "discard");
  const g = await app.api("u_pa_priya", "GET", `/api/drafts?id=${draftId}`);
  assert.equal(g.status, 404);
  const list = await app.api("u_pa_priya", "GET", "/api/drafts");
  assert.ok(!list.data.drafts.some((d: any) => d.id === draftId), "gone from drafts");
  const today = await app.api("u_pa_priya", "GET", "/api/pa-today");
  assert.ok(!today.data.tasks.some((t: any) => t.id === `draft:${draftId}`), "gone from Today");
  assert.equal(audits("ONBOARDING_DRAFT_DISCARDED", draftId).length, 1, "audit entry");
});

let onb7 = "";
await app.test("ONB-07", "PA onboards for a doctor", async () => {
  const r = await onboard("u_pa_priya", "Pa Onboarded", [{ name: "Solo Cg", phone: newPhone() }], { doctorId: "u_dr_rao" });
  ok(r.r, "PA onboard"); onb7 = r.id;
  assert.equal(app.q1<any>("SELECT doctor_id FROM patients WHERE id = ?", r.id).doctor_id, "u_dr_rao");
  assert.equal((await app.api("u_dr_rao", "GET", `/api/patients/${r.id}`)).status, 200, "Rao can open");
  assert.equal((await app.api("u_dr_dileep", "GET", `/api/patients/${r.id}`)).status, 403, "Dileep cannot open");
  assert.ok((await app.api("u_dr_rao", "GET", "/api/dashboard")).data.patients.some((p: any) => p.id === r.id), "on Rao's list");
  assert.ok(!(await app.api("u_dr_dileep", "GET", "/api/dashboard")).data.patients.some((p: any) => p.id === r.id), "not on Dileep's list");
});

await app.test("ONB-08", "Edit patient profile", async () => {
  if (!onb1.id) throw new Error("precondition: ONB-01 patient missing");
  const np = newPhone();
  const r = await app.api("u_pa_priya", "PATCH", `/api/patients/${onb1.id}`, { address: "99 New Address", conditions: "Hypertension, CKD stage 3", phone: np });
  ok(r, "patch");
  const p = app.q1<any>("SELECT * FROM patients WHERE id = ?", onb1.id);
  assert.equal(p.address, "99 New Address"); assert.equal(p.conditions, "Hypertension, CKD stage 3"); assert.equal(p.phone, np);
  assert.equal(app.q1<any>("SELECT phone FROM users WHERE id = ?", userOf(onb1.id)).phone, np, "WhatsApp user's number updated (phoneOf() reads users.phone)");
  assert.equal(audits("PATIENT_UPDATED", onb1.id).length, 1, "audit entry");
  onb1.phone = np;
  // The simulator still reaches the patient on the same account.
  const m = app.mark();
  await app.wa.send(userOf(onb1.id), "YES");
  assert.ok(app.wa.since(userOf(onb1.id), m).some((x) => /Consent recorded/.test(x.body)), "replies still delivered to the patient");
});

await app.test("ONB-09", "Change care circle order", async () => {
  if (!onb1.id) throw new Error("precondition: ONB-01 patient missing");
  const [a, b] = cgsOf(onb1.id);
  const r = await app.api("u_pa_priya", "POST", `/api/patients/${onb1.id}/caregivers`, { caregivers: [{ id: b.id, name: b.name, relation: b.relation, phone: b.phone, dashboard: true }, { id: a.id, name: a.name, relation: a.relation, phone: a.phone, dashboard: true }] });
  ok(r, "swap");
  const after = cgsOf(onb1.id);
  assert.deepEqual(after.map((c) => [c.user_id, c.level]), [[b.user_id, 1], [a.user_id, 2]]);
  const m = app.mark();
  await app.wa.send(userOf(onb1.id), "BP 192/118");
  const esc = app.q1<any>("SELECT * FROM escalations WHERE patient_id = ? ORDER BY id DESC LIMIT 1", onb1.id);
  assert.ok(esc && esc.started_at >= (await app.clock.now()) - 5 * MIN, "alert raised");
  assert.ok(app.wa.since(b.user_id, m).some((x) => x.kind === "escalation"), "new L1 (previous L2) got the alert");
  assert.ok(!app.wa.since(a.user_id, m).some((x) => x.kind === "escalation"), "previous L1 (now L2) did not get it first");
  assert.equal(audits("CARE_CIRCLE_UPDATED", onb1.id).length, 1, "audit entry");
});

await app.test("ONB-10", "Add a caregiver later", async () => {
  if (!onb7) throw new Error("precondition: ONB-07 patient missing");
  const [solo] = cgsOf(onb7);
  const np = newPhone();
  const m = app.mark();
  const r = await app.api("u_pa_priya", "POST", `/api/patients/${onb7}/caregivers`, { caregivers: [{ id: solo.id, name: solo.name, relation: solo.relation, phone: solo.phone, dashboard: true }, { name: "Later Cg", relation: "Brother", phone: np, dashboard: true }] });
  ok(r, "add backup caregiver");
  const added = cgsOf(onb7).find((c) => c.name === "Later Cg")!;
  assert.ok(added && added.level === 2);
  const got = app.wa.since(added.user_id, m);
  assert.ok(got.some((x) => /Reply \*YES\*/.test(x.body) && x.quick?.includes("YES")), "new caregiver got a consent request");
  assert.equal(app.q1<any>("SELECT status FROM consents WHERE patient_id = ? AND user_id = ?", onb7, added.user_id)?.status, "PENDING");
  assert.ok(!app.wa.since(solo.user_id, m).some((x) => /Reply \*YES\*/.test(x.body)), "existing caregiver not asked again");
  // The plan's step: a new L3.
  const third = await app.api("u_pa_priya", "POST", `/api/patients/${onb7}/caregivers`, { caregivers: [...cgsOf(onb7).map((c) => ({ id: c.id, name: c.name, relation: c.relation, phone: c.phone, dashboard: true })), { name: "Third Cg", relation: "Friend", phone: newPhone(), dashboard: true }] });
  assert.equal(third.status, 409);
  throw new Error(`PLAN: the plan adds "a new L3", but a care circle holds at most 2 caregivers by design (lib/types.ts:6; lib/records.ts:73 setCareCircle): adding a third gave HTTP 409 "${third.data.error}". Adding a new backup (L2) later works: the new person got the WhatsApp consent request (consent PENDING), the existing caregiver was not re-asked.`);
});

await app.test("ONB-11", "Remove a caregiver", async () => {
  await app.clock.reset();
  // Seeded Ramesh has three levels (Lakshmi, Arjun, Kavya). Walk an urgent alert up to Kavya, then remove her.
  const m0 = app.mark();
  await app.wa.send("u_ramesh", "BP 192/118");
  const esc = app.q1<any>("SELECT * FROM escalations WHERE patient_id = 'p_ramesh' AND state = 'NOTIFIED' AND type = 'URGENT' ORDER BY id DESC LIMIT 1");
  assert.ok(esc, "urgent alert");
  for (let i = 0; i < 4 && (app.q1<any>("SELECT level FROM escalations WHERE id = ?", esc.id)!.level < 3); i++) await app.clock.advance(16);
  assert.equal(app.q1<any>("SELECT level FROM escalations WHERE id = ?", esc.id)!.level, 3, "alert reached L3 Kavya");
  assert.ok(app.wa.since("u_kavya", m0).some((x) => x.kind === "escalation"), "Kavya was alerted before removal");
  const cg = cgsOf("p_ramesh");
  const m1 = app.mark();
  const r = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/caregivers", { caregivers: cg.filter((c) => c.level < 3).map((c) => ({ id: c.id, name: c.name, relation: c.relation, phone: c.phone, dashboard: true })) });
  ok(r, "remove L3");
  assert.deepEqual(cgsOf("p_ramesh").map((c) => c.user_id), ["u_lakshmi", "u_arjun"]);
  assert.ok(app.wa.since("u_kavya", m1).some((x) => /removed from Ramesh Kumar's care circle/.test(x.body)), "Kavya told she was removed");
  // The open alert sitting at level 3 must not stall or go back to Kavya.
  await app.clock.advance(16);
  const st = app.q1<any>("SELECT state, level FROM escalations WHERE id = ?", esc.id)!;
  assert.notEqual(st.state, "NOTIFIED", `open alert at the removed level moved on (state ${st.state})`);
  await app.wa.send("u_ramesh", "BP 195/120");
  await app.clock.advance(16); await app.clock.advance(16); await app.clock.advance(16);
  const kv = app.wa.since("u_kavya", m1).filter((x) => x.kind === "escalation");
  assert.equal(kv.length, 0, `no further alerts to Kavya; got ${JSON.stringify(kv.map((x) => x.body.slice(0, 80)))}`);
  assert.equal((await app.api("u_kavya", "GET", "/api/patients/p_ramesh")).status, 403, "Kavya lost dashboard access");
});

await app.test("ONB-12", "Resend consent", async () => {
  await app.clock.reset();
  const r = await onboard("u_dr_rao", "Consent Resend", [{ name: "Res One", phone: newPhone() }, { name: "Res Two", phone: newPhone() }]);
  ok(r.r, "onboard");
  const pu = userOf(r.id); const [c1, c2] = cgsOf(r.id);
  let m = app.mark();
  const one = await app.api("u_pa_priya", "POST", `/api/patients/${r.id}/consent`, { userId: c1.user_id });
  ok(one, "resend one"); assert.equal(one.data.sent, 1);
  assert.equal(app.wa.since(c1.user_id, m).length, 1, "chosen caregiver got it again");
  assert.equal(app.wa.since(c2.user_id, m).length + app.wa.since(pu, m).length, 0, "nobody else did");
  await app.wa.send(c2.user_id, "YES"); // c2 is no longer pending
  m = app.mark();
  const all = await app.api("u_pa_priya", "POST", `/api/patients/${r.id}/consent`, {});
  ok(all, "resend all"); assert.equal(all.data.sent, 2);
  assert.equal(app.wa.since(pu, m).length, 1, "pending patient got it");
  assert.equal(app.wa.since(c1.user_id, m).length, 1, "pending caregiver got it");
  assert.equal(app.wa.since(c2.user_id, m).length, 0, "consented caregiver did not");
  assert.ok(app.wa.since(pu, m)[0].quick?.includes("YES"), "YES/NO buttons");
  assert.equal(audits("CONSENT_RESENT", r.id).length, 2, "audited");
});

await app.test("ONB-13", "Delete patient", async () => {
  const r = await onboard("u_dr_rao", "Delete Me", [{ name: "Del Cg", phone: newPhone() }]);
  ok(r.r, "onboard");
  const pu = userOf(r.id); const cgU = cgsOf(r.id)[0].user_id;
  await app.wa.send(pu, "YES");
  await app.wa.send(pu, "BP 130/80");
  await app.wa.media(pu, { base64: PNG, mime: "image/png", name: "report.png", filename: "report.png" } as any);
  assert.ok(cnt("SELECT COUNT(*) AS n FROM observations WHERE patient_id = ?", r.id) > 0, "has a reading");
  assert.ok(cnt("SELECT COUNT(*) AS n FROM patient_documents WHERE patient_id = ?", r.id) > 0, "has a document");
  const other = { obs: cnt("SELECT COUNT(*) AS n FROM observations WHERE patient_id = 'p_ramesh'"), msg: cnt("SELECT COUNT(*) AS n FROM messages WHERE patient_id = 'p_ramesh'"), docs: cnt("SELECT COUNT(*) AS n FROM patient_documents WHERE patient_id = 'p_ramesh'"), pts: cnt("SELECT COUNT(*) AS n FROM patients") };
  const wrong = await app.api("u_dr_rao", "DELETE", `/api/patients/${r.id}`, { confirmName: "Someone Else" });
  assert.equal(wrong.status, 400, "needs the name typed");
  const pa = await app.api("u_pa_priya", "DELETE", `/api/patients/${r.id}`, { confirmName: "Delete Me" });
  assert.equal(pa.status, 403, "PA can't delete");
  ok(await app.api("u_dr_rao", "DELETE", `/api/patients/${r.id}`, { confirmName: "delete me" }), "delete");
  for (const [t, col, v] of [["patients", "id", r.id], ["messages", "patient_id", r.id], ["observations", "patient_id", r.id], ["patient_documents", "patient_id", r.id], ["caregivers", "patient_id", r.id], ["consents", "patient_id", r.id], ["messages", "user_id", pu], ["users", "id", pu], ["users", "id", cgU]] as const)
    assert.equal(cnt(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, v), 0, `${t}.${col}=${v} removed`);
  assert.deepEqual({ obs: cnt("SELECT COUNT(*) AS n FROM observations WHERE patient_id = 'p_ramesh'"), msg: cnt("SELECT COUNT(*) AS n FROM messages WHERE patient_id = 'p_ramesh'"), docs: cnt("SELECT COUNT(*) AS n FROM patient_documents WHERE patient_id = 'p_ramesh'"), pts: cnt("SELECT COUNT(*) AS n FROM patients") }, { ...other, pts: other.pts - 1 }, "other patients untouched");
  assert.equal(audits("PATIENT_DELETED", r.id).length, 1, "audit entry");
});

await app.test("ONB-14", "Clear selected records", async () => {
  await app.clock.reset();
  const pid = "p_sunita";
  const snap = (p: string) => ({
    obs: cnt("SELECT COUNT(*) AS n FROM observations WHERE patient_id = ?", p), msg: cnt("SELECT COUNT(*) AS n FROM messages WHERE patient_id = ?", p),
    visits: cnt("SELECT COUNT(*) AS n FROM visits WHERE patient_id = ?", p), cgs: cnt("SELECT COUNT(*) AS n FROM caregivers WHERE patient_id = ?", p),
    consents: cnt("SELECT COUNT(*) AS n FROM consents WHERE patient_id = ?", p), team: cnt("SELECT COUNT(*) AS n FROM care_team WHERE patient_id = ?", p),
    esc: cnt("SELECT COUNT(*) AS n FROM escalations WHERE patient_id = ?", p), tasks: cnt("SELECT COUNT(*) AS n FROM tasks WHERE patient_id = ?", p),
  });
  const before = snap(pid); const ramesh = snap("p_ramesh");
  assert.ok(before.obs > 0 && before.msg > 0, "Sunita has readings and messages");
  const pa = await app.api("u_pa_priya", "POST", `/api/patients/${pid}/clear`, { parts: ["readings", "whatsapp"], confirmName: "Sunita Sharma" });
  assert.equal(pa.status, 403, "PA can't clear");
  const r = await app.api("u_dr_rao", "POST", `/api/patients/${pid}/clear`, { parts: ["readings", "whatsapp"], confirmName: "Sunita Sharma" });
  ok(r, "clear");
  const after = snap(pid);
  assert.equal(after.obs, 0, "readings cleared"); assert.equal(after.msg, 0, "WhatsApp cleared");
  for (const k of ["visits", "cgs", "consents", "team", "esc"] as const) assert.equal(after[k], before[k], `${k} kept`);
  assert.ok(app.q1("SELECT 1 FROM patients WHERE id = ?", pid), "profile kept");
  assert.deepEqual(snap("p_ramesh"), ramesh, "other patients untouched");
  assert.equal(app.q("SELECT * FROM audit WHERE entity_id = ? AND action LIKE '%CLEAR%'", pid).length >= 1, true, "audit entry");
});

// ================================================================= §5 Baseline and past records
await app.clock.reset();
let basePid = "";
await app.test("BASE-01", "Enter baseline by hand", async () => {
  const r = await onboard("u_pa_priya", "Base Line", [{ name: "Base Cg", phone: newPhone() }], { doctorId: "u_dr_rao" });
  ok(r.r, "onboard"); basePid = r.id;
  let today = await app.api("u_pa_priya", "GET", "/api/pa-today");
  assert.ok(today.data.tasks.some((t: any) => t.id === `baseline:${r.id}`), "Baseline missing task before");
  const now = await app.clock.now();
  const b = { dob: "1955-03-04", allergies: "Penicillin", currentMeds: [{ name: "Amlodipine", dose: "5 mg", frequency: "OD" }], labs: [{ marker: "creatinine", value: 1.3, date: dayKey(now - 30 * DAY) }] };
  ok(await app.api("u_pa_priya", "POST", `/api/patients/${r.id}/baseline`, b), "save baseline");
  const g = await app.api("u_pa_priya", "GET", `/api/patients/${r.id}/baseline`);
  assert.equal(g.data.baseline.dob, "1955-03-04"); assert.equal(g.data.baseline.allergies, "Penicillin");
  assert.equal(g.data.baseline.currentMeds[0].name, "Amlodipine"); assert.equal(g.data.baseline.labs[0].value, 1.3);
  assert.equal(cnt("SELECT COUNT(*) AS n FROM labs WHERE patient_id = ? AND source = 'BASELINE' AND marker = 'creatinine'", r.id), 1, "past lab in the lab record");
  today = await app.api("u_pa_priya", "GET", "/api/pa-today");
  assert.ok(!today.data.tasks.some((t: any) => t.id === `baseline:${r.id}`), "Baseline missing task gone");
  assert.equal(audits("BASELINE_CAPTURED", r.id).length, 1, "audited");
});

await app.test("BASE-02", "Baseline validation", async () => {
  const pid = basePid || "p_ramesh";
  const now = await app.clock.now();
  const r1 = await app.api("u_pa_priya", "POST", `/api/patients/${pid}/baseline`, { dob: dayKey(now + 2 * DAY) });
  assert.equal(r1.status, 400); assert.match(r1.data.error, /Date of birth/);
  const r2 = await app.api("u_pa_priya", "POST", `/api/patients/${pid}/baseline`, { labs: [{ marker: "creatinine", value: "", date: dayKey(now - DAY) }] });
  assert.equal(r2.status, 400); assert.match(r2.data.error, /Enter a value for Creatinine/);
  const r3 = await app.api("u_pa_priya", "POST", `/api/patients/${pid}/baseline`, { labs: [{ marker: "creatinine", value: 1.1, date: dayKey(now + 3 * DAY) }] });
  assert.equal(r3.status, 400); assert.match(r3.data.error, /valid report date/);
  if (basePid) assert.equal((await app.api("u_pa_priya", "GET", `/api/patients/${pid}/baseline`)).data.baseline.dob, "1955-03-04", "stored baseline unchanged");
});

await app.test("BASE-03", "Baseline from a document [AI off]", async () => {
  const r = await app.api("u_pa_priya", "POST", "/api/baseline/extract", { patientId: basePid, files: [{ base64: PDF, mime: "application/pdf", name: "discharge_summary.pdf" }] });
  assert.notEqual(r.status, 200);
  assert.match(String(r.data.error), /AI is not set up.*fill the form by hand/i, `clear message to type them; got ${JSON.stringify(r.data)}`);
  // AI-on path (fields pre-filled with warnings) not run: no AI key in this environment.
});

// Onboarding from past records on a fresh patient.
let recPid = "";
const onbGet = async () => (await app.api("u_pa_priya", "GET", `/api/patients/${recPid}/onboarding`)).data;
const onbPost = (user: string, body: Record<string, unknown>) => app.api(user, "POST", `/api/patients/${recPid}/onboarding`, body);
let docPng = 0, docPdf = 0;
await app.test("BASE-04", "Onboarding from past records: upload [AI off]", async () => {
  const r = await onboard("u_pa_priya", "Records Person", [{ name: "Rec Cg", phone: newPhone() }], { doctorId: "u_dr_rao", startOnboarding: true });
  ok(r.r, "onboard with startOnboarding"); recPid = r.id;
  assert.ok(r.r.data.onboarding, "onboarding opened");
  const u1 = await onbPost("u_pa_priya", { action: "upload", base64: PNG, mime: "image/png", name: "rx_2024.png" });
  ok(u1, "upload png"); docPng = u1.data.docId;
  const u2 = await onbPost("u_pa_priya", { action: "upload", base64: PDF, mime: "application/pdf", name: "lab_report_2024.pdf" });
  ok(u2, "upload pdf"); docPdf = u2.data.docId;
  const d = await until(async () => { const x = await onbGet(); return x.progress?.records.every((rr: any) => rr.state === "failed" || rr.state === "read") ? x : null; }, 8000);
  assert.ok(d, "each file processed");
  assert.equal(d.progress.total, 2);
  for (const rec of d.progress.records) {
    assert.equal(rec.state, "failed");
    assert.match(String(rec.error), /AI is not set up/, "clear reason shown for each record");
  }
  assert.equal(d.onboarding.status, "COLLECTING");
  // AI-on path (each file read and sorted into Clinical / Lab piles) not run: no AI key in this environment.
});

await app.test("BASE-05", "Move and remove a record", async () => {
  if (!recPid) throw new Error("precondition: BASE-04 patient missing");
  ok(await onbPost("u_pa_priya", { action: "move", docId: docPng, pile: "lab" }), "move");
  let d = await onbGet();
  let rec = d.progress.records.find((x: any) => x.id === docPng);
  assert.equal(rec.pile, "lab"); assert.equal(rec.pileBy, "user");
  // A re-read keeps the person's pile (AI off: the re-read fails, the pile must not change).
  ok(await onbPost("u_pa_priya", { action: "retry", docId: docPng }), "re-read");
  d = await until(async () => { const x = await onbGet(); const y = x.progress.records.find((z: any) => z.id === docPng); return y.state === "failed" ? x : null; }, 6000);
  rec = d.progress.records.find((x: any) => x.id === docPng);
  assert.equal(rec.pile, "lab", "person's choice kept after re-read"); assert.equal(rec.pileBy, "user");
  ok(await onbPost("u_pa_priya", { action: "remove", docId: docPdf }), "remove");
  d = await onbGet();
  assert.ok(!d.progress.records.some((x: any) => x.id === docPdf), "removed from the piles");
  assert.equal(cnt("SELECT COUNT(*) AS n FROM patient_documents WHERE id = ?", docPdf), 0, "document deleted");
  // Code check: lib/onboarding.ts readOne keeps pile when pile_by = 'user' (CASE WHEN pile_by = 'user' THEN pile ...). The AI re-read itself was not run (no AI key).
});

await app.test("BASE-06", "Unreadable file", async () => {
  if (!recPid) throw new Error("precondition: BASE-04 patient missing");
  const u = await onbPost("u_pa_priya", { action: "upload", base64: CORRUPT, mime: "image/png", name: "blank_scan.png" });
  ok(u, "upload corrupt");
  let d = await until(async () => { const x = await onbGet(); return x.progress.records.find((z: any) => z.id === u.data.docId)?.state === "failed" ? x : null; }, 6000);
  assert.ok(d, "read error shown");
  assert.ok(d.progress.failed >= 1);
  const rt = await onbPost("u_pa_priya", { action: "retry", docId: u.data.docId });
  ok(rt, "Retry available and accepted");
  d = await until(async () => { const x = await onbGet(); return x.progress.records.find((z: any) => z.id === u.data.docId)?.state === "failed" ? x : null; }, 6000);
  assert.ok(d, "after retry the record shows its read state again");
  // AI off: the error text is "AI is not set up…" rather than an unreadable-image message; the AI read of a corrupt image was not run.
});

let labDate = "";
await app.test("BASE-07", "Typed record", async () => {
  if (!recPid) throw new Error("precondition: BASE-04 patient missing");
  labDate = dayKey((await app.clock.now()) - 40 * DAY);
  const r = await onbPost("u_pa_priya", { action: "type", date: labDate, kind: "lab", values: [{ test: "Creatinine", value: "1.4", unit: "mg/dL" }, { test: "Potassium", value: "4.6", unit: "mmol/L" }, { test: "Urine albumin", value: "trace" }] });
  ok(r, "typed lab record");
  const d = await until(async () => { const x = await onbGet(); return x.onboarding.status === "REVIEW" && x.draft ? x : null; }, 8000);
  assert.ok(d, `draft built after the typed record; status ${(await onbGet()).onboarding.status}`);
  const rec = d.progress.records.find((x: any) => x.id === r.data.docId);
  assert.ok(rec, "typed record listed with the uploads"); assert.equal(rec.state, "read"); assert.equal(rec.pile, "lab");
  assert.ok(d.draft.labs.some((l: any) => l.marker === "creatinine" && l.value === 1.4 && l.date === labDate && l.sources.includes(r.data.docId)), "its values in the draft, cited like an upload");
  assert.ok(d.draft.texts.some((t: any) => /albumin/i.test(t.test)), "non-numeric result kept as text");
});

await app.test("BASE-08", "Build history draft [AI off]", async () => {
  if (!recPid) throw new Error("precondition: BASE-04 patient missing");
  ok(await onbPost("u_pa_priya", { action: "rebuild" }), "build");
  const d = await until(async () => { const x = await onbGet(); return x.onboarding.status === "REVIEW" && x.draft && !x.progress.building ? x : null; }, 10000);
  assert.ok(d, "draft history created");
  assert.ok(d.draft.summary && "conditions" in d.draft.summary && "medicines" in d.draft.summary, "history sections present");
  assert.ok(d.draft.labs.length >= 2, "labs in the draft");
  assert.ok(d.open && typeof d.open.points === "number", `open items listed: ${JSON.stringify(d.open)}`);
  // AI off: conditions and medicines come only from records the AI reads; the typed lab values need no AI. AI-on path not run.
});

let condRow: any = null;
await app.test("BASE-09", "Edit draft and send to doctor", async () => {
  if (!recPid) throw new Error("precondition: BASE-04 patient missing");
  const d = await onbGet();
  condRow = { name: "Hypertension", diagnosed: "2015", status: "controlled", treatment: "Amlodipine 5 mg", advice: "", sources: [] };
  const summary = { ...d.draft.summary, conditions: [condRow], medicines: [{ name: "Amlodipine", dose: "5 mg OD", indication: "BP", started: "2015", prescriber: "", sources: [] }] };
  ok(await onbPost("u_pa_priya", { action: "save", edits: { summary } }), "save edits");
  const d2 = await onbGet();
  assert.equal(d2.draft.summary.conditions[0].name, "Hypertension", "edit saved");
  ok(await onbPost("u_pa_priya", { action: "send" }), "send");
  const d3 = await onbGet();
  assert.equal(d3.onboarding.status, "SENT");
  const docTasks = await app.api("u_dr_rao", "GET", "/api/onboardings");
  assert.ok(docTasks.data.tasks.some((t: any) => t.patientId === recPid && t.status === "SENT"), "doctor sees it on Today");
  const other = await app.api("u_dr_dileep", "GET", "/api/onboardings");
  assert.ok(!other.data.tasks.some((t: any) => t.patientId === recPid), "not on another doctor's Today");
});

await app.test("BASE-10", "Doctor sends it back", async () => {
  if (!recPid) throw new Error("precondition: BASE-04 patient missing");
  ok(await onbPost("u_dr_rao", { action: "return", note: "Please add the 2023 echo report" }), "send back");
  const d = await onbGet();
  assert.equal(d.onboarding.returnNote, "Please add the 2023 echo report", "note stored");
  const pa = await app.api("u_pa_priya", "GET", "/api/onboardings");
  const t = pa.data.tasks.find((x: any) => x.patientId === recPid);
  assert.ok(t && t.note === "Please add the 2023 echo report", "assistant sees the note on Today");
  if (d.onboarding.status !== "COLLECTING")
    throw new Error(`PLAN: the note reaches the assistant (Today task note "${t.note}"), but the status becomes ${d.onboarding.status}, not COLLECTING, by design (lib/onboarding.ts:719 sendBack sets status 'RETURNED'; adding a record then moves it to COLLECTING).`);
});

await app.test("BASE-11", "Doctor confirms history", async () => {
  if (!recPid) throw new Error("precondition: BASE-04 patient missing");
  // A value already on the record for the same test and day must not be entered twice.
  ok(await app.api("u_pa_priya", "POST", `/api/patients/${recPid}/baseline`, { labs: [{ marker: "creatinine", value: 1.4, date: labDate }] }), "baseline lab same day");
  // The same value typed twice (two records) is one value in the draft.
  ok(await onbPost("u_pa_priya", { action: "type", date: labDate, kind: "lab", values: [{ test: "Potassium", value: "4.6", unit: "mmol/L" }] }), "duplicate typed record");
  await until(async () => (await onbGet()).onboarding.status === "REVIEW", 8000);
  ok(await onbPost("u_pa_priya", { action: "send" }), "send again");
  const pa = await onbPost("u_pa_priya", { action: "confirm" });
  assert.equal(pa.status, 400, "assistant can't confirm");
  const c = await onbPost("u_dr_rao", { action: "confirm" });
  ok(c, "confirm");
  const d = await onbGet();
  assert.equal(d.onboarding.status, "CONFIRMED");
  const day0 = Date.parse(`${labDate}T00:00:00+05:30`);
  const n = (m: string) => cnt("SELECT COUNT(*) AS n FROM labs WHERE patient_id = ? AND marker = ? AND taken_at >= ? AND taken_at < ?", recPid, m, day0, day0 + DAY);
  assert.equal(n("creatinine"), 1, "creatinine entered once (baseline value kept, not duplicated)");
  assert.equal(n("potassium"), 1, "potassium entered once (two records, one value)");
  assert.equal(d.versions.length, 1, "history versions shown");
  assert.ok(audits("ONBOARDING_CONFIRMED", recPid).length === 1, "audited");
});

await app.test("BASE-12", "Update a confirmed history", async () => {
  if (!recPid) throw new Error("precondition: BASE-04 patient missing");
  const v1 = (await onbGet()).versions[0];
  ok(await onbPost("u_pa_priya", { action: "update" }), "start update");
  const later = dayKey((await app.clock.now()) - 5 * DAY);
  ok(await onbPost("u_pa_priya", { action: "type", date: later, kind: "lab", values: [{ test: "HbA1c", value: "7.9", unit: "%" }] }), "add a record");
  let d = await until(async () => { const x = await onbGet(); return x.onboarding.status === "REVIEW" && x.draft?.labs.some((l: any) => l.marker === "hba1c") ? x : null; }, 8000);
  assert.ok(d, "update draft includes the new record");
  assert.equal(d.isUpdate, true);
  // Remove the condition entered in the first version.
  ok(await onbPost("u_pa_priya", { action: "save", edits: { summary: { ...d.draft.summary, conditions: [] } } }), "remove a condition");
  d = await onbGet();
  assert.ok(d.removed.some((x: any) => /Hypertension/.test(x.text)), `removed item shown as removed: ${JSON.stringify(d.removed)}`);
  ok(await onbPost("u_pa_priya", { action: "send" }), "send");
  ok(await onbPost("u_dr_rao", { action: "confirm" }), "confirm update");
  d = await onbGet();
  assert.equal(d.versions.length, 2, "new version");
  const old = await app.api("u_pa_priya", "GET", `/api/patients/${recPid}/onboarding?version=${v1.id}`);
  ok(old, "earlier version readable");
  assert.ok(old.data.summary.conditions.some((c: any) => c.name === "Hypertension"), "earlier version kept");
  assert.equal(cnt("SELECT COUNT(*) AS n FROM labs WHERE patient_id = ? AND marker = 'hba1c'", recPid), 1, "new lab filed");
});

// ================================================================= §6 Visits and care plans
await app.clock.reset();
let visPid = "", visPlanMsg = "";
await app.test("VIS-01", "Record Visit 1 and start the plan", async () => {
  const r = await onboard("u_dr_rao", "Visit Person", [{ name: "Vis Lone", phone: newPhone() }, { name: "Vis Two", phone: newPhone() }]);
  ok(r.r, "onboard"); visPid = r.id;
  const pu = userOf(visPid); const cgs = cgsOf(visPid);
  await app.wa.send(pu, "YES");
  const now = await app.clock.now();
  const next = atIST(now + 28 * DAY, 11);
  const m = app.mark();
  const pa = await app.api("u_pa_priya", "POST", `/api/patients/${visPid}/visits`, { vitals: { sys: 150, dia: 92 }, diagnosis: "Hypertension", notes: "x", plan: fullPlan(), next_visit_at: next });
  assert.equal(pa.status, 403, "PA cannot record the visit");
  const v = await app.api("u_dr_rao", "POST", `/api/patients/${visPid}/visits`, { vitals: { sys: 150, dia: 92, weight: 70, hr: 80 }, diagnosis: "Hypertension, type 2 diabetes", notes: "Start treatment", plan: fullPlan(), next_visit_at: next, start_plan: true });
  ok(v, "record visit");
  assert.equal(v.data.paused, false, "plan active");
  const row = app.q1<any>("SELECT * FROM visits WHERE id = ?", v.data.id);
  assert.ok(row && JSON.parse(row.plan).medications.length === 2, "visit saved with plan");
  const pmsg = app.wa.since(pu, m).find((x) => /has set your care plan/.test(x.body));
  assert.ok(pmsg, "patient got the plan on WhatsApp"); visPlanMsg = pmsg!.body;
  for (const c of cgs) assert.ok(app.wa.since(c.user_id, m).some((x) => /care plan was updated/.test(x.body)), `${c.name} got an update`);
  assert.ok(cnt("SELECT COUNT(*) AS n FROM tasks WHERE patient_id = ? AND status = 'PENDING' AND due_at > ?", visPid, now) > 0, "reminders scheduled");
  assert.equal(audits("VISIT_RECORDED", v.data.id).length, 1, "audited");
  // Reminders begin: move to the next medicine time.
  const m2 = app.mark();
  const firstDue = app.q1<any>("SELECT MIN(due_at) AS d FROM tasks WHERE patient_id = ? AND status = 'PENDING'", visPid).d;
  await advanceTo(firstDue + MIN);
  assert.ok(app.wa.since(pu, m2).some((x) => x.kind === "prompt" || x.kind === "reminder"), `a reminder was sent at the first due time; got ${JSON.stringify(app.wa.since(pu, m2).map((x) => [x.kind, x.body.slice(0, 50)]))}`);
});

await app.test("VIS-02", "Plan message content", async () => {
  if (!visPlanMsg) throw new Error("precondition: VIS-01 plan message missing");
  const b = visPlanMsg;
  for (const s of ["Amlodipine", "5 mg", "Metformin", "500 mg", "after food", "Blood pressure", "Weight", "Brisk walk", "20 minutes", "Salt under 5 g a day", "Next visit:"]) assert.ok(b.includes(s), `plan message includes "${s}"`);
  assert.match(b, /8:00\s*am/i, "times shown"); assert.match(b, /8:00\s*pm/i, "evening time shown");
  const stored = JSON.parse(app.q1<any>("SELECT plan FROM visits WHERE patient_id = ? ORDER BY created_at DESC LIMIT 1", visPid).plan);
  const problems: string[] = [];
  if (!b.includes("Fluid limit")) problems.push(`BUG: the fluid limit (plan.fluid {limitMl:1500}) and the lab plan (plan.labs) sent by the visit form are dropped: the stored plan has fluid=${JSON.stringify(stored.fluid)} labs=${JSON.stringify(stored.labs)} template=${JSON.stringify(stored.template)}, so the message has no "Fluid limit" / "Blood tests" lines and no fluid tracking starts. validPlan() in app/api/patients/[id]/visits/route.ts:13-42 rebuilds the plan without copying raw.fluid, raw.labs or raw.template (the visit page sends them: app/patients/[id]/visit/page.tsx:297-308, "Apply kidney template").`);
  if (!/In short/.test(b)) problems.push(`PLAN: no "In short" text — that summary only comes from the plan builder's Send step (plan-draft/route.ts:76 familySummary); the visit form has no family summary (visits/route.ts:66), see VIS-09.`);
  if (problems.length) throw new Error(problems.join(" Also "));
});

await app.test("VIS-03", "Save visit without starting plan", async () => {
  await app.clock.reset();
  const now = await app.clock.now();
  const pendingBefore = cnt("SELECT COUNT(*) AS n FROM tasks WHERE patient_id = 'p_ramesh' AND status = 'PENDING'");
  assert.ok(pendingBefore > 0, "Ramesh has a running schedule");
  const m = app.mark();
  const v = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/visits", { vitals: { sys: 140, dia: 88 }, diagnosis: "HF", notes: "", plan: fullPlan(), next_visit_at: atIST(now + 30 * DAY, 11), start_plan: false });
  ok(v, "save visit without starting");
  assert.equal(v.data.paused, true);
  assert.ok(app.q1("SELECT 1 FROM visits WHERE id = ?", v.data.id), "visit saved");
  assert.equal(cnt("SELECT COUNT(*) AS n FROM tasks WHERE patient_id = 'p_ramesh' AND status = 'PENDING'"), 0, "old schedule stopped");
  assert.ok(!app.wa.since("u_ramesh", m).some((x) => /care plan/.test(x.body)), "no plan sent");
  const m2 = app.mark();
  await app.clock.advance(6 * 60);
  const rem = app.wa.since("u_ramesh", m2).filter((x) => x.kind === "prompt" || x.kind === "reminder");
  assert.equal(rem.length, 0, `no reminders while not started; got ${JSON.stringify(rem.map((x) => x.body.slice(0, 60)))}`);
  assert.equal(cnt("SELECT COUNT(*) AS n FROM tasks WHERE patient_id = 'p_ramesh' AND status = 'PENDING'"), 0, "no new tasks generated");
});

let pastPid = "", pastVisitAt = 0;
await app.test("VIS-05", "Past visit from records", async () => {
  await app.clock.reset();
  const r = await onboard("u_dr_rao", "Past Visit", [{ name: "Past Cg", phone: newPhone() }]);
  ok(r.r, "onboard"); pastPid = r.id;
  const now = await app.clock.now();
  const date = dayKey(now - 5 * DAY);
  const m = app.mark();
  const v = await app.api("u_dr_rao", "POST", `/api/patients/${pastPid}/visits`, { vitals: {}, diagnosis: "Hypertension", notes: "from records", plan: fullPlan(), next_visit_at: null, visit_date: date, visit_time: "10:30" });
  ok(v, "past visit");
  assert.equal(v.data.pastDated, true);
  const row = app.q1<any>("SELECT visit_at FROM visits WHERE id = ?", v.data.id);
  pastVisitAt = row.visit_at;
  assert.equal(dayKey(row.visit_at), date, "saved at that date");
  const sent = [userOf(pastPid), ...cgsOf(pastPid).map((c) => c.user_id)].flatMap((u) => app.wa.since(u, m));
  assert.equal(sent.length, 0, `no WhatsApp sent; got ${JSON.stringify(sent.map((x) => x.body.slice(0, 60)))}`);
  const fut = await app.api("u_dr_rao", "POST", `/api/patients/${pastPid}/visits`, { vitals: {}, diagnosis: "x", notes: "", plan: fullPlan(), next_visit_at: null, visit_date: dayKey(now + DAY) });
  assert.equal(fut.status, 400); assert.match(fut.data.error, /future/);
});

await app.test("VIS-04", "Start care plan later", async () => {
  if (!pastPid) throw new Error("precondition: VIS-05 patient missing");
  const t0 = await app.clock.now();
  const m = app.mark();
  const r = await app.api("u_pa_priya", "POST", `/api/patients/${pastPid}/care-plan`, { action: "start" });
  ok(r, "start care plan");
  const tasks = app.q<any>("SELECT due_at, status FROM tasks WHERE patient_id = ?", pastPid);
  assert.ok(tasks.filter((x) => x.status === "PENDING").length > 0, "reminders begin");
  const early = tasks.filter((x) => x.due_at < t0 - MIN && x.due_at >= pastVisitAt);
  assert.equal(early.length, 0, `days since the visit stay empty; found ${early.length} tasks between the visit and now`);
  assert.ok(app.wa.since(userOf(pastPid), m).some((x) => /care plan after your visit on/.test(x.body)), "plan sent, naming the visit date");
  const again = await app.api("u_pa_priya", "POST", `/api/patients/${pastPid}/care-plan`, { action: "start" });
  assert.equal(again.status, 400, "can't start twice");
});

await app.test("VIS-06", "Visit 2 changes the plan", async () => {
  await app.clock.reset();
  const now = await app.clock.now();
  const v1 = app.q1<any>("SELECT * FROM visits WHERE patient_id = 'p_ramesh' ORDER BY visit_at DESC LIMIT 1");
  const plan = JSON.parse(v1.plan);
  plan.medications = plan.medications.filter((x: any) => x.key !== "atorvastatin");
  plan.medications.find((x: any) => x.key === "furosemide").dose = "40 mg";
  const m = app.mark();
  const v = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/visits", { vitals: { sys: 138, dia: 84, weight: 71 }, diagnosis: v1.diagnosis, notes: "Stop statin, increase furosemide", plan, next_visit_at: atIST(now + 28 * DAY, 11), start_plan: true });
  ok(v, "visit 2");
  const fut = app.q<any>("SELECT * FROM tasks WHERE patient_id = 'p_ramesh' AND status = 'PENDING' AND due_at > ?", now);
  assert.ok(fut.length > 0, "new reminders");
  assert.ok(fut.every((x) => x.visit_id === v.data.id), "old future reminders replaced by the new visit's");
  assert.ok(!fut.some((x) => x.item_key === "med:atorvastatin"), "stopped medicine has no reminders");
  const furo = fut.filter((x) => x.item_key === "med:furosemide");
  assert.ok(furo.length && furo.every((x) => /40 mg/.test(x.label)), `new dose in reminders: ${JSON.stringify(furo.map((x) => x.label))}`);
  const msg = app.wa.since("u_ramesh", m).find((x) => /care plan/.test(x.body))?.body ?? "";
  assert.ok(msg.includes("Furosemide 40 mg"), "new dose in the plan message");
  const told = /atorvastatin/i.test(msg) && /(stop|was 20 mg|changed|increase)/i.test(msg);
  if (!told) throw new Error(`PLAN: reminders follow the new plan (old future tasks replaced, no Atorvastatin tasks, Furosemide tasks at 40 mg), but the patient's WhatsApp only lists the new plan; it doesn't say that Atorvastatin was stopped or that Furosemide went from 20 to 40 mg. The visit form's message (lib/engine.ts:1221 announcePlan) has no change list; changes are spelled out only in the plan builder's "In short" (lib/aftervisit.ts ruleSummary). Message: ${JSON.stringify(msg.slice(0, 300))}`);
});

// A built plan-builder draft cannot be made without AI (sources are read and merged by AI), so tests VIS-07/09/10
// write one directly into plan_drafts as setup. Everything after that goes through the API / page.
function injectDraft(pid: string, meds: { name: string; dose: string; schedule: string; change: string; was?: string | null }[], t: number) {
  const built = {
    at: t,
    medications: meds.map((x, i) => ({ id: `m${i}`, name: x.name, dose: x.dose, schedule: x.schedule, durationDays: null, instructions: "", purpose: "", change: x.change, was: x.was ?? null, sources: ["talk"], quote: null, confidence: "high" })),
    monitoring: [{ id: "mo0", key: "bp", times: ["08:00"], alert: "", limits: {}, sources: ["talk"], quote: null, confidence: "high" }],
    advice: [{ id: "a0", text: "Walk 20 minutes a day", sources: ["talk"], quote: null, confidence: "high" }],
    warningSigns: { keys: [], text: "breathlessness", sources: ["talk"] },
    answers: [], labs: null, nextVisit: null, diagnosis: "Hypertension", note: "BP not controlled on current dose.", conflicts: [],
  };
  app.exec("INSERT INTO plan_drafts(patient_id, data, updated_at) VALUES(?,?,?) ON CONFLICT(patient_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at", pid, JSON.stringify({ sources: [{ id: "s1", kind: "dictation", at: t, label: "Dictation", text: "synthetic" }], built }), t);
}

await app.test("VIS-07", "Plan builder draft is kept", async () => {
  await app.clock.reset();
  const t = await app.clock.now();
  injectDraft("p_sunita", [{ name: "Telmisartan", dose: "40 mg", schedule: "1-0-0", change: "new" }, { name: "Paracetamol", dose: "650 mg", schedule: "SOS", change: "same" }], t);
  // "Fill" the builder: edit a medicine through the API the page uses.
  ok(await app.api("u_dr_rao", "POST", "/api/patients/p_sunita/plan-draft", { action: "editMed", id: "m0", patch: { dose: "80 mg" } }), "edit");
  const { browser, page } = await browserPage("u_dr_rao");
  try {
    await page.goto(`${app.base}/patients/p_sunita`);
    await page.goto(`${app.base}/patients/p_sunita/plan`); // leave and come back
    await page.getByText("Telmisartan").first().waitFor({ timeout: 10000 });
    const html = await page.content();
    assert.ok(/80 mg/.test(html), "edited dose restored on the page");
    assert.ok(/Paracetamol/.test(html), "rest of the draft restored");
  } finally { await browser.close(); }
  const g = await app.api("u_pa_priya", "GET", "/api/patients/p_sunita/plan-draft");
  assert.equal(g.data.draft.built.medications[0].dose, "80 mg", "draft stored on the server (any clinician sees it)");
  // Note: the draft itself was written into plan_drafts as setup, because adding sources and building need AI.
});

await app.test("VIS-08", "Dictate a visit [AI off]", async () => {
  const audio = Buffer.from("RIFF0000WAVEfmt synthetic").toString("base64");
  const r = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/plan-draft", { action: "source", kind: "dictation", base64: audio, mime: "audio/wav", seconds: 3 });
  assert.equal(r.status, 400);
  assert.match(String(r.data.error), /AI|not configured|not set up/i, `message that dictation needs AI; got ${JSON.stringify(r.data)}`);
  const d = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/dictate", { base64: audio, mime: "audio/wav" });
  ok(d, "dictate route");
  assert.equal(d.data.text, ""); assert.match(String(d.data.aiError), /AI|configured/i, `dictate route reports AI missing: ${JSON.stringify(d.data)}`);
  // AI-on path (fields drafted for review) not run: no AI key.
});

await app.test("VIS-09", "\"In short\" for the family [AI off]", async () => {
  await app.clock.reset();
  const t = await app.clock.now();
  injectDraft("p_ramesh", [
    { name: "Telmisartan", dose: "80 mg", schedule: "1-0-0", change: "changed", was: "40 mg" },
    { name: "Atorvastatin", dose: "20 mg", schedule: "0-0-1", change: "stopped" },
    { name: "Metoprolol succinate", dose: "25 mg", schedule: "1-0-0", change: "same" },
  ], t);
  const fs = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/plan-draft", { action: "familySummary", nextVisit: null });
  ok(fs, "family summary");
  assert.equal(fs.data.via, "rules");
  assert.match(fs.data.text, /Telmisartan is now 80 mg/); assert.match(fs.data.text, /Stop Atorvastatin/);
  assert.ok(!/Metformin|Furosemide/.test(fs.data.text), "only from the reviewed draft, not the old plan");
  const edited = "Appa's BP tablet is doubled. Statin stopped. EDITED-BY-DOCTOR";
  const m = app.mark();
  const s = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/plan-draft", { action: "send", familySummary: edited, nextVisit: dayKey(t + 30 * DAY) });
  ok(s, "send");
  const pm = app.wa.since("u_ramesh", m).find((x) => /care plan/.test(x.body))?.body ?? "";
  assert.ok(pm.includes(`In short:\n${edited}`), `patient got the edited text: ${pm.slice(-200)}`);
  assert.ok(!pm.includes(fs.data.text), "the unedited draft text did not go out");
  assert.ok(app.wa.since("u_lakshmi", m).some((x) => x.body.includes(edited)), "family got the edited text");
  // AI-on path (AI-drafted summary) not run: no AI key.
});

await app.test("VIS-10", "Suggested next visit", async () => {
  await app.clock.reset();
  const t = await app.clock.now();
  const r = await onboard("u_dr_rao", "Stable Person", [{ name: "St Cg", phone: newPhone() }]);
  ok(r.r, "onboard");
  ok(await app.api("u_dr_rao", "POST", `/api/patients/${r.id}/visits`, { vitals: {}, diagnosis: "HTN", notes: "", plan: fullPlan(), next_visit_at: null, visit_date: dayKey(t - 30 * DAY) }), "earlier visit");
  injectDraft(r.id, [{ name: "Amlodipine", dose: "5 mg", schedule: "1-0-0", change: "same" }], t);
  injectDraft("p_ramesh", [
    { name: "Telmisartan", dose: "80 mg", schedule: "1-0-0", change: "changed", was: "40 mg" },
    { name: "Furosemide", dose: "40 mg", schedule: "1-0-0", change: "changed", was: "20 mg" },
    { name: "Spironolactone", dose: "25 mg", schedule: "1-0-0", change: "new" },
  ], t);
  const st = (await app.api("u_dr_rao", "POST", `/api/patients/${r.id}/plan-draft`, { action: "familySummary" })).data.suggest;
  const busy = (await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/plan-draft", { action: "familySummary" })).data.suggest;
  assert.ok(st && busy, "suggestions returned");
  assert.ok(st.days > busy.days, `stable later (${st.days} d) than after changes/alerts (${busy.days} d)`);
  assert.match(st.why, /Stable/); assert.match(busy.why, /Sooner/);
  assert.equal(st.date, dayKey(t + st.days * DAY));
});

await app.test("VIS-11", "Compare visits", async () => {
  await app.clock.reset();
  const now = await app.clock.now();
  const v1 = app.q1<any>("SELECT * FROM visits WHERE patient_id = 'p_ramesh' ORDER BY visit_at LIMIT 1");
  const plan = JSON.parse(v1.plan);
  plan.medications = plan.medications.filter((x: any) => x.key !== "atorvastatin");
  plan.medications.find((x: any) => x.key === "furosemide").dose = "40 mg";
  const v2 = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/visits", { vitals: { sys: 132, dia: 82, weight: 70 }, diagnosis: v1.diagnosis, notes: "", plan, next_visit_at: atIST(now + 28 * DAY, 11) });
  ok(v2, "visit 2 today");
  const c = await app.api("u_dr_rao", "GET", `/api/patients/p_ramesh/compare?a=${v1.id}&b=${v2.data.id}`);
  ok(c, "compare");
  const meds = c.data.diff.meds;
  assert.ok(meds.some((x: any) => /Atorvastatin/.test(x.name) && x.change === "removed"), "stopped medicine shown");
  assert.ok(meds.some((x: any) => /Furosemide/.test(x.name) && x.change === "changed"), "dose change shown");
  assert.ok(c.data.diff.vitals.some((x: any) => x.key === "bp" && x.after === "132/82"), "vitals compared");
  const iv = JSON.stringify(c.data.interval);
  assert.ok(/bp|Blood pressure/i.test(iv) && c.data.interval.overall, "what was logged on WhatsApp in between");
  const { browser, page } = await browserPage("u_dr_rao");
  try {
    await page.goto(`${app.base}/patients/p_ramesh/compare?a=${v1.id}&b=${v2.data.id}`);
    await page.getByText(/Atorvastatin/).first().waitFor({ timeout: 10000 });
  } finally { await browser.close(); }
});

await app.test("VIS-12", "Prepare visit", async () => {
  await app.clock.reset();
  const t = await app.clock.now();
  const v = app.q1<any>("SELECT next_visit_at FROM visits WHERE patient_id = 'p_ramesh' ORDER BY visit_at DESC LIMIT 1");
  const rel = Math.round((dayStart(v.next_visit_at) - dayStart(t)) / DAY);
  if (rel < 0 || rel > 7) notRun(`Ramesh's seeded next visit is ${rel} days away, outside the Today window`);
  const today = await app.api("u_pa_priya", "GET", "/api/pa-today");
  const task = today.data.tasks.find((x: any) => x.id === "visit:p_ramesh");
  assert.ok(task, "Prepare visit task on Today");
  // Wait for the background brief (rules summary with AI off).
  await until(async () => (await app.api("u_pa_priya", "GET", "/api/patients/p_ramesh/ai-summary?stored=1")).data?.summary, 8000);
  const { browser, page } = await browserPage("u_pa_priya");
  try {
    await page.goto(`${app.base}${task.actions[0].href}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    const text = await page.locator("main").innerText();
    assert.ok(/brief/i.test(text), "pre-visit brief shown");
    assert.ok(/since (the )?last visit|since visit|readings/i.test(text), "readings since last visit shown");
    assert.ok(/attendance|vitals|flag|open|to do/i.test(text), "open items shown");
  } finally { await browser.close(); }
});

await app.test("VIS-13", "Next visit date picker", async () => {
  const t = await app.clock.now();
  const np = await onboard("u_dr_rao", "Next Visit Person", [{ name: "Nv Cg", phone: newPhone() }]);
  ok(np.r, "onboard"); visPid = np.id;
  ok(await app.api("u_dr_rao", "POST", `/api/patients/${visPid}/visits`, { vitals: {}, diagnosis: "Hypertension", notes: "", plan: fullPlan(), next_visit_at: atIST(t + 28 * DAY, 11) }), "first visit (default 4 weeks)");
  const next = atIST(t + 21 * DAY, 11);
  const v = await app.api("u_dr_rao", "POST", `/api/patients/${visPid}/visits`, { vitals: {}, diagnosis: "Hypertension", notes: "", plan: fullPlan(), next_visit_at: next });
  ok(v, "visit with next date");
  const chart = await app.api("u_dr_rao", "GET", `/api/patients/${visPid}`);
  assert.equal(chart.data.current.next_visit_at, next, "on the chart");
  const cg = cgsOf(visPid)[0].user_id;
  const fam = await app.api(cg, "GET", `/api/patients/${visPid}/today`);
  ok(fam, "family view");
  assert.equal(fam.data.nextVisit, next, "in the family's view");
  // Note: the date is picked on the visit form when the visit is saved; there is no separate control to move the next-visit date of a saved visit.
});

// ================================================================= §16 Visits to other doctors
await app.clock.reset();
const OUT1 = "We took Appa to the cardiologist, he reduced Lasix to half and added nifedipine 10 mg thrice a day";
let out1Reply = "", out1Visit = 0;
const flowOf = (u: string) => app.q1<any>("SELECT value FROM settings WHERE key = ?", `ov:${u}`);
const lastReply = (u: string, m: number) => app.wa.since(u, m).filter((x) => x.kind === "reply").at(-1);
const pendingSnap = () => app.q<any>("SELECT item_key, label, due_at FROM tasks WHERE patient_id = 'p_ramesh' AND status = 'PENDING' ORDER BY due_at, item_key").map((x) => `${x.item_key}|${x.label}|${x.due_at}`).join("\n");
let tasksBeforeOut = "";

await app.test("OUT-01", "Reported on WhatsApp [AI off]", async () => {
  tasksBeforeOut = pendingSnap();
  const m = app.mark();
  ok(await app.wa.send("u_ramesh", OUT1), "send");
  const rep = lastReply("u_ramesh", m);
  assert.ok(rep, "a reply"); out1Reply = rep!.body;
  const v = app.q1<any>("SELECT * FROM outside_visits WHERE patient_id = 'p_ramesh' ORDER BY id DESC LIMIT 1");
  assert.ok(v && v.status === "COLLECTING", "conversation started (visit being collected)"); out1Visit = v.id;
  assert.equal(v.specialty, "Cardiology");
  assert.ok(flowOf("u_ramesh"), "conversation state open");
  const qs = (out1Reply.match(/\?/g) ?? []).length;
  assert.ok(qs >= 1 && qs <= 2, `at most two questions; got ${qs}: ${out1Reply}`);
  assert.match(out1Reply, /Which doctor/, "asks the missing doctor");
  assert.ok(!/What did .* change/.test(out1Reply), "doesn't ask for changes it already has");
  const ch = app.q<any>("SELECT med_name, change, new_dose FROM med_changes WHERE outside_visit_id = ?", v.id);
  assert.ok(ch.some((c) => /nifedipine/i.test(c.med_name) && c.change === "started" && c.new_dose === "10 mg"), "added medicine captured");
  assert.ok(ch.some((c) => /lasix/i.test(c.med_name)), "Lasix change captured");
  // AI-on path not run (no AI key).
});

await app.test("OUT-02", "Ambiguous dose asked first", async () => {
  if (!out1Reply) throw new Error("precondition: OUT-01 reply missing");
  const lasix = app.q1<any>("SELECT med_name, med_key, new_dose FROM med_changes WHERE outside_visit_id = ? AND med_name LIKE '%asix%'", out1Visit);
  // "Lasix … to half" doesn't match the plan clearly (the plan has Furosemide 20 mg, no dose given).
  assert.ok(lasix, "Lasix change recorded");
  const first = out1Reply.split("\n\n").slice(1).join(" ");
  if (!/dose|how much|mg/i.test(first)) throw new Error(`PLAN: with AI off the first question is "${first.trim()}", not a dose clarification. The rules fallback asks fixed questions in order doctor → prescription → next visit (lib/outside.ts:478-557 rulesTurn) and never asks about an unclear dose; clarifying questions come only from the AI path (unclear field, lib/outside.ts:228). Recorded: ${JSON.stringify(lasix)} (not matched to the plan's Furosemide). AI-on path not run.`);
});

await app.test("OUT-05", "Readings during the conversation", async () => {
  if (!flowOf("u_ramesh")) throw new Error("precondition: OUT-01 conversation not open");
  const m = app.mark();
  ok(await app.wa.send("u_ramesh", "BP 140/90"), "send");
  const obs = app.q1<any>("SELECT * FROM observations WHERE patient_id = 'p_ramesh' AND type = 'bp' ORDER BY id DESC LIMIT 1");
  assert.ok(obs && obs.v1 === 140 && obs.v2 === 90 && obs.observed_at >= (await app.clock.now()) - 5 * MIN, "reading logged as usual");
  assert.match(lastReply("u_ramesh", m)!.body, /Logged/);
  assert.ok(flowOf("u_ramesh"), "conversation still open");
  const m2 = app.mark();
  await app.wa.send("u_ramesh", "Dr Ezhilan at Apollo Hospital");
  const v = app.q1<any>("SELECT * FROM outside_visits WHERE id = ?", out1Visit);
  assert.equal(v.doctor_name, "Dr Ezhilan", "conversation continues and takes the next answer");
  assert.match(lastReply("u_ramesh", m2)!.body, /prescription/i);
});

await app.test("OUT-04", "Photo during the conversation", async () => {
  if (!flowOf("u_ramesh")) throw new Error("precondition: conversation not open");
  const m = app.mark();
  const r = await app.wa.media("u_ramesh", { base64: PNG, mime: "image/png", name: "cardio_prescription.png", filename: "cardio_prescription.png" } as any);
  ok(r, "media");
  const doc = app.q1<any>("SELECT * FROM patient_documents WHERE id = ?", r.data.document);
  assert.equal(doc.outside_visit_id, out1Visit, "photo joined the visit");
  assert.match(lastReply("u_ramesh", m)!.body, /attached to this visit/);
  // AI off: the photo is not read for doctor/medicines/tests/review date (needs AI). AI-on path not run.
  const m2 = app.mark();
  await app.wa.send("u_ramesh", "after 2 weeks");
  const v = app.q1<any>("SELECT * FROM outside_visits WHERE id = ?", out1Visit);
  assert.equal(v.status, "COMPLETE", `visit saved after the last answer; reply ${lastReply("u_ramesh", m2)?.body}`);
  assert.equal(dayKey(v.next_visit_at), dayKey((await app.clock.now()) + 14 * DAY));
});

await app.test("OUT-09", "Visit on the record", async () => {
  if (!out1Visit) throw new Error("precondition: OUT-01 visit missing");
  for (const u of ["u_dr_rao", "u_pa_priya", "u_ramesh", "u_lakshmi"]) {
    const g = await app.api(u, "GET", "/api/patients/p_ramesh/outside-visits");
    ok(g, `${u} reads visits`);
    assert.ok(g.data.visits.some((v: any) => v.id === out1Visit), `${u} sees the visit`);
  }
  assert.equal((await app.api("u_dr_dileep", "GET", "/api/patients/p_ramesh/outside-visits")).status, 403, "other doctor can't");
  assert.ok(app.q1("SELECT 1 FROM care_team WHERE patient_id = 'p_ramesh' AND name = 'Dr Ezhilan' AND role = 'CONSULTING'"), "doctor added to the care team");
  const sumRe = /recorded Ramesh's visit to Dr Ezhilan/;
  for (const u of ["u_lakshmi", "u_arjun", "u_kavya"]) assert.ok(app.wa.since(u, 0).some((x) => sumRe.test(x.body)), `${u} got a summary`);
  assert.ok(!app.wa.since("u_ramesh", 0).some((x) => sumRe.test(x.body)), "reporter not sent their own summary");
});

await app.test("OUT-10", "Changes not applied automatically", async () => {
  if (!out1Visit) throw new Error("precondition: OUT-01 visit missing");
  const plan = JSON.parse(app.q1<any>("SELECT plan FROM visits WHERE patient_id = 'p_ramesh' ORDER BY visit_at DESC LIMIT 1").plan);
  assert.ok(!plan.medications.some((x: any) => /nifedipine/i.test(x.name)), "plan unchanged");
  assert.ok(plan.medications.find((x: any) => x.key === "furosemide").dose === "20 mg", "Furosemide dose unchanged");
  const now = pendingSnap();
  assert.ok(!/nifedipine/i.test(now), "no reminders for the new medicine");
  const before = new Set(tasksBeforeOut.split("\n")); const after = now.split("\n");
  assert.ok(after.every((x) => before.has(x) || !/furosemide/.test(x)), "existing reminders unchanged");
  const ch = app.q<any>("SELECT status FROM med_changes WHERE outside_visit_id = ?", out1Visit);
  assert.ok(ch.length && ch.every((c) => c.status === "REPORTED"), "changes REPORTED");
  const t = (await app.api("u_pa_priya", "GET", "/api/pa-today")).data.tasks.find((x: any) => x.id === `ov:${out1Visit}`);
  assert.ok(t && t.label === "Other doctor's changes to review", "task on Today");
});

let warnVisit = 0;
await app.test("OUT-11", "Safety checks shown", async () => {
  // Context: allergy to ibuprofen, potassium 5.4 last week, atrial fibrillation (Ramesh already has heart failure).
  const now = await app.clock.now();
  const base = (await app.api("u_pa_priya", "GET", "/api/patients/p_ramesh/baseline")).data.baseline ?? {};
  ok(await app.api("u_pa_priya", "POST", "/api/patients/p_ramesh/baseline", { ...base, allergies: "Ibuprofen (rash)", labs: [...(base.labs ?? []), { marker: "potassium", value: 5.4, date: dayKey(now - 7 * DAY) }] }), "baseline");
  const p = app.q1<any>("SELECT conditions FROM patients WHERE id = 'p_ramesh'");
  ok(await app.api("u_pa_priya", "PATCH", "/api/patients/p_ramesh", { conditions: `${p.conditions} · Atrial fibrillation` }), "conditions");
  const s = await app.api("u_lakshmi", "POST", "/api/patients/p_ramesh/outside-visits", { action: "save", visit: { visitDate: dayKey(now), doctorName: "Dr Safety", specialty: "Cardiology", medChanges: [
    { medName: "Ibuprofen", change: "started", newDose: "400 mg", frequency: "BD" },
    { medName: "Losartan", change: "started", newDose: "50 mg", frequency: "OD" },
    { medName: "Furosemide", change: "dose_changed", newDose: "80 mg" },
    { medName: "Apixaban", change: "stopped" },
  ] } });
  ok(s, "save visit with changes"); warnVisit = s.data.id;
  const v = (await app.api("u_pa_priya", "GET", "/api/patients/p_ramesh/outside-visits")).data.visits.find((x: any) => x.id === warnVisit);
  const w = (n: string) => v.changes.find((c: any) => c.med_name === n)?.warnings.join(" | ") ?? "";
  assert.match(w("Ibuprofen"), /Allergy on file/, "allergy");
  assert.match(w("Ibuprofen"), /heart failure/, "NSAID in heart failure / kidney disease");
  assert.match(w("Losartan"), /Same type as Telmisartan/, "duplicate class");
  assert.match(w("Losartan"), /Potassium was 5.4/, "potassium ≥5 with ACE/ARB");
  assert.match(w("Furosemide"), /more than double/, "dose more than doubled");
  assert.match(w("Apixaban"), /blood thinner .*atrial fibrillation/i, "stopping a blood thinner in AF");
  assert.ok(v.changes.every((c: any) => c.status === "REPORTED"), "nothing blocked: all saved as REPORTED");
});

await app.test("OUT-12", "Apply to plan", async () => {
  if (!out1Visit) throw new Error("precondition: OUT-01 visit missing");
  const nif = app.q1<any>("SELECT id FROM med_changes WHERE outside_visit_id = ? AND med_name LIKE 'Nifedipine%'", out1Visit);
  const furo = warnVisit ? app.q1<any>("SELECT id FROM med_changes WHERE outside_visit_id = ? AND med_name = 'Furosemide'", warnVisit) : null;
  const t = await app.clock.now();
  const m = app.mark();
  const edits = [{ id: nif.id }, ...(furo ? [{ id: furo.id }] : [])];
  const r = await app.api("u_pa_priya", "POST", "/api/patients/p_ramesh/outside-visits", { action: "apply", edits });
  ok(r, "apply (including a change with a safety warning: not blocked)");
  const plan = JSON.parse(app.q1<any>("SELECT plan FROM visits WHERE patient_id = 'p_ramesh' ORDER BY visit_at DESC LIMIT 1").plan);
  assert.ok(plan.medications.some((x: any) => x.name === "Nifedipine" && x.dose === "10 mg" && x.times.length === 3), "plan amended");
  if (furo) assert.equal(plan.medications.find((x: any) => x.key === "furosemide").dose, "80 mg");
  assert.ok(cnt("SELECT COUNT(*) AS n FROM tasks WHERE patient_id = 'p_ramesh' AND status = 'PENDING' AND due_at > ? AND label LIKE '%Nifedipine%'", t) > 0, "future reminders rebuilt");
  for (const u of ["u_ramesh", "u_lakshmi", "u_arjun"]) assert.ok(app.wa.since(u, m).some((x) => /updated Ramesh's medicines/.test(x.body)), `${u} told`);
  assert.equal(app.q1<any>("SELECT status FROM med_changes WHERE id = ?", nif.id).status, "CONFIRMED");
});

await app.test("OUT-13", "Reject / mark reviewed", async () => {
  if (!out1Visit) throw new Error("precondition: OUT-01 visit missing");
  const lasix = app.q1<any>("SELECT id FROM med_changes WHERE outside_visit_id = ? AND med_name LIKE '%asix%'", out1Visit);
  ok(await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/med-changes", { action: "review", id: lasix.id, status: "REJECTED" }), "reject");
  assert.equal(app.q1<any>("SELECT status FROM med_changes WHERE id = ?", lasix.id).status, "REJECTED");
  ok(await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/outside-visits", { action: "review", id: out1Visit }), "mark reviewed");
  assert.ok(app.q1<any>("SELECT reviewed_at FROM outside_visits WHERE id = ?", out1Visit).reviewed_at, "visit reviewed");
  const tasks = (await app.api("u_pa_priya", "GET", "/api/pa-today")).data.tasks;
  assert.ok(!tasks.some((x: any) => x.id === `ov:${out1Visit}`), "task cleared");
  assert.equal((await app.api("u_lakshmi", "POST", "/api/patients/p_ramesh/outside-visits", { action: "review", id: out1Visit })).status, 403, "family can't review");
});

await app.test("OUT-06", "Urgent message skips it", async () => {
  const m = app.mark();
  await app.wa.send("u_neha", "We took Mum to the orthopaedic doctor, he added calcium 500 mg once daily");
  assert.ok(flowOf("u_neha"), "conversation open");
  const t = await app.clock.now();
  await app.wa.send("u_neha", "Mum has chest pain");
  const esc = app.q1<any>("SELECT * FROM escalations WHERE patient_id = 'p_sunita' AND type = 'URGENT' AND started_at >= ? ORDER BY id DESC LIMIT 1", t - MIN);
  assert.ok(esc, "urgent alert raised immediately");
  assert.ok(app.wa.since("u_neha", m).some((x) => x.kind === "escalation" || /108|emergency/i.test(x.body)), "urgent advice / alert sent");
});

await app.test("OUT-07", "Stop", async () => {
  const m = app.mark();
  await app.wa.send("u_arjun", "Took Appa to the nephrologist yesterday, he stopped metformin");
  const v = app.q1<any>("SELECT * FROM outside_visits WHERE reported_by = 'u_arjun' ORDER BY id DESC LIMIT 1");
  assert.ok(v && v.status === "COLLECTING", "conversation started");
  await app.wa.send("u_arjun", "stop");
  const v2 = app.q1<any>("SELECT * FROM outside_visits WHERE id = ?", v.id);
  assert.equal(v2.status, "COMPLETE", "saved");
  assert.equal(v2.specialty, "Nephrology"); assert.equal(dayKey(v2.visit_at), dayKey((await app.clock.now()) - DAY));
  assert.ok(app.q1("SELECT 1 FROM med_changes WHERE outside_visit_id = ? AND med_name LIKE 'Metformin%' AND change = 'stopped'", v.id), "known change kept");
  assert.match(lastReply("u_arjun", m)!.body, /Saved what we have/);
  assert.ok(!flowOf("u_arjun"), "conversation closed");
});

await app.test("OUT-08", "Abandoned", async () => {
  await app.wa.send("u_kavya", "Appa saw Dr Kumar the ENT today, he added cetirizine 10 mg at night");
  const v = app.q1<any>("SELECT * FROM outside_visits WHERE reported_by = 'u_kavya' ORDER BY id DESC LIMIT 1");
  assert.ok(v && v.status === "COLLECTING" && flowOf("u_kavya"), "conversation open");
  await app.clock.advance(11 * 60);
  assert.equal(app.q1<any>("SELECT status FROM outside_visits WHERE id = ?", v.id).status, "COLLECTING", "not saved before 12 h");
  await app.clock.advance(70);
  assert.equal(app.q1<any>("SELECT status FROM outside_visits WHERE id = ?", v.id).status, "COMPLETE", "saved automatically after 12 h");
  assert.ok(!flowOf("u_kavya"), "conversation closed");
});

// Next appointment reminders and "how did it go" (OUT-14, OUT-15, OUT-18): four visits with an appointment tomorrow,
// each reported by a different person (conversations are per person).
await app.clock.reset();
const fu: Record<string, number> = {};
let tomorrowKey = "";
await app.test("OUT-14", "Next appointment reminders", async () => {
  const t0 = await app.clock.now();
  tomorrowKey = dayKey(t0 + DAY);
  const m = app.mark();
  for (const [u, doc] of [["u_lakshmi", "Dr Lak"], ["u_arjun", "Dr Arj"], ["u_kavya", "Dr Kav"], ["u_ramesh", "Dr Ram"]] as const) {
    const r = await app.api(u, "POST", "/api/patients/p_ramesh/outside-visits", { action: "save", visit: { visitDate: dayKey(t0), doctorName: doc, specialty: "Cardiology", nextVisitDate: tomorrowKey } });
    ok(r, `save ${u}`); fu[u] = r.data.id;
  }
  await advanceTo(atIST(t0, 18, 30)); // the evening before (no-op when it is already evening)
  await app.api(null, "GET", "/api/demo"); // a tick
  const lr = app.wa.since("u_lakshmi", m).filter((x) => x.kind === "reminder" && /visit with Dr Lak .*is tomorrow/.test(x.body));
  const pr = app.wa.since("u_ramesh", m).filter((x) => x.kind === "reminder" && /your visit with Dr Lak/.test(x.body));
  assert.equal(lr.length, 1, "reporter reminded the evening before");
  assert.equal(pr.length, 1, "patient reminded the evening before");
  assert.ok(!app.wa.since("u_arjun", m).some((x) => x.kind === "reminder" && /Dr Lak/.test(x.body)), "others not reminded about someone else's report");
  const m2 = app.mark();
  await advanceTo(atIST(t0 + DAY, 19, 15));
  await app.api(null, "GET", "/api/demo");
  const ask = app.wa.since("u_lakshmi", m2).find((x) => /How did Ramesh's visit with Dr Lak go today/.test(x.body));
  assert.ok(ask, "that evening the reporter is asked how it went");
  assert.ok(ask!.quick?.includes("No changes"), "quick replies offered");
});

await app.test("OUT-15", "\"How did it go\" answers", async () => {
  if (!fu.u_lakshmi) throw new Error("precondition: OUT-14 visits missing");
  const notes: string[] = [];
  // No changes → closed.
  let m = app.mark();
  await app.wa.send("u_lakshmi", "No changes");
  let rep = lastReply("u_lakshmi", m)!.body;
  assert.ok(/no medicine changes/i.test(rep), `no-changes acknowledged: ${rep}`);
  if (flowOf("u_lakshmi")) {
    await app.wa.send("u_lakshmi", "Not planned");
    const nv = app.q1<any>("SELECT * FROM outside_visits WHERE followup_of = ? ORDER BY id DESC LIMIT 1", fu.u_lakshmi);
    assert.ok(!flowOf("u_lakshmi") && nv?.status === "COMPLETE" && nv.advice === "No medicine changes", "closed after the extra question");
    notes.push(`PLAN: "No changes" doesn't close at once: the reply is ${JSON.stringify(rep)}. The rules flow still wants the next-appointment slot for the follow-up row (lib/outside.ts:556-557, 'next' slot when next_visit_at is empty); after answering "Not planned" it closes with "No medicine changes" recorded and no medicine changes`);
  }
  // Postponed → date moved, no visit recorded.
  const t = await app.clock.now();
  const visitsBefore = cnt("SELECT COUNT(*) AS n FROM outside_visits WHERE patient_id = 'p_ramesh'");
  m = app.mark();
  await app.wa.send("u_arjun", "Visit postponed");
  rep = lastReply("u_arjun", m)!.body;
  assert.match(rep, /When is the visit now/, "asks the new date");
  await app.wa.send("u_arjun", "in 10 days");
  const pv = app.q1<any>("SELECT next_visit_at FROM outside_visits WHERE id = ?", fu.u_arjun);
  assert.equal(dayKey(pv.next_visit_at), dayKey(t + 10 * DAY), "date moved");
  assert.equal(cnt("SELECT COUNT(*) AS n FROM outside_visits WHERE patient_id = 'p_ramesh'"), visitsBefore, "no visit recorded");
  assert.ok(!flowOf("u_arjun"), "closed");
  // Changes → a new conversation.
  m = app.mark();
  await app.wa.send("u_ramesh", "Yes, there were changes");
  rep = lastReply("u_ramesh", m)!.body;
  assert.match(rep, /What did Dr Ram change/, `asks what changed: ${rep}`);
  const nv = app.q1<any>("SELECT * FROM outside_visits WHERE followup_of = ? ORDER BY id DESC LIMIT 1", fu.u_ramesh);
  assert.ok(nv && nv.status === "COLLECTING" && nv.doctor_name === "Dr Ram", "new visit conversation for the follow-up");
  if (notes.length) throw new Error(`${notes.join("; ")}. Postponed (date moved, no visit) and changes (new conversation) passed.`);
});

await app.test("OUT-18", "Postponed date in the past year", async () => {
  if (!fu.u_kavya) throw new Error("precondition: OUT-14 visits missing");
  const t = await app.clock.now();
  const past = t - 20 * DAY; // a date that has already gone by this year (or late last year in early January)
  const d = new Date(past + IST);
  const spoken = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  if (dayKey(past).slice(0, 4) !== dayKey(t).slice(0, 4)) notRun("20 days ago falls in the previous year; the case needs a date earlier in the same year");
  await app.wa.send("u_kavya", "Visit postponed");
  await app.wa.send("u_kavya", `postponed to ${spoken}`);
  const v = app.q1<any>("SELECT next_visit_at FROM outside_visits WHERE id = ?", fu.u_kavya);
  const expected = `${Number(dayKey(t).slice(0, 4)) + 1}-${dayKey(past).slice(5)}`;
  assert.equal(v.next_visit_at ? dayKey(v.next_visit_at) : null, expected, `"${spoken}" read as next year`);
});

await app.test("OUT-16", "Entered on the web", async () => {
  await app.clock.reset();
  const t = await app.clock.now();
  const d = await app.api("u_lakshmi", "POST", "/api/patients/p_ramesh/outside-visits", { action: "draft", text: "Took him to Dr Varma the cardiologist yesterday, he added aspirin 75 mg once daily" });
  ok(d, "describe in words");
  assert.equal(d.data.via, "rules");
  assert.equal(d.data.draft.doctorName, "Dr Varma"); assert.equal(d.data.draft.specialty, "Cardiology");
  assert.equal(d.data.draft.visitDate, dayKey(t - DAY));
  assert.ok(d.data.medChanges.some((c: any) => /aspirin/i.test(c.medName) && c.change === "started"), "medicine change drafted");
  assert.equal(cnt("SELECT COUNT(*) AS n FROM outside_visits WHERE doctor_name = 'Dr Varma'"), 0, "draft saves nothing");
  const m = app.mark();
  const before = pendingSnap();
  const s = await app.api("u_lakshmi", "POST", "/api/patients/p_ramesh/outside-visits", { action: "save", visit: { ...d.data.draft, medChanges: d.data.medChanges }, files: [{ base64: PNG, mime: "image/png", filename: "varma_rx.png" }] });
  ok(s, "save");
  const v = app.q1<any>("SELECT * FROM outside_visits WHERE id = ?", s.data.id);
  assert.equal(v.status, "COMPLETE"); assert.equal(v.source, "web");
  assert.ok(app.q1("SELECT 1 FROM med_changes WHERE outside_visit_id = ? AND status = 'REPORTED'", v.id), "change REPORTED, not applied");
  assert.equal(pendingSnap(), before, "reminders unchanged");
  assert.ok(app.q1("SELECT 1 FROM care_team WHERE patient_id = 'p_ramesh' AND name = 'Dr Varma'"), "doctor added to care team");
  assert.ok(app.q1("SELECT 1 FROM patient_documents WHERE outside_visit_id = ?", v.id), "photo attached");
  for (const u of ["u_ramesh", "u_arjun"]) assert.ok(app.wa.since(u, m).some((x) => /recorded Ramesh's visit to Dr Varma/.test(x.body)), `${u} got the summary`);
  assert.ok((await app.api("u_pa_priya", "GET", "/api/pa-today")).data.tasks.some((x: any) => x.id === `ov:${v.id}`), "review task on Today");
});

let docVisit = 0;
await app.test("OUT-17", "Tap \"From another doctor's visit\" under a document", async () => {
  const m = app.mark();
  const r = await app.wa.media("u_ramesh", { base64: PNG, mime: "image/png", name: "rx_from_hospital.png", filename: "rx_from_hospital.png" } as any);
  ok(r, "media");
  const rep = lastReply("u_ramesh", m);
  assert.ok(rep?.quick?.includes("From another doctor's visit"), `button offered: ${JSON.stringify(rep)}`);
  const m2 = app.mark();
  await app.wa.send("u_ramesh", "From another doctor's visit");
  const v = app.q1<any>("SELECT * FROM outside_visits WHERE patient_id = 'p_ramesh' ORDER BY id DESC LIMIT 1");
  assert.ok(v && v.status === "COLLECTING" && v.created_at >= (await app.clock.now()) - 5 * MIN, `conversation started: ${lastReply("u_ramesh", m2)?.body}`);
  assert.equal(app.q1<any>("SELECT outside_visit_id FROM patient_documents WHERE id = ?", r.data.document).outside_visit_id, v.id, "document attached");
  docVisit = v.id;
  await app.wa.send("u_ramesh", "stop");
});

await app.test("OUT-19", "Delete an outside visit", async () => {
  if (!docVisit) throw new Error("precondition: OUT-17 visit missing");
  const v = app.q1<any>("SELECT * FROM outside_visits WHERE id = ?", docVisit);
  assert.ok(v, `visit kept after stop (it has a document); status ${v?.status}`);
  const docs = app.q<any>("SELECT id FROM patient_documents WHERE outside_visit_id = ?", docVisit);
  assert.ok(docs.length, "has a document");
  assert.equal((await app.api("u_arjun", "POST", "/api/patients/p_ramesh/outside-visits", { action: "delete", id: docVisit })).status, 403, "someone else in the family can't delete it");
  ok(await app.api("u_pa_priya", "POST", "/api/patients/p_ramesh/outside-visits", { action: "delete", id: docVisit }), "delete");
  assert.equal(cnt("SELECT COUNT(*) AS n FROM outside_visits WHERE id = ?", docVisit), 0, "removed");
  for (const d of docs) assert.equal(app.q1<any>("SELECT outside_visit_id FROM patient_documents WHERE id = ?", d.id)?.outside_visit_id ?? null, null, "document link removed (file kept)");
  assert.equal(cnt("SELECT COUNT(*) AS n FROM med_changes WHERE outside_visit_id = ?", docVisit), 0, "its changes removed");
  assert.ok(app.q("SELECT * FROM audit WHERE action = 'OUTSIDE_VISIT_DELETED'").some((a: any) => JSON.parse(a.detail ?? "{}").visit === docVisit), "audit entry");
});

await app.stop();
killPort(PORT);
