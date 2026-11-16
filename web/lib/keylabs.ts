// The few lab results worth a glance on the chart: from the patient's last two lab reports (days with lab tests; imaging
// measurements picked up from echo, ECG or scan reports don't count), the tests that matter most for this clinic,
// abnormal ones first, each with the value from the report before.
import { all } from "./db";
import { LAB_META } from "./types";
import { dayKey } from "./time";

/** Tests in order of how much they matter at a glance in a kidney / cardio-metabolic clinic. */
export const KEY_ORDER = [
  "creatinine", "egfr", "potassium", "sodium", "urea", "hb", "bicarbonate", "hba1c", "ntprobnp", "uric_acid",
  "albumin", "uacr", "calcium", "phosphorus", "magnesium", "fbs", "ppbs", "ldl", "platelets", "wbc", "chloride",
  "ferritin", "vitd", "tsh", "cholesterol", "triglycerides", "hdl", "bilirubin", "sgpt", "sgot", "alp",
];
const IMAGING = /\b(echo|ecg|ekg|usg|ultrasound|doppler|ct|mri|x-?ray|2d|lv|la|rv|ivs|ejection|valve|velocity|gradient)\b/i;
const isImaging = (marker: string) => IMAGING.test(LAB_META[marker]?.label ?? marker.replace(/_/g, " "));
/** Built-in lab tests (not learned from documents, not imaging). */
const isCoreLab = (marker: string) => !!LAB_META[marker] && !LAB_META[marker].learned && !isImaging(marker);
const ABNORMAL = new Set(["high", "low", "critical"]);

export interface KeyLab { marker: string; value: number; at: number; flag: string | null; prev: number | null; prevAt: number | null }
export interface KeyLabs { latestAt: number | null; previousAt: number | null; rows: KeyLab[]; more: number }

export function keyLabs(pid: string, limit = 8): KeyLabs {
  const rows = all<{ marker: string; value: number; taken_at: number; flag: string | null }>(
    "SELECT marker, value, taken_at, flag FROM labs WHERE patient_id = ? ORDER BY taken_at DESC, id DESC", pid);
  // The last two lab reports: the two most recent days with at least one lab test.
  const days: string[] = [];
  for (const r of rows) {
    if (!isCoreLab(r.marker)) continue;
    const k = dayKey(r.taken_at);
    if (!days.includes(k)) days.push(k);
    if (days.length === 2) break;
  }
  if (!days.length) return { latestAt: null, previousAt: null, rows: [], more: 0 };
  const inReports = rows.filter((r) => days.includes(dayKey(r.taken_at)));
  const out: KeyLab[] = [];
  for (const r of inReports) {
    if (out.some((x) => x.marker === r.marker)) continue;
    if (isImaging(r.marker)) continue;
    // Tests learned from documents are shown only when flagged; the built-in ones always qualify.
    if (!isCoreLab(r.marker) && !ABNORMAL.has(r.flag ?? "")) continue;
    const before = rows.find((x) => x.marker === r.marker && x.taken_at < r.taken_at && dayKey(x.taken_at) !== dayKey(r.taken_at));
    out.push({ marker: r.marker, value: r.value, at: r.taken_at, flag: r.flag, prev: before?.value ?? null, prevAt: before?.taken_at ?? null });
  }
  const rank = (m: string) => { const i = KEY_ORDER.indexOf(m); return i < 0 ? KEY_ORDER.length : i; };
  out.sort((a, b) => Number(ABNORMAL.has(b.flag ?? "")) - Number(ABNORMAL.has(a.flag ?? "")) || rank(a.marker) - rank(b.marker));
  const at = (k: string) => inReports.find((r) => dayKey(r.taken_at) === k)!.taken_at;
  return { latestAt: at(days[0]), previousAt: days[1] ? at(days[1]) : null, rows: out.slice(0, limit), more: Math.max(0, out.length - limit) };
}
