import { getGeminiApiKey, getGeminiModel, isGeminiConfigured, setGeminiApiKey } from "@/lib/gemini";
import { err, json, ready } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  await ready();
  const key = getGeminiApiKey();
  const configured = isGeminiConfigured();
  const masked = key ? `${key.slice(0, 6)}••••••••${key.slice(-4)}` : null;
  return json({
    configured,
    model: getGeminiModel(),
    maskedKey: masked,
  });
}

export async function POST(req: Request) {
  await ready();
  const body = (await req.json().catch(() => ({}))) as { apiKey?: string };
  if (!body.apiKey || typeof body.apiKey !== "string") {
    return err("apiKey required");
  }
  setGeminiApiKey(body.apiKey.trim());
  return json({ ok: true, configured: true, model: getGeminiModel() });
}
