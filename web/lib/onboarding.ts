// Onboarding from past records. The assistant saves the patient and care circle, then uploads everything the family
// brought. Each record is read on its own (lib/docauto.ts) and sorted into a pile (clinical / lab & home readings);
// when all are read, one draft is put together: the clinical history in a fixed structure, the doctors, every lab value,
// text result and home reading, and the points that need a person. The assistant checks it and sends it to the patient's
// doctor, who confirms it (or sends it back). Only the confirmation writes to the record, and nothing is sent on WhatsApp.
import { all, audit, get, getSetting, run, tx } from "./db";
import { addLab, getPatient, getUser, type UserRow } from "./engine";
import { cleanTexts, enterTexts, extractDocument, readExtract, type DocExtract } from "./docauto";
import { addDocument } from "./records";
import { saveDocumentVisit, upsertCareTeam } from "./outside";
import { cleanBaseline, getBaseline, saveBaseline } from "./clinic";
import { isAIConfigured, lastTranscribeError, synthesizeHistoryAI } from "./gemini";
import { LAB_META, type Baseline } from "./types";
import { dayKey, fmtDate } from "./time";
import { now as clockNow } from "./clock";
import { cell, cleanHistory, emptyHistory, fieldsOf, listOf, type History, type HistRow } from "./historyspec";

export type OnbStatus = "COLLECTING" | "REVIEW" | "SENT" | "RETURNED" | "CONFIRMED";
export type Pile = "clinical" | "lab";

export interface DoctorItem { name: string; specialty: string; hospital: string; role: "treating" | "consultant" | "lab"; seen: number; aliases: string[]; add: boolean }
export interface MergeItem { a: string; b: string; reason: string }
export interface Point { id: string; title: string; detail: string; sources: number[]; status: "open" | "resolved" | "doctor"; answer?: string }
export interface LabItem { id: string; marker: string; date: string | null; value: number | null; unit: string; sources: number[]; check?: string; ok?: boolean }
export interface TextItem { id: string; test: string; group?: string; result: string; reference?: string; date: string | null; sources: number[] }
export interface HomeItem { id: string; type: string; v1: number; v2?: number; date: string; time?: string; sources: number[] }
export interface Draft {
  /** The patient history in the clinic template's sections (lib/historyspec.ts). */
  summary: History;
  doctors: DoctorItem[];
  merges: MergeItem[];
  points: Point[];
  labs: LabItem[];
  texts: TextItem[];
  homes: HomeItem[];
}
export interface OnboardingRow {
  id: number; patient_id: string; status: OnbStatus; draft: string | null; built_at: number | null; build_error: string | null;
  created_by: string | null; created_at: number; updated_at: number; sent_by: string | null; sent_at: number | null;
  confirmed_by: string | null; confirmed_at: number | null; returned_by: string | null; returned_at: number | null; return_note: string | null;
}

export const getOnboarding = (id: number) => get<OnboardingRow>("SELECT * FROM onboardings WHERE id = ?", id);
/** The patient's latest onboarding (an open one, else the last confirmed one). */
export const currentOnboarding = (pid: string) => get<OnboardingRow>("SELECT * FROM onboardings WHERE patient_id = ? ORDER BY CASE status WHEN 'CONFIRMED' THEN 1 ELSE 0 END, id DESC LIMIT 1", pid);
export const draftOf = (o: OnboardingRow | undefined): Draft | null => { try { return o?.draft ? (JSON.parse(o.draft) as Draft) : null; } catch { return null; } };

/** Opens an onboarding for the patient, or returns the one already open. */
export function startOnboarding(pid: string, by: string, t: number): number {
  if (!getPatient(pid)) throw new Error("Patient not found");
  const open = get<{ id: number }>("SELECT id FROM onboardings WHERE patient_id = ? AND status != 'CONFIRMED' ORDER BY id DESC LIMIT 1", pid);
  if (open) return open.id;
  const id = run("INSERT INTO onboardings(patient_id, status, created_by, created_at, updated_at) VALUES(?,?,?,?,?)", pid, "COLLECTING", by, t, t).lastInsertRowid;
  audit(t, by, "ONBOARDING_STARTED", "patient", pid, { onboarding: id });
  return id;
}

function openOnboarding(pid: string): OnboardingRow {
  const o = get<OnboardingRow>("SELECT * FROM onboardings WHERE patient_id = ? AND status != 'CONFIRMED' ORDER BY id DESC LIMIT 1", pid);
  if (!o) throw new Error("No onboarding in progress for this patient");
  return o;
}

// ---------------------------------------------------------------- records and reading
/** Adds one record the family brought; it is read in the background. Adding a record after the draft was put
 *  together sends the onboarding back to reading, so the draft includes it. */
export function addRecord(pid: string, by: string, file: { base64: string; mime: string; name: string }, t: number): number {
  const o = openOnboarding(pid);
  if (o.status === "SENT") throw new Error("This onboarding is with the doctor. Ask them to send it back to add records.");
  const docId = addDocument(pid, { title: (file.name || "Record").replace(/\.[^.]+$/, "").slice(0, 100), category: "other", mime: file.mime || "application/octet-stream", base64: file.base64, notes: "Brought at onboarding" }, t, by);
  run("UPDATE patient_documents SET onboarding_id = ? WHERE id = ?", o.id, docId);
  if (o.status !== "COLLECTING") run("UPDATE onboardings SET status = 'COLLECTING', updated_at = ? WHERE id = ?", t, o.id);
  queueRead(docId);
  return docId;
}

export function removeRecord(pid: string, docId: number, by: string, t: number) {
  const o = openOnboarding(pid);
  if (!get("SELECT 1 FROM patient_documents WHERE id = ? AND onboarding_id = ?", docId, o.id)) throw new Error("Record not found");
  run("DELETE FROM patient_documents WHERE id = ?", docId);
  audit(t, by, "ONBOARDING_RECORD_REMOVED", "patient", pid, { onboarding: o.id, document: docId });
}

export function moveRecord(pid: string, docId: number, pile: Pile) {
  const o = openOnboarding(pid);
  run("UPDATE patient_documents SET pile = ?, pile_by = 'user' WHERE id = ? AND onboarding_id = ?", pile, docId, o.id);
}

export function retryRecord(pid: string, docId: number) {
  const o = openOnboarding(pid);
  run("UPDATE patient_documents SET read_error = NULL, extract = NULL WHERE id = ? AND onboarding_id = ?", docId, o.id);
  if (o.status !== "COLLECTING") run("UPDATE onboardings SET status = 'COLLECTING', updated_at = ? WHERE id = ?", clockNow(), o.id);
  queueRead(docId);
}

const pileFor = (x: DocExtract): Pile => (x.kind === "lab_report" || x.kind === "vitals_diary" || x.category === "lab" ? "lab" : "clinical");

// A small queue: a few records are read at once, the rest wait. It lives in memory; anything left unread after a
// restart is picked up again the next time someone opens the onboarding.
const g = globalThis as unknown as { __ccOnbQ?: { pending: number[]; running: Set<number>; building: Set<number> } };
const Q = (g.__ccOnbQ ??= { pending: [], running: new Set(), building: new Set() });
const PARALLEL = 3;

function queueRead(docId: number) {
  if (!Q.pending.includes(docId) && !Q.running.has(docId)) Q.pending.push(docId);
  pump();
}

function pump() {
  while (Q.running.size < PARALLEL && Q.pending.length) {
    const docId = Q.pending.shift()!;
    Q.running.add(docId);
    void readOne(docId).finally(() => {
      Q.running.delete(docId);
      const o = get<{ onboarding_id: number | null }>("SELECT onboarding_id FROM patient_documents WHERE id = ?", docId);
      if (o?.onboarding_id) maybeBuild(o.onboarding_id);
      pump();
    });
  }
}

async function readOne(docId: number) {
  if (!get("SELECT 1 FROM patient_documents WHERE id = ?", docId)) return;
  if (!isAIConfigured()) {
    run("UPDATE patient_documents SET read_error = ? WHERE id = ?", "AI is not set up, so records can't be read. Add the Anthropic or Gemini key in Settings.", docId);
    return;
  }
  const x = await extractDocument(docId);
  if (!x) {
    run("UPDATE patient_documents SET read_error = ? WHERE id = ?", (lastTranscribeError || "It couldn't be read. Retake the photo or upload a clearer copy.").slice(0, 300), docId);
    return;
  }
  run("UPDATE patient_documents SET read_error = NULL, pile = CASE WHEN pile_by = 'user' THEN pile ELSE ? END, pile_by = COALESCE(pile_by, 'ai') WHERE id = ?", pileFor(x), docId);
}

/** Puts anything unread (and not failed) back in the queue: after a restart, or when the page is opened again. */
export function resumeReading(onbId: number) {
  for (const d of all<{ id: number }>("SELECT id FROM patient_documents WHERE onboarding_id = ? AND extract IS NULL AND read_error IS NULL", onbId)) queueRead(d.id);
  maybeBuild(onbId);
}

// ---------------------------------------------------------------- progress
export interface RecordView { id: number; title: string; mime: string; size: number; pile: Pile | null; pileBy: string | null; state: "waiting" | "reading" | "read" | "failed"; error: string | null; kind: string | null; date: string | null; unclear: boolean }
export function progress(o: OnboardingRow) {
  const docs = all<{ id: number; title: string; mime: string; size: number; pile: Pile | null; pile_by: string | null; extract: string | null; read_error: string | null }>(
    "SELECT id, title, mime, size, pile, pile_by, extract, read_error FROM patient_documents WHERE onboarding_id = ? ORDER BY uploaded_at, id", o.id);
  const records: RecordView[] = docs.map((d) => {
    const x = readExtract(d.extract);
    return {
      id: d.id, title: d.title, mime: d.mime, size: d.size, pile: d.pile, pileBy: d.pile_by,
      state: d.read_error ? "failed" : x ? "read" : Q.running.has(d.id) ? "reading" : "waiting",
      error: d.read_error, kind: x?.kind ?? null, date: x?.date ?? null,
      unclear: !!x && x.labs.some((l) => l.uncertain),
    };
  });
  const read = records.filter((r) => r.state === "read");
  const clinical = records.filter((r) => r.pile !== "lab");
  return {
    total: records.length,
    read: read.length,
    failed: records.filter((r) => r.state === "failed").length,
    clinicalTotal: clinical.length,
    clinicalRead: clinical.filter((r) => r.state === "read").length,
    building: Q.building.has(o.id),
    built: !!o.built_at && o.status !== "COLLECTING",
    found: {
      labValues: read.reduce((n, r) => n + (readExtract(docs.find((d) => d.id === r.id)!.extract)?.labs.length ?? 0), 0),
      visits: read.reduce((n, r) => n + (readExtract(docs.find((d) => d.id === r.id)!.extract)?.visits?.length ?? 0), 0),
      homeReadings: read.reduce((n, r) => n + (readExtract(docs.find((d) => d.id === r.id)!.extract)?.readings?.length ?? 0), 0),
    },
    records,
  };
}

// ---------------------------------------------------------------- putting the draft together
/** Puts the draft together again from the records already read (e.g. after the history couldn't be built). It runs in
 *  the background; the screen shows "putting the history together" until it's done. Edits to the old draft are replaced. */
export function rebuildDraft(pid: string, by: string, t: number) {
  const o = openOnboarding(pid);
  if (o.status === "SENT") throw new Error("This onboarding is with the doctor");
  run("UPDATE onboardings SET status = 'COLLECTING', build_error = NULL, updated_at = ? WHERE id = ?", t, o.id);
  audit(t, by, "ONBOARDING_REBUILD", "patient", pid, { onboarding: o.id });
  maybeBuild(o.id);
}

function maybeBuild(onbId: number) {
  const o = getOnboarding(onbId);
  if (!o || o.status !== "COLLECTING" || Q.building.has(onbId)) return;
  const docs = all<{ id: number; extract: string | null; read_error: string | null }>("SELECT id, extract, read_error FROM patient_documents WHERE onboarding_id = ?", onbId);
  if (!docs.length || docs.some((d) => !d.extract && !d.read_error) || docs.some((d) => Q.running.has(d.id) || Q.pending.includes(d.id))) return;
  if (!docs.some((d) => d.extract)) return; // nothing could be read: the assistant sees the errors and retries
  Q.building.add(onbId);
  void buildDraft(onbId).catch((e) => {
    run("UPDATE onboardings SET build_error = ?, updated_at = ? WHERE id = ?", String((e as Error).message).slice(0, 300), clockNow(), onbId);
  }).finally(() => Q.building.delete(onbId));
}

const str = (v: unknown, n = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const ids = (v: unknown, valid: Set<number>) => (Array.isArray(v) ? v.map(Number).filter((n) => valid.has(n)).slice(0, 30) : []);
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const normDoc = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/^dr\.?\s*/, "").replace(/[^a-z]/g, "");
const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/** Builds the draft from what each record said. The clinical history comes from one AI pass over all clinical
 *  records; labs, results and home readings are gathered directly (no AI), de-duplicated, and checked. */
export async function buildDraft(onbId: number): Promise<Draft> {
  const o = getOnboarding(onbId);
  if (!o) throw new Error("Onboarding not found");
  const p = getPatient(o.patient_id)!;
  const treating = getUser(p.doctor_id)?.name ?? null;
  const docs = all<{ id: number; title: string; pile: Pile | null; extract: string | null }>("SELECT id, title, pile, extract FROM patient_documents WHERE onboarding_id = ? AND extract IS NOT NULL ORDER BY id", onbId)
    .map((d) => ({ ...d, x: readExtract(d.extract)! })).filter((d) => d.x);
  const valid = new Set(docs.map((d) => d.id));

  // Labs: every value with its date; the same test on the same day from two records is one value (or a point if they differ).
  const labs: LabItem[] = [];
  for (const d of docs) for (const l of d.x.labs) {
    const date = l.date ?? d.x.date ?? null;
    const same = labs.find((x) => x.marker === l.marker && x.date === date);
    if (same) {
      if (!same.sources.includes(d.id)) same.sources.push(d.id);
      if (same.value !== l.value) same.check = `Two records differ: ${same.value} and ${l.value}. Check which is right.`;
      continue;
    }
    labs.push({ id: `l${labs.length}`, marker: l.marker, date, value: l.value, unit: l.unit || LAB_META[l.marker]?.unit || "", sources: [d.id], ...(l.uncertain ? { check: "Hard to read, or written as approximate." } : {}), ...(!date ? { check: "No date on the record. Enter the date the sample was taken." } : {}) });
  }
  // A value far from the one before it is worth a second look (misread digits, wrong unit).
  const byMarker = new Map<string, LabItem[]>();
  for (const l of labs) if (l.date) byMarker.set(l.marker, [...(byMarker.get(l.marker) ?? []), l]);
  for (const list of byMarker.values()) {
    list.sort((a, b) => a.date!.localeCompare(b.date!));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1].value, b = list[i].value;
      if (a && b && !list[i].check && (b / a > 2.5 || b / a < 0.4)) list[i].check = `Big change from ${a} on ${fmtDate(Date.parse(`${list[i - 1].date}T12:00:00+05:30`), { day: "numeric", month: "short", year: "numeric" })}. Check it was read correctly.`;
    }
  }
  const texts: TextItem[] = [];
  for (const d of docs) for (const x of cleanTexts(d.x.texts ?? [])) {
    if (texts.some((y) => y.test === x.test && (y.group ?? "") === (x.group ?? "") && y.date === d.x.date)) continue;
    texts.push({ id: `t${texts.length}`, ...x, date: d.x.date ?? null, sources: [d.id] });
  }
  const homes: HomeItem[] = [];
  for (const d of docs) for (const r of d.x.readings ?? []) {
    if (homes.some((h) => h.type === r.type && h.date === r.date && h.time === r.time && h.v1 === r.v1)) continue;
    homes.push({ id: `h${homes.length}`, ...r, sources: [d.id] });
  }

  // The clinical history: one AI pass over every clinical record; the reports and the gathered lab values let it
  // write the studies and lab-trend sections.
  const clinical = docs.filter((d) => d.pile !== "lab");
  const reports = docs.filter((d) => d.pile === "lab");
  const trends: Record<string, string[]> = {};
  for (const l of [...labs].filter((x) => x.value !== null && x.date).sort((a, b) => a.date!.localeCompare(b.date!))) (trends[LAB_META[l.marker]?.label ?? l.marker] ??= []).push(`${l.date}: ${l.value} ${l.unit}`.trim());
  const caregivers = all<{ name: string; relation: string | null }>("SELECT name, relation FROM caregivers WHERE patient_id = ? ORDER BY level", p.id);
  // Keep the whole request well inside the model's context, however many records there are: each record's
  // transcription is shortened only when the total would be too large (the visits and medicines found in it are kept).
  const TEXT_BUDGET = 1_600_000; // characters, roughly 400k tokens
  const perReport = Math.max(600, Math.min(2500, Math.floor((TEXT_BUDGET * 0.2) / Math.max(1, reports.length))));
  const perDoc = Math.max(2000, Math.floor((TEXT_BUDGET - perReport * reports.length) / Math.max(1, clinical.length)));
  const input = {
    today: dayKey(clockNow()),
    treatingDoctor: treating,
    patient: { name: p.name, age: p.age, sex: p.sex, language: (p.user_id && getSetting(`lang:${p.user_id}`)) || null, caregivers },
    documents: clinical.map((d) => ({ id: d.id, title: d.title, date: d.x.date, type: d.x.kind ?? d.x.category, prescriber: d.x.prescriber, text: (d.x.text ?? "").slice(0, perDoc), visits: d.x.visits ?? [], medicines: d.x.medList ?? [] })),
    reports: reports.map((d) => ({ id: d.id, title: d.title, date: d.x.date, type: d.x.kind ?? d.x.category, text: (d.x.text ?? "").slice(0, perReport) })),
    labTrends: trends,
  };
  const ai = clinical.length ? await synthesizeHistoryAI(input) : null;
  const draft: Draft = ai ? fromAi(ai, valid, treating) : fromRecords(clinical, treating);
  draft.summary.visits = visitRows(clinical);
  draft.labs = labs;
  draft.texts = texts;
  draft.homes = homes;
  const t = clockNow();
  run("UPDATE onboardings SET draft = ?, built_at = ?, build_error = ?, status = 'REVIEW', updated_at = ? WHERE id = ?", JSON.stringify(draft), t,
    clinical.length && !ai ? `The history couldn't be put together automatically (${lastTranscribeError ?? "AI unavailable"}); it was filled from each record's visits instead.` : null, t, onbId);
  return draft;
}

function fromAi(ai: Record<string, unknown>, valid: Set<number>, treating: string | null): Draft {
  const doctors: DoctorItem[] = arr(ai.doctors).filter((d) => str(d.name, 80)).slice(0, 60).map((d) => {
    const role = (["treating", "consultant", "lab"] as const).find((r) => r === d.role) ?? "consultant";
    const isTreating = role === "treating" || (!!treating && normDoc(str(d.name)) === normDoc(treating));
    return { name: str(d.name, 80), specialty: str(d.specialty, 60), hospital: str(d.hospital, 80), role: isTreating ? "treating" : role, seen: Math.max(0, Math.round(Number(d.seen) || 0)), aliases: (Array.isArray(d.aliases) ? d.aliases : []).map((a) => str(a, 80)).filter(Boolean).slice(0, 6), add: !isTreating && role === "consultant" };
  });
  return {
    summary: cleanHistory(ai.history, valid),
    doctors,
    merges: arr(ai.merges).map((m) => ({ a: str(m.a, 80), b: str(m.b, 80), reason: str(m.reason, 200) })).filter((m) => m.a && m.b && m.a !== m.b).slice(0, 20),
    points: arr(ai.points).filter((x) => str(x.title)).slice(0, 40).map((x, i) => ({ id: `p${i}`, title: str(x.title, 120), detail: str(x.detail, 400), sources: ids(x.sources, valid), status: "open" as const })),
    labs: [], texts: [], homes: [],
  };
}

/** The consultations, straight from what was read in each record: one row per doctor per day, newest first. */
function visitRows(clinical: { id: number; x: DocExtract }[]): HistRow[] {
  const rows: HistRow[] = [];
  for (const d of clinical) for (const v of d.x.visits ?? []) {
    if (v.kind === "skip" || (!v.doctorName && !v.date)) continue;
    const takeaway = [v.reason, v.findings, v.advice].filter(Boolean).join(" · ");
    const same = rows.find((r) => cell(r, "date") === (v.date ?? "") && normDoc(cell(r, "doctor")) === normDoc(v.doctorName));
    if (same) {
      if (!same.sources.includes(d.id)) same.sources.push(d.id);
      if (takeaway && !cell(same, "takeaway").includes(takeaway)) same.takeaway = [cell(same, "takeaway"), takeaway].filter(Boolean).join(" · ").slice(0, 800);
      for (const k of ["specialty", "hospital"] as const) if (!cell(same, k) && v[k]) same[k] = v[k];
      continue;
    }
    rows.push({ date: v.date ?? "", doctor: v.doctorName ?? "", specialty: v.specialty ?? "", hospital: v.hospital ?? "", takeaway: takeaway.slice(0, 800), sources: [d.id] });
  }
  return rows.sort((a, b) => cell(b, "date").localeCompare(cell(a, "date")));
}

/** Without the AI's history: visits, doctors and the newest medicine list taken straight from each record. */
function fromRecords(clinical: { id: number; x: DocExtract }[], treating: string | null): Draft {
  const doctors: DoctorItem[] = [];
  for (const d of clinical) for (const v of d.x.visits ?? []) {
    if (!v.doctorName) continue;
    const hit = doctors.find((x) => normDoc(x.name) === normDoc(v.doctorName));
    if (hit) { hit.seen++; continue; }
    const isTreating = !!treating && normDoc(v.doctorName) === normDoc(treating);
    doctors.push({ name: v.doctorName, specialty: v.specialty ?? "", hospital: v.hospital ?? "", role: isTreating ? "treating" : "consultant", seen: 1, aliases: [], add: !isTreating });
  }
  const newest = [...clinical].filter((d) => d.x.medList?.length).sort((a, b) => (b.x.date ?? "").localeCompare(a.x.date ?? ""))[0];
  const summary = emptyHistory();
  summary.medicines = (newest?.x.medList ?? []).map((m) => ({ name: m, dose: "", indication: "", started: "", prescriber: newest!.x.prescriber ?? "", sources: [newest!.id] }));
  return { summary, doctors, merges: [], points: [], labs: [], texts: [], homes: [] };
}

// ---------------------------------------------------------------- editing, sending, confirming
/** Saves the checker's edits (any part of the draft). After confirmation only the history can still be edited. */
export function saveDraftEdits(pid: string, edits: Partial<Draft>, by: UserRow, t: number) {
  const o = currentOnboarding(pid);
  if (!o) throw new Error("No onboarding for this patient");
  const d = draftOf(o);
  if (!d) throw new Error("The draft isn't ready yet");
  if (o.status === "SENT" && by.role !== "DOCTOR") throw new Error("This onboarding is with the doctor");
  const next: Draft = { ...d };
  if (edits.summary) next.summary = cleanHistory(edits.summary);
  if (o.status !== "CONFIRMED") {
    for (const k of ["doctors", "merges", "points", "labs", "texts", "homes"] as const) if (Array.isArray(edits[k])) (next as unknown as Record<string, unknown>)[k] = edits[k];
  }
  run("UPDATE onboardings SET draft = ?, updated_at = ? WHERE id = ?", JSON.stringify(next), t, o.id);
  if (o.status === "CONFIRMED") audit(t, by.id, "CLINICAL_HISTORY_EDITED", "patient", pid, { onboarding: o.id });
}

/** Things a person should look at before it goes to the doctor (or that the doctor has to answer). */
export function openItems(d: Draft) {
  return {
    points: d.points.filter((p) => p.status === "open").length,
    forDoctor: d.points.filter((p) => p.status === "doctor").length,
    labs: d.labs.filter((l) => l.check && !l.ok && l.value !== null).length,
    merges: d.merges.length,
  };
}

export function sendToDoctor(pid: string, by: UserRow, t: number) {
  const o = openOnboarding(pid);
  if (o.status !== "REVIEW" && o.status !== "RETURNED") throw new Error(o.status === "COLLECTING" ? "The records are still being read" : "Already sent to the doctor");
  const d = draftOf(o);
  if (!d) throw new Error("The draft isn't ready yet");
  // Points the assistant didn't resolve go to the doctor.
  d.points = d.points.map((p) => (p.status === "open" ? { ...p, status: "doctor" } : p));
  run("UPDATE onboardings SET status = 'SENT', draft = ?, sent_by = ?, sent_at = ?, return_note = NULL, updated_at = ? WHERE id = ?", JSON.stringify(d), by.id, t, t, o.id);
  audit(t, by.id, "ONBOARDING_SENT", "patient", pid, { onboarding: o.id });
}

export function sendBack(pid: string, by: UserRow, note: string, t: number) {
  const o = openOnboarding(pid);
  if (o.status !== "SENT") throw new Error("Only an onboarding waiting for the doctor can be sent back");
  run("UPDATE onboardings SET status = 'RETURNED', returned_by = ?, returned_at = ?, return_note = ?, updated_at = ? WHERE id = ?", by.id, t, note.trim().slice(0, 500) || null, t, o.id);
  audit(t, by.id, "ONBOARDING_RETURNED", "patient", pid, { onboarding: o.id });
}

const FREQ: [RegExp, string][] = [[/\b(three times|tds|tid|1-1-1)\b/i, "TDS"], [/\b(twice|bd|bid|1-0-1)\b/i, "BD"], [/\b(four times|qid)\b/i, "QID"], [/\b(at night|hs|bedtime|0-0-1)\b/i, "HS"], [/\b(once|od|daily|1-0-0)\b/i, "OD"], [/\b(weekly)\b/i, "weekly"], [/\b(sos|as needed|prn)\b/i, "PRN"]];
const freqOf = (dose: string) => FREQ.find(([re]) => re.test(dose))?.[1] ?? "as prescribed";
const fmtDay = (d: string | null) => (d && isDay(d) ? fmtDate(Date.parse(`${d}T12:00:00+05:30`), { day: "numeric", month: "short", year: "numeric" }) : d ?? "date unknown");

/** The doctor confirms: the history, doctors, visits, lab values, results and home readings go into the record. */
export function confirmOnboarding(pid: string, by: UserRow, t: number) {
  const o = openOnboarding(pid);
  const p = getPatient(pid)!;
  if (by.role !== "DOCTOR" || p.doctor_id !== by.id) throw new Error("Only the patient's doctor can confirm the onboarding");
  if (o.status === "COLLECTING") throw new Error("The records are still being read");
  const d = draftOf(o);
  if (!d) throw new Error("The draft isn't ready yet");
  const treating = getUser(p.doctor_id)?.name ?? "";
  const counts = { doctors: 0, visits: 0, labs: 0, texts: 0, homes: 0 };
  tx(() => {
    // Doctors (merged ones are folded into their twin by the review screen and arrive as one entry).
    const added = new Set<string>();
    for (const doc of d.doctors) {
      if (!doc.add || doc.role === "treating" || !doc.name) continue;
      upsertCareTeam(pid, doc.name, doc.specialty || null, doc.hospital || null);
      added.add(normDoc(doc.name));
      for (const a of doc.aliases) added.add(normDoc(a));
      counts.doctors++;
    }
    // Visits to other doctors, on their dates. The treating doctor's own past visits stay in the history only.
    const treatingNames = new Set([normDoc(treating), ...d.doctors.filter((x) => x.role === "treating").flatMap((x) => [normDoc(x.name), ...x.aliases.map(normDoc)])]);
    for (const v of listOf(d.summary, "visits")) {
      const date = cell(v, "date"), doctor = cell(v, "doctor");
      if (!isDay(date) || !doctor || treatingNames.has(normDoc(doctor))) continue;
      const ovId = saveDocumentVisit(pid, by.id, v.sources[0] ?? null, { date, doctorName: doctor, specialty: cell(v, "specialty"), hospital: cell(v, "hospital"), findings: cell(v, "takeaway") }, t);
      // The doctor has just confirmed it: it doesn't wait on the chart as a new visit to review.
      run("UPDATE outside_visits SET reviewed_by = ?, reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL", by.id, t, ovId);
      counts.visits++;
    }
    // Lab values: one per test and day; a value already on record that day is not entered again.
    for (const l of d.labs) {
      if (l.value === null || !Number.isFinite(l.value) || !l.date || !isDay(l.date) || !LAB_META[l.marker]) continue;
      const at = Math.min(Date.parse(`${l.date}T09:00:00+05:30`), t);
      if (get("SELECT 1 FROM labs WHERE patient_id = ? AND marker = ? AND taken_at >= ? AND taken_at < ?", pid, l.marker, at - 9 * 3_600_000, at + 15 * 3_600_000)) continue;
      const r = addLab(pid, l.marker, l.value, at, "ONBOARDING", by.id, null);
      if (l.sources[0]) run("UPDATE labs SET document_id = ? WHERE id = ?", l.sources[0], r.id);
      counts.labs++;
    }
    for (const x of d.texts) {
      if (!x.date || !isDay(x.date)) continue;
      counts.texts += enterTexts(pid, [x], Math.min(Date.parse(`${x.date}T09:00:00+05:30`), t), by.id, x.sources[0] ?? null, "ONBOARDING");
    }
    for (const h of d.homes) {
      const at = Math.min(Date.parse(`${h.date}T${h.time ?? "08:00"}:00+05:30`), t);
      if (!Number.isFinite(at) || get("SELECT 1 FROM observations WHERE patient_id = ? AND type = ? AND observed_at = ? AND v1 = ?", pid, h.type, at, h.v1)) continue;
      run("INSERT INTO observations(patient_id, type, v1, v2, observed_at, logged_by, parser) VALUES(?,?,?,?,?,?,?)", pid, h.type, h.v1, h.v2 ?? null, at, by.id, "onboarding");
      counts.homes++;
    }
    // The baseline gets the essentials from the history (conditions, alerts, current medicines, a short history).
    const s = d.summary;
    const f = (sec: string, k: string) => fieldsOf(s, sec)[k]?.text?.trim() ?? "";
    const rows = (sec: string, fmt: (r: HistRow) => string) => listOf(s, sec).map(fmt).filter(Boolean).join("; ");
    const prev = getBaseline(pid);
    const answered = d.points.filter((x) => x.answer?.trim()).map((x) => `${x.title}: ${x.answer!.trim()}`);
    const line = (label: string, text: string) => (text ? `${label}: ${text}${/[.!?]$/.test(text) ? "" : "."}` : "");
    const history = [
      line("Summary", f("snapshot", "oneGlance")),
      line("Implants / devices", f("alerts", "implants")),
      line("Anticoagulant / antiplatelet", f("alerts", "anticoagulants")),
      line("Code status", f("alerts", "codeStatus")),
      line("Admissions", rows("admissions", (a) => [fmtDay(cell(a, "from") || null) + (cell(a, "to") && cell(a, "to") !== cell(a, "from") ? `–${fmtDay(cell(a, "to"))}` : ""), cell(a, "facility"), cell(a, "reason") && `(${cell(a, "reason")})`].filter(Boolean).join(" "))),
      line("Procedures", rows("procedures", (x) => [cell(x, "date") || "date unknown", cell(x, "procedure"), cell(x, "facility")].filter(Boolean).join(", "))),
      line("Past conditions", rows("resolved", (x) => [cell(x, "name"), cell(x, "period") && `(${cell(x, "period")})`, cell(x, "outcome")].filter(Boolean).join(" "))),
      line("Studies", rows("studies", (x) => [cell(x, "date"), cell(x, "study"), cell(x, "finding")].filter(Boolean).join(" "))),
      line("Immunisations", rows("immunisations", (x) => [cell(x, "vaccine"), cell(x, "dates"), cell(x, "status")].filter(Boolean).join(" "))),
      line("Pending", rows("pending", (x) => [cell(x, "item"), cell(x, "due")].filter(Boolean).join(" "))),
    ].filter(Boolean).join("\n");
    const blood = f("snapshot", "bloodGroup").match(/\b(A|B|AB|O)\s*(\+|-|positive|negative|pos|neg|\+ve|-ve)/i);
    const base = cleanBaseline({
      ...(prev ?? {}),
      ...(blood && !prev?.bloodGroup ? { bloodGroup: `${blood[1].toUpperCase()}${/^(\+|pos|positive|\+ve)/i.test(blood[2]) ? "+" : "-"}` } : {}),
      conditions: [...new Set([...(prev?.conditions ?? []), ...listOf(s, "conditions").map((c) => cell(c, "name")).filter(Boolean)])],
      allergies: f("alerts", "allergies") || prev?.allergies || "",
      history: [prev?.history, history].filter(Boolean).join("\n"),
      familyHistory: [prev?.familyHistory, f("social", "family")].filter(Boolean).join("\n"),
      currentMeds: listOf(s, "medicines").filter((m) => cell(m, "name")).map((m) => ({ name: cell(m, "name"), dose: cell(m, "dose").slice(0, 40), frequency: freqOf(cell(m, "dose")), ...(cell(m, "prescriber") ? { prescriber: cell(m, "prescriber") } : {}), ...(cell(m, "indication") ? { purpose: cell(m, "indication") } : {}) })),
      notes: [prev?.notes, answered.length ? `Confirmed at onboarding:\n${answered.join("\n")}` : ""].filter(Boolean).join("\n\n"),
      labs: prev?.labs ?? [],
    } as Partial<Baseline>, t);
    if (typeof base === "string") throw new Error(base);
    saveBaseline(pid, base, t, by.id);
    // The records are filed: they don't wait for a separate check on the Documents tab.
    for (const r of all<{ id: number; extract: string | null }>("SELECT id, extract FROM patient_documents WHERE onboarding_id = ?", o.id)) {
      const x = readExtract(r.extract);
      run("UPDATE patient_documents SET filed_at = COALESCE(filed_at, ?), filed_by = COALESCE(filed_by, ?), extract = ? WHERE id = ?", t, by.id, x ? JSON.stringify({ ...x, done: true }) : r.extract, r.id);
    }
    run("UPDATE onboardings SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?", by.id, t, t, o.id);
    audit(t, by.id, "ONBOARDING_CONFIRMED", "patient", pid, { onboarding: o.id, ...counts });
  });
  return counts;
}

// ---------------------------------------------------------------- worklists
export interface OnboardingTask { onboardingId: number; patientId: string; patientName: string; status: OnbStatus; updatedAt: number; records: number; forDoctor: number; byName: string | null; note: string | null }
/** The doctor sees onboardings waiting for them; the assistant sees the ones in progress or sent back. */
export function onboardingTasks(user: UserRow): OnboardingTask[] {
  const rows = all<OnboardingRow & { name: string; doctor_id: string }>(
    "SELECT o.*, p.name, p.doctor_id FROM onboardings o JOIN patients p ON p.id = o.patient_id WHERE o.status != 'CONFIRMED' ORDER BY o.updated_at DESC");
  return rows
    .filter((r) => (user.role === "DOCTOR" ? r.doctor_id === user.id && r.status === "SENT" : user.role === "PA"))
    .map((r) => {
      const d = draftOf(r);
      return {
        onboardingId: r.id, patientId: r.patient_id, patientName: r.name, status: r.status, updatedAt: r.updated_at,
        records: get<{ n: number }>("SELECT COUNT(*) AS n FROM patient_documents WHERE onboarding_id = ?", r.id)?.n ?? 0,
        forDoctor: d ? d.points.filter((p) => p.status === "doctor").length : 0,
        byName: (r.status === "SENT" ? getUser(r.sent_by ?? "") : r.status === "RETURNED" ? getUser(r.returned_by ?? "") : null)?.name ?? null,
        note: r.status === "RETURNED" ? r.return_note : null,
      };
    });
}

