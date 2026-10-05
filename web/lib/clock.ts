// Demo clock: real time + a persisted offset, so a presenter can "fast-forward" hours/days.
// During seeding a fixed simulated time is injected instead.
import { getSetting, setSetting } from "./db";

const g = globalThis as unknown as { __ccSimNow?: number | null; __ccOffset?: number };

export function setSimNow(ms: number | null) {
  g.__ccSimNow = ms;
}

function offset(): number {
  if (g.__ccOffset === undefined) g.__ccOffset = Number(getSetting("clock_offset_ms") || 0);
  return g.__ccOffset;
}

export function now(): number {
  if (g.__ccSimNow != null) return g.__ccSimNow;
  return Date.now() + offset();
}

export function advanceClock(ms: number) {
  const next = offset() + ms;
  g.__ccOffset = next;
  setSetting("clock_offset_ms", String(next));
}

export function resetClockCache() {
  g.__ccOffset = undefined;
}
