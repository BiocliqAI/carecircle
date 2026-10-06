// Shared domain types for the CareCircle MVP.

export type Role = "ADMIN" | "DOCTOR" | "PA" | "PATIENT" | "CAREGIVER";

/** Care circle size for the current product scope: a primary and a backup caregiver. */
export const MAX_CAREGIVERS = 2;

export type VitalType = "bp" | "weight" | "glucose" | "hr" | "spo2" | "temp" | "pain";

export interface Medication {
  key: string;
  name: string;
  dose: string;
  times: string[]; // "HH:MM" local clinic time
  instructions?: string;
  /** Per-time dose when it differs (parallel to `times`), e.g. Lasix ["40 mg", "20 mg"]. */
  doses?: string[];
  /** Days of week (0=Sun..6=Sat). Omitted = every day. */
  days?: number[];
  /** Every N days counted from the visit day (2 = alternate days). */
  everyNDays?: number;
  /** Course length in days from the visit (e.g. antibiotic for 7 days). */
  courseDays?: number;
  /** Starts this many days after the visit (the second step of a taper, e.g. 20 mg from day 15). */
  startDay?: number;
  /** Only if required — never scheduled or counted for adherence. */
  prn?: boolean;
  /** Care-team member who prescribed it (name). */
  prescriber?: string;
  purpose?: string;
}

export interface MonitorItem {
  key: VitalType;
  times: string[];
  days?: number[]; // 0=Sun..6=Sat; omitted = every day
}

export interface PhysioItem {
  key: string;
  name: string;
  detail: string;
  times: string[];
}

export interface LifestyleItem {
  key: string;
  text: string;
}

export interface Thresholds {
  sysHigh: number;
  diaHigh: number;
  sysLow: number;
  weightGainKg: number; // gain within 3 days that counts as a deviation
  glucoseHigh: number;
  glucoseLow: number;
  hrHigh: number;
  hrLow: number;
  spo2Low: number;
  painHigh: number;
  // ---- kidney / heart-failure (optional)
  dryWeight?: number; // doctor's target ("dry") weight, kg
  weightBand?: number; // ± kg allowed around dry weight
  weightDayGainKg?: number; // gain vs previous day's weight
  kHigh?: number;
  kLow?: number;
  naLow?: number;
  naHigh?: number;
  creatRiseAbs?: number; // mg/dL rise vs previous result
  creatRisePct?: number; // % rise vs result before the visit
  hbLow?: number;
}

export interface FluidPlan {
  limitMl: number; // daily intake limit
  checkTime: string; // evening prompt for day totals (intake + urine)
  lowOutputMl: number; // daily urine below this = deviation
  ratioLow: number; // output/intake ratio below this on 2 days = deviation
}

export interface LabPlan {
  panel: string; // e.g. "RFT + electrolytes + uric acid"
  everyDays: number;
}

export interface EscalationTimers {
  complianceMin: number;
  deviationMin: number;
  urgentMin: number;
}

export interface CarePlan {
  medications: Medication[];
  monitoring: MonitorItem[];
  physio: PhysioItem[];
  lifestyle: LifestyleItem[];
  checkinTime: string; // daily symptom + lifestyle check-in
  watchSymptoms: string[]; // symptom keys that trigger a care-circle deviation alert
  thresholds: Thresholds;
  escalation: EscalationTimers;
  fluid?: FluidPlan;
  labs?: LabPlan;
  template?: string; // e.g. "kidney"
}

export interface ClinicVitals {
  sys?: number;
  dia?: number;
  weight?: number;
  hr?: number;
  glucose?: number;
  spo2?: number;
  pain?: number;
}

export interface Visit {
  id: string;
  patient_id: string;
  doctor_id: string;
  visit_at: number;
  vitals: ClinicVitals;
  diagnosis: string;
  notes: string;
  plan: CarePlan;
  next_visit_at: number | null;
  created_at: number;
}

export type TaskKind = "med" | "vital" | "physio" | "checkin" | "fluid" | "lab";
export type TaskStatus = "PENDING" | "DONE" | "NOT_DONE" | "MISSED" | "CANCELLED";

export type EscalationType = "COMPLIANCE" | "DEVIATION" | "URGENT";
export type EscalationState = "NOTIFIED" | "ACKNOWLEDGED" | "RESOLVED" | "EXHAUSTED";

export interface ParsedVital {
  type: VitalType;
  v1: number;
  v2?: number;
}

export interface ParsedSymptom {
  key: string;
  severity: "mild" | "moderate" | "severe";
  text: string;
}

export interface ParsedFluid {
  kind: "in" | "out"; // intake / urine output
  ml: number;
  total: boolean; // true = day total so far, false = add to today's total
}

export interface ParsedLab {
  marker: string; // LAB_META key
  value: number;
}

export interface ParsedMedChange {
  medName: string;
  change: "started" | "stopped" | "dose_changed" | "other";
  detail: string;
  prescriber: string | null;
}

export interface ParsedMessage {
  vitals: ParsedVital[];
  meds: { allTaken: boolean; allMissed: boolean; taken: string[]; missed: string[] };
  physio: "done" | "not_done" | null;
  lifestyle: "ok" | "not_ok" | null;
  symptoms: ParsedSymptom[];
  noSymptoms: boolean;
  help: boolean;
  fluids: ParsedFluid[];
  labs: ParsedLab[];
  medChanges: ParsedMedChange[];
  /** The sender is telling us about a visit to / advice from another doctor (Gemini only). */
  outsideVisit?: boolean;
}

export const VITAL_META: Record<VitalType, { label: string; unit: string }> = {
  bp: { label: "Blood pressure", unit: "mmHg" },
  weight: { label: "Weight", unit: "kg" },
  glucose: { label: "Blood sugar", unit: "mg/dL" },
  hr: { label: "Pulse", unit: "bpm" },
  spo2: { label: "SpO₂", unit: "%" },
  temp: { label: "Temperature", unit: "°F" },
  pain: { label: "Pain score", unit: "/10" },
};

export const SYMPTOMS: Record<string, string> = {
  edema: "Ankle / leg swelling",
  breathlessness: "Breathlessness",
  orthopnea: "Breathless lying flat",
  chest_pain: "Chest pain",
  dizziness: "Dizziness",
  fainting: "Fainting / collapse",
  confusion: "Confusion / unusual drowsiness",
  palpitations: "Palpitations",
  fatigue: "Fatigue / weakness",
  headache: "Headache",
  cough: "Cough",
  knee_pain: "Knee / joint pain",
  calf_pain: "Calf pain / swelling",
  fever: "Fever",
  wound: "Wound redness / discharge",
  nausea: "Nausea / vomiting",
  diarrhoea: "Loose stools / diarrhoea",
  low_urine: "Passing less urine",
  itching: "Itching",
  cramps: "Muscle cramps",
  appetite: "Poor appetite",
  hypo: "Sweating / shakiness",
};

/** Lab catalogue (units as reported by Indian labs). `kidney` = shown in the kidney panel. */
export const LAB_META: Record<string, { label: string; unit: string; kidney?: boolean; lowerBetter?: boolean; digits?: number }> = {
  creatinine: { label: "Creatinine", unit: "mg/dL", kidney: true, lowerBetter: true, digits: 2 },
  egfr: { label: "eGFR", unit: "mL/min/1.73m²", kidney: true, digits: 0 },
  urea: { label: "Urea", unit: "mg/dL", kidney: true, lowerBetter: true, digits: 0 },
  potassium: { label: "Potassium (K)", unit: "mmol/L", kidney: true, digits: 1 },
  sodium: { label: "Sodium (Na)", unit: "mmol/L", kidney: true, digits: 0 },
  uric_acid: { label: "Uric acid", unit: "mg/dL", kidney: true, lowerBetter: true, digits: 1 },
  hb: { label: "Haemoglobin", unit: "g/dL", kidney: true, digits: 1 },
  ntprobnp: { label: "NT-proBNP", unit: "pg/mL", kidney: true, lowerBetter: true, digits: 0 },
  bicarbonate: { label: "Bicarbonate", unit: "mmol/L", digits: 0 },
  chloride: { label: "Chloride", unit: "mmol/L", digits: 0 },
  calcium: { label: "Calcium", unit: "mg/dL", digits: 1 },
  phosphorus: { label: "Phosphorus", unit: "mg/dL", lowerBetter: true, digits: 1 },
  magnesium: { label: "Magnesium", unit: "mg/dL", digits: 1 },
  albumin: { label: "Albumin", unit: "g/dL", digits: 1 },
  hba1c: { label: "HbA1c", unit: "%", lowerBetter: true, digits: 1 },
  wbc: { label: "WBC", unit: "/µL", digits: 0 },
  ldl: { label: "LDL cholesterol", unit: "mg/dL", lowerBetter: true, digits: 0 },
  vitd: { label: "Vitamin D", unit: "ng/mL", digits: 1 },
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  sysHigh: 150,
  diaHigh: 95,
  sysLow: 100,
  weightGainKg: 2,
  glucoseHigh: 250,
  glucoseLow: 70,
  hrHigh: 110,
  hrLow: 50,
  spo2Low: 92,
  painHigh: 7,
};

export const DEFAULT_TIMERS: EscalationTimers = {
  complianceMin: 120,
  deviationMin: 60,
  urgentMin: 15,
};

/** Kidney (CKD + heart failure / cardiorenal) template: monitoring, limits, symptoms. Doctor edits before saving. */
export const KIDNEY_TEMPLATE = {
  monitoring: [
    { key: "weight", times: ["07:00"] },
    { key: "bp", times: ["08:00"] },
    { key: "glucose", times: ["07:00"] },
  ] as MonitorItem[],
  fluid: { limitMl: 1000, checkTime: "21:00", lowOutputMl: 500, ratioLow: 0.6 } as FluidPlan,
  labs: { panel: "RFT (creatinine, urea, eGFR) + Na/K + uric acid", everyDays: 28 } as LabPlan,
  thresholds: { weightBand: 1.0, weightDayGainKg: 1.0, weightGainKg: 2, kHigh: 5.0, kLow: 3.5, naLow: 132, naHigh: 148, creatRiseAbs: 0.3, creatRisePct: 25, hbLow: 8, sysLow: 100 } as Partial<Thresholds>,
  watchSymptoms: ["edema", "breathlessness", "orthopnea", "low_urine", "diarrhoea", "nausea", "dizziness", "cramps"],
  lifestyle: [
    { key: "fluid", text: "Total fluids (water, tea, soup, milk) within the daily limit" },
    { key: "salt", text: "Salt under 5 g/day — no pickles, papad, salted snacks" },
    { key: "potassium", text: "Low-potassium diet — limit banana, coconut water, tomato, oranges" },
    { key: "nsaid", text: "No painkillers like ibuprofen/diclofenac without the nephrologist" },
  ] as LifestyleItem[],
};

const DIURETIC_RE = /furosemide|lasix|torsemide|dytor|metolazone|zytanix|spironolactone|aldactone|bumetanide|eplerenone|chlorthalidone|hydrochlorothiazide/i;
export const isDiuretic = (name: string) => DIURETIC_RE.test(name);
/** mg in a dose string, e.g. "40 mg" -> 40, "½ tab (10 mg)" -> 10. */
export function doseMg(dose: string | undefined): number | null {
  const m = (dose || "").match(/(\d+(?:\.\d+)?)\s*mg/i);
  return m ? Number(m[1]) : null;
}

/** Name used in friendly messages: skips leading initials ("A Gopal" -> "Gopal", "Dr. Meera Rao" -> "Meera"). */
export function shortName(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.find((p) => p.replace(/\./g, "").length > 1 && !/^dr\.?$/i.test(p)) ?? parts[0] ?? name;
}

// ---------------------------------------------------------------- live clinic: baseline intake
/** Medicine the patient was already taking when onboarded (before the clinic's care plan). */
export interface BaselineMed {
  name: string;
  dose: string;
  frequency: string; // OD | BD | TDS | QID | HS | weekly | PRN | free text
  prescriber?: string;
  purpose?: string;
}

export interface BaselineLab {
  marker: string; // LAB_META key
  value: number;
  date: string; // YYYY-MM-DD
}

/** Baseline captured at registration (usually by the PA) — the reference point for the first visit. */
export interface Baseline {
  dob?: string; // YYYY-MM-DD
  language?: string;
  bloodGroup?: string;
  heightCm?: number;
  vitals: ClinicVitals; // intake vitals taken at registration
  conditions: string[];
  allergies: string;
  history: string; // past surgeries / hospitalisations
  familyHistory: string;
  smoking: "" | "never" | "former" | "current";
  alcohol: "" | "never" | "occasional" | "regular";
  activity: "" | "sedentary" | "light" | "active";
  diet: string;
  currentMeds: BaselineMed[];
  labs: BaselineLab[];
  notes: string;
}

export const EMPTY_BASELINE: Baseline = {
  vitals: {},
  conditions: [],
  allergies: "",
  history: "",
  familyHistory: "",
  smoking: "",
  alcohol: "",
  activity: "",
  diet: "",
  currentMeds: [],
  labs: [],
  notes: "",
};

/** Default reminder times for common prescription shorthand. */
export const FREQ_TIMES: Record<string, string[]> = {
  OD: ["08:00"],
  BD: ["08:00", "20:00"],
  TDS: ["08:00", "14:00", "20:00"],
  QID: ["08:00", "12:00", "16:00", "20:00"],
  HS: ["21:30"],
  weekly: ["08:00"],
  PRN: ["08:00"],
};

export function ageFromDob(dob: string | undefined, at: number): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  const n = new Date(at);
  let age = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

export function bmi(heightCm: number | undefined, weightKg: number | undefined): number | null {
  if (!heightCm || !weightKg) return null;
  return Math.round((weightKg / (heightCm / 100) ** 2) * 10) / 10;
}
