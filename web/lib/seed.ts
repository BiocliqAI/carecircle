// Demo data. Instead of inserting fake rows, the seed REPLAYS weeks of realistic WhatsApp activity
// through the real engine (prompts, reminders, parsing, rules, escalations, acknowledgements), so
// every number on the dashboard is produced by the same code path used live.
import { LIVE } from "./mode";
import { all, get, getDb, getSetting, resetDb, run, setSetting, tx } from "./db";
import { now, resetClockCache, setSimNow, advanceClock } from "./clock";
import { createVisit, getCaregivers, ingestMessage, latestVisit, listPatients, tick, type EscalationRow } from "./engine";
import { sendWhatsApp } from "./whatsapp";
import { DAY, HOUR, MIN, atLocal, dayStart, localDow } from "./time";
import type { CarePlan, ClinicVitals } from "./types";
import { DEFAULT_THRESHOLDS, DEFAULT_TIMERS, shortName } from "./types";
import { GOPAL, setupGopal } from "./seed_gopal";

// ---------------------------------------------------------------- deterministic RNG
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = rng(42);
const jitter = (n: number) => (rand() * 2 - 1) * n;
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const r1 = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- plans
export const RAMESH_PLAN: CarePlan = {
  medications: [
    { key: "telmisartan", name: "Telmisartan", dose: "40 mg", times: ["08:00"] },
    { key: "metoprolol", name: "Metoprolol succinate", dose: "25 mg", times: ["08:00"] },
    { key: "furosemide", name: "Furosemide", dose: "20 mg", times: ["08:00"], instructions: "after breakfast" },
    { key: "metformin", name: "Metformin", dose: "500 mg", times: ["08:00", "20:00"], instructions: "after food" },
    { key: "atorvastatin", name: "Atorvastatin", dose: "20 mg", times: ["20:00"], instructions: "with dinner" },
  ],
  monitoring: [
    { key: "bp", times: ["08:00"] },
    { key: "hr", times: ["08:00"] },
    { key: "weight", times: ["08:00"] },
    { key: "glucose", times: ["08:00"], days: [1, 3, 5] },
  ],
  physio: [{ key: "walk", name: "Brisk walk", detail: "20 minutes on flat ground", times: ["17:00"] }],
  lifestyle: [
    { key: "salt", text: "Salt under 5 g/day — no pickles or papad" },
    { key: "fluid", text: "Fluids max 1.5 L/day" },
    { key: "diet", text: "Diabetic diet — no sweets" },
  ],
  checkinTime: "21:00",
  watchSymptoms: ["edema", "breathlessness", "dizziness", "palpitations"],
  thresholds: { ...DEFAULT_THRESHOLDS },
  escalation: { ...DEFAULT_TIMERS },
};

const SUNITA_PLAN_1: CarePlan = {
  medications: [
    { key: "amlodipine", name: "Amlodipine", dose: "5 mg", times: ["08:00"] },
    { key: "paracetamol", name: "Paracetamol", dose: "650 mg", times: ["08:00", "20:00"], instructions: "after food" },
    { key: "apixaban", name: "Apixaban", dose: "2.5 mg", times: ["08:00", "20:00"], instructions: "blood thinner — do not skip" },
  ],
  monitoring: [
    { key: "bp", times: ["08:00"] },
    { key: "pain", times: ["20:00"] },
  ],
  physio: [
    { key: "knee", name: "Knee bending & straight-leg raises", detail: "10 reps × 3 sets", times: ["09:00", "18:00"] },
    { key: "walk", name: "Walker-assisted walk", detail: "10 minutes indoors", times: ["16:00"] },
  ],
  lifestyle: [
    { key: "ice", text: "Ice pack 15 min after exercises" },
    { key: "elevate", text: "Keep leg elevated while resting" },
  ],
  checkinTime: "21:00",
  watchSymptoms: ["calf_pain", "fever", "wound"],
  thresholds: { ...DEFAULT_THRESHOLDS, painHigh: 7 },
  escalation: { ...DEFAULT_TIMERS },
};

const SUNITA_PLAN_2: CarePlan = {
  ...SUNITA_PLAN_1,
  medications: [
    { key: "amlodipine", name: "Amlodipine", dose: "5 mg", times: ["08:00"] },
    { key: "paracetamol", name: "Paracetamol", dose: "650 mg", times: ["08:00"], instructions: "morning only; extra dose only if needed" },
  ],
  physio: [
    { key: "knee", name: "Knee bending & straight-leg raises", detail: "15 reps × 3 sets", times: ["09:00", "13:00", "18:00"] },
    { key: "stairs", name: "Stair practice", detail: "1 flight with rail support", times: ["11:00"] },
    { key: "walk", name: "Walk with cane", detail: "20 minutes outdoors", times: ["16:30"] },
  ],
  lifestyle: [
    { key: "ice", text: "Ice pack 15 min after exercises" },
    { key: "squat", text: "Avoid squatting / sitting cross-legged" },
  ],
};

const ABDUL_PLAN: CarePlan = {
  medications: [
    { key: "tiotropium", name: "Tiotropium inhaler", dose: "18 mcg, 1 puff", times: ["09:00"] },
    { key: "budesonide", name: "Budesonide/Formoterol inhaler", dose: "200/6, 2 puffs", times: ["09:00", "21:00"], instructions: "rinse mouth after" },
    { key: "amlodipine", name: "Amlodipine", dose: "5 mg", times: ["09:00"] },
  ],
  monitoring: [
    { key: "spo2", times: ["09:00"] },
    { key: "hr", times: ["09:00"] },
    { key: "bp", times: ["09:00"] },
  ],
  physio: [{ key: "breathing", name: "Pursed-lip breathing & spirometer", detail: "10 minutes", times: ["11:00", "18:00"] }],
  lifestyle: [
    { key: "smoke", text: "No smoking; avoid smoke & dust" },
    { key: "steam", text: "Steam inhalation once daily" },
  ],
  checkinTime: "21:00",
  watchSymptoms: ["breathlessness", "cough", "fever"],
  thresholds: { ...DEFAULT_THRESHOLDS, spo2Low: 92, hrHigh: 110 },
  escalation: { ...DEFAULT_TIMERS },
};

// ---------------------------------------------------------------- simulation machinery
interface Msg {
  at: number;
  userId: string;
  body: string;
}
interface VisitEvent {
  at: number;
  pid: string;
  doctorId?: string;
  vitals: ClinicVitals;
  diagnosis: string;
  notes: string;
  plan: CarePlan;
  next: number | null;
}
interface ResponderCfg {
  ackLevel: number; // which caregiver level acknowledges (99 = nobody)
  ackAfter: number; // minutes after being notified
  code: string;
  note?: string;
}
type ResponderFn = (esc: EscalationRow) => ResponderCfg | null;

async function simulate(start: number, end: number, msgs: Msg[], visits: VisitEvent[], responder: ResponderFn) {
  const queue = [...msgs].sort((a, b) => a.at - b.at);
  const scheduled = new Set<string>();
  const vq = [...visits].sort((a, b) => a.at - b.at);
  const STEP = 15 * MIN;
  for (let t = start; t <= end; t += STEP) {
    while (vq.length && vq[0].at <= t) {
      const v = vq.shift()!;
      createVisit(v.pid, v.doctorId ?? "u_dr_rao", { vitals: v.vitals, diagnosis: v.diagnosis, notes: v.notes, plan: v.plan, next_visit_at: v.next }, v.at);
    }
    while (queue.length && queue[0].at <= t) {
      const m = queue.shift()!;
      setSimNow(m.at);
      await ingestMessage(m.userId, m.body, { allowAi: false, at: m.at });
    }
    setSimNow(t);
    tx(() => tick(t));
    // scripted caregiver behaviour
    const open = all<EscalationRow>("SELECT * FROM escalations WHERE state = 'NOTIFIED'");
    for (const esc of open) {
      const key = `${esc.id}:${esc.level}`;
      if (scheduled.has(key)) continue;
      scheduled.add(key);
      const cfg = responder(esc);
      if (!cfg || cfg.ackLevel !== esc.level) continue;
      const cg = getCaregivers(esc.patient_id).find((c) => c.level === esc.level);
      if (!cg?.user_id) continue;
      const ackAt = esc.level_at + cfg.ackAfter * MIN;
      const add = (m: Msg) => {
        const i = queue.findIndex((q) => q.at > m.at);
        if (i < 0) queue.push(m);
        else queue.splice(i, 0, m);
      };
      add({ at: ackAt, userId: cg.user_id, body: pick(["ACK", "ACK – I'll handle it", "Ack, calling him now", "ok I'll handle"]) });
      add({ at: ackAt + 25 * MIN, userId: cg.user_id, body: cfg.code });
      if (cfg.code !== "1") add({ at: ackAt + 32 * MIN, userId: cg.user_id, body: cfg.note || "Spoke to the clinic, advised to continue medicines and monitor." });
    }
  }
  setSimNow(null);
}

const genericResponder: ResponderFn = (esc) => {
  if (rand() < 0.15) return null; // sometimes nobody at this level responds in time
  const code = esc.type === "COMPLIANCE" ? "1" : rand() < 0.5 ? "2" : "1";
  const lvl = esc.level;
  return { ackLevel: lvl, ackAfter: 15 + Math.floor(rand() * 30), code, note: "Called the clinic — advised to continue medicines, rest and recheck. Will bring readings to the visit." };
};

// ---------------------------------------------------------------- demo scenario
function insertUsers() {
  const users: [string, string, string, string, string][] = [
    ["u_dr_rao", "Dr. Meera Rao", "DOCTOR", "+91 98450 10001", "MD (Internal Medicine) · Rao Family & Chronic Care Clinic"],
    ["u_pa_priya", "Priya Nair", "PA", "+91 98450 10002", "Physician Assistant · Rao Clinic"],
    ["u_ramesh", "Ramesh Kumar", "PATIENT", "+91 98860 20001", "Patient"],
    ["u_lakshmi", "Lakshmi Kumar", "CAREGIVER", "+91 98860 20002", "Wife of Ramesh"],
    ["u_arjun", "Arjun Kumar", "CAREGIVER", "+91 98860 20003", "Son of Ramesh"],
    ["u_kavya", "Kavya Iyer", "CAREGIVER", "+91 98860 20004", "Daughter of Ramesh"],
    ["u_sunita", "Sunita Sharma", "PATIENT", "+91 99000 30001", "Patient"],
    ["u_neha", "Neha Sharma", "CAREGIVER", "+91 99000 30002", "Daughter of Sunita"],
    ["u_vikram", "Vikram Sharma", "CAREGIVER", "+91 99000 30003", "Son of Sunita"],
    ["u_abdul", "Abdul Rahman", "PATIENT", "+91 97400 40001", "Patient"],
    ["u_imran", "Imran Rahman", "CAREGIVER", "+91 97400 40002", "Son of Abdul"],
    ["u_farah", "Farah Rahman", "CAREGIVER", "+91 97400 40003", "Daughter-in-law of Abdul"],
    ["u_joseph", "Joseph Mathew", "CAREGIVER", "+91 97400 40004", "Neighbour of Abdul"],
  ];
  for (const u of users) run("INSERT INTO users(id, name, role, phone, title) VALUES(?,?,?,?,?)", ...u);
}

function addPatient(id: string, userId: string, name: string, age: number, sex: string, phone: string, conditions: string, address: string, at: number, cgs: [string, string, string, string, number][]) {
  run("INSERT INTO patients(id, user_id, name, age, sex, phone, conditions, address, doctor_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, userId, name, age, sex, phone, conditions, address, "u_dr_rao", at);
  run("INSERT INTO care_team(patient_id, name, specialty, role, user_id) VALUES(?,?,?,?,?)", id, "Dr. Meera Rao", "Internal Medicine", "PRIMARY", "u_dr_rao");
  for (const [cid, uid, cname, rel, lvl] of cgs) {
    const phoneCg = get<{ phone: string }>("SELECT phone FROM users WHERE id = ?", uid)!.phone;
    run("INSERT INTO caregivers(id, patient_id, user_id, name, relation, phone, level, dashboard) VALUES(?,?,?,?,?,?,?,1)", cid, id, uid, cname, rel, phoneCg, lvl);
    sendWhatsApp({ userId: uid, patientId: id, body: `👋 Hi ${cname.split(" ")[0]}, ${name} has added you as Level ${lvl} in their CareCircle (${rel}).\nYou can log readings for them here anytime, and I'll alert you if something needs attention. Reply *ACK* to alerts to take ownership.`, kind: "info", at });
  }
  sendWhatsApp({ userId, patientId: id, body: `👋 Welcome to CareCircle, ${name.split(" ")[0]}! I'm Dr. Meera Rao's WhatsApp care assistant.\nAfter your visit I'll remind you about medicines, readings and exercises — just reply in your own words. Your care circle will be kept in the loop if anything needs attention.\n\nReply *YES* to consent to share your readings with your care team.`, quick: ["YES"], kind: "info", at });
}

function rameshScript(v1: number, end: number): Msg[] {
  const out: Msg[] = [];
  const d0 = dayStart(v1);
  const weights: Record<number, number> = { 15: 78.4, 16: 79.0, 17: 80.3, 18: 80.2, 19: 79.6, 20: 78.9, 21: 78.4, 22: 78.0 };
  for (let d = 0; d <= 28; d++) {
    const day = d0 + d * DAY;
    const dow = localDow(day + 12 * HOUR);
    const f = Math.min(d, 27) / 27;
    // ---- morning (08:20–08:50)
    const mAt = atLocal(day, "08:00") + (20 + Math.floor(rand() * 30)) * MIN;
    if (d >= 1 && mAt <= end) {
      let sys = Math.round(152 - 18 * f + jitter(4));
      let dia = Math.round(94 - 9 * f + jitter(3));
      if (d === 25) { sys = 168; dia = 100; }
      const hr = Math.round(80 - 6 * f + jitter(3));
      const wt = weights[d] ?? r1(78.0 - 0.6 * f + jitter(0.2));
      const sugar = [1, 3, 5].includes(dow) ? Math.round(160 - 25 * f + jitter(10)) : null;
      const byCg = d % 5 === 4 ? "u_lakshmi" : d === 12 || d === 13 ? "u_arjun" : "u_ramesh";
      let body: string;
      if (byCg === "u_ramesh") {
        body = pick([
          `BP ${sys}/${dia} pulse ${hr} weight ${wt}${sugar ? ` sugar ${sugar}` : ""}. Took all tablets`,
          `Good morning. bp ${sys}/${dia}, pulse ${hr}, wt ${wt} kg${sugar ? `, fasting ${sugar}` : ""}. Morning tablets taken`,
          `${sys}/${dia}, pulse ${hr}, weight ${wt}${sugar ? `, sugar ${sugar}` : ""} — took my tablets`,
        ]);
        if (d === 6) body = `BP ${sys}/${dia} pulse ${hr} weight ${wt}. Took all tablets except furosemide, will take after I return from temple`;
      } else body = `Ramesh BP ${sys}/${dia}, pulse ${hr}, weight ${wt}${sugar ? `, sugar ${sugar}` : ""}. He took his tablets.`;
      out.push({ at: mAt, userId: byCg, body });
      if (d === 25) out.push({ at: mAt + 50 * MIN, userId: "u_ramesh", body: "Rested and rechecked BP 146/90. Feeling ok" });
    }
    // ---- evening (20:20–20:45)
    const eAt = atLocal(day, "20:00") + (20 + Math.floor(rand() * 25)) * MIN;
    if (eAt > end || eAt < v1) continue;
    if (d === 9 || d === 10) continue; // forgot to log -> compliance escalation
    let body = pick([
      "Took night tablets. Walked 20 min. Salt and fluids ok, no swelling",
      "Evening tablets taken, walked 20 minutes, no symptoms, diet ok",
      "Took evening meds, walk done. Feeling fine, salt ok",
    ]);
    if (d === 17) body = "Took night tablets, walked slowly. Ankles are swollen since afternoon. Fluids ok";
    if (d >= 18 && d <= 19) body = "Took night tablets, walked 15 min. Swelling less today. Salt and fluids ok";
    if (d >= 20 && d <= 22) body = "Took night tablets. Skipped walk — knee pain. Salt ok";
    if (d === 23) body = "Took night tablets. Did short walk 10 min, knee pain better. No swelling";
    out.push({ at: eAt, userId: d % 7 === 3 ? "u_lakshmi" : "u_ramesh", body });
  }
  return out;
}

function sunitaScript(v1: number, v2: number, end: number): Msg[] {
  const out: Msg[] = [];
  const d0 = dayStart(v1);
  for (let d = 0; d <= 42; d++) {
    const day = d0 + d * DAY;
    const phase2 = day + 12 * HOUR > v2;
    const f = d / 42;
    const mAt = atLocal(day, "09:00") + (15 + Math.floor(rand() * 30)) * MIN;
    const logger = rand() < 0.7 ? "u_neha" : "u_sunita";
    const sys = Math.round(146 - 14 * f + jitter(4));
    const dia = Math.round(88 - 6 * f + jitter(3));
    const skip = !phase2 ? rand() < 0.3 : rand() < 0.08;
    if (d >= 1 && mAt <= end) {
      const ex = skip ? "Skipped exercises, knee too stiff" : "did exercises";
      out.push({ at: mAt, userId: logger, body: logger === "u_neha" ? `Mum's BP ${sys}/${dia}, took morning tablets, ${ex}` : `BP ${sys}/${dia}. Tablets taken, ${ex}` });
    }
    if (phase2 && d >= 1) {
      const nAt = atLocal(day, "13:00") + 20 * MIN;
      if (nAt <= end && rand() < 0.9) out.push({ at: nAt, userId: "u_sunita", body: rand() < 0.5 ? "Exercises done after lunch" : "did my afternoon exercises" });
      const sAt = atLocal(day, "11:00") + 15 * MIN;
      if (sAt <= end && rand() < 0.85) out.push({ at: sAt, userId: "u_sunita", body: "Stairs done, exercises done" });
    }
    const eAt = atLocal(day, "20:00") + (20 + Math.floor(rand() * 20)) * MIN;
    if (eAt > end || eAt < v1) continue;
    let pain = Math.max(1, Math.round(6 - 4.5 * f + jitter(1)));
    if (d === 8) pain = 8;
    const ex2 = !phase2 ? (rand() < 0.3 ? "skipped exercises, too painful" : "exercises done, walked 10 min") : rand() < 0.08 ? "skipped exercises today" : "exercises done, walked 20 min";
    const tabs = !phase2 && d === 5 ? "forgot the apixaban tonight" : "took evening tablets";
    out.push({ at: eAt, userId: rand() < 0.6 ? "u_neha" : "u_sunita", body: `Pain ${pain}/10, ${tabs}, ${ex2}. No fever, wound clean` });
  }
  return out;
}

function abdulScript(v1: number, end: number): Msg[] {
  const out: Msg[] = [];
  const d0 = dayStart(v1);
  for (let d = 1; d <= 10; d++) {
    const day = d0 + d * DAY;
    const mAt = atLocal(day, "09:00") + (10 + Math.floor(rand() * 30)) * MIN;
    if (mAt <= end - 3 * HOUR) {
      const spo2 = Math.round(94 + jitter(1.4));
      const hr = Math.round(90 + jitter(5));
      const sys = Math.round(140 + jitter(5));
      const dia = Math.round(86 + jitter(3));
      out.push({ at: mAt, userId: d % 3 === 0 ? "u_imran" : "u_abdul", body: d % 3 === 0 ? `Abba SpO2 ${spo2}, pulse ${hr}, BP ${sys}/${dia}. Inhalers taken` : `spo2 ${spo2} pulse ${hr} bp ${sys}/${dia} took inhalers and tablet` });
    }
    const bAt = atLocal(day, "11:00") + 20 * MIN;
    if (bAt <= end - 3 * HOUR && rand() < 0.8) out.push({ at: bAt, userId: "u_abdul", body: "breathing exercise done" });
    const eAt = atLocal(day, "18:00") + 30 * MIN;
    if (eAt <= end - 3 * HOUR && rand() < 0.75) out.push({ at: eAt, userId: "u_abdul", body: "did breathing exercises" });
    const nAt = atLocal(day, "21:00") + 15 * MIN;
    if (nAt <= end - 3 * HOUR) out.push({ at: nAt, userId: "u_abdul", body: pick(["Night inhaler taken. No fever, no smoking", "took night inhaler, feeling ok, steam done", "Night puffs taken, no symptoms"]) });
  }
  return out;
}

export async function seedDemo(): Promise<void> {
  rand = rng(42);
  const preservedSettings: Record<string, string> = {};
  try {
    const k = getSetting("gemini_api_key");
    if (k) preservedSettings["gemini_api_key"] = k;
    const m = getSetting("gemini_model");
    if (m) preservedSettings["gemini_model"] = m;
  } catch {}
  resetDb();
  for (const [k, v] of Object.entries(preservedSettings)) {
    setSetting(k, v);
  }
  resetClockCache();
  const realNow = now();
  const today = dayStart(realNow);
  insertUsers();

  // Visit timings
  const rV1 = atLocal(today - 28 * DAY, "10:30");
  const rNext = atLocal(today, "11:00");
  const sV1 = atLocal(today - 42 * DAY, "11:30");
  const sV2 = atLocal(today - 14 * DAY, "11:00");
  const sNext = atLocal(today + 14 * DAY, "11:00");
  const aV1 = atLocal(today - 10 * DAY, "12:00");
  const aNext = atLocal(today + 20 * DAY, "10:00");
  const simStart = sV1 - 30 * MIN;

  addPatient("p_ramesh", "u_ramesh", "Ramesh Kumar", 62, "M", "+91 98860 20001", "Hypertension · Heart failure (EF 35%) · Type 2 diabetes", "14, 3rd Cross, Jayanagar, Bengaluru", rV1 - 20 * MIN, [
    ["cg_ramesh_1", "u_lakshmi", "Lakshmi Kumar", "Wife", 1],
    ["cg_ramesh_2", "u_arjun", "Arjun Kumar", "Son", 2],
    ["cg_ramesh_3", "u_kavya", "Kavya Iyer", "Daughter", 3],
  ]);
  addPatient("p_sunita", "u_sunita", "Sunita Sharma", 68, "F", "+91 99000 30001", "Right total knee replacement (rehab) · Hypertension", "22, Indiranagar 2nd Stage, Bengaluru", sV1 - 20 * MIN, [
    ["cg_sunita_1", "u_neha", "Neha Sharma", "Daughter", 1],
    ["cg_sunita_2", "u_vikram", "Vikram Sharma", "Son", 2],
  ]);
  addPatient("p_abdul", "u_abdul", "Abdul Rahman", 71, "M", "+91 97400 40001", "COPD (moderate) · Hypertension", "7, Frazer Town, Bengaluru", aV1 - 20 * MIN, [
    ["cg_abdul_1", "u_imran", "Imran Rahman", "Son", 1],
    ["cg_abdul_2", "u_farah", "Farah Rahman", "Daughter-in-law", 2],
    ["cg_abdul_3", "u_joseph", "Joseph Mathew", "Neighbour", 3],
  ]);
  // consent replies
  const consent: Msg[] = [
    { at: rV1 - 15 * MIN, userId: "u_ramesh", body: "YES" },
    { at: sV1 - 12 * MIN, userId: "u_sunita", body: "Yes" },
    { at: aV1 - 10 * MIN, userId: "u_abdul", body: "yes" },
  ];

  const visits: VisitEvent[] = [
    { at: rV1, pid: "p_ramesh", vitals: { sys: 158, dia: 96, weight: 78.0, hr: 84, glucose: 168, spo2: 97 }, diagnosis: "Hypertension (uncontrolled); Heart failure with reduced EF (EF 35%); Type 2 diabetes mellitus", notes: "Started guideline-directed therapy. Home BP, pulse, daily weight, sugar thrice weekly. Educated on salt & fluid restriction and red-flag symptoms. Review in 4 weeks with home log.", plan: RAMESH_PLAN, next: rNext },
    { at: sV1, pid: "p_sunita", vitals: { sys: 148, dia: 88, weight: 71, hr: 80, pain: 6 }, diagnosis: "Post right total knee replacement (2 weeks); Hypertension", notes: "Wound healing well. Physio protocol phase 1. Apixaban for 4 weeks DVT prophylaxis. Watch for calf pain, fever, wound discharge.", plan: SUNITA_PLAN_1, next: sV2 },
    { at: sV2, pid: "p_sunita", vitals: { sys: 136, dia: 84, weight: 70.2, hr: 76, pain: 3 }, diagnosis: "Post right total knee replacement (6 weeks) — good recovery; Hypertension (controlled)", notes: "ROM 0–105°. Apixaban course completed — stopped. Paracetamol reduced to morning only. Progress to phase 2 physio with stairs and outdoor walking.", plan: SUNITA_PLAN_2, next: sNext },
    { at: aV1, pid: "p_abdul", vitals: { sys: 146, dia: 88, hr: 92, spo2: 93, weight: 64 }, diagnosis: "COPD (GOLD 2) — recent exacerbation, recovering; Hypertension", notes: "Inhaler technique reviewed. Daily SpO₂ and pulse. Pursed-lip breathing twice daily. Smoking cessation reinforced.", plan: ABDUL_PLAN, next: aNext },
  ];

  const abdulTrigger = realNow - 95 * MIN;
  const gopal = setupGopal(realNow);
  visits.push(gopal.latestVisit);
  const msgs: Msg[] = [
    ...consent,
    ...rameshScript(rV1, realNow - 5 * MIN),
    ...sunitaScript(sV1, sV2, realNow - 5 * MIN),
    ...abdulScript(aV1, abdulTrigger),
    { at: abdulTrigger, userId: "u_abdul", body: "SpO2 90, pulse 102, bp 142/88. Took inhalers. Feeling a bit tired today" },
    ...gopal.msgs,
  ];

  const rDay = (t: number) => Math.round((dayStart(t) - dayStart(rV1)) / DAY);
  const responder: ResponderFn = (esc) => {
    if (esc.patient_id === GOPAL.pid) return gopal.responder(esc);
    if (esc.patient_id === "p_abdul" && esc.started_at >= abdulTrigger - MIN) return { ackLevel: 99, ackAfter: 0, code: "1" };
    if (esc.patient_id === "p_ramesh") {
      const d = rDay(esc.started_at);
      if (esc.rule_key === "weight_gain") return { ackLevel: 2, ackAfter: 20, code: "2", note: "Called Dr. Rao's clinic — Priya advised an extra Furosemide 20 mg for 3 days, strict 1.5 L fluids, and to keep sending daily weight." };
      if (esc.rule_key === "sx:edema") return { ackLevel: 1, ackAfter: 25, code: "4", note: "Arjun already spoke to the clinic this morning; following the extra water-pill advice and keeping legs raised." };
      if (esc.rule_key.startsWith("physio:")) return { ackLevel: 1, ackAfter: 40, code: "4", note: "Knee pain — doing chair exercises instead, will show Dr. Rao at the visit." };
      if (esc.rule_key === "bp_high") return { ackLevel: 1, ackAfter: 20, code: "1" };
      void d;
      return { ackLevel: 1, ackAfter: 30, code: "1" };
    }
    if (esc.patient_id === "p_sunita" && esc.rule_key === "pain_high") return { ackLevel: 1, ackAfter: 15, code: "2", note: "Spoke to Priya at the clinic — continue paracetamol, ice after exercises, reduce sets for 2 days; review if worse." };
    return { ackLevel: esc.level, ackAfter: 30, code: "1" };
  };

  setSetting("last_tick", String(simStart));
  await simulate(simStart, realNow, msgs, visits, responder);
  setSetting("last_tick", String(realNow));
  setSetting("seeded_at", String(realNow));
  setSetting("clock_offset_ms", "0");
  resetClockCache();
}

// ---------------------------------------------------------------- live "simulate N days"
function genericScript(pid: string, from: number, to: number): Msg[] {
  const visit = latestVisit(pid, from);
  if (!visit) return [];
  const p = get<{ user_id: string; name: string }>("SELECT user_id, name FROM patients WHERE id = ?", pid)!;
  const cg = getCaregivers(pid)[0];
  const plan = visit.plan;
  const out: Msg[] = [];
  const last = (type: string) => get<{ v1: number; v2: number | null }>("SELECT v1, v2 FROM observations WHERE patient_id = ? AND type = ? ORDER BY observed_at DESC LIMIT 1", pid, type);
  const state = {
    sys: last("bp")?.v1 ?? visit.vitals.sys ?? 135,
    dia: last("bp")?.v2 ?? visit.vitals.dia ?? 85,
    weight: last("weight")?.v1 ?? visit.vitals.weight ?? 70,
    glucose: last("glucose")?.v1 ?? visit.vitals.glucose ?? 140,
    hr: last("hr")?.v1 ?? visit.vitals.hr ?? 78,
    spo2: last("spo2")?.v1 ?? visit.vitals.spo2 ?? 95,
    pain: last("pain")?.v1 ?? visit.vitals.pain ?? 3,
  };
  const times = new Set<string>();
  for (const m of plan.medications) m.times.forEach((x) => times.add(x));
  for (const m of plan.monitoring) m.times.forEach((x) => times.add(x));
  for (const m of plan.physio) m.times.forEach((x) => times.add(x));
  if (plan.checkinTime) times.add(plan.checkinTime);
  if (plan.fluid) times.add(plan.fluid.checkTime);
  for (let day = dayStart(from); day <= to; day += DAY) {
    const dow = localDow(day + 12 * HOUR);
    for (const hhmm of [...times].sort()) {
      const at = atLocal(day, hhmm) + (10 + Math.floor(rand() * 35)) * MIN;
      if (at <= from || at > to) continue;
      if (rand() < 0.08) continue; // forgot to respond
      const parts: string[] = [];
      for (const m of plan.monitoring.filter((x) => x.times.includes(hhmm) && (!x.days || x.days.includes(dow)))) {
        if (m.key === "bp") { state.sys = Math.round(state.sys * 0.8 + 0.2 * 132 + jitter(4)); state.dia = Math.round(state.dia * 0.8 + 0.2 * 82 + jitter(3)); parts.push(`BP ${state.sys}/${state.dia}`); }
        if (m.key === "weight") { state.weight = r1(state.weight + jitter(0.3)); parts.push(`weight ${state.weight}`); }
        if (m.key === "glucose") { state.glucose = Math.round(state.glucose * 0.85 + 0.15 * 130 + jitter(10)); parts.push(`sugar ${state.glucose}`); }
        if (m.key === "hr") { state.hr = Math.round(state.hr * 0.8 + 0.2 * 76 + jitter(3)); parts.push(`pulse ${state.hr}`); }
        if (m.key === "spo2") { state.spo2 = Math.min(99, Math.round(state.spo2 * 0.8 + 0.2 * 95 + jitter(1))); parts.push(`SpO2 ${state.spo2}`); }
        if (m.key === "pain") { state.pain = Math.max(0, Math.round(state.pain * 0.85 + jitter(1))); parts.push(`pain ${state.pain}/10`); }
      }
      const medsNow = plan.medications.filter((x) => x.times.includes(hhmm));
      if (medsNow.length) parts.push(rand() < 0.93 ? "took all tablets" : `forgot ${medsNow[0].name.split(" ")[0]}`);
      if (plan.physio.some((x) => x.times.includes(hhmm))) parts.push(rand() < 0.82 ? "exercises done" : "skipped exercises today");
      if (hhmm === plan.checkinTime) {
        if (rand() < 0.9) parts.push(pick(["no symptoms, diet ok", "feeling fine, salt ok", "all good, followed diet"]));
        else parts.push(`slight ${pick(["swelling", "cough", "headache", "dizziness"])}`);
      }
      if (plan.fluid && hhmm === plan.fluid.checkTime) {
        const lim = plan.fluid.limitMl;
        const fin = Math.round((lim * (0.85 + rand() * 0.25)) / 50) * 50;
        parts.push(`intake ${fin} ml, urine ${Math.round((fin * (0.75 + rand() * 0.2)) / 50) * 50} ml today`);
      }
      if (!parts.length) continue;
      const byCg = cg?.user_id && rand() < 0.3;
      out.push({ at, userId: byCg ? cg.user_id! : p.user_id, body: byCg ? `${shortName(p.name)}: ${parts.join(", ")}` : parts.join(", ") });
    }
  }
  return out;
}

export async function simulateDays(days: number): Promise<void> {
  rand = rng(Date.now() % 100000);
  const from = now();
  const to = from + days * DAY;
  const msgs = listPatients().flatMap((p) => genericScript(p.id, from, to));
  const last = Number(getSetting("last_tick") || from);
  await simulate(Math.max(last, from - 15 * MIN), to, msgs, [], genericResponder);
  advanceClock(days * DAY);
  setSetting("last_tick", String(to));
}

let seeding: Promise<void> | null = (globalThis as unknown as { __ccSeeding?: Promise<void> | null }).__ccSeeding ?? null;
export async function ensureSeeded(): Promise<void> {
  if (LIVE) return void getDb(); // live clinic: schema only, everything is onboarded through the UI
  const has = (() => {
    try {
      return !!get("SELECT 1 FROM users WHERE id = 'u_mom'");
    } catch {
      return false;
    }
  })();
  if (has) return;
  if (!seeding) {
    seeding = seedDemo().finally(() => {
      seeding = null;
      (globalThis as unknown as { __ccSeeding?: Promise<void> | null }).__ccSeeding = null;
    });
    (globalThis as unknown as { __ccSeeding?: Promise<void> | null }).__ccSeeding = seeding;
  }
  await seeding;
}

export async function reseed(): Promise<void> {
  await seedDemo();
}
