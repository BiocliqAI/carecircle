// WhatsApp gateway adapter. Every outbound message is stored and shown in the /whatsapp simulator. In live-clinic mode
// with Twilio configured (lib/twilio.ts) it is also delivered to the person's real WhatsApp, in their language.
//
// WhatsApp only allows free-form messages within 24 hours of the person's last message. Outside that window a message
// waits, and an approved template ("you have a new message — Show message") is sent instead; when they reply or tap,
// the waiting messages are delivered. Alerts use their own template that carries the alert's first line.
import { get, getSetting, run, setSetting, all } from "./db";
import { now } from "./clock";
import { langOf, scheduleTranslation } from "./lang";
import { buttonsContent, e164, templateFor, twilioConfig, twilioSend, TwilioError, type TwilioConfig } from "./twilio";

export interface OutboundMessage {
  userId: string; // recipient (patient or caregiver user)
  patientId: string | null;
  body: string;
  quick?: string[]; // quick-reply buttons (WhatsApp interactive replies)
  kind?: string; // prompt | reminder | reply | escalation | info
  at: number;
}

export function sendWhatsApp(m: OutboundMessage): number {
  const cfg = twilioConfig();
  const r = run(
    "INSERT INTO messages(patient_id, user_id, direction, body, quick, created_at, kind, wa_status) VALUES(?,?,?,?,?,?,?,?)",
    m.patientId,
    m.userId,
    "OUT",
    m.body,
    m.quick && m.quick.length ? JSON.stringify(m.quick) : null,
    m.at,
    m.kind || "info",
    cfg ? "pending" : null,
  );
  // In the person's own language: translated in the background right after it is stored, and delivered once
  // translated. The English stays in body_en.
  const translated = scheduleTranslation(r.lastInsertRowid, langOf(m.userId));
  if (cfg) enqueue(m.userId, async () => { await translated; await deliver(cfg, r.lastInsertRowid); });
  return r.lastInsertRowid;
}

// ---------------------------------------------------------------- delivery
const WINDOW_MS = 24 * 3600_000 - 10 * 60_000; // WhatsApp's 24 h customer-service window, with a margin
const STALE_MS = 2 * 3600_000; // a reminder generated while the server was down is not worth sending hours later
const NUDGE_GAP_MS = 6 * 3600_000; // at most one "you have a new message" template per person per 6 h
const FLUSH_MAX = 6; // when the window opens, deliver at most the latest few waiting messages
const TEXT_MAX = 1500; // Twilio's limit is 1600
const BUTTON_BODY_MAX = 1000; // WhatsApp's limit for a message with buttons is 1024

// Messages to one person go out strictly in order.
const g = globalThis as unknown as { __ccWaChains?: Map<string, Promise<void>> };
const chains = (g.__ccWaChains ??= new Map<string, Promise<void>>());
function enqueue(userId: string, job: () => Promise<void>) {
  const next = (chains.get(userId) ?? Promise.resolve()).then(job).catch((e: unknown) => console.error("[whatsapp]", e));
  chains.set(userId, next);
  void next.finally(() => { if (chains.get(userId) === next) chains.delete(userId); });
}
/** Resolves when every queued delivery has finished (tests). */
export async function deliveriesSettled() {
  while (chains.size) await Promise.all([...chains.values()]);
}

type Row = { id: number; user_id: string; patient_id: string | null; body: string; quick: string | null; created_at: number; kind: string | null; wa_status: string | null };
const mark = (id: number, status: string, sid: string | null = null, error: string | null = null) =>
  run("UPDATE messages SET wa_status = ?, wa_sid = COALESCE(?, wa_sid), wa_error = ? WHERE id = ?", status, sid, error, id);

/** The person's WhatsApp number in E.164, from their user record (or their patient record). */
export function phoneOf(userId: string): string | null {
  const u = get<{ phone: string | null }>("SELECT phone FROM users WHERE id = ?", userId);
  return e164(u?.phone) ?? e164(get<{ phone: string }>("SELECT phone FROM patients WHERE user_id = ?", userId)?.phone);
}

/** The patient or caregiver a WhatsApp number belongs to. Clinic staff never get automated messages. */
export function userByPhone(raw: string): { id: string; role: string } | undefined {
  const want = e164(raw);
  if (!want) return undefined;
  return all<{ id: string; role: string; phone: string | null }>("SELECT id, role, phone FROM users WHERE role IN ('PATIENT','CAREGIVER')")
    .find((u) => e164(u.phone) === want || (u.role === "PATIENT" && phoneOf(u.id) === want));
}

/** Within 24 h of their last message, including one sent before they were onboarded (kept by number). */
function windowOpen(userId: string): boolean {
  const phone = phoneOf(userId);
  const last = Math.max(Number(getSetting(`wa:lastin:${userId}`) || 0), phone ? Number(getSetting(`wa:lastin:${phone}`) || 0) : 0);
  return Date.now() - last < WINDOW_MS;
}

/** A message from a number not (yet) in a care circle: remembered so a welcome sent soon after can go out as text. */
export function strangerWrote(from: string) {
  const phone = e164(from);
  if (phone) setSetting(`wa:lastin:${phone}`, String(Date.now()));
}

async function deliver(cfg: TwilioConfig, id: number) {
  const row = get<Row>("SELECT id, user_id, patient_id, body, quick, created_at, kind, wa_status FROM messages WHERE id = ?", id);
  if (!row || row.wa_status !== "pending") return;
  const to = phoneOf(row.user_id);
  if (!to) return void mark(id, "failed", null, "No valid WhatsApp number on file");
  if (cfg.allow && !cfg.allow.has(to)) return void mark(id, "skipped", null, "Number not on WHATSAPP_ALLOWLIST");
  if (now() - row.created_at > STALE_MS) return void mark(id, "expired", null, "Too old to send");
  if (!windowOpen(row.user_id)) return void (await hold(cfg, row, to));
  try {
    mark(id, "sent", await sendSession(cfg, row, to));
  } catch (e) {
    // 63016: outside the 24-hour window after all (e.g. the window was opened from another device's chat).
    if (e instanceof TwilioError && e.code === 63016) return void (await hold(cfg, row, to));
    mark(id, "failed", null, (e as Error).message.slice(0, 300));
    console.error("[whatsapp] send failed", id, (e as Error).message);
  }
}

/** A free-form message (inside the window), split if long, with its buttons as WhatsApp buttons when they fit. */
async function sendSession(cfg: TwilioConfig, row: Row, to: string): Promise<string> {
  const quick = row.quick ? (JSON.parse(row.quick) as string[]) : [];
  let sid = "";
  if (quick.length) {
    const content = await buttonsContent(cfg, quick).catch((e) => { console.error("[whatsapp] buttons", (e as Error).message); return null; });
    if (content) {
      const parts = splitText(row.body, BUTTON_BODY_MAX);
      for (const p of parts.slice(0, -1)) await twilioSend(cfg, to, { body: p });
      try {
        return await twilioSend(cfg, to, { contentSid: content, variables: { "1": parts.at(-1)! } });
      } catch (e) {
        if (e instanceof TwilioError && e.code === 63016) throw e;
        console.error("[whatsapp] buttons send", (e as Error).message);
        return twilioSend(cfg, to, { body: withOptions(parts.at(-1)!, quick) });
      }
    }
    for (const p of splitText(withOptions(row.body, quick), TEXT_MAX)) sid = await twilioSend(cfg, to, { body: p });
    return sid;
  }
  for (const p of splitText(row.body, TEXT_MAX)) sid = await twilioSend(cfg, to, { body: p });
  return sid;
}

const withOptions = (body: string, quick: string[]) => `${body}\n\nReply with: ${quick.map((q) => `*${q}*`).join(" / ")}`;

/** Splits on paragraph, then line, then word boundaries so no part is longer than max. */
export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while ([...rest].length > max) {
    const head = [...rest].slice(0, max).join("");
    const at = (sep: string) => { const i = head.lastIndexOf(sep); return i > head.length / 3 ? i : -1; };
    const cut = [at("\n\n"), at("\n"), at(" ")].find((i) => i > 0) ?? head.length;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.length ? out : [""];
}

/** One line, no formatting, short: what a template variable may hold. */
export function templateLine(text: string, max = 160): string {
  const line = text.replace(/[*_~`]/g, "").replace(/\s*\n+\s*/g, " · ").replace(/\s{2,}/g, " ").trim();
  return [...line].length > max ? [...line].slice(0, max - 1).join("").trimEnd() + "…" : line;
}

/** Outside the window: the message waits, and the person gets an approved template asking them to open it. */
async function hold(cfg: TwilioConfig, row: Row, to: string) {
  const alert = row.kind === "escalation";
  const tpl = templateFor(cfg, alert ? "alert" : "update", langOf(row.user_id));
  if (!tpl) return void mark(row.id, "waiting", null, `Outside the 24-hour window and no ${alert ? "TWILIO_TEMPLATE_ALERT" : "TWILIO_TEMPLATE_UPDATE"} is set`);
  mark(row.id, "waiting");
  const key = `wa:nudge:${row.user_id}`;
  if (!alert && Date.now() - Number(getSetting(key) || 0) < NUDGE_GAP_MS) return;
  const { getUser, getPatient, clinicLabel } = await import("./engine");
  const { shortName } = await import("./types");
  const name = shortName(getUser(row.user_id)?.name ?? "there");
  const variables: Record<string, string> = alert
    ? { "1": name, "2": shortName((row.patient_id && getPatient(row.patient_id)?.name) || "your family member"), "3": templateLine(row.body) }
    : { "1": name, "2": clinicLabel() || "your clinic" };
  try {
    await twilioSend(cfg, to, { contentSid: tpl, variables });
    setSetting(key, String(Date.now()));
  } catch (e) {
    mark(row.id, "waiting", null, `Template not sent: ${(e as Error).message}`.slice(0, 300));
    console.error("[whatsapp] template failed", row.id, (e as Error).message);
  }
}

/**
 * The person just wrote to us: the window is open, so deliver what was waiting (oldest first) before any new replies.
 * Returns how many messages were waiting.
 */
export function inboundReceived(userId: string): number {
  const cfg = twilioConfig();
  setSetting(`wa:lastin:${userId}`, String(Date.now()));
  if (!cfg) return 0;
  const held = get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND direction = 'OUT' AND wa_status = 'waiting'", userId)?.n ?? 0;
  enqueue(userId, async () => {
    const waiting = all<{ id: number; created_at: number }>("SELECT id, created_at FROM messages WHERE user_id = ? AND direction = 'OUT' AND wa_status = 'waiting' ORDER BY created_at, id", userId);
    const fresh = waiting.filter((w) => now() - w.created_at < 24 * 3600_000).slice(-FLUSH_MAX);
    for (const w of waiting) if (!fresh.includes(w)) mark(w.id, "expired", null, "Waited too long for the 24-hour window");
    for (const w of fresh) {
      // A waiting message is still worth sending however long it waited (up to a day): no staleness check here.
      run("UPDATE messages SET wa_status = 'pending', wa_error = NULL WHERE id = ?", w.id);
      await deliverWaiting(cfg, w.id);
    }
  });
  return held;
}

async function deliverWaiting(cfg: TwilioConfig, id: number) {
  const row = get<Row>("SELECT id, user_id, patient_id, body, quick, created_at, kind, wa_status FROM messages WHERE id = ?", id);
  const to = row && phoneOf(row.user_id);
  if (!row || !to) return;
  try {
    mark(id, "sent", await sendSession(cfg, row, to));
  } catch (e) {
    mark(id, "failed", null, (e as Error).message.slice(0, 300));
  }
}

// ---------------------------------------------------------------- delivery receipts
const RANK: Record<string, number> = { pending: 0, queued: 1, accepted: 1, sending: 1, sent: 2, delivered: 3, read: 4 };

/** Twilio status callback: sent → delivered → read, or failed/undelivered with Twilio's error code. */
export function deliveryStatus(sid: string, status: string, errorCode: string | null) {
  const row = get<Row & { wa_sid: string }>("SELECT id, user_id, patient_id, body, quick, created_at, kind, wa_status, wa_sid FROM messages WHERE wa_sid = ?", sid);
  if (!row) return;
  if (status === "failed" || status === "undelivered") {
    if ((RANK[row.wa_status ?? ""] ?? 0) >= 3) return;
    const cfg = twilioConfig();
    const to = phoneOf(row.user_id);
    if (errorCode === "63016" && cfg && to) return void enqueue(row.user_id, () => hold(cfg, row, to));
    mark(row.id, "failed", null, `Twilio error ${errorCode ?? "unknown"}`);
    return;
  }
  if (RANK[status] !== undefined && RANK[status] > (RANK[row.wa_status ?? ""] ?? -1)) mark(row.id, status === "queued" || status === "accepted" || status === "sending" ? "sent" : status);
}
