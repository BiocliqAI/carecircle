import { startApp, assert } from "./harness.mts";
const app = await startApp({ port: 3290, suite: "_smoke" });
await app.test("SMOKE-01", "harness works", async () => {
  const s = await app.api("u_dr_rao", "GET", "/api/session");
  assert.equal(s.data.user.id, "u_dr_rao");
  const m = app.mark();
  await app.wa.send("u_ramesh", "BP 185/112");
  const out = app.wa.since("u_lakshmi", m);
  assert.ok(out.some((x) => x.kind === "escalation"), "L1 got the alert");
  const t0 = await app.clock.now(); await app.clock.advance(15); assert.ok((await app.clock.now()) - t0 >= 15 * 60000 - 1000);
});
await app.stop();
