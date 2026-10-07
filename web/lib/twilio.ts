// Twilio WhatsApp transport: config, phone numbers, webhook signatures, the Messages and Content REST calls, and media
// downloads. No SDK: plain fetch, so it adds no dependency. What to send and when is decided in lib/whatsapp.ts.
import crypto from "node:crypto";
import { getSetting, setSetting } from "./db";
import { LIVE } from "./mode";

export interface TwilioConfig {
  sid: string;
  token: string;
  from: string; // E.164, e.g. +919035913536
  baseUrl: string | null; // public https origin of this app, used for webhook signatures and status callbacks
  templates: { update: string | null; alert: string | null };
  allow: Set<string> | null; // when set, only these numbers are ever messaged (go-live testing)
}

/** Real WhatsApp only in live-clinic mode (the demo's numbers are made up) and only when Twilio is configured. */
export function twilioConfig(): TwilioConfig | null {
  const e = process.env;
  if (!LIVE || e.WHATSAPP_GATEWAY === "off" || !e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN || !e.TWILIO_WHATSAPP_FROM) return null;
  const allow = (e.WHATSAPP_ALLOWLIST ?? "").split(",").map((x) => e164(x)).filter((x): x is string => !!x);
  return {
    sid: e.TWILIO_ACCOUNT_SID,
    token: e.TWILIO_AUTH_TOKEN,
    from: e164(e.TWILIO_WHATSAPP_FROM) ?? e.TWILIO_WHATSAPP_FROM,
    baseUrl: e.PUBLIC_BASE_URL ? e.PUBLIC_BASE_URL.replace(/\/+$/, "") : null,
    templates: { update: e.TWILIO_TEMPLATE_UPDATE || null, alert: e.TWILIO_TEMPLATE_ALERT || null },
    allow: allow.length ? new Set(allow) : null,
  };
}

/** Template SID for a language, e.g. TWILIO_TEMPLATE_UPDATE_HI, falling back to the English one. */
export function templateFor(cfg: TwilioConfig, which: "update" | "alert", lang: string): string | null {
  const own = lang !== "en" ? process.env[`TWILIO_TEMPLATE_${which.toUpperCase()}_${lang.toUpperCase()}`] : undefined;
  return own || cfg.templates[which];
}

/** "+91 98860 20001", "09886020001", "whatsapp:+919886020001" → "+919886020001". Ten digits are taken as Indian. */
export function e164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = "91" + d.slice(1);
  else if (d.length === 10) d = "91" + d;
  return /^\d{8,15}$/.test(d) ? `+${d}` : null;
}

// ---------------------------------------------------------------- webhook signatures
/** X-Twilio-Signature: base64 HMAC-SHA1 of the full URL followed by each POST param (sorted by name) as name+value. */
export function twilioSignature(token: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function validSignature(cfg: TwilioConfig, signature: string | null, url: string, params: Record<string, string>): boolean {
  if (!signature) return false;
  const want = Buffer.from(twilioSignature(cfg.token, url, params));
  const got = Buffer.from(signature);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** The URL Twilio signed: PUBLIC_BASE_URL + path (behind a proxy, req.url carries the internal host). */
export function signedUrl(cfg: TwilioConfig, req: Request): string {
  const u = new URL(req.url);
  return (cfg.baseUrl ?? u.origin) + u.pathname + u.search;
}

// ---------------------------------------------------------------- REST
type Fetch = typeof fetch;
let fetcher: Fetch | null = null;
/** Tests inject a fake. */
export const setTwilioFetch = (f: Fetch | null) => { fetcher = f; };
const doFetch: Fetch = (...a) => (fetcher ?? fetch)(...a);
const auth = (cfg: TwilioConfig) => "Basic " + Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");

export class TwilioError extends Error {
  constructor(message: string, readonly code: number | null, readonly status: number) { super(message); }
}

export type Outgoing = { body: string } | { contentSid: string; variables?: Record<string, string> };

/** Sends one WhatsApp message. Returns the Twilio message SID. */
export async function twilioSend(cfg: TwilioConfig, to: string, m: Outgoing): Promise<string> {
  const form = new URLSearchParams({ From: `whatsapp:${cfg.from}`, To: `whatsapp:${to}` });
  if ("body" in m) form.set("Body", m.body);
  else {
    form.set("ContentSid", m.contentSid);
    if (m.variables) form.set("ContentVariables", JSON.stringify(m.variables));
  }
  if (cfg.baseUrl) form.set("StatusCallback", `${cfg.baseUrl}/api/twilio/status`);
  const r = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: auth(cfg), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = (await r.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
  if (!r.ok || !j.sid) throw new TwilioError(j.message || `Twilio returned ${r.status}`, j.code ?? null, r.status);
  return j.sid;
}

/**
 * Buttons for a reply inside the 24-hour window (no Meta approval needed): a Content resource whose body is a single
 * variable, created once per set of button labels and remembered. Up to 3 short labels → reply buttons; up to 10 →
 * a list. Returns null when the labels don't fit WhatsApp's limits (the caller lists them as text instead).
 */
export async function buttonsContent(cfg: TwilioConfig, labels: string[]): Promise<string | null> {
  const asButtons = labels.length <= 3 && labels.every((l) => [...l].length <= 20);
  const asList = !asButtons && labels.length <= 10 && labels.every((l) => [...l].length <= 24);
  if (!asButtons && !asList) return null;
  const key = `wa:content:${crypto.createHash("sha1").update((asButtons ? "qr" : "lp") + "\u0000" + labels.join("\u0000")).digest("hex")}`;
  const have = getSetting(key);
  if (have) return have;
  const types = asButtons
    ? { "twilio/quick-reply": { body: "{{1}}", actions: labels.map((title, i) => ({ title, id: `b${i}` })) } }
    : { "twilio/list-picker": { body: "{{1}}", button: "Choose", items: labels.map((item, i) => ({ item, id: `b${i}` })) } };
  const r = await doFetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: { Authorization: auth(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({
      friendly_name: `carecircle_${key.slice(-12)}`,
      language: "en",
      variables: { "1": "Please choose" },
      types: { ...types, "twilio/text": { body: "{{1}}" } },
    }),
  });
  const j = (await r.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
  if (!r.ok || !j.sid) throw new TwilioError(j.message || `Twilio Content returned ${r.status}`, j.code ?? null, r.status);
  setSetting(key, j.sid);
  return j.sid;
}

/** Downloads an inbound media file (Twilio media URLs need the account's credentials). */
export async function twilioMedia(cfg: TwilioConfig, url: string, maxBytes = 20 * 1024 * 1024): Promise<{ base64: string; mime: string } | null> {
  const r = await doFetch(url, { headers: { Authorization: auth(cfg) }, redirect: "follow" });
  if (!r.ok) throw new TwilioError(`Media download failed (${r.status})`, null, r.status);
  if (Number(r.headers.get("content-length") || 0) > maxBytes) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) return null;
  return { base64: buf.toString("base64"), mime: (r.headers.get("content-type") || "application/octet-stream").split(";")[0] };
}
