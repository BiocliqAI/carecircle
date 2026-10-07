import { after } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { getUser, ingestMessage, runScheduler } from "@/lib/engine";
import { receiveMedia } from "@/lib/inbox";
import { ready } from "@/lib/server";
import { signedUrl, twilioConfig, twilioMedia, validSignature, type TwilioConfig } from "@/lib/twilio";
import { inboundReceived, sendWhatsApp, strangerWrote, userByPhone } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

// Twilio webhook for incoming WhatsApp messages (set as the sender's "Webhook URL for incoming messages").
// Answers at once with empty TwiML and does the work afterwards, so a slow AI read never makes Twilio retry.
export async function POST(req: Request) {
  const cfg = twilioConfig();
  if (!cfg) return new Response("WhatsApp gateway is not configured", { status: 503 });
  const params: Record<string, string> = {};
  for (const [k, v] of await req.formData()) if (typeof v === "string") params[k] = v;
  if (!validSignature(cfg, req.headers.get("x-twilio-signature"), signedUrl(cfg, req), params)) return new Response("Invalid signature", { status: 403 });
  await ready();
  const user = userByPhone(params.From ?? "");
  if (!user) {
    // Someone not (yet) in a care circle: one polite note a day, and only the time they wrote is kept.
    strangerWrote(params.From ?? "");
    const key = `wa:stranger:${params.From}`;
    if (Date.now() - Number(getSetting(key) || 0) < 24 * 3600_000) return twiml();
    setSetting(key, String(Date.now()));
    return twiml("Hello! This is a clinic's CareCircle WhatsApp assistant. Your number isn't linked to a patient yet. Please contact your clinic to be added.");
  }
  if (seen(params.MessageSid)) return twiml(); // Twilio retried a message we already have
  const previous = inbound.get(user.id) ?? Promise.resolve();
  const job = previous.then(() => handle(cfg, user.id, params)).catch((e) => console.error("[twilio inbound]", e));
  inbound.set(user.id, job);
  after(() => job);
  return twiml();
}

// One person's messages are handled in the order they arrived.
const g = globalThis as unknown as { __ccWaIn?: Map<string, Promise<void>>; __ccWaSeen?: string[] };
const inbound = (g.__ccWaIn ??= new Map<string, Promise<void>>());
function seen(sid: string | undefined): boolean {
  if (!sid) return false;
  const list = (g.__ccWaSeen ??= []);
  if (list.includes(sid)) return true;
  list.push(sid);
  if (list.length > 500) list.shift();
  return false;
}

const SHOW = /^show (message|messages|alert)$/i; // the template buttons (payload id "cc_show")
// "Hi" sent to receive what was waiting (e.g. a caregiver's invitation) needs no reply of its own.
const GREETING = /^(hi+|hello+|hey+|hai|helo|namaste|namaskar(am)?|vanakkam|good (morning|afternoon|evening)|ok(ay)?)[\s!.🙏👋]*$/i;

async function handle(cfg: TwilioConfig, userId: string, p: Record<string, string>) {
  const held = inboundReceived(userId); // the 24-hour window is open: deliver what was waiting first
  const body = (p.ButtonText || p.Body || "").trim();
  if (p.ButtonPayload === "cc_show" || SHOW.test(body)) return;
  if (held > 0 && Number(p.NumMedia || 0) === 0 && GREETING.test(body)) return;
  const user = getUser(userId)!;
  const n = Math.min(Number(p.NumMedia || 0), 5);
  if (n > 0) {
    for (let i = 0; i < n; i++) {
      const type = (p[`MediaContentType${i}`] || "").split(";")[0];
      const file = await twilioMedia(cfg, p[`MediaUrl${i}`]);
      if (!file) {
        sendWhatsApp({ userId, patientId: null, at: Date.now(), kind: "reply", body: "That file is too large for me to keep (over 20 MB). Please send a smaller photo or ask your clinic." });
        continue;
      }
      const voice = /^audio\//.test(type);
      const ext = type === "application/pdf" ? ".pdf" : "";
      const filename = body && !voice ? body.slice(0, 100) : /^image\//.test(type) ? "Photo" : `Document${ext}`;
      await receiveMedia(user, { kind: voice ? "voice" : "document", base64: file.base64, mime: type || file.mime, filename })
        .catch((e) => sendWhatsApp({ userId, patientId: null, at: Date.now(), kind: "reply", body: `Sorry, I couldn't save that file: ${(e as Error).message}` }));
    }
    return;
  }
  if (!body) return; // a sticker, location or reaction: nothing to log
  await ingestMessage(userId, body.slice(0, 1000));
  runScheduler();
}

function twiml(message?: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${esc(message)}</Message>` : ""}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });
}
