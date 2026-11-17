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
import { isAIConfigured, lastTranscribeError, synthesizeHistoryAI, updateHistoryAI } from "./gemini";
import { LAB_META, type Baseline } from "./types";
import { resolveMarker } from "./labmarkers";
import { dayKey, fmtDate } from "./time";
import { now as clockNow } from "./clock";
import { HISTORY, cell, cleanHistory, emptyHistory, fieldsOf, listOf, rowText, unmarked, type HistField, type History, type HistRow, type ListSpec } from "./historyspec";

export type OnbStatus = "COLLECTING" | "REVIEW" | "SENT" | "RETURNED" | "CONFIRMED";
export type Pile = "clinical" | "lab";

export interface DoctorItem { name: string; specialty: string; hospital: string; role: "treating" | "consultant" | "lab"; seen: number; aliases: string[]; add: boolean }
export interface MergeItem { a: string; b: string; reason: string }
/** `old`: from an earlier, already confirmed history (shown folded away when the history is updated). */
export interface Point { id: string; title: string; detail: string; sources: number[]; status: "open" | "resolved" | "doctor"; answer?: string; old?: boolean }
/** `fresh`: came from records added after the draft was first put together. */
export interface LabItem { id: string; marker: string; date: string | null; value: number | null; unit: string; sources: number[]; check?: string; ok?: boolean; fresh?: boolean }
export interface TextItem { id: string; test: string; group?: string; result: string; reference?: string; date: string | null; sources: number[]; fresh?: boolean }
export interface HomeItem { id: string; type: string; v1: number; v2?: number; date: string; time?: string; sources: number[]; fresh?: boolean }
export interface Draft {
  /** The patient history in the clinic template's sections (lib/historyspec.ts). */
  summary: History;
  doctors: DoctorItem[];
  merges: MergeItem[];
  points: Point[];
  labs: LabItem[];
  texts: TextItem[];
  homes: HomeItem[];
  /** The records already folded into this draft; records added later are added to it, not rebuilt from scratch. */
  builtFrom?: number[];
}
export interface OnboardingRow {
  id: number; patient_id: string; status: OnbStatus; draft: string | null; built_at: number | null; build_error: string | null;
  created_by: string | null; created_at: number; updated_at: number; sent_by: string | null; sent_at: number | null;
  confirmed_by: string | null; confirmed_at: number | null; returned_by: string | null; returned_at: number | null; return_note: string | null;
  /** Set when this adds records to an already confirmed history (the onboarding it builds on). */
  base_id: number | null;
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

/** The patient's latest confirmed history, if any. */
export const confirmedOnboarding = (pid: string) => get<OnboardingRow>("SELECT * FROM onboardings WHERE patient_id = ? AND status = 'CONFIRMED' ORDER BY id DESC LIMIT 1", pid);

/** What the confirmed history (built from the patient's own records) says at a glance: the one-glance summary, the
 *  active conditions, and the most recent visit to the treating doctor (any doctor when the records show none to them). */
export interface RecordSummary {
  confirmedAt: number | null;
  oneGlance: string;
  /** `detail` is the whole entry as a sentence (status with its value, when diagnosed, treatment, advice). */
  conditions: { name: string; status: string; detail: string }[];
  lastVisit: { date: string; doctor: string; specialty: string; hospital: string; takeaway: string; treating: boolean; changes: string[] } | null;
}
function conditionSentence(c: HistRow): string {
  const end = (x: string) => (/[.!?]$/.test(x) ? x : `${x}.`);
  const status = cell(c, "status"), diagnosed = cell(c, "diagnosed"), treatment = cell(c, "treatment"), advice = cell(c, "advice");
  return [
    end(status ? `${cell(c, "name")} is ${status.charAt(0).toLowerCase()}${status.slice(1)}` : cell(c, "name")),
    diagnosed ? end(`Diagnosed ${diagnosed}`) : "",
    treatment ? end(`Current treatment: ${treatment}`) : "",
    advice ? end(`Advice given: ${advice}`) : "",
  ].filter(Boolean).join(" ");
}
export function recordSummary(pid: string): RecordSummary | null {
  const o = confirmedOnboarding(pid);
  const d = draftOf(o);
  if (!o || !d) return null;
  const s = d.summary;
  const treating = getUser(getPatient(pid)?.doctor_id ?? "")?.name ?? "";
  const names = new Set([normDoc(treating), ...d.doctors.filter((x) => x.role === "treating").flatMap((x) => [normDoc(x.name), ...x.aliases.map(normDoc)])].filter(Boolean));
  const visits = listOf(s, "visits").filter((v) => cell(v, "date") || cell(v, "takeaway")).sort((a, b) => cell(b, "date").localeCompare(cell(a, "date")));
  const mine = visits.find((v) => names.has(normDoc(cell(v, "doctor"))));
  const v = mine ?? visits[0];
  return {
    confirmedAt: o.confirmed_at ?? null,
    oneGlance: fieldsOf(s, "snapshot").oneGlance?.text?.trim() ?? "",
    conditions: listOf(s, "conditions").filter((c) => cell(c, "name")).slice(0, 8).map((c) => ({ name: cell(c, "name"), status: cell(c, "status"), detail: conditionSentence(c) })),
    lastVisit: v ? {
      date: cell(v, "date"), doctor: cell(v, "doctor"), specialty: cell(v, "specialty"), hospital: cell(v, "hospital"), takeaway: cell(v, "takeaway"), treating: !!mine,
      // Medicine changes the records put on that same day.
      changes: cell(v, "date") ? listOf(s, "medChanges").filter((m) => cell(m, "date") === cell(v, "date")).slice(0, 6).map((m) => [cell(m, "drug"), cell(m, "change"), cell(m, "reason") ? `(${cell(m, "reason")})` : ""].filter(Boolean).join(" ")) : [],
    } : null,
  };
}

/** Opens an update to a confirmed history (the only way to change it once confirmed): it starts as a copy of that
 *  history; corrections and the records added to it are marked new or changed, for the doctor to confirm again.
 *  The confirmed version itself is never edited: each confirmation is kept as its own version. */
export function startUpdate(pid: string, by: string, t: number): number {
  const open = get<{ id: number }>("SELECT id FROM onboardings WHERE patient_id = ? AND status != 'CONFIRMED' ORDER BY id DESC LIMIT 1", pid);
  if (open) return open.id;
  const base = confirmedOnboarding(pid);
  const d = draftOf(base);
  if (!base || !d) return startOnboarding(pid, by, t);
  const copy: Draft = {
    ...d,
    summary: unmarked(d.summary),
    builtFrom: d.builtFrom ?? builtSoFar(base),
    points: d.points.map((x) => ({ ...x, old: true })),
    merges: [],
    // The doctor has confirmed these values: their warnings are settled.
    labs: d.labs.map(({ fresh: _f, ...x }) => (x.check ? { ...x, ok: true } : x)), texts: d.texts.map(({ fresh: _f, ...x }) => x), homes: d.homes.map(({ fresh: _f, ...x }) => x),
  };
  // It opens ready to correct; adding records sends it to reading first.
  const id = run("INSERT INTO onboardings(patient_id, status, draft, built_at, created_by, created_at, updated_at, base_id) VALUES(?,?,?,?,?,?,?,?)", pid, "REVIEW", JSON.stringify(copy), t, by, t, t, base.id).lastInsertRowid;
  audit(t, by, "HISTORY_UPDATE_STARTED", "patient", pid, { onboarding: id, base: base.id });
  return id;
}

/** An update opened before confirmed values were marked checked: settles their warnings (once; values from the
 *  records added in the update keep theirs). */
export function settleConfirmedLabs(o: OnboardingRow) {
  if (!o.base_id || o.status === "CONFIRMED") return;
  const d = draftOf(o);
  if (!d || !d.labs.some((l) => l.check && !l.ok && !l.fresh)) return;
  d.labs = d.labs.map((l) => (l.check && !l.ok && !l.fresh ? { ...l, ok: true } : l));
  run("UPDATE onboardings SET draft = ? WHERE id = ?", JSON.stringify(d), o.id);
}

/** For drafts made before `builtFrom` was kept: the records that were read when the draft was put together. */
function builtSoFar(o: OnboardingRow): number[] {
  return all<{ id: number }>("SELECT id FROM patient_documents WHERE onboarding_id = ? AND extract IS NOT NULL AND uploaded_at <= ?", o.id, o.built_at ?? 0).map((r) => r.id);
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

/** A record typed in instead of uploaded: lab values (filed as typed, no AI needed) or a note (read like any document).
 *  It is kept as a small text document, so it appears in the piles, can be opened, and is cited like an upload. */
export function addTypedRecord(pid: string, by: string, input: { date?: string; kind?: string; text?: string; values?: { test?: string; value?: string; unit?: string }[] }, t: number): number {
  const date = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : null;
  if (!date) throw new Error("Enter the date of the report or visit");
  if (Date.parse(`${date}T00:00:00+05:30`) > t + 86_400_000) throw new Error("The date can't be in the future");
  const shown = fmtDay(date);
  if (input.kind === "note") {
    const text = (input.text ?? "").trim().slice(0, 20_000);
    if (text.length < 5) throw new Error("Type the note first");
    const body = `Date of this record: ${date}\nTyped in by the clinic (not a scanned document).\n\n${text}`;
    return addRecord(pid, by, { base64: `data:text/plain;base64,${Buffer.from(body, "utf8").toString("base64")}`, mime: "text/plain", name: `Typed note, ${shown}` }, t);
  }
  // Lab values: each test is matched to a known one by name (or learned as a new test); results that aren't numbers
  // are kept as text results. Nothing is guessed, so no AI is needed.
  const rows = (input.values ?? []).map((v) => ({ test: str(v.test, 60), value: str(v.value, 60), unit: str(v.unit, 20) })).filter((v) => v.test && v.value).slice(0, 80);
  if (!rows.length) throw new Error("Enter at least one test and its value");
  const labs: DocExtract["labs"] = [];
  const texts: { test: string; result: string }[] = [];
  for (const r of rows) {
    const num = Number(r.value.replace(",", "."));
    const marker = Number.isFinite(num) && /^[<>]?\s*-?[\d.,]+$/.test(r.value) ? resolveMarker(null, r.test, r.unit) : null;
    if (marker) labs.push({ marker, value: num, unit: r.unit || LAB_META[marker]?.unit || "", date });
    else texts.push({ test: r.test, result: [r.value, r.unit].filter(Boolean).join(" ") });
  }
  const lines = rows.map((r) => `${r.test}: ${r.value}${r.unit ? ` ${r.unit}` : ""}`);
  const body = `Lab values typed in by the clinic. Sample date: ${date}\n\n${lines.join("\n")}`;
  const title = `Lab values typed in, ${shown}`;
  const o = openOnboarding(pid);
  if (o.status === "SENT") throw new Error("This onboarding is with the doctor. Ask them to send it back to add records.");
  const docId = addDocument(pid, { title, category: "lab", mime: "text/plain", base64: `data:text/plain;base64,${Buffer.from(body, "utf8").toString("base64")}`, notes: "Typed in at onboarding" }, t, by);
  const x: DocExtract = { category: "lab", title, date, prescriber: null, labs, texts, kind: "lab_report", text: body, meds: 0, note: null };
  run("UPDATE patient_documents SET onboarding_id = ?, pile = 'lab', pile_by = 'user', extract = ? WHERE id = ?", o.id, JSON.stringify(x), docId);
  run("UPDATE onboardings SET status = 'COLLECTING', updated_at = ? WHERE id = ?", t, o.id);
  audit(t, by, "ONBOARDING_VALUES_TYPED", "patient", pid, { onboarding: o.id, document: docId, values: rows.length });
  maybeBuild(o.id);
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
  // From scratch: a first onboarding forgets its draft; an update goes back to the confirmed history it started from.
  const base = o.base_id ? getOnboarding(o.base_id) : null;
  const restart = base ? JSON.stringify({ ...draftOf(base)!, summary: unmarked(draftOf(base)!.summary), builtFrom: draftOf(base)!.builtFrom ?? builtSoFar(base), points: draftOf(base)!.points.map((x) => ({ ...x, old: true })), merges: [], labs: draftOf(base)!.labs.map((x) => (x.check ? { ...x, ok: true } : x)) }) : null;
  const hasRecords = !!get("SELECT 1 FROM patient_documents WHERE onboarding_id = ?", o.id);
  run("UPDATE onboardings SET status = ?, draft = ?, build_error = NULL, updated_at = ? WHERE id = ?", base && !hasRecords ? "REVIEW" : "COLLECTING", restart, t, o.id);
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
  // A draft that already exists (checked, perhaps edited) takes in only the records added since: nothing is lost.
  const prev = draftOf(o);
  if (prev) return addToDraft(o, prev, docs, p, treating);
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
  draft.builtFrom = docs.map((d) => d.id);
  const t = clockNow();
  run("UPDATE onboardings SET draft = ?, built_at = ?, build_error = ?, status = 'REVIEW', updated_at = ? WHERE id = ?", JSON.stringify(draft), t,
    clinical.length && !ai ? `The history couldn't be put together automatically (${lastTranscribeError ?? "AI unavailable"}); it was filled from each record's visits instead.` : null, t, onbId);
  return draft;
}

type ReadDoc = { id: number; title: string; pile: Pile | null; x: DocExtract };
const uniq = (ids: Set<string>, prefix: string) => { let n = ids.size; while (ids.has(`${prefix}${n}`)) n++; ids.add(`${prefix}${n}`); return `${prefix}${n}`; };

/** Folds records added after the draft was put together into it. The assistant's edits and answers stay; what the new
 *  records add or change is marked, so the checker and the doctor see exactly what's new. */
async function addToDraft(o: OnboardingRow, prev: Draft, docs: ReadDoc[], p: { id: string; name: string; age: number | null; sex: string | null; user_id: string | null }, treating: string | null): Promise<Draft> {
  const done = new Set(prev.builtFrom ?? builtSoFar(o));
  const fresh = docs.filter((d) => !done.has(d.id));
  const d: Draft = structuredClone(prev);
  d.builtFrom = [...new Set([...done, ...docs.map((x) => x.id)])];
  let error: string | null = null;
  if (fresh.length) {
    // Lab values, results and home readings from the new records (a value already in the draft isn't added twice).
    const labIds = new Set(d.labs.map((l) => l.id)), textIds = new Set(d.texts.map((x) => x.id)), homeIds = new Set(d.homes.map((x) => x.id));
    for (const r of fresh) for (const l of r.x.labs) {
      const date = l.date ?? r.x.date ?? null;
      const same = d.labs.find((x) => x.marker === l.marker && x.date === date);
      if (same) {
        if (!same.sources.includes(r.id)) same.sources.push(r.id);
        if (same.value !== l.value && !same.ok) same.check = `A newly added record says ${l.value} (was ${same.value}). Check which is right.`;
        continue;
      }
      const before = d.labs.filter((x) => x.marker === l.marker && x.date && date && x.date < date && x.value).sort((a, b) => b.date!.localeCompare(a.date!))[0];
      const jump = before?.value && l.value && (l.value / before.value > 2.5 || l.value / before.value < 0.4);
      d.labs.push({ id: uniq(labIds, "l"), marker: l.marker, date, value: l.value, unit: l.unit || LAB_META[l.marker]?.unit || "", sources: [r.id], fresh: true,
        ...(l.uncertain ? { check: "Hard to read, or written as approximate." } : jump ? { check: `Big change from ${before!.value} on ${fmtDay(before!.date)}. Check it was read correctly.` } : {}),
        ...(!date ? { check: "No date on the record. Enter the date the sample was taken." } : {}) });
    }
    for (const r of fresh) for (const x of cleanTexts(r.x.texts ?? [])) {
      if (d.texts.some((y) => y.test === x.test && (y.group ?? "") === (x.group ?? "") && y.date === r.x.date)) continue;
      d.texts.push({ id: uniq(textIds, "t"), ...x, date: r.x.date ?? null, sources: [r.id], fresh: true });
    }
    for (const r of fresh) for (const h of r.x.readings ?? []) {
      if (d.homes.some((y) => y.type === h.type && y.date === h.date && y.time === h.time && y.v1 === h.v1)) continue;
      d.homes.push({ id: uniq(homeIds, "h"), ...h, sources: [r.id], fresh: true });
    }
    // Consultations: straight from the new records, merged with the same doctor on the same day.
    const visits = listOf(d.summary, "visits");
    for (const v of visitRows(fresh.filter((r) => r.pile !== "lab"))) {
      const same = visits.find((r) => cell(r, "date") === cell(v, "date") && normDoc(cell(r, "doctor")) === normDoc(cell(v, "doctor")));
      if (same) {
        same.sources = [...new Set([...same.sources, ...v.sources])];
        if (cell(v, "takeaway") && !cell(same, "takeaway").includes(cell(v, "takeaway"))) same.takeaway = [cell(same, "takeaway"), cell(v, "takeaway")].filter(Boolean).join(" · ").slice(0, 800);
      } else visits.push({ ...v, _new: true });
    }
    d.summary.visits = visits.sort((a, b) => cell(b, "date").localeCompare(cell(a, "date")));

    // The rest of the history: the AI reads the new records against it and says what to add or change.
    const clinical = fresh.filter((r) => r.pile !== "lab"), reports = fresh.filter((r) => r.pile === "lab");
    const trends: Record<string, string[]> = {};
    for (const l of [...d.labs].filter((x) => x.value !== null && x.date).sort((a, b) => a.date!.localeCompare(b.date!))) (trends[LAB_META[l.marker]?.label ?? l.marker] ??= []).push(`${l.date}: ${l.value} ${l.unit}`.trim());
    const history: Record<string, unknown> = {};
    for (const sec of HISTORY) {
      if (sec.key === "visits") continue;
      history[sec.key] = sec.kind === "list"
        ? listOf(d.summary, sec.key).map((r, i) => ({ i, ...Object.fromEntries(sec.cols.map((c) => [c.key, cell(r, c.key)]).filter(([, v]) => v)) }))
        : Object.fromEntries(Object.entries(fieldsOf(d.summary, sec.key)).map(([k, v]) => [k, v.text]).filter(([, v]) => v));
    }
    const caregivers = all<{ name: string; relation: string | null }>("SELECT name, relation FROM caregivers WHERE patient_id = ? ORDER BY level", p.id);
    const ai = await updateHistoryAI({
      today: dayKey(clockNow()), treatingDoctor: treating,
      patient: { name: p.name, age: p.age, sex: p.sex, language: (p.user_id && getSetting(`lang:${p.user_id}`)) || null, caregivers },
      history, doctors: d.doctors.map((x) => ({ name: x.name, specialty: x.specialty, aliases: x.aliases })),
      documents: clinical.map((r) => ({ id: r.id, title: r.title, date: r.x.date, type: r.x.kind ?? r.x.category, prescriber: r.x.prescriber, text: (r.x.text ?? "").slice(0, 30_000), visits: r.x.visits ?? [], medicines: r.x.medList ?? [] })),
      reports: reports.map((r) => ({ id: r.id, title: r.title, date: r.x.date, type: r.x.kind ?? r.x.category, text: (r.x.text ?? "").slice(0, 2500) })),
      labTrends: trends,
    });
    const valid = new Set([...d.builtFrom, ...docs.map((x) => x.id)]);
    if (ai) applyUpdate(d, ai, valid, treating, !!o.base_id);
    else {
      error = `The new records couldn't be added to the history automatically (${lastTranscribeError ?? "AI unavailable"}). Their visits, lab values and readings were added; update the other sections by hand, or try again.`;
      for (const r of clinical) for (const v of r.x.visits ?? []) if (v.doctorName) addDoctor(d, { name: v.doctorName, specialty: v.specialty ?? "", hospital: v.hospital ?? "", role: treating && normDoc(v.doctorName) === normDoc(treating) ? "treating" : "consultant", seen: 1, aliases: [], add: true });
    }
  }
  const t = clockNow();
  run("UPDATE onboardings SET draft = ?, built_at = ?, build_error = ?, status = 'REVIEW', updated_at = ? WHERE id = ?", JSON.stringify(d), t, error, t, o.id);
  return d;
}

function addDoctor(d: Draft, doc: DoctorItem) {
  const hit = d.doctors.find((x) => [x.name, ...x.aliases].some((n) => normDoc(n) === normDoc(doc.name)));
  if (hit) { hit.seen += doc.seen; hit.specialty ||= doc.specialty; hit.hospital ||= doc.hospital; return; }
  d.doctors.push(doc);
}

/** Applies the AI's additions and changes to the history, marking each one. */
function applyUpdate(d: Draft, ai: Record<string, unknown>, valid: Set<number>, treating: string | null, approved = false) {
  // In an update, entries the doctor has confirmed are not rewritten by a new record: the disagreement becomes a point
  // to confirm instead. Only entries added in this update can be changed.
  const pointIds = new Set(d.points.map((x) => x.id));
  const disagree = (where: string, was: string, now: string, why: string, sources: number[]) => d.points.push({
    id: uniq(pointIds, "p"), title: `${where}: a new record differs from the confirmed history`,
    detail: `Confirmed: “${was}”. ${why ? `${why}: ` : "New record: "}“${now}”. Update the entry if the new record is right.`, sources, status: "open" });
  const lists = Object.fromEntries(HISTORY.filter((x): x is ListSpec => x.kind === "list").map((x) => [x.key, x]));
  const add = (ai.add ?? {}) as Record<string, unknown>;
  for (const [key, rows] of Object.entries(add)) {
    if (!lists[key] || key === "visits") continue;
    const clean = listOf(cleanHistory({ [key]: rows }, valid), key);
    d.summary[key] = [...clean.map((r) => ({ ...r, _new: true })), ...listOf(d.summary, key)];
  }
  // Changes refer to rows by their place in the history as it was sent (before the additions above).
  const offset = (key: string) => (Array.isArray(add[key]) ? listOf(cleanHistory({ [key]: add[key] }, valid), key).length : 0);
  for (const c of arr(ai.change)) {
    const key = str(c.section, 40), sec = lists[key];
    if (!sec || key === "visits") continue;
    const rows = listOf(d.summary, key), i = Math.round(Number(c.i)) + offset(key);
    const now = listOf(cleanHistory({ [key]: [c.row] }, valid), key)[0];
    if (!now || !Number.isInteger(i) || !rows[i]) continue;
    const old = rows[i];
    if (rowText(sec, now) === rowText(sec, old)) continue;
    if (approved && !old._new) { disagree(sec.title, rowText(sec, old), rowText(sec, now), str(c.why, 300), now.sources); continue; }
    rows[i] = { ...now, sources: [...new Set([...old.sources, ...now.sources])], ...(old._new ? { _new: true } : { _changed: str(c.why, 300) || "Updated from a new record", _was: old._was ?? rowText(sec, old) }) };
  }
  for (const [key, fields] of Object.entries((ai.fields ?? {}) as Record<string, Record<string, { text?: unknown; sources?: unknown; why?: unknown }>>)) {
    const sec = HISTORY.find((x) => x.key === key);
    if (!sec || sec.kind !== "fields" || !fields || typeof fields !== "object") continue;
    const cur = fieldsOf(d.summary, key);
    for (const f of sec.fields) {
      const v = fields[f.key];
      const text = str(v?.text, 800);
      if (!v || !text || text === cur[f.key]?.text) continue;
      const old: HistField = cur[f.key] ?? { text: "", sources: [] };
      if (approved && old.text && !old._new) { disagree(`${sec.title} – ${f.label}`, old.text, text, str(v.why, 300), ids(v.sources, valid)); continue; }
      cur[f.key] = { text, sources: [...new Set([...old.sources, ...ids(v.sources, valid)])], ...(old.text && !old._new ? { _changed: str(v.why, 300) || "Updated from a new record", _was: old._was ?? old.text } : { _new: true }) };
    }
    d.summary[key] = cur;
  }
  for (const x of arr(ai.doctors)) {
    if (!str(x.name, 80)) continue;
    const role = (["treating", "consultant", "lab"] as const).find((r) => r === x.role) ?? "consultant";
    const isTreating = role === "treating" || (!!treating && normDoc(str(x.name)) === normDoc(treating));
    addDoctor(d, { name: str(x.name, 80), specialty: str(x.specialty, 60), hospital: str(x.hospital, 80), role: isTreating ? "treating" : role, seen: Math.max(1, Math.round(Number(x.seen) || 1)), aliases: (Array.isArray(x.aliases) ? x.aliases : []).map((a) => str(a, 80)).filter(Boolean).slice(0, 6), add: !isTreating && role === "consultant" });
  }
  for (const m of arr(ai.merges)) {
    const a = str(m.a, 80), b = str(m.b, 80);
    if (a && b && a !== b && d.doctors.some((x) => x.name === a) && d.doctors.some((x) => x.name === b) && !d.merges.some((y) => y.a === a && y.b === b)) d.merges.push({ a, b, reason: str(m.reason, 200) });
  }
  for (const x of arr(ai.points).filter((x) => str(x.title)).slice(0, 40)) d.points.push({ id: uniq(pointIds, "p"), title: str(x.title, 120), detail: str(x.detail, 400), sources: ids(x.sources, valid), status: "open" });
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
/** Saves the checker's edits to a draft in progress. A confirmed history can't be edited: corrections go through an
 *  update (startUpdate), where every difference from the confirmed version is marked for the doctor. */
export function saveDraftEdits(pid: string, edits: Partial<Draft>, by: UserRow, t: number) {
  const o = currentOnboarding(pid);
  if (!o) throw new Error("No onboarding for this patient");
  if (o.status === "CONFIRMED") throw new Error("The confirmed history is locked. Use “Correct or add records” to propose a change for the doctor to confirm.");
  const d = draftOf(o);
  if (!d) throw new Error("The draft isn't ready yet");
  if (o.status === "SENT" && by.role !== "DOCTOR") throw new Error("This onboarding is with the doctor");
  const next: Draft = { ...d };
  if (edits.summary) {
    next.summary = cleanHistory(edits.summary, undefined, true);
    const base = o.base_id ? draftOf(getOnboarding(o.base_id)) : null;
    if (base) markEdits(base.summary, next.summary, by.name);
  }
  for (const k of ["doctors", "merges", "points", "labs", "texts", "homes"] as const) if (Array.isArray(edits[k])) (next as unknown as Record<string, unknown>)[k] = edits[k];
  run("UPDATE onboardings SET draft = ?, updated_at = ? WHERE id = ?", JSON.stringify(next), t, o.id);
}

/** In an update, marks what a person changed by hand against the confirmed version, so the doctor sees it too:
 *  an edited entry is "Changed" (with what it said before), a new one "New". Entries left as they were stay unmarked. */
function markEdits(base: History, h: History, who: string) {
  for (const sec of HISTORY) {
    if (sec.kind === "list") {
      const was = listOf(base, sec.key);
      const texts = new Set(was.map((r) => rowText(sec, r)));
      const key = sec.cols[0].key;
      for (const r of listOf(h, sec.key)) {
        const text = rowText(sec, r);
        if (texts.has(text)) { if (!r._new) { delete r._changed; delete r._was; } continue; } // back as it was
        if (r._new || r._changed) continue;
        const twin = was.find((w) => cell(w, key) && cell(w, key) === cell(r, key));
        if (twin) { r._changed = `Edited by ${who}`; r._was = rowText(sec, twin); } else r._new = true;
      }
    } else {
      const was = fieldsOf(base, sec.key), now = fieldsOf(h, sec.key);
      for (const f of sec.fields) {
        const v = now[f.key];
        if (!v) continue;
        const before = was[f.key]?.text ?? "";
        if (v.text === before) { delete v._new; delete v._changed; delete v._was; continue; }
        if (v._new || v._changed) continue;
        if (before) { v._changed = `Edited by ${who}`; v._was = before; } else v._new = true;
      }
    }
  }
}

/** What an update takes out of the confirmed history (shown to the checker and the doctor). */
export function removedFrom(base: History, h: History): { section: string; text: string }[] {
  const out: { section: string; text: string }[] = [];
  for (const sec of HISTORY) {
    if (sec.kind !== "list") continue;
    const now = listOf(h, sec.key);
    const texts = new Set(now.map((r) => rowText(sec, r)));
    const wasTexts = new Set(now.map((r) => r._was).filter(Boolean));
    for (const w of listOf(base, sec.key)) {
      const text = rowText(sec, w);
      if (!texts.has(text) && !wasTexts.has(text)) out.push({ section: sec.title, text });
    }
  }
  return out;
}

/** Every confirmed version of the patient's history, newest first. */
export function historyVersions(pid: string) {
  return all<{ id: number; base_id: number | null; confirmed_at: number; confirmed_by: string | null; created_by: string | null }>(
    "SELECT id, base_id, confirmed_at, confirmed_by, created_by FROM onboardings WHERE patient_id = ? AND status = 'CONFIRMED' ORDER BY id DESC", pid,
  ).map((v, i, list) => ({
    id: v.id, n: list.length - i, confirmedAt: v.confirmed_at, confirmedBy: getUser(v.confirmed_by ?? "")?.name ?? null,
    records: get<{ n: number }>("SELECT COUNT(*) AS n FROM patient_documents WHERE onboarding_id = ?", v.id)?.n ?? 0,
    kind: v.base_id ? "update" as const : "first" as const,
  }));
}

/** Things a person should look at before it goes to the doctor (or that the doctor has to answer). */
export function openItems(d: Draft) {
  return {
    points: d.points.filter((p) => p.status === "open" && !p.old).length,
    forDoctor: d.points.filter((p) => p.status === "doctor" && !p.old).length,
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
  d.points = d.points.map((p) => (p.status === "open" && !p.old ? { ...p, status: "doctor" } : p));
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

/** The short history written into the baseline. */
function historyText(s: History): string {
  const f = (sec: string, k: string) => fieldsOf(s, sec)[k]?.text?.trim() ?? "";
  const rows = (sec: string, fmt: (r: HistRow) => string) => listOf(s, sec).map(fmt).filter(Boolean).join("; ");
  const line = (label: string, text: string) => (text ? `${label}: ${text}${/[.!?]$/.test(text) ? "" : "."}` : "");
  return [
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
}

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
  // Only what came from this onboarding's records is filed (an update leaves what was confirmed before alone).
  const mine = new Set(all<{ id: number }>("SELECT id FROM patient_documents WHERE onboarding_id = ?", o.id).map((r) => r.id));
  const ours = (x: { sources: number[] }) => !o.base_id || x.sources.some((id) => mine.has(id));
  const baseDraft = o.base_id ? draftOf(getOnboarding(o.base_id)) : null;
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
      if (!ours(v)) continue;
      const date = cell(v, "date"), doctor = cell(v, "doctor");
      if (!isDay(date) || !doctor || treatingNames.has(normDoc(doctor))) continue;
      const ovId = saveDocumentVisit(pid, by.id, v.sources[0] ?? null, { date, doctorName: doctor, specialty: cell(v, "specialty"), hospital: cell(v, "hospital"), findings: cell(v, "takeaway") }, t);
      // The doctor has just confirmed it: it doesn't wait on the chart as a new visit to review.
      run("UPDATE outside_visits SET reviewed_by = ?, reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL", by.id, t, ovId);
      counts.visits++;
    }
    // Lab values: one per test and day; a value already on record that day is not entered again.
    for (const l of d.labs) {
      if (!ours(l)) continue;
      if (l.value === null || !Number.isFinite(l.value) || !l.date || !isDay(l.date) || !LAB_META[l.marker]) continue;
      const at = Math.min(Date.parse(`${l.date}T09:00:00+05:30`), t);
      if (get("SELECT 1 FROM labs WHERE patient_id = ? AND marker = ? AND taken_at >= ? AND taken_at < ?", pid, l.marker, at - 9 * 3_600_000, at + 15 * 3_600_000)) continue;
      const r = addLab(pid, l.marker, l.value, at, "ONBOARDING", by.id, null);
      if (l.sources[0]) run("UPDATE labs SET document_id = ? WHERE id = ?", l.sources[0], r.id);
      counts.labs++;
    }
    for (const x of d.texts) {
      if (!ours(x)) continue;
      if (!x.date || !isDay(x.date)) continue;
      counts.texts += enterTexts(pid, [x], Math.min(Date.parse(`${x.date}T09:00:00+05:30`), t), by.id, x.sources[0] ?? null, "ONBOARDING");
    }
    for (const h of d.homes) {
      if (!ours(h)) continue;
      const at = Math.min(Date.parse(`${h.date}T${h.time ?? "08:00"}:00+05:30`), t);
      if (!Number.isFinite(at) || get("SELECT 1 FROM observations WHERE patient_id = ? AND type = ? AND observed_at = ? AND v1 = ?", pid, h.type, at, h.v1)) continue;
      run("INSERT INTO observations(patient_id, type, v1, v2, observed_at, logged_by, parser) VALUES(?,?,?,?,?,?,?)", pid, h.type, h.v1, h.v2 ?? null, at, by.id, "onboarding");
      counts.homes++;
    }
    // The baseline gets the essentials from the history (conditions, alerts, current medicines, a short history).
    // An update replaces what the earlier confirmation wrote rather than adding it twice.
    const s = d.summary;
    const f = (sec: string, k: string) => fieldsOf(s, sec)[k]?.text?.trim() ?? "";
    const prev = getBaseline(pid);
    const answered = d.points.filter((x) => !x.old && x.answer?.trim()).map((x) => `${x.title}: ${x.answer!.trim()}`);
    const swap = (before: string | undefined, oldPart: string, newPart: string) => (oldPart && before?.includes(oldPart) ? before.replace(oldPart, newPart) : [before, newPart].filter(Boolean).join("\n"));
    const history = swap(prev?.history, baseDraft ? historyText(baseDraft.summary) : "", historyText(s));
    const family = swap(prev?.familyHistory, baseDraft ? fieldsOf(baseDraft.summary, "social").family?.text?.trim() ?? "" : "", f("social", "family"));
    const blood = f("snapshot", "bloodGroup").match(/\b(A|B|AB|O)\s*(\+|-|positive|negative|pos|neg|\+ve|-ve)/i);
    const base = cleanBaseline({
      ...(prev ?? {}),
      // Filled when empty, or replaced when the doctor confirmed a correction to it in an update.
      ...(blood && (!prev?.bloodGroup || (baseDraft && fieldsOf(baseDraft.summary, "snapshot").bloodGroup?.text?.trim() !== f("snapshot", "bloodGroup"))) ? { bloodGroup: `${blood[1].toUpperCase()}${/^(\+|pos|positive|\+ve)/i.test(blood[2]) ? "+" : "-"}` } : {}),
      conditions: [...new Set([...(prev?.conditions ?? []), ...listOf(s, "conditions").map((c) => cell(c, "name")).filter(Boolean)])],
      allergies: f("alerts", "allergies") || prev?.allergies || "",
      history,
      familyHistory: family,
      currentMeds: listOf(s, "medicines").filter((m) => cell(m, "name")).map((m) => ({ name: cell(m, "name"), dose: cell(m, "dose").slice(0, 40), frequency: freqOf(cell(m, "dose")), ...(cell(m, "prescriber") ? { prescriber: cell(m, "prescriber") } : {}), ...(cell(m, "indication") ? { purpose: cell(m, "indication") } : {}) })),
      notes: [prev?.notes, answered.length ? `Confirmed ${o.base_id ? "with added records" : "at onboarding"}:\n${answered.join("\n")}` : ""].filter(Boolean).join("\n\n"),
      labs: prev?.labs ?? [],
    } as Partial<Baseline>, t);
    if (typeof base === "string") throw new Error(base);
    saveBaseline(pid, base, t, by.id);
    // The records are filed: they don't wait for a separate check on the Documents tab.
    for (const r of all<{ id: number; extract: string | null }>("SELECT id, extract FROM patient_documents WHERE onboarding_id = ?", o.id)) {
      const x = readExtract(r.extract);
      run("UPDATE patient_documents SET filed_at = COALESCE(filed_at, ?), filed_by = COALESCE(filed_by, ?), extract = ? WHERE id = ?", t, by.id, x ? JSON.stringify({ ...x, done: true }) : r.extract, r.id);
    }
    // What's confirmed is no longer "new": the marks go, and this becomes the history later updates start from.
    const final: Draft = { ...d, summary: unmarked(d.summary), points: d.points.map((x) => ({ ...x, old: true })), merges: [],
      labs: d.labs.map(({ fresh: _f, ...x }) => (x.check ? { ...x, ok: true } : x)), texts: d.texts.map(({ fresh: _f, ...x }) => x), homes: d.homes.map(({ fresh: _f, ...x }) => x),
      builtFrom: d.builtFrom ?? [...mine] };
    run("UPDATE onboardings SET status = 'CONFIRMED', draft = ?, confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?", JSON.stringify(final), by.id, t, t, o.id);
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
        forDoctor: d ? d.points.filter((p) => p.status === "doctor" && !p.old).length : 0,
        byName: (r.status === "SENT" ? getUser(r.sent_by ?? "") : r.status === "RETURNED" ? getUser(r.returned_by ?? "") : null)?.name ?? null,
        note: r.status === "RETURNED" ? r.return_note : null,
      };
    });
}

