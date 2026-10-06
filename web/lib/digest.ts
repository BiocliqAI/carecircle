// The caregiver's evening summary: one short message so "no news" is visibly good news.
// Pure text builder; the engine gathers the numbers.
export interface DigestInput {
  patientFirst: string;
  medsDue: number;
  medsTaken: number;
  missed: string[]; // labels of things marked missed today
  readings: string[]; // e.g. "BP 132/84", "Weight 72.8 kg"
  openAlerts: number;
  nextVisit: string | null;
}

export function buildDigest(d: DigestInput): string {
  const lines = [`🌙 ${d.patientFirst} today`];
  if (d.medsDue) lines.push(`💊 Medicines: ${d.medsTaken} of ${d.medsDue} taken${d.medsTaken === d.medsDue ? " ✅" : ""}`);
  lines.push(d.readings.length ? `📏 ${d.readings.join(" · ")}` : "📏 No readings sent today");
  if (d.missed.length) lines.push(`⚠️ Missed: ${d.missed.slice(0, 4).join(", ")}${d.missed.length > 4 ? ` and ${d.missed.length - 4} more` : ""}`);
  lines.push("");
  lines.push(d.openAlerts ? `🔔 ${d.openAlerts} alert${d.openAlerts > 1 ? "s" : ""} still open. Please check the earlier message and reply *ACK*.` : d.missed.length ? "Nothing urgent. You may want to check in with them." : "All good. Nothing needs you tonight 👍");
  if (d.nextVisit) lines.push(`📅 Next visit: ${d.nextVisit}`);
  return lines.join("\n");
}
