// Advisory checks shown beside a medicine change reported from another doctor's visit, before the doctor or
// assistant applies it to the plan. Fixed rules, not AI: overlap with a medicine already in the plan, the same
// drug under another name, an allergy that names it, recent potassium or kidney results, recent low BP, a large
// dose jump, or stopping a blood thinner. These are prompts to look twice. Nothing is blocked.
import { all, get } from "./db";
import { getBaseline } from "./clinic";
import { latestVisit } from "./engine";
import { DAY } from "./time";
import { doseMg, type CarePlan, type Medication } from "./types";

// A small built-in class list (generic and common Indian brand names). Not a drug database: it only has to
// recognise the classes where doubling up or the wrong patient matters.
export const CLASSES: Record<string, { label: string; re: RegExp }> = {
  arb_ace: { label: "ACE inhibitor / ARB / ARNI", re: /telmisartan|losartan|valsartan|olmesartan|irbesartan|candesartan|azilsartan|ramipril|enalapril|lisinopril|perindopril|sacubitril|sacurise|telma|losar|cilacar/i },
  beta: { label: "beta blocker", re: /metoprolol|bisoprolol|concor|betaloc|atenolol|carvedilol|nebivolol|propranolol|labetalol/i },
  ccb: { label: "calcium channel blocker", re: /amlodipine|nifedipine|nifidipin|depin|felodipine|diltiazem|verapamil|cilnidipine/i },
  loop: { label: "loop diuretic", re: /furosemide|lasix|torsemide|dytor|bumetanide/i },
  thiazide: { label: "thiazide-type diuretic", re: /hydrochlorothiazide|metolazone|zytanix|chlorthalidone|indapamide/i },
  kspare: { label: "potassium-sparing diuretic", re: /spironolactone|aldactone|eplerenone|finerenone/i },
  statin: { label: "statin", re: /atorvastatin|aztor|rosuvastatin|simvastatin|pravastatin|pitavastatin/i },
  antiplatelet: { label: "antiplatelet", re: /aspirin|ecosprin|clopidogrel|ticagrelor|prasugrel/i },
  anticoag: { label: "blood thinner", re: /apixaban|eliquis|rivaroxaban|xarelto|dabigatran|edoxaban|warfarin|acitrom/i },
  sulfonylurea: { label: "sulfonylurea", re: /gliclazide|prizide|glimepiride|glipizide|glibenclamide/i },
  metformin: { label: "metformin", re: /metformin|glycomet|glucophage/i },
  sglt2: { label: "SGLT2 inhibitor", re: /dapagliflozin|empagliflozin|canagliflozin|forxiga|jardiance/i },
  nsaid: { label: "anti-inflammatory painkiller (NSAID)", re: /ibuprofen|diclofenac|naproxen|aceclofenac|etoricoxib|ketorolac|nimesulide|brufen|voveran/i },
};
const classesOf = (name: string) => Object.entries(CLASSES).filter(([, c]) => c.re.test(name)).map(([k]) => k);
const BP_LOWERING = new Set(["arb_ace", "beta", "ccb", "loop", "thiazide", "kspare"]);

export interface ChangeIn { med_name: string; change: string; new_dose?: string | null; med_key?: string | null }

/** Does the allergy text name this drug, a brand of it, or another drug of the same type? */
export function allergyHit(allergies: string | undefined | null, med: string): string | null {
  const a = (allergies ?? "").toLowerCase();
  if (!a || /^(none|nil|nkda|no known|no)\b/.test(a.trim())) return null;
  for (const w of med.toLowerCase().replace(/[()]/g, " ").split(/[\s/]+/).filter((x) => x.length >= 4)) if (a.includes(w)) return `it names ${w}`;
  for (const k of classesOf(med)) {
    const m = a.match(CLASSES[k].re);
    if (m) return `it names ${m[0]}, which is the same type (${CLASSES[k].label})`;
  }
  return null;
}

export interface Ctx {
  plan: CarePlan | undefined;
  allergies: string | null;
  conditions: string | null;
  potassium: { v: number; at: number } | null;
  creatinine: { v: number; at: number } | null;
  egfr: { v: number; at: number } | null;
  minSys3d: number | null;
  now: number;
}

/** Pure: warnings for one change. */
export function checkChange(c: ChangeIn, x: Ctx): string[] {
  const out: string[] = [];
  const stopped = c.change === "stopped";
  const mine = classesOf(c.med_name);
  const inPlan = x.plan?.medications.find((m) => (c.med_key && m.key === c.med_key) || m.name.toLowerCase() === c.med_name.toLowerCase());
  const others = (x.plan?.medications ?? []).filter((m) => m !== inPlan);
  const ago = (at: number) => `${Math.max(0, Math.round((x.now - at) / DAY))} days ago`;

  if (!stopped) {
    const hit = allergyHit(x.allergies, c.med_name);
    if (hit) out.push(`Allergy on file (${x.allergies}): ${hit}.`);
    if (!inPlan) {
      const same = others.find((m) => m.name.toLowerCase().split(/[\s/()]+/).some((w) => w.length >= 4 && c.med_name.toLowerCase().includes(w)));
      if (same) out.push(`Looks like ${same.name}, which is already in the plan (possibly a different brand).`);
      else for (const k of mine) {
        const dup = others.find((m) => classesOf(m.name).includes(k));
        if (dup) out.push(`Same type as ${dup.name} already in the plan (${CLASSES[k].label}). Check this is meant to be added, not swapped.`);
      }
    }
    if (mine.some((k) => k === "arb_ace" || k === "kspare") && x.potassium && x.potassium.v >= 5.0) out.push(`Potassium was ${x.potassium.v} (${ago(x.potassium.at)}). This type of medicine can raise it further.`);
    const lowKidney = (x.egfr && x.egfr.v < 30) ? `eGFR ${x.egfr.v}` : (x.creatinine && x.creatinine.v >= 2.5) ? `creatinine ${x.creatinine.v}` : null;
    if (lowKidney && mine.some((k) => ["metformin", "nsaid", "kspare"].includes(k))) out.push(`Kidney function is reduced (${lowKidney}). Please check this is suitable.`);
    if (mine.includes("nsaid")) {
      if (others.some((m) => classesOf(m.name).some((k) => k === "anticoag" || k === "antiplatelet"))) out.push("Painkillers of this type with a blood thinner raise bleeding risk.");
      if (/heart failure|ckd|kidney/i.test(x.conditions ?? "")) out.push("This type of painkiller can worsen heart failure and kidney disease.");
    }
    if (mine.some((k) => BP_LOWERING.has(k)) && x.minSys3d != null && x.plan && x.minSys3d < x.plan.thresholds.sysLow + 10) out.push(`Recent BP readings have been low (lowest top number ${x.minSys3d} in the last 3 days).`);
    const was = doseMg(inPlan?.dose), now = doseMg(c.new_dose ?? undefined);
    if (inPlan && was && now && (now >= was * 2 || now <= was / 2)) out.push(`Dose changes from ${was} mg to ${now} mg (${now > was ? "more than double" : "less than half"}). Please check it was not a slip.`);
  } else if (mine.includes("anticoag") && /fibrillation|\baf\b|afib/i.test(x.conditions ?? "")) out.push("Stopping a blood thinner in a patient with atrial fibrillation. Please confirm with the prescriber.");
  else if (mine.includes("antiplatelet") && /stent|heart attack|mi\b|ischaemic|ischemic|cad\b/i.test(x.conditions ?? "")) out.push("Stopping an antiplatelet in a patient with heart disease. Please confirm with the prescriber.");
  return out;
}

/** Gathers what the checks need from the record. */
export function contextFor(pid: string, t: number): Ctx {
  const lab = (m: string) => get<{ v: number; at: number }>("SELECT value AS v, taken_at AS at FROM labs WHERE patient_id = ? AND marker = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1", pid, m, t) ?? null;
  const cond = get<{ conditions: string | null }>("SELECT conditions FROM patients WHERE id = ?", pid)?.conditions ?? null;
  const sys = all<{ v1: number }>("SELECT v1 FROM observations WHERE patient_id = ? AND type = 'bp' AND observed_at > ?", pid, t - 3 * DAY).map((r) => r.v1);
  return { plan: latestVisit(pid, t)?.plan, allergies: getBaseline(pid)?.allergies ?? null, conditions: cond, potassium: lab("potassium"), creatinine: lab("creatinine"), egfr: lab("egfr"), minSys3d: sys.length ? Math.min(...sys) : null, now: t };
}

export type { Medication };
