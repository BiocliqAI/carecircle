// Lab tests learned from documents. When the AI reads a numeric result for a test the record doesn't know yet, the
// test is added once (key, name, unit) for the whole clinic and from then on is read, charted and listed like a
// built-in one. Stored in settings under "lab_markers"; loaded into LAB_META on every server request.
import { getSetting, setSetting } from "./db";
import { addLabMarkers, LAB_META, type LabMetaEntry } from "./types";

const KEY = "lab_markers";
const MAX_LEARNED = 500; // far more than a clinic will see; stops a runaway reading from flooding the list

function stored(): Record<string, LabMetaEntry> {
  try {
    return JSON.parse(getSetting(KEY) || "{}") as Record<string, LabMetaEntry>;
  } catch {
    return {};
  }
}

/** Puts every learned test into LAB_META (cheap; safe to call on every request). */
export function loadLearnedMarkers(): Record<string, LabMetaEntry> {
  const m = stored();
  addLabMarkers(m);
  return m;
}

const tidy = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
/** A marker key: lowercase letters, digits and underscores, starting with a letter. */
export function markerKey(raw: unknown): string {
  return tidy(raw, 80).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 40);
}
const sameName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The key to file a reading under: a known test as it is (matched by key or by name), or a new test, learned now.
 * Returns null when there isn't enough to go on (no usable key or name).
 */
export function resolveMarker(marker: unknown, label: unknown, unit: unknown): string | null {
  loadLearnedMarkers();
  const key = markerKey(marker);
  if (key && LAB_META[key]) return key;
  const name = tidy(label, 60);
  const byName = name ? Object.keys(LAB_META).find((k) => sameName(LAB_META[k].label, name)) : undefined;
  if (byName) return byName;
  const k = key || markerKey(name);
  if (!k || k.length < 2 || !name) return null;
  const all = stored();
  if (Object.keys(all).length >= MAX_LEARNED) return null;
  all[k] = { label: name, unit: tidy(unit, 20), digits: 2, learned: true };
  setSetting(KEY, JSON.stringify(all));
  addLabMarkers({ [k]: all[k] });
  return k;
}
