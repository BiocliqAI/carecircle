// Embedded SQLite (Node's built-in node:sqlite) — zero native dependencies.
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { LIVE } from "./mode";

type SqliteModule = typeof import("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, phone TEXT, title TEXT
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, user_id TEXT UNIQUE REFERENCES users(id), name TEXT NOT NULL, age INTEGER, sex TEXT,
  phone TEXT NOT NULL UNIQUE, conditions TEXT, address TEXT, doctor_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS caregivers (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL, relation TEXT, phone TEXT NOT NULL, level INTEGER NOT NULL, dashboard INTEGER NOT NULL DEFAULT 1,
  UNIQUE(patient_id, level)
);
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), doctor_id TEXT NOT NULL,
  visit_at INTEGER NOT NULL, vitals TEXT NOT NULL, diagnosis TEXT, notes TEXT, plan TEXT NOT NULL,
  next_visit_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_patient ON visits(patient_id, visit_at);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, visit_id TEXT NOT NULL, kind TEXT NOT NULL,
  item_key TEXT NOT NULL, label TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
  completed_at INTEGER, completed_by TEXT, message_id INTEGER, prompted INTEGER NOT NULL DEFAULT 0,
  reminded INTEGER NOT NULL DEFAULT 0, late INTEGER NOT NULL DEFAULT 0,
  UNIQUE(patient_id, item_key, due_at)
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(patient_id, status, due_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, user_id TEXT NOT NULL, direction TEXT NOT NULL,
  body TEXT NOT NULL, quick TEXT, created_at INTEGER NOT NULL, parsed TEXT, parser TEXT, kind TEXT
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS messages_patient ON messages(patient_id, created_at);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, type TEXT NOT NULL, v1 REAL, v2 REAL,
  text TEXT, severity TEXT, observed_at INTEGER NOT NULL, logged_by TEXT, message_id INTEGER, parser TEXT, flag TEXT
);
CREATE INDEX IF NOT EXISTS obs_patient ON observations(patient_id, type, observed_at);
CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, type TEXT NOT NULL, rule_key TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT, advice TEXT, state TEXT NOT NULL, level INTEGER NOT NULL,
  started_at INTEGER NOT NULL, level_at INTEGER NOT NULL, ack_by TEXT, ack_at INTEGER,
  resolved_at INTEGER, resolved_by TEXT, outcome_code TEXT, outcome_note TEXT,
  trigger_message_id INTEGER, trigger_observation_id INTEGER, task_ids TEXT
);
CREATE INDEX IF NOT EXISTS esc_patient ON escalations(patient_id, state);
CREATE TABLE IF NOT EXISTS escalation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, escalation_id INTEGER NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL,
  level INTEGER, actor TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS convo_state (
  user_id TEXT PRIMARY KEY, state TEXT NOT NULL, escalation_id INTEGER, data TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS labs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, marker TEXT NOT NULL, value REAL NOT NULL,
  taken_at INTEGER NOT NULL, source TEXT NOT NULL, entered_by TEXT, message_id INTEGER, flag TEXT
);
CREATE INDEX IF NOT EXISTS labs_patient ON labs(patient_id, marker, taken_at);
CREATE TABLE IF NOT EXISTS med_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, at INTEGER NOT NULL, med_name TEXT NOT NULL,
  change TEXT NOT NULL, detail TEXT, prescriber TEXT, reported_by TEXT, message_id INTEGER, source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REPORTED', reviewed_by TEXT, reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS medchg_patient ON med_changes(patient_id, at);
CREATE TABLE IF NOT EXISTS care_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, name TEXT NOT NULL, specialty TEXT,
  hospital TEXT, phone TEXT, role TEXT NOT NULL DEFAULT 'CONSULTING', user_id TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS patient_baseline (
  patient_id TEXT PRIMARY KEY REFERENCES patients(id), data TEXT NOT NULL, captured_at INTEGER NOT NULL, captured_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS patient_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL REFERENCES patients(id), author_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'clinical', body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_patient ON patient_notes(patient_id, created_at);
CREATE TABLE IF NOT EXISTS patient_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL REFERENCES patients(id), title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other', mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, notes TEXT,
  source TEXT NOT NULL DEFAULT 'clinic', uploaded_by TEXT, uploaded_at INTEGER NOT NULL, message_id INTEGER
);
CREATE INDEX IF NOT EXISTS docs_patient ON patient_documents(patient_id, uploaded_at);
CREATE TABLE IF NOT EXISTS patient_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_patient ON patient_reviews(patient_id, at);
CREATE TABLE IF NOT EXISTS plan_drafts (
  patient_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS visit_prep (
  patient_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_by TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS onboarding_drafts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, step INTEGER NOT NULL, data TEXT NOT NULL,
  created_by TEXT, created_at INTEGER NOT NULL, updated_by TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outside_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL REFERENCES patients(id), visit_at INTEGER NOT NULL,
  doctor_name TEXT, specialty TEXT, hospital TEXT, care_team_id INTEGER, reason TEXT, advice TEXT, tests TEXT,
  next_visit_at INTEGER, next_visit_note TEXT, status TEXT NOT NULL DEFAULT 'COLLECTING', source TEXT NOT NULL,
  reported_by TEXT, message_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  reviewed_by TEXT, reviewed_at INTEGER, followup_of INTEGER
);
CREATE INDEX IF NOT EXISTS outside_patient ON outside_visits(patient_id, visit_at);
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, advice TEXT,
  state TEXT NOT NULL DEFAULT 'OPEN', started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER, closed_by TEXT
);
CREATE INDEX IF NOT EXISTS watches_patient ON watches(patient_id, state);
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL REFERENCES patients(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', requested_at INTEGER NOT NULL, responded_at INTEGER, message_id INTEGER,
  UNIQUE(patient_id, user_id)
);
CREATE TABLE IF NOT EXISTS record_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL REFERENCES patients(id), user_id TEXT NOT NULL, at INTEGER NOT NULL,
  question TEXT NOT NULL, answer TEXT NOT NULL, facts TEXT, note TEXT, via TEXT NOT NULL, chart TEXT, ctx_hash TEXT
);
CREATE INDEX IF NOT EXISTS questions_patient ON record_questions(patient_id, at);
`;

// Columns added after the first release; applied to existing databases on open.
const COLUMNS: [table: string, column: string, ddl: string][] = [
  ["users", "email", "TEXT"],
  ["users", "reg_no", "TEXT"],
  ["users", "created_at", "INTEGER"],
  ["patient_documents", "filed_at", "INTEGER"],
  ["patient_documents", "outside_visit_id", "INTEGER"],
  ["patient_documents", "extract", "TEXT"],
  ["messages", "body_en", "TEXT"],
  ["messages", "quick_en", "TEXT"],
  ["messages", "wa_status", "TEXT"],
  ["messages", "wa_sid", "TEXT"],
  ["messages", "wa_error", "TEXT"],
  ["record_questions", "ctx_hash", "TEXT"],
  ["med_changes", "outside_visit_id", "INTEGER"],
  ["med_changes", "med_key", "TEXT"],
  ["med_changes", "new_dose", "TEXT"],
  ["med_changes", "new_times", "TEXT"],
  ["med_changes", "applied_at", "INTEGER"],
];

function migrate(db: DatabaseSyncT) {
  for (const [table, column, ddl] of COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS messages_wa_sid ON messages(wa_sid)");
}

const g = globalThis as unknown as { __ccDb?: DatabaseSyncT; __ccSchema?: string };

export function dbPath(): string {
  return process.env.CARECIRCLE_DB || path.join(process.cwd(), "data", LIVE ? "clinic.db" : "carecircle.db");
}

export function getDb(): DatabaseSyncT {
  if (g.__ccDb) {
    // Hot reload (dev) can bring a newer schema to an already-open connection: apply it once.
    if (g.__ccSchema !== SCHEMA) {
      g.__ccDb.exec(SCHEMA);
      migrate(g.__ccDb);
      g.__ccSchema = SCHEMA;
    }
    return g.__ccDb;
  }
  // getBuiltinModule avoids bundlers trying to resolve node:sqlite.
  const sqlite = process.getBuiltinModule("node:sqlite") as SqliteModule;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  g.__ccDb = db;
  g.__ccSchema = SCHEMA;
  return db;
}

export function resetDb(): void {
  const db = getDb();
  db.exec(`
    DROP TABLE IF EXISTS record_questions; DROP TABLE IF EXISTS patient_baseline; DROP TABLE IF EXISTS consents; DROP TABLE IF EXISTS outside_visits; DROP TABLE IF EXISTS watches; DROP TABLE IF EXISTS onboarding_drafts;
    DROP TABLE IF EXISTS patient_notes; DROP TABLE IF EXISTS patient_documents; DROP TABLE IF EXISTS patient_reviews; DROP TABLE IF EXISTS visit_prep; DROP TABLE IF EXISTS plan_drafts;
    DROP TABLE IF EXISTS escalation_events; DROP TABLE IF EXISTS escalations; DROP TABLE IF EXISTS observations;
    DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS visits;
    DROP TABLE IF EXISTS caregivers; DROP TABLE IF EXISTS patients; DROP TABLE IF EXISTS convo_state;
    DROP TABLE IF EXISTS audit; DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS labs; DROP TABLE IF EXISTS med_changes; DROP TABLE IF EXISTS care_team;
  `);
  db.exec(SCHEMA);
  migrate(db);
}

type Param = string | number | null | bigint | Uint8Array;

export function all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: Param[]): { lastInsertRowid: number; changes: number } {
  const r = getDb().prepare(sql).run(...params);
  return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
}

export function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getSetting(key: string): string | undefined {
  return get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
}

export function setSetting(key: string, value: string): void {
  run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

export function audit(at: number, actor: string | null, action: string, entity: string, entityId: string | number, detail?: unknown) {
  run(
    "INSERT INTO audit(at, actor, action, entity, entity_id, detail) VALUES(?,?,?,?,?,?)",
    at,
    actor,
    action,
    entity,
    String(entityId),
    detail === undefined ? null : JSON.stringify(detail),
  );
}
