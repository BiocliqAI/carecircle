import { getAnthropicApiKey, getClaudeModel, isClaudeConfigured, setAnthropicApiKey } from "@/lib/claude";
import { err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// The Anthropic key reads documents and does the reasoning. ANTHROPIC_API_KEY in the environment takes precedence
// over a key saved here. Only the clinic admin or a doctor can see or change it.
async function allowed() {
  const u = await sessionUser();
  return !!u && (u.role === "ADMIN" || u.role === "DOCTOR");
}

export async function GET() {
  await ready();
  if (!(await allowed())) return err("Only the clinic admin or a doctor can see AI settings", 403);
  const key = getAnthropicApiKey();
  return json({
    configured: isClaudeConfigured(),
    fromEnv: !!process.env.ANTHROPIC_API_KEY?.trim(),
    model: getClaudeModel(),
    maskedKey: key ? `${key.slice(0, 10)}••••••••${key.slice(-4)}` : null,
  });
}

export async function POST(req: Request) {
  await ready();
  if (!(await allowed())) return err("Only the clinic admin or a doctor can change AI settings", 403);
  const body = (await req.json().catch(() => ({}))) as { apiKey?: string };
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return err("That doesn't look like an Anthropic API key (it starts with sk-ant-)");
  setAnthropicApiKey(key);
  return json({ ok: true, configured: true, model: getClaudeModel() });
}
