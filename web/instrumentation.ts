// Runs the scheduler every minute so reminders and escalation timeouts fire even when nobody has
// the app open (route handlers also run it lazily on each request). Disable with CARECIRCLE_SCHEDULER=off.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.CARECIRCLE_SCHEDULER === "off") return;
  const { ensureSeeded } = await import("./lib/seed");
  const { runScheduler } = await import("./lib/engine");
  const g = globalThis as unknown as { __ccTimer?: ReturnType<typeof setInterval> };
  if (g.__ccTimer) return;
  g.__ccTimer = setInterval(() => {
    ensureSeeded()
      .then(() => runScheduler())
      .catch((e) => console.error("[scheduler]", e));
  }, 60_000);
}
