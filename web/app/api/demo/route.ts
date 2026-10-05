import { now, advanceClock } from "@/lib/clock";
import { getSetting } from "@/lib/db";
import { runScheduler } from "@/lib/engine";
import { aiEnabled } from "@/lib/parser";
import { reseed, simulateDays } from "@/lib/seed";
import { LIVE } from "@/lib/mode";
import { err, json, ready } from "@/lib/server";
import { MIN } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET() {
  await ready();
  return json({ now: now(), offsetMs: Number(getSetting("clock_offset_ms") || 0), ai: aiEnabled(), model: aiEnabled() ? process.env.GEMINI_MODEL || "gemini-3.8-flash" : null });
}

// Presenter controls: fast-forward the clock (escalation timers), simulate days of activity, reset.
export async function POST(req: Request) {
  await ready();
  const body = (await req.json()) as { action: string; minutes?: number; days?: number };
  if (body.action === "advance") {
    const m = Math.max(1, Math.min(7 * 24 * 60, Number(body.minutes) || 60));
    advanceClock(m * MIN);
    runScheduler();
  } else if (body.action === "simulate") {
    const d = Math.max(1, Math.min(30, Number(body.days) || 7));
    await simulateDays(d);
  } else if (body.action === "reset") {
    if (LIVE) return err("Use Clinic settings → Reset clinic to erase a live clinic", 400);
    await reseed();
  } else return err("Unknown action");
  return json({ ok: true, now: now() });
}
