// Kidney demo patient: A Gopal ("Appa"). History up to the 03-Sep-2026 visit (weights, fluids, BP, sugars,
// diuretic doses, labs, prescriptions and the doctors' medicine changes) is IMPORTED from the family's own
// spreadsheet (lib/data/appa.json — stays local). Everything after the visit is replayed as WhatsApp messages
// through the real engine; Sep 4–10 fluids and the Sep 10 lab report are the real values, later days are simulated.
import { audit, run, setSetting } from "./db";
import { addLab, addMedChange } from "./engine";
import { sendWhatsApp } from "./whatsapp";
import { DAY, MIN, atLocal, dayStart } from "./time";
import type { CarePlan, ClinicVitals, Medication } from "./types";
import { DEFAULT_THRESHOLDS, DEFAULT_TIMERS, KIDNEY_TEMPLATE } from "./types";
import appa from "./data/appa.json";

interface Msg {
  at: number;
  userId: string;
  body: string;
}
interface Esc {
  rule_key: string;
  type: string;
  level: number;
}

type AppaData = {
  weight: { d: string; kg: number }[];
  fluid: { d: string; in: number | null; out: number | null }[];
  glucose: { d: string; f: number | null; pp: number | null }[];
  bp: { d: string; s: number; di: number }[];
  spo2: { d: string; v: number }[];
  diuretic: { d: string; drug: string; mg: number }[];
  labs: { d: string; m: string; v: number; c?: string }[]; // c: the cell's colour in the sheet (red / yellow)
};
export const APPA = appa as unknown as AppaData;
const A = APPA;

export const GOPAL = { pid: "p_gopal", uid: "u_gopal", mom: "u_mom", cg: "u_durai", doctor: "u_dr_dileep" };
export const LATEST_REAL = "2026-09-03";

const EZ = "Dr Ezhilan", SA = "Dr Satish", MS = "Dr Manoj Shah", DI = "Dr Dileep", SS = "Dr Sunil Shroff";

/** The other doctors involved in Appa's care (the primary is the clinic's own doctor). */
export const GOPAL_CONSULTANTS: [name: string, specialty: string][] = [
  ["Dr Ezhilan", "Cardiology"],
  ["Dr Satish", "Cardiology (to confirm)"],
  ["Dr Manoj Shah", "Diabetology"],
  ["Dr Sunil Shroff", "Gastroenterology / general (to confirm)"],
  ["Dr. K. Sridhar", "Neurology"],
];
const M = (key: string, name: string, dose: string, times: string[], prescriber: string, purpose: string, extra: Partial<Medication> = {}): Medication => ({ key, name, dose, times, prescriber, purpose, ...extra });

// Reconstructed from the prescription sheets (Morn 08:00, Anoon 14:00, Night 21:00, before food 07:30).
const core = (concor: string, concorTime: string) => [
  M("eliquis", "Eliquis (apixaban)", "5 mg", ["08:00", "21:00"], EZ, "Blood thinner (AF)"),
  M("concor", "Concor (bisoprolol)", concor, [concorTime], EZ, "Heart rate / rhythm"),
  M("levesam", "Levesam (levetiracetam)", "500 mg", ["08:00", "21:00"], EZ, "Epilepsy"),
  M("prizide", "Prizide MR (gliclazide)", "60 mg", ["07:30"], MS, "Diabetes", { instructions: "before breakfast" }),
];
const P2025 = [M("ecosprin", "Ecosprin", "75 mg", ["14:00"], EZ, "Heart (antiplatelet)"), M("aztor", "Aztor (atorvastatin)", "20 mg", ["21:00"], EZ, "Cholesterol"), M("pruvict", "Pruvict", "1 mg", ["08:00", "21:00"], SS, "Constipation"), M("pan", "Pan", "40 mg", ["07:30"], SS, "Acidity", { instructions: "before food" })];

function basePlan(meds: Medication[], extra: Partial<CarePlan> = {}): CarePlan {
  return {
    medications: meds,
    monitoring: [{ key: "weight", times: ["07:00"] }, { key: "bp", times: ["08:00"] }],
    physio: [],
    lifestyle: [{ key: "salt", text: "Low salt diet" }, { key: "fluid", text: "Fluids about 1 litre/day" }],
    checkinTime: "",
    watchSymptoms: ["edema", "breathlessness"],
    thresholds: { ...DEFAULT_THRESHOLDS },
    escalation: { ...DEFAULT_TIMERS },
    ...extra,
  };
}

const LATEST_MEDS: Medication[] = [
  M("ecosprin", "Ecosprin AV 75/20", "1 tab", ["14:00"], EZ, "Heart attack prevention / cholesterol", { instructions: "after lunch" }),
  ...core("2.5 mg", "21:00"),
  M("lasix", "Lasix (furosemide)", "40 mg", ["08:00", "16:00"], DI, "Water tablet (diuretic)", { doses: ["40 mg", "20 mg"] }),
  M("zurig", "Zurig (febuxostat)", "40 mg", ["08:00"], SA, "Uric acid", { instructions: "reintroduced 3 Sep" }),
  M("zincovit", "Zincovit", "1 tab", ["21:00"], SS, "Multivitamin"),
  M("pantocid", "Pantocid DSR", "40 mg", ["07:30"], SS, "Acidity", { instructions: "30 min before breakfast" }),
  M("isolazine", "Isolazine 20/37.5", "½ tab", ["08:00", "14:00", "21:00"], EZ, "Heart failure"),
  M("drise", "D-Rise 60000 IU", "1 sachet", ["08:00"], DI, "Vitamin D", { everyNDays: 7, courseDays: 28 }),
];

export const GOPAL_LATEST_PLAN: CarePlan = {
  medications: LATEST_MEDS,
  monitoring: KIDNEY_TEMPLATE.monitoring,
  physio: [],
  lifestyle: KIDNEY_TEMPLATE.lifestyle,
  checkinTime: "",
  watchSymptoms: [...KIDNEY_TEMPLATE.watchSymptoms, "confusion"],
  thresholds: { ...DEFAULT_THRESHOLDS, ...KIDNEY_TEMPLATE.thresholds, dryWeight: 59.2 },
  escalation: { ...DEFAULT_TIMERS },
  fluid: { ...KIDNEY_TEMPLATE.fluid },
  labs: { ...KIDNEY_TEMPLATE.labs },
  template: "kidney",
};

export const GOPAL_DX = "CKD stage 4 (cardiorenal) · Heart failure · Type 2 diabetes · Atrial fibrillation on apixaban · Epilepsy · Hyperuricaemia";
export const GOPAL_VISITS: { d: string; dx: string; notes: string; plan: CarePlan }[] = [
  { d: "2025-06-19", dx: GOPAL_DX, notes: "Diuretic (Dytor) calibrated up to 80 mg/day as needed. Trajenta and Ciplox stopped. Augmentin 1 week.", plan: basePlan([...P2025, ...core("1.25 mg", "08:00"), M("dytor", "Dytor (torsemide)", "20 mg", ["08:00", "14:00"], DI, "Water tablet (diuretic)"), M("augmentin", "Augmentin", "625 mg", ["08:00", "21:00"], DI, "Infection", { courseDays: 7 }), M("bifilac", "Bifilac", "1 cap", ["08:00", "21:00"], DI, "Gut")]) },
  { d: "2025-08-13", dx: GOPAL_DX, notes: "Dytor 30 mg/day. Zytanix 2.5 mg × 4 days. Rystat thrice weekly, iron.", plan: basePlan([...P2025, ...core("1.25 mg", "08:00"), M("dytor", "Dytor (torsemide)", "20 mg", ["08:00", "14:00"], DI, "Water tablet (diuretic)", { doses: ["20 mg", "10 mg"] }), M("zytanix", "Zytanix (metolazone)", "2.5 mg", ["08:00"], SA, "Water tablet (diuretic)", { courseDays: 4 }), M("zurig", "Zurig (febuxostat)", "40 mg", ["08:00"], SA, "Uric acid"), M("rystat", "Rystat", "50 mg", ["08:00"], DI, "Anaemia", { days: [1, 3, 5] }), M("ferinios", "Ferinios", "1 tab", ["08:00"], DI, "Iron")]) },
  { d: "2025-09-30", dx: GOPAL_DX, notes: "Sacurise restarted after cardiology–nephrology discussion. Zytanix Tue/Fri.", plan: basePlan([...P2025, ...core("1.25 mg", "08:00"), M("dytor", "Dytor (torsemide)", "20 mg", ["08:00", "14:00"], DI, "Water tablet (diuretic)", { doses: ["20 mg", "10 mg"] }), M("sacurise", "Sacurise", "½ tab (25 mg)", ["08:00", "21:00"], SA, "Heart failure"), M("zytanix", "Zytanix (metolazone)", "2.5 mg", ["08:00"], SA, "Water tablet (diuretic)", { days: [2, 5] }), M("zurig", "Zurig (febuxostat)", "40 mg", ["08:00"], SA, "Uric acid"), M("rystat", "Rystat", "50 mg", ["08:00"], DI, "Anaemia", { days: [1, 4] }), M("ferinios", "Ferinios", "1 tab", ["08:00"], DI, "Iron")]) },
  { d: "2025-10-30", dx: GOPAL_DX, notes: "Dytor reduced to 20 mg/day. Rystat and iron stopped.", plan: basePlan([...P2025, ...core("1.25 mg", "08:00"), M("dytor", "Dytor (torsemide)", "10 mg", ["08:00", "14:00"], DI, "Water tablet (diuretic)"), M("sacurise", "Sacurise", "½ tab (25 mg)", ["08:00", "21:00"], SA, "Heart failure"), M("zytanix", "Zytanix (metolazone)", "2.5 mg", ["08:00"], SA, "Water tablet (diuretic)", { days: [2, 5] }), M("zurig", "Zurig (febuxostat)", "40 mg", ["08:00"], SA, "Uric acid")]) },
  { d: "2025-11-29", dx: GOPAL_DX + " · post-admission", notes: "Discharge plan: Dytor/Zytanix changed to Lasix + Aldactone. Betaloc newly added. Several changes followed in December by Dr Satish / Dr Dileep (see medicine-change log).", plan: basePlan([M("ecosprin", "Ecosprin AV 75/20", "1 tab", ["21:00"], EZ, "Heart attack prevention / cholesterol"), M("eliquis", "Eliquis (apixaban)", "5 mg", ["08:00", "21:00"], EZ, "Blood thinner (AF)"), M("concor", "Concor (bisoprolol)", "5 mg", ["08:00"], EZ, "Heart rate / rhythm"), M("levesam", "Levesam (levetiracetam)", "500 mg", ["08:00", "21:00"], EZ, "Epilepsy"), M("prizide", "Prizide MR (gliclazide)", "60 mg", ["07:30"], MS, "Diabetes"), M("pan", "Pan", "40 mg", ["07:30"], SS, "Acidity", { prn: true }), M("pruvict", "Pruvict", "1 mg", ["21:00"], SS, "Constipation", { prn: true }), M("sacurise", "Sacurise", "½ tab (25 mg)", ["08:00", "21:00"], SA, "Heart failure"), M("aldactone", "Aldactone (spironolactone)", "25 mg", ["10:00", "17:00"], EZ, "Diuretic / heart"), M("betaloc", "Betaloc (metoprolol)", "25 mg", ["08:00", "21:00"], EZ, "BP / heart"), M("lasix", "Lasix (furosemide)", "60 mg", ["08:00", "16:00"], DI, "Water tablet (diuretic)", { doses: ["60 mg", "40 mg"] })]) },
  { d: "2026-02-10", dx: GOPAL_DX, notes: "December changes reconciled. Lasix 40 + 20 mg. Zurig 20 mg/day. Concor 1.25 mg at night.", plan: basePlan([M("ecosprin", "Ecosprin AV 75/20", "1 tab", ["14:00"], EZ, "Heart attack prevention / cholesterol"), ...core("1.25 mg", "21:00"), M("lasix", "Lasix (furosemide)", "40 mg", ["08:00", "16:00"], DI, "Water tablet (diuretic)", { doses: ["40 mg", "20 mg"] }), M("zurig", "Zurig (febuxostat)", "½ tab (20 mg)", ["08:00"], SA, "Uric acid"), M("zincovit", "Zincovit", "1 tab", ["21:00"], SS, "Multivitamin"), M("pan", "Pan", "40 mg", ["07:30"], SS, "Acidity", { prn: true }), M("bixify", "Bixify", "1 tab", ["21:00"], DI, "Constipation", { prn: true })]) },
  { d: "2026-07-02", dx: GOPAL_DX, notes: "Stable. Continue same medicines.", plan: basePlan([M("ecosprin", "Ecosprin AV 75/20", "1 tab", ["14:00"], EZ, "Heart attack prevention / cholesterol"), ...core("1.25 mg", "21:00"), M("lasix", "Lasix (furosemide)", "40 mg", ["08:00", "16:00"], DI, "Water tablet (diuretic)", { doses: ["40 mg", "20 mg"] }), M("zurig", "Zurig (febuxostat)", "½ tab (20 mg)", ["08:00"], SA, "Uric acid"), M("zincovit", "Zincovit", "1 tab", ["21:00"], SS, "Multivitamin"), M("pan", "Pan", "40 mg", ["07:30"], SS, "Acidity", { prn: true }), M("bixify", "Bixify", "1 tab", ["21:00"], DI, "Constipation", { prn: true })]) },
];

// Real medicine changes made between visits by other doctors (from the sheet comments).
export const GOPAL_CHANGES: { d: string; med: string; change: string; detail: string; by: string; status: string }[] = [
  { d: "2025-12-06", med: "Betaloc (metoprolol)", change: "stopped", detail: "Stopped — Concor does the same job", by: SA, status: "REVIEWED" },
  { d: "2025-12-13", med: "Sacurise", change: "stopped", detail: "Stopped — creatinine 2.9, urea 122", by: SA, status: "REVIEWED" },
  { d: "2025-12-13", med: "Aldactone (spironolactone)", change: "stopped", detail: "Stopped — potassium 5.2", by: SA, status: "REVIEWED" },
  { d: "2025-12-13", med: "Zurig (febuxostat)", change: "started", detail: "Added 40 mg morning for uric acid", by: SA, status: "REVIEWED" },
  { d: "2025-12-16", med: "Lasix (furosemide)", change: "dose_changed", detail: "Morning dose 60 → 40 mg", by: SA, status: "REVIEWED" },
  { d: "2025-12-16", med: "Concor (bisoprolol)", change: "dose_changed", detail: "5 → 2.5 mg, moved to night", by: SA, status: "REVIEWED" },
  { d: "2025-12-16", med: "Zytanix (metolazone)", change: "started", detail: "2.5 mg afternoon; alternate days from 19 Dec (weight 57.7 kg)", by: SA, status: "REVIEWED" },
  { d: "2025-12-16", med: "Ecosprin AV 75/20", change: "other", detail: "Moved from night to afternoon", by: SA, status: "REVIEWED" },
  { d: "2025-12-21", med: "Zytanix (metolazone)", change: "stopped", detail: "Temporarily stopped", by: DI, status: "REVIEWED" },
  { d: "2025-12-24", med: "Concor (bisoprolol)", change: "dose_changed", detail: "Reduced to 1.25 mg", by: DI, status: "REVIEWED" },
  { d: "2026-01-03", med: "Bifilac", change: "started", detail: "For loose stools, 3 Jan – 12 Jan", by: DI, status: "REVIEWED" },
  { d: "2026-01-09", med: "Ciplox TZ", change: "started", detail: "Antibiotic 9 – 13 Jan", by: DI, status: "REVIEWED" },
  { d: "2026-08-22", med: "Concor (bisoprolol)", change: "dose_changed", detail: "1.25 → 2.5 mg at hospital discharge", by: EZ, status: "REVIEWED" },
  { d: "2026-08-22", med: "Prizide MR (gliclazide)", change: "dose_changed", detail: "60 → 30 mg at discharge", by: EZ, status: "REVIEWED" },
  { d: "2026-08-22", med: "Aldactone (spironolactone)", change: "started", detail: "25 mg morning + afternoon at discharge", by: EZ, status: "REVIEWED" },
  { d: "2026-08-22", med: "Isolazine 20/37.5", change: "started", detail: "½ tab three times a day", by: EZ, status: "REVIEWED" },
  { d: "2026-08-22", med: "Nodosis", change: "started", detail: "500 mg ½ tab twice a day", by: EZ, status: "REVIEWED" },
  { d: "2026-08-22", med: "Anxit", change: "started", detail: "0.25 mg at night", by: EZ, status: "REVIEWED" },
];

export function gopalShiftMs(realNow: number): number {
  const target = dayStart(realNow) - 31 * DAY;
  const real = dayStart(Date.parse(LATEST_REAL + "T12:00:00+05:30"));
  return Math.round((target - real) / DAY) * DAY;
}

const nearest = <T extends { d: string }>(xs: T[], d: string, maxDays = 10): T | undefined => {
  const t = Date.parse(d);
  let best: T | undefined;
  let bd = Infinity;
  for (const x of xs) {
    const dd = Math.abs(Date.parse(x.d) - t) / DAY;
    if (dd < bd && dd <= maxDays) {
      bd = dd;
      best = x;
    }
  }
  return best;
};

export function clinicVitals(d: string): ClinicVitals {
  const w = nearest(A.weight, d), b = nearest(A.bp, d), s = nearest(A.spo2, d);
  return { ...(w ? { weight: w.kg } : {}), ...(b ? { sys: b.s, dia: b.di } : {}), ...(s ? { spo2: s.v } : {}) };
}

/** The latest real visit (03 Sep 2026): post-discharge review, which set the current plan. */
export const GOPAL_LATEST_VISIT = {
  vitals: { ...clinicVitals(LATEST_REAL), weight: 59.6, sys: 118, dia: 64 } as ClinicVitals,
  diagnosis: GOPAL_DX + " — creatinine rising (2.59), K 5.1",
  notes: "Post-discharge review. Aldactone, Nodosis and Anxit stopped. Zurig reintroduced with Dr Satish. Dry weight 59.2 kg (±1). Fluids 1 litre/day incl. tea & soup. Daily weight, BP, fasting sugar; evening intake/urine totals. RFT + electrolytes every 4 weeks — sooner if unwell.",
};

export interface GopalSetup {
  latestVisit: { at: number; pid: string; doctorId: string; vitals: ClinicVitals; diagnosis: string; notes: string; plan: CarePlan; next: number };
  msgs: Msg[];
  responder: (esc: Esc) => { ackLevel: number; ackAfter: number; code: string; note?: string } | null;
}

/** Inserts users/patient/care team, imports history before the latest visit, and returns the post-visit WhatsApp script. */
export function setupGopal(realNow: number): GopalSetup {
  const shift = gopalShiftMs(realNow);
  const at = (d: string, hhmm: string) => atLocal(dayStart(Date.parse(d + "T12:00:00+05:30")) + shift, hhmm);
  const vAt = at(LATEST_REAL, "11:00");
  const onboard = vAt - DAY;

  run("INSERT INTO users(id, name, role, phone, title) VALUES(?,?,?,?,?)", GOPAL.doctor, "Dr. Dileep", "DOCTOR", "+91 90000 50010", "Nephrologist · primary doctor");
  run("INSERT INTO users(id, name, role, phone, title) VALUES(?,?,?,?,?)", GOPAL.uid, "A Gopal", "PATIENT", "+91 90000 50001", "Patient");
  run("INSERT INTO users(id, name, role, phone, title) VALUES(?,?,?,?,?)", GOPAL.mom, "Mom", "CAREGIVER", "+91 90000 50003", "Wife of A Gopal");
  run("INSERT INTO users(id, name, role, phone, title) VALUES(?,?,?,?,?)", GOPAL.cg, "Durai", "CAREGIVER", "+91 90000 50002", "Caretaker of A Gopal");
  run("INSERT INTO patients(id, user_id, name, age, sex, phone, conditions, address, doctor_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", GOPAL.pid, GOPAL.uid, "A Gopal", null, "M", "+91 90000 50001", GOPAL_DX, "", GOPAL.doctor, at("2025-06-19", "10:00"));
  run("INSERT INTO caregivers(id, patient_id, user_id, name, relation, phone, level, dashboard) VALUES(?,?,?,?,?,?,?,1)", "cg_gopal_1", GOPAL.pid, GOPAL.mom, "Mom", "Wife", "+91 90000 50003", 1);
  run("INSERT INTO caregivers(id, patient_id, user_id, name, relation, phone, level, dashboard) VALUES(?,?,?,?,?,?,?,1)", "cg_gopal_2", GOPAL.pid, GOPAL.cg, "Durai", "Caretaker", "+91 90000 50002", 2);
  const team: [string, string, string, string | null][] = [
    ["Dr. Dileep", "Nephrology", "PRIMARY", GOPAL.doctor],
    ["Dr Ezhilan", "Cardiology", "CONSULTING", null],
    ["Dr Satish", "Cardiology (to confirm)", "CONSULTING", null],
    ["Dr Manoj Shah", "Diabetology", "CONSULTING", null],
    ["Dr Sunil Shroff", "Gastroenterology / general (to confirm)", "CONSULTING", null],
    ["Dr. K. Sridhar", "Neurology", "CONSULTING", null],
  ];
  for (const [name, sp, role, uid] of team) run("INSERT INTO care_team(patient_id, name, specialty, role, user_id) VALUES(?,?,?,?,?)", GOPAL.pid, name, sp, role, uid);

  // Prior visits (prescription versions) — recorded directly; no reminders are generated for the past.
  const all = [...GOPAL_VISITS.map((v) => ({ ...v, at: at(v.d, "11:00") }))];
  all.forEach((v, i) => {
    const next = i + 1 < all.length ? all[i + 1].at : vAt;
    run("INSERT INTO visits(id, patient_id, doctor_id, visit_at, vitals, diagnosis, notes, plan, next_visit_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", `v_${GOPAL.pid}_${v.at}`, GOPAL.pid, GOPAL.doctor, v.at, JSON.stringify(clinicVitals(v.d)), v.dx, v.notes, JSON.stringify(v.plan), next, v.at);
  });
  setSetting(`gen:${GOPAL.pid}`, String(vAt)); // tasks start with the CareCircle plan

  // Import home logs before the visit.
  const before = (d: string) => d < LATEST_REAL;
  const obs = (type: string, v1: number, v2: number | null, text: string | null, t: number) => run("INSERT INTO observations(patient_id, type, v1, v2, text, observed_at, logged_by, parser) VALUES(?,?,?,?,?,?,?,?)", GOPAL.pid, type, v1, v2, text, t, GOPAL.cg, "import");
  for (const w of A.weight) if (before(w.d)) obs("weight", w.kg, null, null, at(w.d, "07:00"));
  for (const g of A.glucose) if (before(g.d) && g.f) obs("glucose", g.f, null, "fasting", at(g.d, "07:00"));
  for (const b of A.bp) if (before(b.d)) obs("bp", b.s, b.di, null, at(b.d, "08:00"));
  for (const s of A.spo2) if (before(s.d)) obs("spo2", s.v, null, null, at(s.d, "08:00"));
  for (const f of A.fluid) {
    if (!before(f.d)) continue;
    if (f.in) obs("fluid_in", f.in, null, "total", at(f.d, "21:00"));
    if (f.out) obs("urine_out", f.out, null, "total", at(f.d, "21:00"));
  }
  for (const x of A.diuretic) if (before(x.d)) obs("diuretic", x.mg, null, x.drug, at(x.d, "08:00"));
  for (const l of A.labs) {
    if (l.d > LATEST_REAL) continue;
    const { id } = addLab(GOPAL.pid, l.m, l.v, at(l.d, "09:00"), "import", null, null);
    if (l.c) run("UPDATE labs SET mark = ? WHERE id = ?", l.c, id);
  }
  for (const c of GOPAL_CHANGES) {
    const id = addMedChange(GOPAL.pid, at(c.d, "12:00"), { medName: c.med, change: c.change, detail: c.detail, prescriber: c.by }, null, null, "import", c.status);
    run("UPDATE med_changes SET reviewed_by = ?, reviewed_at = ? WHERE id = ?", GOPAL.doctor, vAt, id);
  }
  audit(onboard, "system", "HISTORY_IMPORTED", "patient", GOPAL.pid, { source: "family spreadsheet" });

  sendWhatsApp({ userId: GOPAL.mom, patientId: GOPAL.pid, body: "👋 Hi Mom, A Gopal has added you as Level 1 in his CareCircle (Wife).\nYou can log readings for him here anytime, and I'll alert you if something needs attention. Reply *ACK* to alerts to take ownership.", kind: "info", at: onboard });
  sendWhatsApp({ userId: GOPAL.cg, patientId: GOPAL.pid, body: "👋 Hi Durai, A Gopal has added you as Level 2 in his CareCircle (Caretaker).\nYou can log readings for him here anytime, and if Level 1 is unavailable, I'll alert you. Reply *ACK* to alerts to take ownership.", kind: "info", at: onboard });
  sendWhatsApp({ userId: GOPAL.uid, patientId: GOPAL.pid, body: "👋 Welcome to CareCircle, Gopal! I'm Dr. Dileep's WhatsApp care assistant.\nI'll remind you about medicines, weight, fluids and tests — just reply in your own words. Mom and Durai will be kept in the loop if anything needs attention.\n\nReply *YES* to consent to share your readings with your care team.", quick: ["YES"], kind: "info", at: onboard });

  // ---------------------------------------------------------------- after the visit: WhatsApp script
  const d0 = dayStart(vAt);
  const end = realNow - 5 * MIN;
  const msgs: Msg[] = [{ at: onboard + 20 * MIN, userId: GOPAL.uid, body: "YES" }];
  const push = (d: number, hhmm: string, userId: string, body: string, jitterMin = 0) => {
    const t = atLocal(d0 + d * DAY, hhmm) + jitterMin * MIN;
    if (t > vAt && t <= end) msgs.push({ at: t, userId, body });
  };
  const realFluid = A.fluid.filter((f) => f.d > LATEST_REAL);
  const weights: Record<number, number> = { 1: 59.4, 2: 59.5, 3: 59.3, 4: 59.0, 5: 58.9, 6: 59.1, 7: 59.6, 8: 59.4, 9: 59.3, 10: 59.2, 11: 59.0, 12: 58.7, 13: 57.9, 14: 58.4, 15: 58.9, 16: 59.1, 17: 59.2, 18: 59.4, 19: 59.3, 20: 59.5, 21: 59.9, 22: 60.4, 23: 59.9, 24: 59.5, 25: 59.3, 26: 59.2, 27: 59.4, 28: 59.1, 29: 59.3, 30: 59.2, 31: 59.3 };
  const fluidDay: Record<number, [number, number]> = { 12: [800, 600], 13: [900, 650], 20: [1250, 950], 21: [1300, 1000] };
  const days = Math.round((dayStart(realNow) - d0) / DAY);
  for (let d = 0; d <= days; d++) {
    const r = (n: number) => ((d * 37 + n * 11) % 9) - 4; // deterministic small jitter
    const wt = weights[d] ?? 59.3;
    const sys = 124 + r(1) * 2, dia = 66 + r(2);
    const fast = d === 24 ? 68 : d === 25 ? 64 : 104 + r(3) * 3;
    const byDurai = d % 4 !== 1;
    let morning = byDurai ? `Appa weight ${wt}, BP ${sys}/${dia}, fasting sugar ${fast}. Morning tablets given` : `wt ${wt} bp ${sys}/${dia} sugar ${fast} took morning tablets`;
    if (d === 13) morning = `Appa weight ${wt}, BP 104/60, sugar ${fast}. Feeling dizzy when standing. Morning tablets given`;
    push(d, "07:35", byDurai ? GOPAL.cg : GOPAL.uid, morning, 12 + (d % 5) * 3);
    if (d % 3 === 0 || d === days) push(d, "11:00", GOPAL.uid, d % 2 ? "had 2 glasses water" : "Appa had 1 cup tea and 1 glass water", 5);
    push(d, "14:00", d % 2 ? GOPAL.uid : GOPAL.cg, d % 2 ? "afternoon tablets taken" : "Appa afternoon tablets given", 18);
    let [fin, fout] = fluidDay[d] ?? [950 + r(4) * 25, 850 + r(5) * 30];
    if (d <= 7 && realFluid[d - 1]) [fin, fout] = [realFluid[d - 1].in ?? fin, realFluid[d - 1].out ?? fout];
    let evening = `Intake ${fin} ml, urine ${fout} ml today. Night tablets given. No swelling`;
    if (d === 12) evening = `Appa had loose stools 3 times today. Intake ${fin} ml, urine ${fout} ml. Night tablets given`;
    if (d === 18) evening = `Intake ${fin} ml, urine ${fout} ml. Night tablets given. Slight itching on arms`;
    if (d === 20 || d === 21) evening = `Visitors at home, Appa drank more tea. Intake ${fin} ml, urine ${fout} ml. Night tablets given`;
    push(d, "21:00", d === 18 ? GOPAL.uid : GOPAL.cg, evening, 15);
    if (d === 7) push(d, "18:00", GOPAL.cg, "Appa's blood report today: creatinine 3.01, urea 96, K 4.9, Na 138, uric acid 5.8, eGFR 21, NT-proBNP 2102", 30);
    if (d === 17) push(d, "17:00", GOPAL.cg, "Repeat RFT report: creatinine 2.85, urea 90, K 4.7, Na 137", 10);
    if (d === 25) push(d, "18:00", GOPAL.cg, "Dr Manoj Shah reduced Prizide to 30 mg because of low sugars", 5);
  }

  const responder: GopalSetup["responder"] = (esc) => {
    const R: Record<string, { ackLevel: number; ackAfter: number; code: string; note?: string }> = {
      "lab:creat_rise": { ackLevel: 2, ackAfter: 20, code: "2", note: "Shared the report with Dr Dileep's clinic on WhatsApp — asked to continue the same medicines, keep fluids at 1 litre and repeat RFT next week." },
      "sx:diarrhoea": { ackLevel: 2, ackAfter: 30, code: "2", note: "Called Dr Dileep's clinic — asked to give ORS sips within the fluid limit and watch weight and urine." },
      weight_below_band: { ackLevel: 2, ackAfter: 15, code: "2", note: "Spoke to Dr Dileep's clinic — following their instructions on the water tablet; will recheck weight tomorrow morning." },
      "sx:dizziness": { ackLevel: 1, ackAfter: 50, code: "1" },
      fluid_over: { ackLevel: 1, ackAfter: 40, code: "1" },
      weight_gain: { ackLevel: 2, ackAfter: 20, code: "2", note: "Informed Dr Dileep's clinic — asked to keep strictly to 1 litre and send weight daily." },
      glucose_low: { ackLevel: 2, ackAfter: 10, code: "2", note: "Called Dr Manoj Shah's clinic about the low fasting sugars — he will review the Prizide dose." },
    };
    const c = R[esc.rule_key] ?? { ackLevel: 1, ackAfter: 30, code: "1" };
    return { ackLevel: c.ackLevel, ackAfter: c.ackAfter, code: c.code, note: c.note };
  };

  return {
    latestVisit: {
      at: vAt,
      pid: GOPAL.pid,
      doctorId: GOPAL.doctor,
      ...GOPAL_LATEST_VISIT,
      plan: GOPAL_LATEST_PLAN,
      next: atLocal(dayStart(realNow), "17:00"),
    },
    msgs,
    responder,
  };
}
