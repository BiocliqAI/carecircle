import fs from "node:fs";
import { now } from "@/lib/clock";
import { audit, dbPath, getDb, getSetting } from "@/lib/db";
import { getClinic } from "@/lib/clinic";
import { backupFileName, cancelPendingRestore, getPendingRestore, snapshotTo, stageRestore, type LastRestore } from "@/lib/backup";
import { LIVE } from "@/lib/mode";
import { err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const MAX_UPLOAD = 80 * 1024 * 1024; // the request buffer limit (next.config.ts proxyClientMaxBodySize)

// Backup and restore of the live clinic database: admin only.
//  GET                -> { pending, last }: a restore waiting for the next start, and the last restore applied
//  GET ?download=1    -> a consistent snapshot of the database, as a file
//  POST (file body)   -> check the uploaded backup and stage it; it is applied the next time the app starts
//  DELETE             -> cancel the staged restore
async function admin() {
  await ready();
  if (!LIVE) return { error: err("Backup and restore are only available in the live clinic", 400) };
  const user = await sessionUser();
  if (!user || user.role !== "ADMIN") return { error: err("Only the clinic admin can back up or restore the clinic", 403) };
  return { user };
}

export async function GET(req: Request) {
  const a = await admin();
  if (a.error) return a.error;
  const t = now();
  if (new URL(req.url).searchParams.get("download")) {
    const file = snapshotTo(getDb(), t, a.user.id);
    try {
      const data = fs.readFileSync(file);
      const name = backupFileName(getClinic()?.name ?? null, t);
      audit(t, a.user.id, "BACKUP_DOWNLOADED", "clinic", "database", { file: name, bytes: data.length });
      return new Response(data, {
        headers: {
          "content-type": "application/vnd.sqlite3",
          "content-disposition": `attachment; filename="${name}"`,
          "content-length": String(data.length),
          "cache-control": "no-store",
        },
      });
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  let last: LastRestore | null = null;
  try { last = JSON.parse(getSetting("restore:last") ?? "null"); } catch {}
  return json({ pending: getPendingRestore(dbPath()), last });
}

export async function POST(req: Request) {
  const a = await admin();
  if (a.error) return a.error;
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_UPLOAD) return err("The backup is larger than 80 MB, so it can't be uploaded here. Restore it on Railway instead (see the README).", 413);
  const data = new Uint8Array(await req.arrayBuffer());
  if (!data.length) return err("Choose a backup file to upload");
  if (declared && data.length < declared) return err("The upload was cut short. Try again, or restore it on Railway if the file is very large.", 413);
  const t = now();
  const name = decodeURIComponent(req.headers.get("x-file-name") || "backup.db");
  try {
    const pending = stageRestore(dbPath(), data, name, a.user.id, t);
    audit(t, a.user.id, "RESTORE_STAGED", "clinic", "database", { file: pending.fileName, summary: pending.summary });
    return json({ pending });
  } catch (e) {
    return err((e as Error).message, 400);
  }
}

export async function DELETE() {
  const a = await admin();
  if (a.error) return a.error;
  const had = cancelPendingRestore(dbPath());
  if (had) audit(now(), a.user.id, "RESTORE_CANCELLED", "clinic", "database");
  return json({ ok: true, cancelled: had });
}
