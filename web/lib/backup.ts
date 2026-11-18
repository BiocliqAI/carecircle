// Back up and restore the live clinic database.
//
// Backup: a consistent snapshot (VACUUM INTO) taken while the app runs, downloaded by the admin.
// Restore: the admin uploads a backup; it is checked and saved next to the database as a pending restore. The swap
// happens the next time the app starts, before the database is opened (applyPendingRestore, called from getDb), so
// nothing is replaced under a running app. The current database is kept as <db>.before-restore-<stamp>, and the WAL
// files are removed so leftover changes can't be replayed onto the restored data.
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type SqliteModule = typeof import("node:sqlite");
const sqlite = () => process.getBuiltinModule("node:sqlite") as SqliteModule;

const REQUIRED_TABLES = ["users", "patients", "caregivers", "messages", "visits", "settings", "audit"];

export interface BackupSummary {
  clinic: string | null;
  takenAt: number | null; // when the snapshot was made (set by snapshotTo)
  patients: number;
  staff: number;
  caregivers: number;
  messages: number;
  lastActivity: number | null;
  sizeBytes: number;
}

export interface PendingRestore { stagedAt: number; stagedBy: string; fileName: string; summary: BackupSummary }
export interface LastRestore { restoredAt: number; stagedBy: string; fileName: string; backupTakenAt: number | null; previous: string }

export const pendingFile = (db: string) => `${db}.restore-pending`;
const pendingMeta = (db: string) => `${db}.restore-pending.json`;
const restoredMarker = (db: string) => `${db}.restored.json`;
const stamp = (t: number) => new Date(t + 330 * 60_000).toISOString().slice(0, 16).replace("T", "-").replace(":", ""); // IST

function count(db: DatabaseSyncT, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number | bigint } | undefined)?.n ?? 0);
}

/**
 * Checks that `file` is an intact CareCircle clinic database and summarises it. Throws a message fit to show the admin.
 */
export function inspectBackup(file: string): BackupSummary {
  if (!fs.existsSync(file)) throw new Error("The backup file is missing.");
  const sizeBytes = fs.statSync(file).size;
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  if (head.toString("latin1") !== "SQLite format 3\0") throw new Error("This isn't a CareCircle backup (not a database file).");
  let db: DatabaseSyncT;
  try {
    db = new (sqlite().DatabaseSync)(file, { readOnly: true });
  } catch {
    throw new Error("The backup file can't be opened. It may be damaged.");
  }
  try {
    let check: string;
    try {
      check = String((db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)?.integrity_check ?? "");
    } catch {
      throw new Error("The backup file is damaged and can't be read.");
    }
    if (check !== "ok") throw new Error("The backup file is damaged (integrity check failed).");
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) throw new Error("This isn't a CareCircle clinic backup (tables are missing).");
    const setting = (k: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
    if (setting("seeded_at")) throw new Error("This is a backup of the demo, not of the live clinic.");
    let clinic: string | null = null;
    try { clinic = (JSON.parse(setting("clinic") ?? "null") as { name?: string } | null)?.name ?? null; } catch {}
    const takenAt = Number(setting("backup:taken_at")) || null;
    const last = (db.prepare("SELECT MAX(created_at) AS m FROM messages").get() as { m: number | null }).m;
    return {
      clinic,
      takenAt,
      patients: count(db, "SELECT COUNT(*) AS n FROM patients"),
      staff: count(db, "SELECT COUNT(*) AS n FROM users WHERE role IN ('DOCTOR','PA')"),
      caregivers: count(db, "SELECT COUNT(*) AS n FROM caregivers"),
      messages: count(db, "SELECT COUNT(*) AS n FROM messages"),
      lastActivity: last ?? null,
      sizeBytes,
    };
  } finally {
    db.close();
  }
}

/** A consistent snapshot of the open database `live`, written to a new temp file. Returns its path. */
export function snapshotTo(live: DatabaseSyncT, t: number, by: string): string {
  const out = path.join(os.tmpdir(), `carecircle-backup-${process.pid}-${Date.now()}.db`);
  live.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  const snap = new (sqlite().DatabaseSync)(out);
  try {
    const put = snap.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    put.run("backup:taken_at", String(t));
    put.run("backup:taken_by", by);
  } finally {
    snap.close();
  }
  return out;
}

export function backupFileName(clinic: string | null, t: number): string {
  const slug = (clinic ?? "clinic").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "clinic";
  return `carecircle-${slug}-${stamp(t)}.db`;
}

/** Checks an uploaded backup and saves it as the pending restore for database `db`. */
export function stageRestore(db: string, data: Uint8Array, fileName: string, by: string, t: number): PendingRestore {
  const tmp = `${pendingFile(db)}.upload-${process.pid}`;
  fs.writeFileSync(tmp, data);
  let summary: BackupSummary;
  try {
    summary = inspectBackup(tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.renameSync(tmp, pendingFile(db));
  const meta: PendingRestore = { stagedAt: t, stagedBy: by, fileName: path.basename(fileName || "backup.db").slice(0, 120), summary };
  fs.writeFileSync(pendingMeta(db), JSON.stringify(meta));
  return meta;
}

export function getPendingRestore(db: string): PendingRestore | null {
  if (!fs.existsSync(pendingFile(db))) return null;
  try { return JSON.parse(fs.readFileSync(pendingMeta(db), "utf8")) as PendingRestore; } catch { return null; }
}

export function cancelPendingRestore(db: string): boolean {
  const had = fs.existsSync(pendingFile(db));
  fs.rmSync(pendingFile(db), { force: true });
  fs.rmSync(pendingMeta(db), { force: true });
  return had;
}

/**
 * Called before the database is opened. If a restore is pending and still checks out, keeps the current database as
 * <db>.before-restore-<stamp>, puts the backup in its place and removes the WAL files. Returns true if it swapped.
 * A pending file that fails the check is set aside as <db>.restore-rejected and the current database is left alone.
 */
export function applyPendingRestore(db: string, t = Date.now()): boolean {
  const pending = pendingFile(db);
  if (!fs.existsSync(pending)) return false;
  const meta = getPendingRestore(db);
  try {
    inspectBackup(pending);
  } catch (e) {
    fs.renameSync(pending, `${db}.restore-rejected`);
    fs.rmSync(pendingMeta(db), { force: true });
    console.error(`[carecircle] pending restore rejected: ${(e as Error).message}`);
    return false;
  }
  let previous = "";
  if (fs.existsSync(db)) {
    // Fold the WAL into the main file first, so the kept copy is complete on its own.
    const cur = new (sqlite().DatabaseSync)(db);
    try { cur.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { cur.close(); }
    previous = `${db}.before-restore-${stamp(t)}`;
    fs.renameSync(db, previous);
  }
  for (const ext of ["-wal", "-shm", "-journal"]) fs.rmSync(db + ext, { force: true });
  fs.renameSync(pending, db);
  fs.rmSync(pendingMeta(db), { force: true });
  const marker: LastRestore = { restoredAt: t, stagedBy: meta?.stagedBy ?? "unknown", fileName: meta?.fileName ?? "backup.db", backupTakenAt: meta?.summary.takenAt ?? null, previous: path.basename(previous) };
  fs.writeFileSync(restoredMarker(db), JSON.stringify(marker));
  console.log(`[carecircle] restored the database from ${marker.fileName}; previous database kept as ${marker.previous || "(none)"}`);
  return true;
}

/** After the restored database is open: the restore marker, if any (removed once read). */
export function takeRestoreMarker(db: string): LastRestore | null {
  const f = restoredMarker(db);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as LastRestore; } catch { return null; } finally { fs.rmSync(f, { force: true }); }
}
