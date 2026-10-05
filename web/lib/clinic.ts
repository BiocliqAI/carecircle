// Live-clinic administration: clinic setup, staff, baseline intake and the onboarding checklist.
// Patients and caregivers are still onboarded through engine.onboardPatient so the WhatsApp flows
// (welcome, consent, care plan) are identical in demo and live mode.
import { all, audit, get, getSetting, resetDb, run, setSetting, tx } from "./db";
import { resetClockCache } from "./clock";
import { addLab, getPatient, getUser } from "./engine";
import { LAB_META, type Baseline, type BaselineLab, type BaselineMed, type ClinicVitals, EMPTY_BASELINE } from "./types";

export interface Clinic {
  name: string;
  address: string;
  phone: string;
  setupAt: number;
}

export interface StaffInput {
  name: string;
  role: "DOCTOR" | "PA";
  title: string; // specialty / designation shown under the name
  phone: string;
  email: string;
  regNo: string; // medical council registration (doctors)
}

export interface StaffRow {
  id: string;
  name: string;
  role: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  reg_no: string | null;
  created_at: number | null;
  patients: number;
}

export function getClinic(): Clinic | null {
  const raw = getSetting("clinic");
  return raw ? (JSON.parse(raw) as Clinic) : null;
}

const slugify = (s: string) => s.toLowerCase().replace(/^dr\.?\s+/, "").replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "").slice(0, 20) || "user";
const normPhone = (p: string) => p.replace(/[^\d+]/g, "");

function validateStaff(s: StaffInput): string | null {
  if (!s.name?.trim()) return "Name is required";
  if (s.role !== "DOCTOR" && s.role !== "PA") return "Role must be Doctor or Physician Assistant";
  if (!s.phone || !/^\+?[\d\s-]{8,}$/.test(s.phone)) return "A valid phone number is required";
  if (s.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) return "Email address looks invalid";
  const dup = all<{ phone: string | null }>("SELECT phone FROM users WHERE role IN ('DOCTOR','PA')").some((u) => u.phone && normPhone(u.phone) === normPhone(s.phone));
  if (dup) return "A staff member with this phone number already exists";
  return null;
}

export function addStaff(s: StaffInput, t: number, actor: string | null): string {
  const e = validateStaff(s);
  if (e) throw new Error(e);
  const name = s.role === "DOCTOR" && !/^dr\.?\s/i.test(s.name.trim()) ? `Dr. ${s.name.trim()}` : s.name.trim();
  let id = `u_${s.role === "DOCTOR" ? "dr" : "pa"}_${slugify(name)}`;
  while (getUser(id)) id += "_2";
  run(
    "INSERT INTO users(id, name, role, phone, title, email, reg_no, created_at) VALUES(?,?,?,?,?,?,?,?)",
    id, name, s.role, s.phone.trim(), s.title?.trim() || (s.role === "DOCTOR" ? "Doctor" : "Physician Assistant"), s.email?.trim() || null, s.regNo?.trim() || null, t,
  );
  audit(t, actor ?? id, "STAFF_ADDED", "user", id, { role: s.role, name });
  return id;
}

export function listStaff(): StaffRow[] {
  return all<StaffRow>(
    `SELECT u.id, u.name, u.role, u.title, u.phone, u.email, u.reg_no, u.created_at,
       (SELECT COUNT(*) FROM patients p WHERE p.doctor_id = u.id) AS patients
     FROM users u WHERE u.role IN ('DOCTOR','PA') ORDER BY CASE u.role WHEN 'DOCTOR' THEN 0 ELSE 1 END, u.name`,
  );
}

export function listDoctors(): { id: string; name: string; title: string | null }[] {
  return all("SELECT id, name, title FROM users WHERE role = 'DOCTOR' ORDER BY name");
}

/** First-run setup: the clinic and its first doctor. Returns the doctor's user id (signed in next). */
export function setupClinic(clinic: Omit<Clinic, "setupAt">, doctor: Omit<StaffInput, "role">, t: number): string {
  if (getClinic()) throw new Error("The clinic is already set up");
  if (!clinic.name?.trim()) throw new Error("Clinic name is required");
  return tx(() => {
    setSetting("clinic", JSON.stringify({ name: clinic.name.trim(), address: clinic.address?.trim() || "", phone: clinic.phone?.trim() || "", setupAt: t } satisfies Clinic));
    const id = addStaff({ ...doctor, role: "DOCTOR" }, t, null);
    audit(t, id, "CLINIC_SETUP", "clinic", "clinic", { name: clinic.name.trim() });
    return id;
  });
}

export function updateClinic(c: Partial<Omit<Clinic, "setupAt">>, t: number, actor: string) {
  const cur = getClinic();
  if (!cur) throw new Error("The clinic is not set up yet");
  const next: Clinic = { ...cur, ...Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, (v as string).trim()])) };
  if (!next.name) throw new Error("Clinic name is required");
  setSetting("clinic", JSON.stringify(next));
  audit(t, actor, "CLINIC_UPDATED", "clinic", "clinic", c);
}

/** Erase everything (live mode, between customer demos). Keeps the Gemini settings. */
export function resetClinic() {
  const keep = ["gemini_api_key", "gemini_model"].map((k) => [k, getSetting(k)] as const).filter(([, v]) => v);
  resetDb();
  for (const [k, v] of keep) setSetting(k, v!);
  resetClockCache();
}

// ---------------------------------------------------------------- baseline
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validates and normalises a baseline coming from the browser. Returns an error string on bad input. */
export function cleanBaseline(raw: Partial<Baseline> | undefined, t: number): Baseline | string {
  const r = raw ?? {};
  const b: Baseline = { ...EMPTY_BASELINE, vitals: {}, conditions: [], currentMeds: [], labs: [] };
  if (r.dob) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.dob) || Date.parse(r.dob) > t) return "Date of birth must be a valid past date";
    b.dob = r.dob;
  }
  b.language = str(r.language, 40) || undefined;
  b.bloodGroup = str(r.bloodGroup, 5) || undefined;
  b.heightCm = num(r.heightCm);
  if (b.heightCm !== undefined && (b.heightCm < 40 || b.heightCm > 250)) return "Height should be in cm (40–250)";
  const ranges: Record<keyof ClinicVitals, [number, number]> = { sys: [60, 260], dia: [30, 160], weight: [2, 300], hr: [20, 250], glucose: [20, 800], spo2: [50, 100], pain: [0, 10] };
  for (const [k, [lo, hi]] of Object.entries(ranges) as [keyof ClinicVitals, [number, number]][]) {
    const v = num(r.vitals?.[k]);
    if (v === undefined) continue;
    if (v < lo || v > hi) return `Intake ${k} value ${v} is out of range`;
    b.vitals[k] = v;
  }
  b.conditions = (r.conditions ?? []).map((c) => str(c, 120)).filter(Boolean);
  b.allergies = str(r.allergies);
  b.history = str(r.history);
  b.familyHistory = str(r.familyHistory);
  b.smoking = (["never", "former", "current"] as const).find((x) => x === r.smoking) ?? "";
  b.alcohol = (["never", "occasional", "regular"] as const).find((x) => x === r.alcohol) ?? "";
  b.activity = (["sedentary", "light", "active"] as const).find((x) => x === r.activity) ?? "";
  b.diet = str(r.diet, 200);
  b.notes = str(r.notes);
  b.currentMeds = (r.currentMeds ?? [])
    .filter((m) => m?.name?.trim())
    .map((m): BaselineMed => ({ name: str(m.name, 80), dose: str(m.dose, 40), frequency: str(m.frequency, 40) || "OD", prescriber: str(m.prescriber, 80) || undefined, purpose: str(m.purpose, 80) || undefined }));
  const labs: BaselineLab[] = [];
  for (const l of r.labs ?? []) {
    if (!l?.marker) continue;
    if (!(l.marker in LAB_META)) return `Unknown lab test "${l.marker}"`;
    const v = num(l.value);
    if (v === undefined) return `Enter a value for ${LAB_META[l.marker].label}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date || "") || Date.parse(l.date) > t + 86_400_000) return `Enter a valid report date for ${LAB_META[l.marker].label}`;
    labs.push({ marker: l.marker, value: v, date: l.date });
  }
  b.labs = labs;
  return b;
}

export function getBaseline(pid: string): (Baseline & { capturedAt: number; capturedBy: string | null; updatedAt: number }) | null {
  const r = get<{ data: string; captured_at: number; captured_by: string | null; updated_at: number }>("SELECT * FROM patient_baseline WHERE patient_id = ?", pid);
  if (!r) return null;
  return { ...EMPTY_BASELINE, ...(JSON.parse(r.data) as Baseline), capturedAt: r.captured_at, capturedBy: r.captured_by ? getUser(r.captured_by)?.name ?? r.captured_by : null, updatedAt: r.updated_at };
}

/**
 * Saves the baseline. Baseline lab reports are written into the longitudinal lab record (source BASELINE)
 * so trends start from them; they never raise care-circle alerts (there is no care plan yet).
 */
export function saveBaseline(pid: string, b: Baseline, t: number, actor: string) {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  tx(() => {
    const existing = get<{ captured_at: number; captured_by: string | null }>("SELECT captured_at, captured_by FROM patient_baseline WHERE patient_id = ?", pid);
    run(
      `INSERT INTO patient_baseline(patient_id, data, captured_at, captured_by, updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(patient_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      pid, JSON.stringify(b), existing?.captured_at ?? t, existing?.captured_by ?? actor, t,
    );
    run("DELETE FROM labs WHERE patient_id = ? AND source = 'BASELINE'", pid);
    for (const l of b.labs) addLab(pid, l.marker, l.value, Date.parse(`${l.date}T09:00:00+05:30`), "BASELINE", actor, null);
    if (b.conditions.length) run("UPDATE patients SET conditions = ? WHERE id = ?", b.conditions.join(", "), pid);
    audit(t, actor, existing ? "BASELINE_UPDATED" : "BASELINE_CAPTURED", "patient", pid, { meds: b.currentMeds.length, labs: b.labs.length });
  });
}

// ---------------------------------------------------------------- onboarding checklist
export function checklist() {
  const n = (sql: string) => get<{ n: number }>(sql)?.n ?? 0;
  return {
    clinic: !!getClinic(),
    doctors: n("SELECT COUNT(*) AS n FROM users WHERE role = 'DOCTOR'"),
    pas: n("SELECT COUNT(*) AS n FROM users WHERE role = 'PA'"),
    patients: n("SELECT COUNT(*) AS n FROM patients"),
    caregivers: n("SELECT COUNT(*) AS n FROM caregivers"),
    baselines: n("SELECT COUNT(*) AS n FROM patient_baseline"),
    withVisit: n("SELECT COUNT(DISTINCT patient_id) AS n FROM visits"),
    consentsGiven: n("SELECT COUNT(*) AS n FROM consents WHERE status = 'GIVEN'"),
    consentsPending: n("SELECT COUNT(*) AS n FROM consents WHERE status = 'PENDING'"),
    inbound: n("SELECT COUNT(*) AS n FROM messages WHERE direction = 'IN'"),
    escalations: n("SELECT COUNT(*) AS n FROM escalations"),
  };
}

// ---------------------------------------------------------------- onboarding drafts
// Saved on every "Continue" in the onboarding wizard so any clinician can resume later.
// Nothing is sent on WhatsApp until the patient is actually created.
export interface DraftRow {
  id: string;
  name: string;
  step: number;
  created_by: string | null;
  created_at: number;
  updated_by: string | null;
  updated_at: number;
}

export function saveDraft(id: string | null, step: number, data: unknown, t: number, actor: string): string {
  const d = (data ?? {}) as { f?: { name?: string } };
  const name = d.f?.name?.trim() || "Unnamed patient";
  const json = JSON.stringify(data ?? {});
  if (json.length > 200_000) throw new Error("Draft is too large");
  const s = Math.max(0, Math.min(3, Math.floor(Number(step) || 0)));
  if (id && get("SELECT 1 FROM onboarding_drafts WHERE id = ?", id)) {
    run("UPDATE onboarding_drafts SET name = ?, step = ?, data = ?, updated_by = ?, updated_at = ? WHERE id = ?", name, s, json, actor, t, id);
    return id;
  }
  const nid = `d_${t.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  run("INSERT INTO onboarding_drafts(id, name, step, data, created_by, created_at, updated_by, updated_at) VALUES(?,?,?,?,?,?,?,?)", nid, name, s, json, actor, t, actor, t);
  audit(t, actor, "ONBOARDING_DRAFT_STARTED", "draft", nid, { name });
  return nid;
}

export function getDraft(id: string): (DraftRow & { data: unknown }) | null {
  const r = get<DraftRow & { data: string }>("SELECT * FROM onboarding_drafts WHERE id = ?", id);
  return r ? { ...r, data: JSON.parse(r.data) } : null;
}

export function listDrafts(): (DraftRow & { updated_by_name: string | null; created_by_name: string | null })[] {
  return all<DraftRow>("SELECT id, name, step, created_by, created_at, updated_by, updated_at FROM onboarding_drafts ORDER BY updated_at DESC").map((d) => ({
    ...d,
    updated_by_name: d.updated_by ? getUser(d.updated_by)?.name ?? null : null,
    created_by_name: d.created_by ? getUser(d.created_by)?.name ?? null : null,
  }));
}

export function deleteDraft(id: string) {
  run("DELETE FROM onboarding_drafts WHERE id = ?", id);
}
