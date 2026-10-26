import { ready } from "@/lib/server";
import { signedUrl, twilioConfig, validSignature } from "@/lib/twilio";
import { deliveryStatus } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

// Twilio delivery receipts for messages we sent: sent → delivered → read, or failed with an error code.
export async function POST(req: Request) {
  const cfg = twilioConfig();
  if (!cfg) return new Response(null, { status: 204 });
  const params: Record<string, string> = {};
  const form = await req.formData().catch(() => null); // Twilio always posts a form; anything else is not Twilio
  if (!form) return new Response("Expected a form post from Twilio", { status: 400 });
  for (const [k, v] of form) if (typeof v === "string") params[k] = v;
  if (!validSignature(cfg, req.headers.get("x-twilio-signature"), signedUrl(cfg, req), params)) return new Response("Invalid signature", { status: 403 });
  await ready();
  if (params.MessageSid && params.MessageStatus) deliveryStatus(params.MessageSid, params.MessageStatus, params.ErrorCode || null);
  return new Response(null, { status: 204 });
}
