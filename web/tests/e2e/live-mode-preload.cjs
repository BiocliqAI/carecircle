// Test-only preload: there is no live-mode build (.next-clinic) and the suite must not rebuild the app.
// The demo and live builds are the same code; next.config.ts only picks a different distDir from CARECIRCLE_MODE.
// This makes next.config.ts see demo mode (so `next start` uses the existing .next build) while the app code,
// which reads process.env.CARECIRCLE_MODE at runtime (lib/mode.ts), sees "live".
if (process.env.E2E_FORCE_LIVE === "1") {
  const real = process.env;
  process.env = new Proxy(real, {
    get(t, k) {
      if (k === "CARECIRCLE_MODE") return /next\.config/.test(new Error().stack || "") ? undefined : "live";
      return Reflect.get(t, k);
    },
  });
}
