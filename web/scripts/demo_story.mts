// Builds a ready-to-present demo clinic with a FICTIONAL patient (Venkat Raman). Nothing real in it.
//   npx tsx scripts/demo_story.mts ready   -> clinic, staff, patient and family onboarded and consented; NO baseline,
//                                             so you can show "Fill from documents" and Visit 1 live.
//   npx tsx scripts/demo_story.mts story   -> the same, plus baseline, Visit 1 and 12 days of WhatsApp history with
//                                             a weight drift and a missed evening dose. Open on a full Today screen,
//                                             or use as the fallback if a live scene breaks.
// Writes data/demo-<stage>.db. Run it with:  CARECIRCLE_DB=data/demo-story.db npm run clinic
import fs from "node:fs";
import path from "node:path";

const stage = process.argv[2] === "story" ? "story" : "ready";
const dbFile = path.join(process.cwd(), "data", `demo-${stage}.db`);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
for (const f of [dbFile, `${dbFile}-shm`, `${dbFile}-wal`]) fs.rmSync(f, { force: true });
process.env.CARECIRCLE_DB = dbFile;
process.env.CARECIRCLE_MODE = "live";
delete process.env.GEMINI_API_KEY; // history is replayed with the rule parser: no AI cost, same result every time

const { ensureSeeded } = await import("../lib/seed");
const { setupClinic, addStaff, saveBaseline } = await import("../lib/clinic");
const engine = await import("../lib/engine");
const { all, get, setSetting } = await import("../lib/db");
const { DAY, MIN, atLocal, dayStart } = await import("../lib/time");
const { DEFAULT_THRESHOLDS, DEFAULT_TIMERS, KIDNEY_TEMPLATE } = await import("../lib/types");
type Plan = import("../lib/types").CarePlan;

await ensureSeeded();
const NOW = Date.now();
const T0 = atLocal(dayStart(NOW) - 12 * DAY, "10:00"); // Visit 1, twelve days ago
const ONBOARD = T0 - 2 * DAY;

// ---- people (all fictional; +91 90000 numbers are not real)
const doctor = setupClinic({ name: "Sunrise Heart & Kidney Clinic", address: "12 Lake Road, Chennai", phone: "+91 90000 10000" },
  { name: "Meera Iyer", title: "Cardiologist", phone: "+91 90000 10001", email: "meera@sunrise.example", regNo: "TN-12345" }, ONBOARD - DAY)!;
addStaff({ name: "Divya Menon", role: "PA", title: "Physician Assistant", phone: "+91 90000 10002", email: "", regNo: "" }, ONBOARD - DAY, null);
const pid = engine.onboardPatient({
  name: "Venkat Raman", age: 71, sex: "M", phone: "+91 90000 20001", conditions: "Heart failure, Type 2 diabetes, CKD stage 3", address: "Adyar, Chennai", doctorId: doctor,
  caregivers: [
    { name: "Anjali Raman", relation: "Daughter", phone: "+91 90000 20002", level: 1 },
    { name: "Karthik Raman", relation: "Son", phone: "+91 90000 20003", level: 2 },
  ],
}, ONBOARD, doctor);
const slug = pid.slice(2);
const U = { patient: `u_${slug}`, anjali: `u_cg_${slug}_1`, karthik: `u_cg_${slug}_2` };

const say = async (u: string, body: string, at: number) => { engine.runScheduler(at - 1); await engine.ingestMessage(u, body, { allowAi: false, at }); };
await say(U.patient, "YES", ONBOARD + 20 * MIN);
await say(U.anjali, "YES", ONBOARD + 35 * MIN);
await say(U.karthik, "YES", ONBOARD + 3 * 60 * MIN);

if (stage === "story") {
  setSetting("last_tick", String(ONBOARD));
  saveBaseline(pid, {
    dob: "1955-03-02", language: "English", bloodGroup: "O+", heightCm: 168, vitals: { sys: 142, dia: 88, weight: 71.5, hr: 78, spo2: 96 },
    conditions: ["Heart failure (HFrEF)", "Type 2 diabetes", "CKD stage 3", "Hypertension"], allergies: "Sulfa drugs (rash)",
    history: "CABG 2016. Appendectomy 1988. Metformin stopped Mar 2022 (low eGFR). Admitted for heart failure Aug 2026. Aspirin stopped Aug 2026 (replaced by clopidogrel).",
    familyHistory: "Father: diabetes, MI at 60.", smoking: "former", alcohol: "never", activity: "light", diet: "Low salt, vegetarian",
    currentMeds: [
      { name: "Furosemide", dose: "40 mg", frequency: "OD", purpose: "Fluid" }, { name: "Telmisartan", dose: "40 mg", frequency: "BD" },
      { name: "Amlodipine", dose: "5 mg", frequency: "OD" }, { name: "Glimepiride", dose: "1 mg", frequency: "OD" },
      { name: "Atorvastatin", dose: "20 mg", frequency: "HS" }, { name: "Clopidogrel", dose: "75 mg", frequency: "OD" }, { name: "Pantoprazole", dose: "40 mg", frequency: "OD" },
    ],
    labs: [{ marker: "creatinine", value: 1.9, date: "2026-08-14" }, { marker: "urea", value: 64, date: "2026-08-14" }, { marker: "egfr", value: 37, date: "2026-08-14" }, { marker: "potassium", value: 4.6, date: "2026-08-14" }, { marker: "sodium", value: 136, date: "2026-08-14" }, { marker: "hba1c", value: 8.1, date: "2026-08-14" }],
    notes: "",
  }, ONBOARD + 5 * 60 * MIN, doctor);

  const M = (key: string, name: string, dose: string, times: string[], purpose: string, extra: object = {}) => ({ key, name, dose, times, purpose, prescriber: "Dr. Meera Iyer", ...extra });
  const plan: Plan = {
    medications: [
      M("furosemide", "Furosemide", "40 mg", ["08:00"], "Fluid"), M("telmisartan", "Telmisartan", "40 mg", ["08:00", "20:00"], "Blood pressure / kidney"),
      M("amlodipine", "Amlodipine", "5 mg", ["08:00"], "Blood pressure"), M("glimepiride", "Glimepiride", "1 mg", ["07:30"], "Diabetes", { instructions: "before breakfast" }),
      M("atorvastatin", "Atorvastatin", "20 mg", ["21:30"], "Cholesterol"), M("clopidogrel", "Clopidogrel", "75 mg", ["08:00"], "Blood thinner"),
      M("pantoprazole", "Pantoprazole", "40 mg", ["07:30"], "Acidity", { instructions: "before food" }),
    ],
    monitoring: [{ key: "weight", times: ["07:00"] }, { key: "bp", times: ["08:00"] }, { key: "glucose", times: ["07:00"] }],
    physio: [], lifestyle: [{ key: "salt", text: "Low salt diet" }, { key: "fluid", text: "Fluids about 1 litre a day" }],
    checkinTime: "", watchSymptoms: ["edema", "breathlessness"],
    thresholds: { ...DEFAULT_THRESHOLDS, dryWeight: 71.5, weightBand: 1.5, weightDayGainKg: 1 }, escalation: { ...DEFAULT_TIMERS },
    fluid: { ...KIDNEY_TEMPLATE.fluid }, template: "kidney",
  };
  engine.createVisit(pid, doctor, {
    vitals: { sys: 142, dia: 88, weight: 71.5, hr: 78, spo2: 96 }, diagnosis: "Heart failure, type 2 diabetes, CKD stage 3",
    notes: "Stable after admission. Dry weight 71.5 kg. Continue current medicines; salt and fluid restriction. Review in 4 weeks.", plan, next_visit_at: atLocal(T0 + 28 * DAY, "10:30"),
  }, T0);

  // 12 days at home. Days 1-7 steady; from day 8 weight creeps up; day 9 he forgets the evening tablets.
  const weights = [71.4, 71.6, 71.5, 71.3, 71.6, 71.5, 71.7, 72.2, 72.6, 73.1, 73.7, 74.3];
  const bps = [[138, 86], [136, 84], [140, 88], [134, 84], [138, 86], [136, 84], [140, 86], [142, 88], [144, 90], [146, 90], [148, 92], [150, 94]];
  const sugar = [128, 122, 131, 118, 126, 124, 129, 133, 136, 130, 138, 141];
  const last = 12;
  const settle = async (at: number, finalDay: boolean) => {
    // Anjali takes ownership of anything raised, except the very latest alert, which is left for the doctor to see.
    if (finalDay) return;
    engine.runScheduler(at - 1); // let the alert be raised first
    if (get("SELECT 1 FROM escalations WHERE patient_id = ? AND state = 'NOTIFIED'", pid)) await say(U.anjali, "ACK", at);
  };
  await say(U.patient, "took night tablets", atLocal(dayStart(T0), "21:10")); // the evening of the visit
  for (let d = 1; d <= last; d++) {
    const day = dayStart(T0) + d * DAY;
    const fin = d === last;
    await say(U.patient, `weight ${weights[d - 1]}, BP ${bps[d - 1][0]}/${bps[d - 1][1]}, sugar ${sugar[d - 1]}`, atLocal(day, "07:12"));
    await settle(atLocal(day, "07:25"), fin);
    await say(U.patient, "took all tablets", atLocal(day, "08:20"));
    if (d !== 9) await say(U.patient, `intake ${900 + ((d * 37) % 120)} ml, urine ${700 + d * 8 - (d > 8 ? (d - 8) * 60 : 0)} ml`, atLocal(day, "21:02"));
    if (d !== 9) await say(U.patient, d % 3 === 0 ? "took night tablets, no swelling" : "took night tablets", atLocal(day, "21:05"));
    if (d === 9) { await say(U.patient, "no swelling", atLocal(day, "21:20")); } // evening tablets forgotten
    await settle(atLocal(day, d === 9 ? "23:50" : "21:30"), fin);
    if (d === 10) { await say(U.patient, "ankles a little swollen today", atLocal(day, "19:40")); await settle(atLocal(day, "19:55"), false); }
  }
  engine.runScheduler(NOW);
}

engine.runScheduler(NOW);
const counts = { messages: get<{ n: number }>("SELECT COUNT(*) AS n FROM messages")!.n, observations: get<{ n: number }>("SELECT COUNT(*) AS n FROM observations")!.n, escalations: get<{ n: number }>("SELECT COUNT(*) AS n FROM escalations")!.n };
console.log(`Built ${path.relative(process.cwd(), dbFile)} (${stage}):`, counts);
console.log(`Logins in the app: Clinic Admin, Dr. Meera Iyer, Divya Menon (PA), Venkat Raman (patient), Anjali (daughter), Karthik (son).`);
console.log(`Run it:  CARECIRCLE_DB=${path.relative(process.cwd(), dbFile)} npm run clinic    (http://localhost:3100)`);
