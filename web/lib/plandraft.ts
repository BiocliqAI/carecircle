// Care-plan builder: the doctor's sources for today's visit (printed prescription photo, dictation,
// the consultation conversation) are merged by Gemini into a draft plan where every item says where it
// came from. The doctor resolves conflicts, confirms uncertain items, and sends it as the visit.
import { audit, get, run } from "./db";
import { getPatient, latestVisit } from "./engine";
import { getPrep } from "./prep";
import { getBaseline } from "./clinic";
import { buildPlanDraftAI, readPrescriptionAI, transcribeConversationAI, transcribeDictation, lastTranscribeError } from "./gemini";
import { DEFAULT_THRESHOLDS, DEFAULT_TIMERS, SYMPTOMS, VITAL_META, type CarePlan, type Medication, type MonitorItem, type Thresholds, type VitalType } from "./types";

export type SourceKind = "rx" | "dictation" | "conversation";
export interface DraftSource { id: string; kind: SourceKind; at: number; label: string; text: string; seconds?: number }
export type Tag = "rx" | "talk" | "keep" | "protocol" | "pa";
export type Change = "new" | "changed" | "same" | "stopped";

export interface DraftMed {
  id: string;
  name: string;
  dose: string;
  schedule: string; // 1-0-1 style, or "SOS"
  durationDays: number | null;
  startDay?: number | null; // second step of a taper: starts this many days after the visit
  instructions: string;
  purpose: string;
  change: Change;
  was: string | null; // previous dose/schedule when changed
  sources: Tag[];
  quote: string | null;
  confidence: "high" | "low";
  confirmed?: boolean;
}
export interface DraftItem { id: string; text: string; sources: Tag[]; quote: string | null; confidence: "high" | "low"; confirmed?: boolean }
export interface DraftMonitor { id: string; key: VitalType; times: string[]; alert: string; limits: Partial<Thresholds>; sources: Tag[]; quote: string | null; confidence: "high" | "low"; confirmed?: boolean }
export interface DraftConflict { id: string; field: string; medName?: string; options: { label: string; value: Partial<DraftMed> | null; source: Tag; quote: string | null }[]; chosen: number | null }
export interface DraftAnswer { id: string; question: string; answer: string; askedBy: string | null; quote: string | null; sources: Tag[] }

export interface PlanDraft {
  sources: DraftSource[];
  built: null | {
    at: number;
    medications: DraftMed[];
    monitoring: DraftMonitor[];
    advice: DraftItem[];
    warningSigns: { keys: string[]; text: string; sources: Tag[] };
    answers: DraftAnswer[];
    labs: { panel: string; everyDays: number | null; sources: Tag[] } | null;
    nextVisit: { date: string | null; sources: Tag[] } | null;
    diagnosis: string;
    note: string;
    conflicts: DraftConflict[];
  };
}

const EMPTY: PlanDraft = { sources: [], built: null };

export function getPlanDraft(pid: string): PlanDraft {
  const r = get<{ data: string }>("SELECT data FROM plan_drafts WHERE patient_id = ?", pid);
  return r ? { ...EMPTY, ...(JSON.parse(r.data) as PlanDraft) } : { ...EMPTY, sources: [] };
}
export function savePlanDraft(pid: string, d: PlanDraft, t: number) {
  run("INSERT INTO plan_drafts(patient_id, data, updated_at) VALUES(?,?,?) ON CONFLICT(patient_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at", pid, JSON.stringify(d), t);
}
export function clearPlanDraft(pid: string) {
  run("DELETE FROM plan_drafts WHERE patient_id = ?", pid);
}

const nid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Adds a source: reads the prescription photo, or transcribes dictation / the conversation. */
export async function addSource(pid: string, kind: SourceKind, base64: string, mime: string, seconds: number | undefined, t: number, actor: string): Promise<DraftSource> {
  const visit = latestVisit(pid, t);
  const meds = visit?.plan.medications.map((m) => `${m.name} ${m.dose}`) ?? [];
  const p = getPatient(pid);
  let text: string | null = null;
  if (kind === "rx") text = await readPrescriptionAI(base64, mime);
  else if (kind === "dictation") text = await transcribeDictation(base64, mime, { meds, conditions: p?.conditions ?? "" });
  else text = await transcribeConversationAI(base64, mime, { meds, conditions: p?.conditions ?? "" });
  if (!text) throw new Error(lastTranscribeError ? `Couldn't read it: ${lastTranscribeError}` : "Nothing could be read from it");
  const src: DraftSource = {
    id: nid("s"), kind, at: t, text, seconds,
    label: kind === "rx" ? "Prescription photo" : kind === "dictation" ? "Dictation" : "Consultation",
  };
  const d = getPlanDraft(pid);
  d.sources.push(src);
  savePlanDraft(pid, d, t);
  audit(t, actor, "PLAN_SOURCE_ADDED", "patient", pid, { kind });
  return src;
}

export function removeSource(pid: string, sourceId: string, t: number) {
  const d = getPlanDraft(pid);
  d.sources = d.sources.filter((s) => s.id !== sourceId);
  savePlanDraft(pid, d, t);
}

/** Merges all sources with the current plan, the PA's flags and the patient's context into a draft. */
export async function buildDraft(pid: string, t: number, actor: string): Promise<PlanDraft> {
  const p = getPatient(pid);
  if (!p) throw new Error("Patient not found");
  const d = getPlanDraft(pid);
  if (!d.sources.length) throw new Error("Add a prescription photo, dictation or the consultation first");
  const visit = latestVisit(pid, t);
  const prep = getPrep(pid);
  const baseline = getBaseline(pid);
  const context = {
    patient: { name: p.name, age: p.age, sex: p.sex, conditions: p.conditions, allergies: baseline?.allergies ?? "" },
    currentPlan: visit
      ? { medications: visit.plan.medications.map((m) => ({ name: m.name, dose: m.dose, times: m.times, instructions: m.instructions ?? "" })), monitoring: visit.plan.monitoring.map((m) => m.key), thresholds: visit.plan.thresholds, lifestyle: visit.plan.lifestyle.map((l) => l.text), watchSymptoms: visit.plan.watchSymptoms }
      : null,
    medicinesAtOnboarding: !visit ? baseline?.currentMeds ?? [] : [],
    assistantFlags: prep.flags.map((f) => f.text),
    familyQuestions: prep.questions || null,
    symptomKeys: Object.keys(SYMPTOMS),
    vitalKeys: Object.keys(VITAL_META),
  };
  const out = await buildPlanDraftAI(context, d.sources.map((s) => ({ kind: s.kind, text: s.text })));
  if (!out) throw new Error(lastTranscribeError ? `Couldn't build the draft: ${lastTranscribeError}` : "Couldn't build the draft");
  d.built = normalise(out, t);
  savePlanDraft(pid, d, t);
  audit(t, actor, "PLAN_DRAFT_BUILT", "patient", pid, { sources: d.sources.length });
  return d;
}

const TAGS: Tag[] = ["rx", "talk", "keep", "protocol", "pa"];
const tags = (x: unknown): Tag[] => (Array.isArray(x) ? x.filter((v): v is Tag => TAGS.includes(v as Tag)) : []);
const conf = (x: unknown): "high" | "low" => (x === "low" ? "low" : "high");
const str = (x: unknown, n = 300) => (typeof x === "string" ? x.trim().slice(0, n) : "");

/** Defensive normalisation of the model's JSON into the draft shape. */
function normalise(o: Record<string, unknown>, t: number): NonNullable<PlanDraft["built"]> {
  const arr = (k: string) => (Array.isArray(o[k]) ? (o[k] as Record<string, unknown>[]) : []);
  const meds: DraftMed[] = arr("medications").filter((m) => str(m.name)).map((m) => ({
    id: nid("m"), name: str(m.name, 80), dose: str(m.dose, 40), schedule: str(m.schedule, 20) || "1-0-0",
    durationDays: Number.isFinite(Number(m.durationDays)) && Number(m.durationDays) > 0 ? Number(m.durationDays) : null,
    startDay: Number.isFinite(Number(m.startDay)) && Number(m.startDay) > 0 ? Number(m.startDay) : null,
    instructions: str(m.instructions, 120), purpose: str(m.purpose, 80),
    change: (["new", "changed", "same", "stopped"] as const).find((c) => c === m.change) ?? "new",
    was: str(m.was, 80) || null, sources: tags(m.sources), quote: str(m.quote, 200) || null, confidence: conf(m.confidence),
  }));
  const monitoring: DraftMonitor[] = arr("monitoring").filter((m) => typeof m.key === "string" && m.key in VITAL_META).map((m) => ({
    id: nid("v"), key: m.key as VitalType,
    times: Array.isArray(m.times) ? (m.times as unknown[]).map((x) => str(x, 5)).filter((x) => /^\d{2}:\d{2}$/.test(x)) : ["08:00"],
    alert: str(m.alert, 120), limits: typeof m.limits === "object" && m.limits ? Object.fromEntries(Object.entries(m.limits as Record<string, unknown>).filter(([k, v]) => k in DEFAULT_THRESHOLDS || ["dryWeight", "weightBand"].includes(k) ? Number.isFinite(Number(v)) : false).map(([k, v]) => [k, Number(v)])) : {},
    sources: tags(m.sources), quote: str(m.quote, 200) || null, confidence: conf(m.confidence),
  }));
  for (const m of monitoring) if (!m.times.length) m.times = ["08:00"];
  const advice: DraftItem[] = arr("advice").filter((a) => str(a.text)).map((a) => ({ id: nid("a"), text: str(a.text, 200), sources: tags(a.sources), quote: str(a.quote, 200) || null, confidence: conf(a.confidence) }));
  const ws = (o.warningSigns ?? {}) as Record<string, unknown>;
  const answers: DraftAnswer[] = arr("answers").filter((a) => str(a.question) && str(a.answer)).map((a) => ({ id: nid("q"), question: str(a.question, 200), answer: str(a.answer, 300), askedBy: str(a.askedBy, 60) || null, quote: str(a.quote, 200) || null, sources: tags(a.sources) }));
  const labs = o.labs && typeof o.labs === "object" && str((o.labs as Record<string, unknown>).panel) ? { panel: str((o.labs as Record<string, unknown>).panel, 120), everyDays: Number((o.labs as Record<string, unknown>).everyDays) || null, sources: tags((o.labs as Record<string, unknown>).sources) } : null;
  const nv = o.nextVisit && typeof o.nextVisit === "object" ? (o.nextVisit as Record<string, unknown>) : null;
  const conflicts: DraftConflict[] = arr("conflicts").map((c) => ({
    id: nid("c"), field: str(c.field, 120), medName: str(c.medName, 80) || undefined, chosen: null,
    options: (Array.isArray(c.options) ? (c.options as Record<string, unknown>[]) : []).slice(0, 3).map((op) => ({
      label: str(op.label, 120), source: tags([op.source])[0] ?? "talk", quote: str(op.quote, 200) || null,
      value: op.value && typeof op.value === "object" ? { dose: str((op.value as Record<string, unknown>).dose, 40) || undefined, schedule: str((op.value as Record<string, unknown>).schedule, 20) || undefined, durationDays: Number((op.value as Record<string, unknown>).durationDays) || undefined } : null,
    })),
  })).filter((c) => c.options.length >= 2);
  return {
    at: t, medications: meds, monitoring, advice,
    warningSigns: { keys: (Array.isArray(ws.keys) ? (ws.keys as unknown[]) : []).map((k) => str(k, 30)).filter((k) => k in SYMPTOMS), text: str(ws.text, 200), sources: tags(ws.sources) },
    answers, labs, nextVisit: nv ? { date: /^\d{4}-\d{2}-\d{2}$/.test(str(nv.date, 10)) ? str(nv.date, 10) : null, sources: tags(nv.sources) } : null,
    diagnosis: str(o.diagnosis, 200), note: str(o.note, 2000), conflicts,
  };
}

/** What still blocks sending: unresolved conflicts and unconfirmed low-confidence items. */
export function blockers(b: NonNullable<PlanDraft["built"]>): { conflicts: number; toConfirm: number } {
  const low = [...b.medications, ...b.monitoring, ...b.advice].filter((x) => x.confidence === "low" && !x.confirmed).length;
  return { conflicts: b.conflicts.filter((c) => c.chosen === null).length, toConfirm: low };
}

const DEFAULT_SLOTS = ["08:00", "14:00", "21:00"];
/** "1-0-1" → ["08:00","21:00"]; "SOS" → prn. */
export function scheduleToTimes(schedule: string): { times: string[]; prn: boolean } {
  if (/sos|prn|as needed|if required/i.test(schedule)) return { times: ["08:00"], prn: true };
  const m = schedule.match(/(\d)\s*[-–]\s*(\d)\s*[-–]\s*(\d)/);
  if (m) {
    const times: string[] = [];
    [m[1], m[2], m[3]].forEach((n, i) => { for (let k = 0; k < Number(n); k++) times.push(DEFAULT_SLOTS[i]); });
    return { times: [...new Set(times)].length ? [...new Set(times)] : ["08:00"], prn: false };
  }
  if (/bd|twice/i.test(schedule)) return { times: ["08:00", "21:00"], prn: false };
  if (/tds|thrice/i.test(schedule)) return { times: ["08:00", "14:00", "21:00"], prn: false };
  if (/hs|night|bedtime/i.test(schedule)) return { times: ["21:30"], prn: false };
  return { times: ["08:00"], prn: false };
}

/** Converts a reviewed draft into the care plan the engine runs. */
export function draftToPlan(b: NonNullable<PlanDraft["built"]>, base: CarePlan | null): CarePlan {
  const medications: Medication[] = b.medications.filter((m) => m.change !== "stopped").map((m, i) => {
    const { times, prn } = scheduleToTimes(m.schedule);
    return {
      key: m.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30) || `med${i}`,
      name: m.name, dose: m.dose, times, ...(prn ? { prn: true } : {}),
      // A printed "30 days" is the supply until the next visit, not a course: only short courses end reminders.
      ...(m.durationDays && m.durationDays < 28 ? { courseDays: (m.startDay ?? 0) + m.durationDays } : {}),
      ...(m.startDay ? { startDay: m.startDay } : {}),
      instructions: m.instructions || undefined, purpose: m.purpose || undefined,
    };
  });
  const seen = new Set<string>();
  for (const m of medications) { while (seen.has(m.key)) m.key += "_2"; seen.add(m.key); }
  const monitoring: MonitorItem[] = b.monitoring.map((m) => ({ key: m.key, times: m.times }));
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...(base?.thresholds ?? {}) };
  for (const m of b.monitoring) Object.assign(thresholds, m.limits);
  return {
    medications,
    monitoring: monitoring.length ? monitoring : base?.monitoring ?? [{ key: "bp", times: ["08:00"] }],
    physio: base?.physio ?? [],
    lifestyle: b.advice.map((a, i) => ({ key: `adv${i}`, text: a.text })),
    checkinTime: base?.checkinTime || "21:00",
    watchSymptoms: [...new Set([...(b.warningSigns.keys ?? []), ...(base?.watchSymptoms ?? [])])],
    thresholds,
    escalation: base?.escalation ?? { ...DEFAULT_TIMERS },
    ...(base?.fluid ? { fluid: base.fluid } : {}),
    ...(b.labs?.everyDays ? { labs: { panel: b.labs.panel, everyDays: b.labs.everyDays } } : base?.labs ? { labs: base.labs } : {}),
    ...(base?.template ? { template: base.template } : {}),
  };
}

/** Applies the doctor's choice in a conflict to the matching medicine. */
export function resolveConflict(b: NonNullable<PlanDraft["built"]>, conflictId: string, option: number) {
  const c = b.conflicts.find((x) => x.id === conflictId);
  if (!c || !c.options[option]) throw new Error("Unknown choice");
  c.chosen = option;
  const op = c.options[option];
  if (c.medName && op.value) {
    const m = b.medications.find((x) => x.name.toLowerCase() === c.medName!.toLowerCase());
    if (m) {
      if (op.value.dose) m.dose = op.value.dose;
      if (op.value.schedule) m.schedule = op.value.schedule;
      m.durationDays = op.value.durationDays ?? (op.source === "rx" ? m.durationDays : null);
      const then = op.label.match(/then\s+(?:back\s+to\s+)?(\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units?))/i);
      b.medications = b.medications.filter((x) => !(x.name.toLowerCase() === m.name.toLowerCase() && x.startDay));
      if (then && m.durationDays) {
        // Taper: this dose for the course, then the follow-on dose from the next day onward.
        const idx = b.medications.indexOf(m);
        b.medications.splice(idx + 1, 0, { ...m, id: nid("m"), dose: then[1].replace(/\s+/g, " "), durationDays: null, startDay: m.durationDays, change: "changed", was: null, quote: op.quote, confidence: "high", confirmed: true });
      }
      if (!m.sources.includes(op.source)) m.sources = [op.source, ...m.sources.filter((x) => x !== "rx" || op.source === "rx")];
      if (op.quote) m.quote = op.quote;
      if (m.change === "same") m.change = "changed";
    }
  }
}

export function confirmItem(b: NonNullable<PlanDraft["built"]>, id: string) {
  for (const x of [...b.medications, ...b.monitoring, ...b.advice]) if (x.id === id) x.confirmed = true;
}

export function removeItem(b: NonNullable<PlanDraft["built"]>, id: string) {
  b.medications = b.medications.filter((x) => x.id !== id);
  b.monitoring = b.monitoring.filter((x) => x.id !== id);
  b.advice = b.advice.filter((x) => x.id !== id);
  b.answers = b.answers.filter((x) => x.id !== id);
}

export function editMed(b: NonNullable<PlanDraft["built"]>, id: string, patch: Partial<Pick<DraftMed, "name" | "dose" | "schedule" | "instructions" | "durationDays">>) {
  const m = b.medications.find((x) => x.id === id);
  if (!m) throw new Error("Medicine not found");
  Object.assign(m, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  m.confirmed = true;
  m.confidence = "high";
}
