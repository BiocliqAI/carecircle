// "Key vitals" on the patient overview: the most recent measurement of each vital, wherever it came from
// (a reading the family logged, the vitals taken at a clinic visit, or the intake vitals in the baseline).
import { all } from "./db";
import { getBaseline } from "./clinic";
import type { ClinicVitals, VitalType } from "./types";

export interface KeyVital { type: VitalType; v1: number; v2: number | null; at: number; flag: string | null; source: "home" | "clinic" | "baseline" }

const ORDER: VitalType[] = ["bp", "weight", "glucose", "spo2", "hr", "temp", "pain"];

function fromClinic(v: ClinicVitals, at: number, source: "clinic" | "baseline"): KeyVital[] {
  const out: KeyVital[] = [];
  const add = (type: VitalType, v1: number | undefined, v2: number | undefined = undefined) => {
    if (typeof v1 === "number" && Number.isFinite(v1)) out.push({ type, v1, v2: typeof v2 === "number" ? v2 : null, at, flag: null, source });
  };
  add("bp", v.sys, v.dia);
  add("weight", v.weight);
  add("glucose", v.glucose);
  add("spo2", v.spo2);
  add("hr", v.hr);
  add("pain", v.pain);
  return out;
}

export function keyVitals(pid: string): KeyVital[] {
  const found: KeyVital[] = [];
  for (const type of ORDER) {
    const r = all<{ v1: number | null; v2: number | null; observed_at: number; flag: string | null }>(
      "SELECT v1, v2, observed_at, flag FROM observations WHERE patient_id = ? AND type = ? AND v1 IS NOT NULL ORDER BY observed_at DESC, id DESC LIMIT 1", pid, type)[0];
    if (r && r.v1 !== null) found.push({ type, v1: r.v1, v2: r.v2, at: r.observed_at, flag: r.flag, source: "home" });
  }
  for (const v of all<{ visit_at: number; vitals: string }>("SELECT visit_at, vitals FROM visits WHERE patient_id = ? ORDER BY visit_at DESC", pid)) {
    try { found.push(...fromClinic(JSON.parse(v.vitals) as ClinicVitals, v.visit_at, "clinic")); } catch { /* unreadable vitals: skip */ }
  }
  const b = getBaseline(pid);
  if (b) found.push(...fromClinic(b.vitals ?? {}, b.capturedAt, "baseline"));
  // The newest of each; at the same moment a home reading wins over the clinic's, and the clinic's over the baseline.
  const rank = { home: 0, clinic: 1, baseline: 2 };
  return ORDER.map((type) => found.filter((x) => x.type === type).sort((a, c) => c.at - a.at || rank[a.source] - rank[c.source])[0]).filter(Boolean);
}
