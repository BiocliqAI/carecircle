// Backup and restore of the live clinic database (lib/backup.ts and the restore hook in lib/db.ts getDb).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-backup-test-"));
const DB = path.join(dir, "clinic.db");
process.env.CARECIRCLE_DB = DB;
process.env.CARECIRCLE_MODE = "live";
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const db = await import("../lib/db");
const clinic = await import("../lib/clinic");
const backup = await import("../lib/backup");

const g = globalThis as unknown as { __ccDb?: { close(): void } };
/** Close the connection as a process exit would, so the next getDb() behaves like a fresh start. */
function restart() {
  g.__ccDb?.close();
  delete g.__ccDb;
  db.getDb();
}
const staffNames = () => db.all<{ name: string }>("SELECT name FROM users WHERE role IN ('DOCTOR','PA') ORDER BY name").map((r) => r.name);
const write = (name: string, data: Uint8Array | string) => { const f = path.join(dir, name); fs.writeFileSync(f, data); return f; };

describe("clinic backup and restore", () => {
  let snap = "";
  before(() => {
    clinic.ensureAdmin();
    clinic.setupClinic({ name: "Test Clinic", address: "1 Main St", phone: "+91 90000 00000" }, { name: "Dr. Before", phone: "+91 90000 00001", title: "MD", email: "", regNo: "" }, Date.now(), null);
  });

  it("takes a consistent snapshot while the database is open, stamped with when and by whom", () => {
    snap = backup.snapshotTo(db.getDb() as never, 1_800_000_000_000, "u_admin");
    const s = backup.inspectBackup(snap);
    assert.equal(s.clinic, "Test Clinic");
    assert.equal(s.takenAt, 1_800_000_000_000);
    assert.equal(s.staff, 1);
    assert.ok(s.sizeBytes > 0);
    // The live database itself is not stamped.
    assert.equal(db.getSetting("backup:taken_at"), undefined);
  });

  it("names the file after the clinic and the date", () => {
    assert.match(backup.backupFileName("Rao Family & Chronic Care", Date.UTC(2026, 10, 18, 4, 0)), /^carecircle-rao-family-chronic-care-2026-11-18-0930\.db$/);
    assert.equal(backup.backupFileName(null, Date.UTC(2026, 10, 18, 4, 0)), "carecircle-clinic-2026-11-18-0930.db");
  });

  it("refuses files that aren't intact CareCircle clinic backups, and changes nothing", () => {
    assert.throws(() => backup.stageRestore(DB, Buffer.from("hello, not a database"), "notes.txt", "u_admin", Date.now()), /not a database file/);
    const bytes = fs.readFileSync(snap);
    assert.throws(() => backup.stageRestore(DB, bytes.subarray(0, Math.floor(bytes.length / 2)), "half.db", "u_admin", Date.now()), /damaged/);
    const other = write("other.db", "");
    fs.rmSync(other);
    const o = new DatabaseSync(other); o.exec("CREATE TABLE t(x)"); o.close();
    assert.throws(() => backup.stageRestore(DB, fs.readFileSync(other), "other.db", "u_admin", Date.now()), /tables are missing/);
    const demo = path.join(dir, "demo.db");
    fs.copyFileSync(snap, demo);
    const d = new DatabaseSync(demo); d.prepare("INSERT INTO settings(key, value) VALUES('seeded_at', '1')").run(); d.close();
    assert.throws(() => backup.stageRestore(DB, fs.readFileSync(demo), "demo.db", "u_admin", Date.now()), /demo/);
    assert.equal(backup.getPendingRestore(DB), null);
    assert.equal(fs.existsSync(backup.pendingFile(DB)), false);
  });

  it("stages a good backup without touching the running clinic, and can cancel it", () => {
    const p = backup.stageRestore(DB, fs.readFileSync(snap), "carecircle-test.db", "u_admin", 123);
    assert.equal(p.summary.clinic, "Test Clinic");
    assert.equal(p.fileName, "carecircle-test.db");
    assert.deepEqual(backup.getPendingRestore(DB)?.stagedAt, 123);
    assert.deepEqual(staffNames(), ["Dr. Before"]);
    assert.equal(backup.cancelPendingRestore(DB), true);
    assert.equal(backup.getPendingRestore(DB), null);
    assert.equal(backup.cancelPendingRestore(DB), false);
  });

  it("round trip: changes made after the backup are gone after a restart, and the previous data is kept", () => {
    clinic.addStaff({ role: "PA", name: "PA After", phone: "+91 90000 00002", title: "PA", email: "", regNo: "" }, Date.now(), "u_admin");
    db.run("UPDATE settings SET value = ? WHERE key = 'clinic'", JSON.stringify({ ...clinic.getClinic(), name: "Renamed During Testing" }));
    assert.deepEqual(staffNames(), ["Dr. Before", "PA After"]);

    backup.stageRestore(DB, fs.readFileSync(snap), "carecircle-test.db", "u_admin", Date.now());
    restart();

    assert.deepEqual(staffNames(), ["Dr. Before"]);
    assert.equal(clinic.getClinic()?.name, "Test Clinic");
    assert.equal(backup.getPendingRestore(DB), null);
    const last = JSON.parse(db.getSetting("restore:last") ?? "null");
    assert.equal(last.fileName, "carecircle-test.db");
    assert.equal(last.backupTakenAt, 1_800_000_000_000);
    assert.ok(db.get("SELECT 1 FROM audit WHERE action = 'CLINIC_RESTORED'"));

    // The database from before the restore is kept, complete (its WAL was folded in first).
    const prev = path.join(dir, last.previous);
    assert.ok(fs.existsSync(prev), "previous database kept");
    assert.equal(fs.existsSync(`${prev}-wal`), false, "no separate WAL beside the kept copy");
    const p = new DatabaseSync(prev, { readOnly: true });
    const names = (p.prepare("SELECT name FROM users WHERE role IN ('DOCTOR','PA') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    p.close();
    assert.deepEqual(names, ["Dr. Before", "PA After"]);
  });

  it("a pending file damaged after staging is set aside at start, and the clinic is left as it was", () => {
    clinic.addStaff({ role: "PA", name: "PA Kept", phone: "+91 90000 00003", title: "PA", email: "", regNo: "" }, Date.now(), "u_admin");
    backup.stageRestore(DB, fs.readFileSync(snap), "carecircle-test.db", "u_admin", Date.now());
    fs.writeFileSync(backup.pendingFile(DB), "garbage");
    restart();
    assert.deepEqual(staffNames(), ["Dr. Before", "PA Kept"]);
    assert.equal(backup.getPendingRestore(DB), null);
    assert.ok(fs.existsSync(`${DB}.restore-rejected`));
  });
});
