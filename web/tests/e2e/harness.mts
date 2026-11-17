// End-to-end harness: runs the built app (`next start`) on its own port with its own temporary database, drives it
// over HTTP (pages, API, WhatsApp simulator, demo clock) and records one result per test-plan ID
// (docs/E2E_TEST_PLAN.md). Real WhatsApp delivery is impossible here: every Twilio variable is removed and the
// gateway is switched off. AI keys are removed too, so AI features run on their rules fallback.
//
// Usage in a suite:
//   const app = await startApp({ mode: "demo", port: 3201, suite: "rules" });
//   await app.test("RULE-01", "BP crisis", async () => { ... });
//   await app.stop();
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export { assert };
const WEB = path.resolve(import.meta.dirname, "..", "..");
export const RESULTS_DIR = path.join(WEB, "tests", "e2e", "results");

export type Status = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export interface Result { id: string; title: string; status: Status; note: string; ms: number }

/** Raised inside a test to record it as NOT_RUN (cannot be run here) or BLOCKED (a precondition failed). */
export class Skip extends Error { constructor(public status: "NOT_RUN" | "BLOCKED", msg: string) { super(msg); } }
export const notRun = (why: string): never => { throw new Skip("NOT_RUN", why); };
export const blocked = (why: string): never => { throw new Skip("BLOCKED", why); };

export interface App {
  base: string;
  dbFile: string;
  mode: "demo" | "live";
  /** Fetch as a signed-in user (cookie cc_user), or signed out with `null`. Returns status and parsed JSON/text. */
  api: (userId: string | null, method: string, url: string, body?: unknown) => Promise<{ status: number; data: any }>;
  /** Read-only SQL against the app's database (WAL allows reading while the server writes). */
  q: <T = any>(sql: string, ...params: (string | number | null)[]) => T[];
  q1: <T = any>(sql: string, ...params: (string | number | null)[]) => T | undefined;
  /** Direct write, only for test setup the UI/API cannot do; say so in the test note. */
  exec: (sql: string, ...params: (string | number | null)[]) => void;
  wa: {
    send: (userId: string, body: string) => Promise<{ status: number; data: any }>;
    thread: (userId: string, limit?: number) => Promise<{ id: number; direction: string; body: string; quick: string[] | null; created_at: number; kind: string }[]>;
    /** Outbound messages to `userId` with id greater than `afterId`. */
    since: (userId: string, afterId: number) => { id: number; body: string; kind: string; quick: string | null; created_at: number }[];
    sos: (userId: string) => Promise<{ status: number; data: any }>;
    media: (userId: string, file: { base64: string; mime: string; name: string; caption?: string; kind?: string }) => Promise<{ status: number; data: any }>;
    contacts: () => Promise<any[]>;
  };
  /** Highest message id so far (use with wa.since). */
  mark: () => number;
  clock: {
    now: () => Promise<number>;
    advance: (minutes: number) => Promise<void>;
    simulate: (days: number) => Promise<void>;
    reset: () => Promise<void>;
  };
  test: (id: string, title: string, fn: () => Promise<void> | void) => Promise<Result>;
  results: Result[];
  stop: () => Promise<void>;
}

function cleanEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(TWILIO_|WHATSAPP_|GEMINI_|ANTHROPIC_API_KEY|APP_PASSWORD|APP_USER|PUBLIC_BASE_URL)/.test(k)) continue;
    env[k] = v;
  }
  env.WHATSAPP_GATEWAY = "off";
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]; else env[k] = v;
  return env;
}

export async function startApp(opts: { mode?: "demo" | "live"; port: number; suite: string; env?: Record<string, string | undefined> }): Promise<App> {
  const mode = opts.mode ?? "demo";
  const dbFile = path.join(os.tmpdir(), `cc-e2e-${opts.suite}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const base = `http://127.0.0.1:${opts.port}`;
  const env = cleanEnv({ CARECIRCLE_DB: dbFile, CARECIRCLE_MODE: mode === "live" ? "live" : undefined, PORT: String(opts.port), ...opts.env });
  const log = fs.createWriteStream(path.join(os.tmpdir(), `cc-e2e-${opts.suite}.server.log`));
  const child: ChildProcess = spawn(process.execPath, [path.join(WEB, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(opts.port), "-H", "127.0.0.1"], { cwd: WEB, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout!.pipe(log); child.stderr!.pipe(log);

  const deadline = Date.now() + 90_000;
  for (;;) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}); see ${log.path}`);
    if (Date.now() > deadline) throw new Error("server did not start in 90 s");
    await new Promise((r) => setTimeout(r, 500));
  }

  const api: App["api"] = async (userId, method, url, body) => {
    const headers: Record<string, string> = {};
    if (userId) headers.cookie = `cc_user=${userId}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
    const text = await r.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch {}
    return { status: r.status, data };
  };
  // Seeding happens on the first request that calls ready(); make sure it has run before opening the DB.
  await api(null, "GET", "/api/session");
  let db: DatabaseSync | null = null;
  const conn = () => (db ??= new DatabaseSync(dbFile));
  const q: App["q"] = (sql, ...p) => conn().prepare(sql).all(...p) as any[];
  const q1: App["q1"] = (sql, ...p) => conn().prepare(sql).get(...p) as any;
  const exec: App["exec"] = (sql, ...p) => { conn().prepare(sql).run(...p); };

  const results: Result[] = [];
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `${opts.suite}.jsonl`);
  fs.writeFileSync(outFile, "");

  const app: App = {
    base, dbFile, mode, api, q, q1, exec,
    wa: {
      send: (userId, body) => api(null, "POST", "/api/whatsapp", { userId, body }),
      thread: async (userId, limit = 200) => (await api(null, "GET", `/api/whatsapp?userId=${encodeURIComponent(userId)}&limit=${limit}`)).data.messages,
      since: (userId, afterId) => q("SELECT id, body, kind, quick, created_at FROM messages WHERE user_id = ? AND direction = 'OUT' AND id > ? ORDER BY id", userId, afterId),
      sos: (userId) => api(null, "POST", "/api/whatsapp/sos", { userId }),
      media: (userId, f) => api(null, "POST", "/api/whatsapp/media", { userId, ...f }),
      contacts: async () => (await api(null, "GET", "/api/whatsapp")).data.contacts,
    },
    mark: () => (q1<{ m: number | null }>("SELECT MAX(id) AS m FROM messages")?.m ?? 0),
    clock: {
      now: async () => (await api(null, "GET", "/api/demo")).data.now,
      advance: async (minutes) => { const r = await api(null, "POST", "/api/demo", { action: "advance", minutes }); if (r.status !== 200) throw new Error(`advance failed: ${r.status} ${JSON.stringify(r.data)}`); },
      simulate: async (days) => { const r = await api(null, "POST", "/api/demo", { action: "simulate", days }); if (r.status !== 200) throw new Error(`simulate failed: ${r.status}`); },
      reset: async () => { const r = await api(null, "POST", "/api/demo", { action: "reset" }); if (r.status !== 200) throw new Error(`reset failed: ${r.status} ${JSON.stringify(r.data)}`); },
    },
    results,
    test: async (id, title, fn) => {
      const t0 = Date.now();
      let res: Result;
      try {
        await fn();
        res = { id, title, status: "PASS", note: "", ms: Date.now() - t0 };
      } catch (e) {
        const err = e as Error;
        res = err instanceof Skip
          ? { id, title, status: err.status, note: err.message, ms: Date.now() - t0 }
          : { id, title, status: "FAIL", note: (err.message || String(err)).replace(/\s+/g, " ").slice(0, 600), ms: Date.now() - t0 };
      }
      results.push(res);
      fs.appendFileSync(outFile, JSON.stringify(res) + "\n");
      console.log(`${res.status.padEnd(7)} ${id.padEnd(12)} ${title}${res.note ? ` — ${res.note.slice(0, 160)}` : ""}`);
      return res;
    },
    stop: async () => {
      db?.close();
      // `next start` forks a next-server child: stop the whole process group so nothing keeps the port.
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      await new Promise((r) => setTimeout(r, 500));
      const c = results.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
      console.log(`\n${opts.suite}: ${JSON.stringify(c)}  (results: ${outFile})`);
    },
  };
  return app;
}

/** Wait until `fn` returns truthy (background work such as translation or document reading). */
export async function until<T>(fn: () => T | Promise<T>, ms = 5000, step = 200): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, step));
  }
}
