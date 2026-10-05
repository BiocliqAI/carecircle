// Visit preparation (assistant, before the visit): attendance, check-in vitals, flags and questions for
// the doctor, then "ready". The doctor's consult view reads it; recording the visit clears it.
import { audit, get, run } from "./db";
import { getUser } from "./engine";

export interface PrepFlag { id: string; text: string; medChangeId?: number }
export interface Prep {
  attendance: boolean;
  attendanceNote: string;
  vitals: { bp?: string; weight?: string; hr?: string; glucose?: string; spo2?: string };
  vitalsAt: number | null;
  vitalsBy: string | null;
  docsChecked: boolean;
  flags: PrepFlag[];
  questions: string;
  readyAt: number | null;
  readyBy: string | null;
}

export const EMPTY_PREP: Prep = { attendance: false, attendanceNote: "", vitals: {}, vitalsAt: null, vitalsBy: null, docsChecked: false, flags: [], questions: "", readyAt: null, readyBy: null };

export function getPrep(pid: string): Prep & { updatedAt: number | null; readyByName: string | null; vitalsByName: string | null } {
  const r = get<{ data: string; updated_at: number }>("SELECT data, updated_at FROM visit_prep WHERE patient_id = ?", pid);
  const d: Prep = r ? { ...EMPTY_PREP, ...(JSON.parse(r.data) as Partial<Prep>) } : { ...EMPTY_PREP };
  return { ...d, updatedAt: r?.updated_at ?? null, readyByName: d.readyBy ? getUser(d.readyBy)?.name ?? null : null, vitalsByName: d.vitalsBy ? getUser(d.vitalsBy)?.name ?? null : null };
}

export function savePrep(pid: string, patch: Partial<Prep>, t: number, actor: string): Prep {
  const cur = getPrep(pid);
  const next: Prep = {
    attendance: patch.attendance ?? cur.attendance,
    attendanceNote: (patch.attendanceNote ?? cur.attendanceNote).slice(0, 300),
    vitals: patch.vitals ? Object.fromEntries(Object.entries(patch.vitals).map(([k, v]) => [k, String(v ?? "").slice(0, 20)])) : cur.vitals,
    vitalsAt: patch.vitals ? t : cur.vitalsAt,
    vitalsBy: patch.vitals ? actor : cur.vitalsBy,
    docsChecked: patch.docsChecked ?? cur.docsChecked,
    flags: (patch.flags ?? cur.flags).slice(0, 20).map((f) => ({ id: String(f.id).slice(0, 40), text: String(f.text).slice(0, 500), medChangeId: f.medChangeId })),
    questions: (patch.questions ?? cur.questions).slice(0, 2000),
    readyAt: patch.readyAt !== undefined ? patch.readyAt : cur.readyAt,
    readyBy: patch.readyAt !== undefined ? (patch.readyAt ? actor : null) : cur.readyBy,
  };
  run("INSERT INTO visit_prep(patient_id, data, updated_by, updated_at) VALUES(?,?,?,?) ON CONFLICT(patient_id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at", pid, JSON.stringify(next), actor, t);
  if (patch.readyAt) audit(t, actor, "VISIT_PREPARED", "patient", pid);
  return next;
}

export function clearPrep(pid: string) {
  run("DELETE FROM visit_prep WHERE patient_id = ?", pid);
}
