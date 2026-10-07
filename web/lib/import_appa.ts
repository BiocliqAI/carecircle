// Imports Appa's real history (the family's spreadsheet, extracted to lib/data/appa.json) into an existing patient of
// the live clinic, on the real dates. The baseline (intake record + Visit 1) is 13 Aug 2025; readings and labs from
// before it are kept as history, so trends show what led up to it. Each later prescription version is a visit, and the
// 03 Sep 2026 post-discharge visit sets the current plan.
//
// Nothing is sent and no alert is raised: past readings are written directly, and reminders start from `now`.
// Re-running replaces what an earlier import (or test messages) left in the patient's record; the WhatsApp thread,
// consents and care circle are kept.
import { all, audit, get, getSetting, run, setSetting, tx } from "./db";
import { addLab, addMedChange, getPatient } from "./engine";
import { atLocal, dayStart } from "./time";
import { LAB_META, type Baseline, type BaselineMed, type Medication } from "./types";
import { APPA, GOPAL_CHANGES, GOPAL_CONSULTANTS, GOPAL_DX, GOPAL_LATEST_PLAN, GOPAL_LATEST_VISIT, GOPAL_VISITS, LATEST_REAL, clinicVitals } from "./seed_gopal";

export const APPA_BASELINE = "2025-08-13";

/** A spreadsheet date (YYYY-MM-DD) at a local time of day. */
const at = (d: string, hhmm: string) => atLocal(dayStart(Date.parse(`${d}T12:00:00+05:30`)), hhmm);

function frequency(m: Medication): string {
  if (m.prn) return "PRN";
  if (m.everyNDays === 7) return "weekly";
  if (m.days?.length) return `${m.days.length}× a week`;
  return ["OD", "BD", "TDS", "QID"][m.times.length - 1] ?? `${m.times.length}× a day`;
}

export interface ImportSummary {
  visits: number;
  readings: number;
  labs: number;
  medChanges: number;
  firstReading: string;
  lastReading: string;
}

export function importAppa(pid: string, now: number): ImportSummary {
  const p = getPatient(pid);
  if (!p) throw new Error(`No patient ${pid}`);
  const doctor = p.doctor_id;
  const base = at(APPA_BASELINE, "11:00");
  const visits = GOPAL_VISITS.filter((v) => v.d >= APPA_BASELINE);
  const v1 = visits[0];
  if (v1?.d !== APPA_BASELINE) throw new Error(`No prescription version on ${APPA_BASELINE}`);

  return tx(() => {
    // ---------------------------------------------------------------- clear the clinical record
    const escs = all<{ id: number }>("SELECT id FROM escalations WHERE patient_id = ?", pid);
    for (const e of escs) {
      run("DELETE FROM escalation_events WHERE escalation_id = ?", e.id);
      run("DELETE FROM settings WHERE key = ?", `loop:${e.id}`);
    }
    for (const t of ["escalations", "observations", "labs", "med_changes", "tasks", "visits", "patient_baseline"]) run(`DELETE FROM ${t} WHERE patient_id = ?`, pid);
    run("DELETE FROM settings WHERE key LIKE ?", `recheck:${pid}:%`);
    for (const u of [p.user_id, ...all<{ user_id: string }>("SELECT user_id FROM caregivers WHERE patient_id = ? AND user_id IS NOT NULL", pid).map((c) => c.user_id)]) {
      if (u) run("DELETE FROM convo_state WHERE user_id = ? AND state IN ('awaiting_outcome','awaiting_note','clarify','symptom_q')", u);
    }

    // ---------------------------------------------------------------- patient, care team, baseline
    run("UPDATE patients SET conditions = ?, created_at = ? WHERE id = ?", GOPAL_DX.split(" · ").join(", "), at(APPA_BASELINE, "10:00"), pid);
    for (const [name, specialty] of GOPAL_CONSULTANTS) {
      if (!get("SELECT 1 FROM care_team WHERE patient_id = ? AND name = ?", pid, name)) run("INSERT INTO care_team(patient_id, name, specialty, role) VALUES(?,?,?,'CONSULTING')", pid, name, specialty);
    }
    // Baseline labs: the latest value of each test on or before the baseline date.
    const baseLabs = new Map<string, { marker: string; value: number; date: string }>();
    for (const l of APPA.labs) if (l.d <= APPA_BASELINE && LAB_META[l.m] && (baseLabs.get(l.m)?.date ?? "") <= l.d) baseLabs.set(l.m, { marker: l.m, value: l.v, date: l.d });
    const g = [...APPA.glucose].reverse().find((x) => x.d <= APPA_BASELINE && x.f);
    const baseline: Baseline = {
      vitals: { ...clinicVitals(APPA_BASELINE), ...(g?.f ? { glucose: g.f } : {}) },
      conditions: GOPAL_DX.split(" · "),
      allergies: "",
      history: "",
      familyHistory: "",
      smoking: "",
      alcohol: "",
      activity: "",
      diet: "Low salt; fluids about 1 litre/day",
      currentMeds: v1.plan.medications.map((m): BaselineMed => ({ name: m.name, dose: m.dose, frequency: frequency(m), prescriber: m.prescriber, purpose: m.purpose })),
      labs: [...baseLabs.values()],
      notes: "Imported from the family's spreadsheet (weights, sugars, BP, SpO₂, fluids, diuretic doses, labs and prescriptions since Jun 2025).",
    };
    run("INSERT INTO patient_baseline(patient_id, data, captured_at, captured_by, updated_at) VALUES(?,?,?,?,?)", pid, JSON.stringify(baseline), base, doctor, now);

    // ---------------------------------------------------------------- visits: each prescription version, then the latest
    const all_ = [
      ...visits.map((v) => ({ at: at(v.d, "11:00"), vitals: clinicVitals(v.d), dx: v.dx, notes: v.notes, plan: v.plan })),
      { at: at(LATEST_REAL, "11:00"), vitals: GOPAL_LATEST_VISIT.vitals, dx: GOPAL_LATEST_VISIT.diagnosis, notes: GOPAL_LATEST_VISIT.notes, plan: GOPAL_LATEST_PLAN },
    ];
    all_[0].notes = `Baseline (Visit 1). ${all_[0].notes}`;
    all_.forEach((v, i) => {
      const next = i + 1 < all_.length ? all_[i + 1].at : null;
      run("INSERT INTO visits(id, patient_id, doctor_id, visit_at, vitals, diagnosis, notes, plan, next_visit_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", `v_${pid}_${v.at}`, pid, doctor, v.at, JSON.stringify(v.vitals), v.dx, v.notes, JSON.stringify(v.plan), next, v.at);
    });
    setSetting(`gen:${pid}`, String(now)); // reminders follow the current plan from now on, nothing for the past

    // ---------------------------------------------------------------- home readings (all of them, including pre-baseline)
    let readings = 0;
    const obs = (type: string, v1: number, v2: number | null, text: string | null, t: number) => {
      run("INSERT INTO observations(patient_id, type, v1, v2, text, observed_at, logged_by, parser) VALUES(?,?,?,?,?,?,?,?)", pid, type, v1, v2, text, t, null, "import");
      readings++;
    };
    for (const w of APPA.weight) obs("weight", w.kg, null, null, at(w.d, "07:00"));
    // Fasting only: the sugar trend is a fasting series (the sheet's 2-hour post-meal values aren't comparable).
    for (const x of APPA.glucose) if (x.f) obs("glucose", x.f, null, "fasting", at(x.d, "07:00"));
    for (const b of APPA.bp) obs("bp", b.s, b.di, null, at(b.d, "08:00"));
    for (const s of APPA.spo2) obs("spo2", s.v, null, null, at(s.d, "08:00"));
    for (const f of APPA.fluid) {
      if (f.in) obs("fluid_in", f.in, null, "total", at(f.d, "21:00"));
      if (f.out) obs("urine_out", f.out, null, "total", at(f.d, "21:00"));
    }
    for (const x of APPA.diuretic) obs("diuretic", x.mg, null, x.drug, at(x.d, "08:00"));

    // ---------------------------------------------------------------- labs and other doctors' medicine changes
    let labs = 0;
    for (const l of APPA.labs) {
      const isBase = baseLabs.get(l.m)?.date === l.d && baseLabs.get(l.m)?.value === l.v;
      const { id } = addLab(pid, l.m, l.v, at(l.d, "09:00"), isBase ? "BASELINE" : "import", null, null);
      if (l.c) run("UPDATE labs SET mark = ? WHERE id = ?", l.c, id);
      labs++;
    }
    for (const c of GOPAL_CHANGES) {
      const id = addMedChange(pid, at(c.d, "12:00"), { medName: c.med, change: c.change, detail: c.detail, prescriber: c.by }, null, null, "import", c.status);
      run("UPDATE med_changes SET reviewed_by = ?, reviewed_at = ? WHERE id = ?", doctor, at(LATEST_REAL, "11:00"), id);
    }
    audit(now, "system", "HISTORY_IMPORTED", "patient", pid, { source: "family spreadsheet", baseline: APPA_BASELINE, visits: all_.length, readings, labs });

    const days = [...APPA.weight, ...APPA.glucose, ...APPA.bp, ...APPA.spo2, ...APPA.fluid, ...APPA.diuretic].map((x) => x.d).sort();
    return { visits: all_.length, readings, labs, medChanges: GOPAL_CHANGES.length, firstReading: days[0], lastReading: days.at(-1)! };
  });
}

/**
 * Live clinic: adds "A Gopal" with the spreadsheet history, once per database, as soon as the clinic has a doctor
 * (so a fresh deployment shows real trends without any manual step). A Gopal created by hand with no readings yet is
 * filled in instead of adding a second one. Skipped if a history import was already done
 * (e.g. into a patient of your choice) and never repeated after that. Turn off with CARECIRCLE_SAMPLE_PATIENT=off.
 */
export function ensureAppaSample(now: number): string | null {
  if (process.env.CARECIRCLE_SAMPLE_PATIENT === "off" || getSetting("sample:appa")) return null;
  if (get("SELECT 1 FROM audit WHERE action = 'HISTORY_IMPORTED'")) {
    setSetting("sample:appa", "imported earlier");
    return null;
  }
  // A Gopal already created by hand (with no readings yet): fill in that record rather than adding a second one.
  const existing = get<{ id: string }>(
    "SELECT p.id FROM patients p WHERE lower(p.name) LIKE '%gopal%' AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.patient_id = p.id) ORDER BY p.created_at LIMIT 1");
  if (existing) {
    importAppa(existing.id, now);
    setSetting("sample:appa", existing.id);
    return existing.id;
  }
  const doctor = get<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR' ORDER BY (name LIKE '%Dileep%') DESC, rowid LIMIT 1");
  if (!doctor) return null; // the clinic isn't set up yet: try again on a later request
  const pid = "p_appa", uid = "u_appa";
  let phone = "+91 90000 50001";
  for (let n = 2; get("SELECT 1 FROM patients WHERE phone = ?", phone); n++) phone = `+91 90000 5${String(n).padStart(4, "0")}`;
  run("INSERT INTO users(id, name, role, phone, title) VALUES(?,?,?,?,?)", uid, "A Gopal", "PATIENT", phone, "Patient");
  run("INSERT INTO patients(id, user_id, name, age, sex, phone, conditions, address, doctor_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", pid, uid, "A Gopal", 78, "M", phone, "", "", doctor.id, now);
  importAppa(pid, now);
  setSetting("sample:appa", pid);
  return pid;
}

/**
 * Adds spreadsheet fluid days that an earlier import didn't have (the "fluid IO" sheet, Jul–Dec 2025) to every patient
 * the history was imported into. Only days with no fluid entries are filled; nothing else changes. Runs once.
 */
export function topUpAppaFluids(): number {
  if (getSetting("sample:appa:fluids-v2")) return 0;
  let added = 0;
  const pids = all<{ entity_id: string }>("SELECT DISTINCT entity_id FROM audit WHERE action = 'HISTORY_IMPORTED' AND entity = 'patient'").map((r) => r.entity_id).filter((id) => getPatient(id));
  tx(() => {
    for (const pid of pids) {
      for (const f of APPA.fluid) {
        const day = at(f.d, "00:00");
        if (get("SELECT 1 FROM observations WHERE patient_id = ? AND type IN ('fluid_in','urine_out') AND observed_at >= ? AND observed_at < ?", pid, day, day + 86_400_000)) continue;
        for (const [type, v] of [["fluid_in", f.in], ["urine_out", f.out]] as const) {
          if (!v) continue;
          run("INSERT INTO observations(patient_id, type, v1, v2, text, observed_at, logged_by, parser) VALUES(?,?,?,?,?,?,?,?)", pid, type, v, null, "total", at(f.d, "21:00"), null, "import");
          added++;
        }
      }
    }
    setSetting("sample:appa:fluids-v2", String(added));
  });
  return added;
}

/** Adds the sheet's lab colours (red / yellow) to histories imported before they were carried over. Runs once. */
export function topUpAppaLabMarks(): number {
  if (getSetting("sample:appa:labmarks")) return 0;
  let n = 0;
  const pids = all<{ entity_id: string }>("SELECT DISTINCT entity_id FROM audit WHERE action = 'HISTORY_IMPORTED' AND entity = 'patient'").map((r) => r.entity_id).filter((id) => getPatient(id));
  tx(() => {
    for (const pid of pids) {
      for (const l of APPA.labs) {
        if (!l.c) continue;
        n += run("UPDATE labs SET mark = ? WHERE patient_id = ? AND marker = ? AND value = ? AND taken_at = ? AND source IN ('import','BASELINE') AND mark IS NULL", l.c, pid, l.m, l.v, at(l.d, "09:00")).changes;
      }
    }
    setSetting("sample:appa:labmarks", String(n));
  });
  return n;
}
