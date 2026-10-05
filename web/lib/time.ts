// Time helpers. All persisted timestamps are epoch milliseconds (UTC).
// Care plan schedules ("08:00") are interpreted in the clinic timezone (IST for the demo).

export const TZ = "Asia/Kolkata";
export const TZ_OFFSET_MS = 330 * 60_000; // IST has no DST
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function dayStart(ms: number): number {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;
}

export function atLocal(dayStartMs: number, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return dayStartMs + h * HOUR + (m || 0) * MIN;
}

export function localDow(ms: number): number {
  return new Date(ms + TZ_OFFSET_MS).getUTCDay();
}

export function localHHMM(ms: number): string {
  const d = new Date(ms + TZ_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function dayKey(ms: number): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

export function fmtDate(ms: number, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: TZ, ...opts }).format(ms);
}

export function fmtDateTime(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

export function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(ms);
}

export function relDays(fromMs: number, toMs: number): number {
  return Math.round((dayStart(toMs) - dayStart(fromMs)) / DAY);
}
