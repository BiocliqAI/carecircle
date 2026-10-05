// Consistent snapshot of the live clinic database (safe while the app is running).
// Usage: npm run clinic:backup            -> backups/clinic-YYYY-MM-DD_HHMM.db
//        CARECIRCLE_DB=/path/x.db npm run clinic:backup
// Restore: stop the app, copy the snapshot over data/clinic.db, start the app.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const src = process.env.CARECIRCLE_DB || path.join(process.cwd(), "data", "clinic.db");
if (!fs.existsSync(src)) {
  console.error(`No database at ${src}. Start the live clinic first (npm run clinic).`);
  process.exit(1);
}
const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
const outDir = path.join(process.cwd(), "backups");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `clinic-${stamp}.db`);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`Backed up ${src} -> ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
