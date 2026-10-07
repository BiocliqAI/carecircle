// Imports Appa's spreadsheet history into a live-clinic patient (see lib/import_appa.ts).
// Usage (from web/):  npx tsx scripts/import_appa.mts <patient-id> [--db data/clinic.db]
// Back up the database first (npm run clinic:backup); re-running replaces the earlier import.
import path from "node:path";

const args = process.argv.slice(2);
const pid = args.find((a) => !a.startsWith("--"));
const dbAt = args.indexOf("--db");
if (!pid) {
  console.error("Usage: npx tsx scripts/import_appa.mts <patient-id> [--db data/clinic.db]");
  process.exit(1);
}
process.env.CARECIRCLE_MODE = "live";
process.env.CARECIRCLE_DB = path.resolve(dbAt >= 0 ? args[dbAt + 1] : process.env.CARECIRCLE_DB || "data/clinic.db");

const { importAppa } = await import("../lib/import_appa");
const r = importAppa(pid, Date.now());
console.log(`Imported into ${pid} (${process.env.CARECIRCLE_DB}):`);
console.log(`  ${r.visits} visits (baseline 13 Aug 2025 → 03 Sep 2026), ${r.readings} home readings (${r.firstReading} → ${r.lastReading}), ${r.labs} lab values, ${r.medChanges} medicine changes`);
