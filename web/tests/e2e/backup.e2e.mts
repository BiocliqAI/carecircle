// Backup and restore of the live clinic, end to end: the admin page, the API, and a real server restart that applies
// the restore. Needs the live-clinic build: `npm run clinic:build` (writes .next-clinic).
// Run: npx tsx tests/e2e/backup.e2e.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { startApp, assert, type App } from "./harness.mts";

// Playwright is installed globally in this environment, so load it with require (as access.e2e.mts does).
const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");

const PORT = 3220;
const ADMIN = "u_admin";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-backup-"));
const dbFile = path.join(dir, "clinic.db");

let app: App = await startApp({ mode: "live", port: PORT, suite: "backup", dbFile });
const staff = async () => ((await app.api(ADMIN, "GET", "/api/clinic")).data.staff as { name: string }[]).map((s) => s.name).sort();
async function upload(userId: string | null, data: Uint8Array, name: string) {
  const r = await fetch(`${app.base}/api/clinic/backup`, { method: "POST", body: data, headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name), ...(userId ? { cookie: `cc_user=${userId}` } : {}) } });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function restartServer(suite: string) {
  await app.stop();
  app = await startApp({ mode: "live", port: PORT, suite, dbFile });
}

const setup = await app.api(ADMIN, "POST", "/api/clinic", { action: "setup", clinic: { name: "Backup Test Clinic", address: "1 Test Road", phone: "+91 90000 00000" }, doctor: { name: "Before", phone: "+91 90000 00001", title: "MD", email: "", regNo: "" } });
assert.equal(setup.status, 200, JSON.stringify(setup.data));

let backupBytes = new Uint8Array();
let doctorId = "";

await app.test("BK-01", "Admin downloads a consistent backup", async () => {
  const r = await fetch(`${app.base}/api/clinic/backup?download=1`, { headers: { cookie: `cc_user=${ADMIN}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition") ?? "", /attachment; filename="carecircle-backup-test-clinic-\d{4}-\d{2}-\d{2}-\d{4}\.db"/);
  backupBytes = new Uint8Array(await r.arrayBuffer());
  const f = path.join(dir, "downloaded.db");
  fs.writeFileSync(f, backupBytes);
  const d = new DatabaseSync(f, { readOnly: true });
  assert.equal((d.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  assert.equal(JSON.parse((d.prepare("SELECT value FROM settings WHERE key='clinic'").get() as { value: string }).value).name, "Backup Test Clinic");
  assert.ok((d.prepare("SELECT value FROM settings WHERE key='backup:taken_at'").get() as { value: string } | undefined)?.value);
  d.close();
  assert.ok(app.q1("SELECT 1 FROM audit WHERE action = 'BACKUP_DOWNLOADED' AND actor = ?", ADMIN), "download audited");
});

await app.test("BK-02", "Only the admin can back up or restore", async () => {
  doctorId = (app.q1<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR'"))!.id;
  for (const who of [doctorId, null]) {
    assert.equal((await app.api(who, "GET", "/api/clinic/backup?download=1")).status, 403, `download as ${who}`);
    assert.equal((await app.api(who, "GET", "/api/clinic/backup")).status, 403, `status as ${who}`);
    assert.equal((await upload(who, backupBytes, "x.db")).status, 403, `upload as ${who}`);
    assert.equal((await app.api(who, "DELETE", "/api/clinic/backup")).status, 403, `cancel as ${who}`);
  }
});

await app.test("BK-03", "A file that isn't a clinic backup is refused with a clear message", async () => {
  const r1 = await upload(ADMIN, new TextEncoder().encode("not a database"), "notes.txt");
  assert.equal(r1.status, 400);
  assert.match(r1.data.error, /not a database file/);
  const r2 = await upload(ADMIN, backupBytes.subarray(0, Math.floor(backupBytes.length / 2)), "half.db");
  assert.equal(r2.status, 400);
  assert.match(r2.data.error, /damaged/);
  assert.equal((await app.api(ADMIN, "GET", "/api/clinic/backup")).data.pending, null);
});

await app.test("BK-04", "A cancelled restore changes nothing after a restart", async () => {
  assert.equal((await upload(ADMIN, backupBytes, "cancel-me.db")).status, 200);
  const c = await app.api(ADMIN, "DELETE", "/api/clinic/backup");
  assert.equal(c.data.cancelled, true);
  await app.api(ADMIN, "POST", "/api/clinic", { action: "addStaff", staff: { role: "PA", name: "PA During Testing", phone: "+91 90000 00002", title: "PA", email: "", regNo: "" } });
  await restartServer("backup-2");
  assert.deepEqual(await staff(), ["Dr. Before", "PA During Testing"]);
  assert.equal((await app.api(ADMIN, "GET", "/api/clinic/backup")).data.last, null);
});

await app.test("BK-05", "Staged restore shows what's in the backup and leaves the clinic running unchanged", async () => {
  const r = await upload(ADMIN, backupBytes, "carecircle-before-testing.db");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = r.data.pending.summary;
  assert.equal(s.clinic, "Backup Test Clinic");
  assert.equal(s.staff, 1);
  assert.ok(s.takenAt);
  assert.deepEqual(await staff(), ["Dr. Before", "PA During Testing"]);
  assert.ok(app.q1("SELECT 1 FROM audit WHERE action = 'RESTORE_STAGED'"));
});

await app.test("BK-06", "After a restart the clinic matches the backup; the previous data is kept", async () => {
  await restartServer("backup-3");
  assert.deepEqual(await staff(), ["Dr. Before"]);
  const st = (await app.api(ADMIN, "GET", "/api/clinic/backup")).data;
  assert.equal(st.pending, null);
  assert.equal(st.last.fileName, "carecircle-before-testing.db");
  assert.ok(st.last.previous.startsWith("clinic.db.before-restore-"));
  assert.ok(fs.existsSync(path.join(dir, st.last.previous)), "previous database kept on disk");
  assert.ok(app.q1("SELECT 1 FROM audit WHERE action = 'CLINIC_RESTORED'"));
  // The restored clinic still works: the admin can change it.
  const add = await app.api(ADMIN, "POST", "/api/clinic", { action: "addStaff", staff: { role: "PA", name: "PA After Restore", phone: "+91 90000 00004", title: "PA", email: "", regNo: "" } });
  assert.equal(add.status, 200, JSON.stringify(add.data));
});

await app.test("BK-07", "Admin page: download, then check and prepare a restore, then cancel it", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    await ctx.addCookies([{ name: "cc_user", value: ADMIN, url: app.base }]);
    const page = await ctx.newPage();
    await page.goto(`${app.base}/admin`);
    await page.getByRole("heading", { name: "Backup and restore" }).waitFor();
    await page.getByText(/Restored on .* from carecircle-before-testing\.db/).waitFor();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download backup/ }).click()]);
    const saved = path.join(dir, dl.suggestedFilename());
    await dl.saveAs(saved);
    assert.match(dl.suggestedFilename(), /^carecircle-backup-test-clinic-.*\.db$/);
    assert.ok(fs.statSync(saved).size > 0);
    await page.locator('input[type="file"]').setInputFiles(saved);
    await page.getByRole("button", { name: /Check and prepare restore/ }).click();
    await page.getByText(/Restore ready:/).waitFor();
    await page.getByText(/restart the service in Railway/).waitFor();
    await page.screenshot({ path: path.join(path.dirname(new URL(import.meta.url).pathname), "results", "screens", "backup-restore-ready.png"), fullPage: true });
    await page.getByRole("button", { name: /Cancel restore/ }).click();
    await page.getByText(/Restore cancelled/).waitFor();
    assert.equal((await app.api(ADMIN, "GET", "/api/clinic/backup")).data.pending, null);
  } finally {
    await browser.close();
  }
});

await app.stop();
// Each server start writes its own results file (backup, backup-2, backup-3); count across all of them.
const resDir = path.join(path.dirname(new URL(import.meta.url).pathname), "results");
const all = ["backup", "backup-2", "backup-3"].flatMap((s) => fs.readFileSync(path.join(resDir, `${s}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { status: string }));
const failed = all.filter((r) => r.status !== "PASS").length;
console.log(`\nbackup: ${all.length - failed}/${all.length} passed`);
process.exit(failed ? 1 : 0);
