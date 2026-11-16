// The patient history summary's structure, following the clinic's "Patient History Summary" template (13 sections).
// One definition drives the AI's instructions, the checking screen and the Clinical history card, so they stay in step.
// Client-safe: no server imports.

export type FieldType = "text" | "long" | "date";
export interface ColSpec { key: string; label: string; type?: FieldType; options?: string[]; hint?: string }
export interface ListSpec { kind: "list"; key: string; n: string; title: string; hint: string; cols: ColSpec[]; max: number }
export interface FieldsSpec { kind: "fields"; key: string; n: string; title: string; hint: string; fields: ColSpec[] }
export type SectionSpec = ListSpec | FieldsSpec;

export const CONDITION_STATUS = ["controlled", "uncontrolled", "improving", "worsening", "stable"];

export const HISTORY: SectionSpec[] = [
  { kind: "fields", key: "snapshot", n: "1", title: "Patient profile and snapshot", hint: "A one-glance summary in 2–3 lines: age, sex, main conditions, key events, current status.",
    fields: [{ key: "oneGlance", label: "One-glance summary", type: "long" }, { key: "bloodGroup", label: "Blood group" }, { key: "heightWeight", label: "Height / weight / BMI" }, { key: "lifestyle", label: "Lifestyle", hint: "smoking, alcohol, diet, activity" }] },
  { kind: "fields", key: "alerts", n: "2", title: "Critical alerts", hint: "Safety-critical items first.",
    fields: [{ key: "allergies", label: "Allergies / adverse drug reactions" }, { key: "implants", label: "Implants / devices", hint: "stents, pacemaker, valves, grafts" }, { key: "anticoagulants", label: "Anticoagulant / antiplatelet" }, { key: "pregnancy", label: "Pregnancy status" }, { key: "codeStatus", label: "Code status / advance directive" }] },
  { kind: "list", key: "conditions", n: "3", title: "Active medical conditions", hint: "Status with the latest supporting value.", max: 60,
    cols: [{ key: "name", label: "Condition" }, { key: "diagnosed", label: "Diagnosed" }, { key: "status", label: "Status", options: CONDITION_STATUS, hint: "controlled / uncontrolled / improving / worsening, with the latest value" }, { key: "treatment", label: "Current treatment" }, { key: "advice", label: "Advice given" }] },
  { kind: "list", key: "resolved", n: "3", title: "Resolved / historical conditions", hint: "", max: 60,
    cols: [{ key: "name", label: "Condition" }, { key: "period", label: "Period" }, { key: "outcome", label: "Outcome" }] },
  { kind: "list", key: "medicines", n: "4", title: "Current medications", hint: "Reconciled list, including OTC, supplements and AYUSH / alternative medicines if reported.", max: 60,
    cols: [{ key: "name", label: "Drug" }, { key: "dose", label: "Dose / frequency" }, { key: "indication", label: "Indication" }, { key: "started", label: "Started" }, { key: "prescriber", label: "Prescriber" }] },
  { kind: "list", key: "medChanges", n: "5", title: "Medication changes and rationale", hint: "Newest first. Flag stops for side effects or non-response, and adherence issues.", max: 80,
    cols: [{ key: "date", label: "Date" }, { key: "drug", label: "Drug" }, { key: "change", label: "Change" }, { key: "reason", label: "Reason" }, { key: "by", label: "By" }] },
  { kind: "list", key: "labNotes", n: "6", title: "Key lab findings", hint: "Abnormal or clinically significant values with their trend, oldest to latest. Every value is in Labs & home readings.", max: 40,
    cols: [{ key: "parameter", label: "Parameter" }, { key: "reference", label: "Reference / target" }, { key: "trend", label: "Trend (oldest to latest)", type: "long" }, { key: "latest", label: "Latest date" }, { key: "comment", label: "Comment" }] },
  { kind: "list", key: "studies", n: "6", title: "Imaging, ECG and other studies", hint: "", max: 60,
    cols: [{ key: "date", label: "Date" }, { key: "study", label: "Study" }, { key: "finding", label: "Key finding", type: "long" }] },
  { kind: "list", key: "admissions", n: "7", title: "Hospitalisations", hint: "Newest first.", max: 60,
    cols: [{ key: "from", label: "Admitted", type: "date" }, { key: "to", label: "Discharged", type: "date" }, { key: "facility", label: "Facility" }, { key: "reason", label: "Reason" }, { key: "findings", label: "Key findings / treatment", type: "long" }, { key: "outcome", label: "Outcome at discharge" }] },
  { kind: "list", key: "procedures", n: "8", title: "Procedures and surgeries", hint: "All major procedures ever; minor ones in the last 5 years.", max: 60,
    cols: [{ key: "date", label: "Date" }, { key: "procedure", label: "Procedure" }, { key: "facility", label: "Facility / surgeon" }, { key: "notes", label: "Complications / notes" }] },
  { kind: "list", key: "immunisations", n: "9", title: "Immunisation history", hint: "Mark due or overdue items, especially for diabetics, the elderly and immunocompromised patients.", max: 30,
    cols: [{ key: "vaccine", label: "Vaccine" }, { key: "dates", label: "Date(s) given" }, { key: "status", label: "Status / next due" }] },
  { kind: "list", key: "visits", n: "10", title: "Specialist consultations", hint: "Newest first. One-line takeaway per visit.", max: 300,
    cols: [{ key: "date", label: "Date", type: "date" }, { key: "doctor", label: "Doctor" }, { key: "specialty", label: "Specialty" }, { key: "hospital", label: "Hospital / clinic" }, { key: "takeaway", label: "Key takeaway", type: "long" }] },
  { kind: "list", key: "pending", n: "11", title: "Pending items and follow-up", hint: "Outstanding tests, referrals, planned procedures and follow-up dates.", max: 40,
    cols: [{ key: "item", label: "Item" }, { key: "due", label: "Due / status" }, { key: "responsible", label: "Responsible" }] },
  { kind: "fields", key: "social", n: "12", title: "Family and social history", hint: "Only what bears on risk and care.",
    fields: [{ key: "family", label: "Family history" }, { key: "occupation", label: "Occupation" }, { key: "living", label: "Living situation" }, { key: "caregiver", label: "Caregiver" }, { key: "language", label: "Language" }] },
  { kind: "list", key: "inferences", n: "13", title: "Inferred, not documented", hint: "Kept apart from documented facts. Conflicts and missing records are in Points to confirm.", max: 30,
    cols: [{ key: "text", label: "Inference", type: "long" }] },
];

export type HistRow = { sources: number[] } & Record<string, unknown>;
export interface HistField { text: string; sources: number[] }
export type History = Record<string, HistRow[] | Record<string, HistField>>;

export const listOf = (h: History | null | undefined, key: string): HistRow[] => (Array.isArray(h?.[key]) ? (h![key] as HistRow[]) : []);
export const fieldsOf = (h: History | null | undefined, key: string): Record<string, HistField> => (h?.[key] && !Array.isArray(h[key]) ? (h[key] as Record<string, HistField>) : {});
export const cell = (r: HistRow, k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");

export function emptyHistory(): History {
  const h: History = {};
  for (const s of HISTORY) h[s.key] = s.kind === "list" ? [] : Object.fromEntries(s.fields.map((f) => [f.key, { text: "", sources: [] }]));
  return h;
}

/** The AI's instructions for the history part of the JSON, generated from the sections above. */
export function historySchemaText(): string {
  return HISTORY.map((s) => s.kind === "list"
    ? ` "${s.key}": [{${s.cols.map((c) => `"${c.key}": "${c.label}${c.hint ? ` (${c.hint})` : ""}${c.type === "date" ? ", YYYY-MM-DD" : ""}"`).join(", ")}, "sources": [document ids]}]  // ${s.n}. ${s.title}. ${s.hint}`
    : ` "${s.key}": {${s.fields.map((f) => `"${f.key}": {"text": "${f.label}${f.hint ? ` (${f.hint})` : ""}", "sources": [ids]}`).join(", ")}}  // ${s.n}. ${s.title}. ${s.hint}`,
  ).join(",\n");
}

/** Tidies a history from the AI (or a person's edits): only known sections and columns, strings capped, sources kept. */
export function cleanHistory(raw: unknown, validIds?: Set<number>): History {
  const h = emptyHistory();
  const src = (raw ?? {}) as Record<string, unknown>;
  const s2 = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[ \t]+/g, " ").trim().slice(0, n) : "");
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isInteger(x) && (!validIds || validIds.has(x))).slice(0, 30) : []);
  for (const s of HISTORY) {
    if (s.kind === "list") {
      const rows = Array.isArray(src[s.key]) ? (src[s.key] as Record<string, unknown>[]) : [];
      h[s.key] = rows.slice(0, s.max).map((r) => {
        const row: HistRow = { sources: ids(r?.sources) };
        for (const c of s.cols) row[c.key] = s2(r?.[c.key], c.type === "long" ? 800 : 300);
        return row;
      }).filter((r) => s.cols.some((c) => cell(r, c.key)));
    } else {
      const f = (src[s.key] ?? {}) as Record<string, unknown>;
      h[s.key] = Object.fromEntries(s.fields.map((x) => {
        const v = f[x.key];
        return [x.key, typeof v === "string" ? { text: s2(v, 800), sources: [] } : { text: s2((v as HistField | undefined)?.text, 800), sources: ids((v as HistField | undefined)?.sources) }];
      }));
    }
  }
  return h;
}
