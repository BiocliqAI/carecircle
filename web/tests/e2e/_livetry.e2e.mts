import path from "node:path";
import { startApp } from "/home/user/carecircle/web/tests/e2e/harness.mts";
const d = "/home/user/carecircle/web/tests/e2e";
const live = await startApp({ mode: "live", port: 3219, suite: "_livetry", env: { CARECIRCLE_MODE: undefined, E2E_FORCE_LIVE: "1", NODE_OPTIONS: `--require ${path.join(d, "live-mode-preload.cjs")}` } });
console.log(JSON.stringify((await live.api(null, "GET", "/api/session")).data).slice(0, 300));
console.log((await live.api(null, "POST", "/api/demo", {action:"reset"})));
await live.stop();
