// Anthropic Claude: document reading (PDFs, photos of prescriptions / reports / device displays), OCR and every
// text-reasoning task. Speech (voice notes, dictation, consultation audio) stays with Gemini, which can hear audio.
// Used only when an Anthropic API key is set; otherwise those tasks run on Gemini as before.
import Anthropic from "@anthropic-ai/sdk";
import { getSetting, setSetting } from "./db";

/** One piece of an AI request: text, or a base64 file (image / PDF / audio). Same shape the Gemini calls use. */
export type AIPart = { type: "text"; text: string } | { type: "image" | "document" | "audio"; data: string; mime_type: string };
export type Effort = "low" | "medium" | "high";

export function getAnthropicApiKey(): string | null {
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  if (env) return env;
  const db = getSetting("anthropic_api_key")?.trim();
  return db || null;
}

export function setAnthropicApiKey(key: string): void {
  setSetting("anthropic_api_key", key.trim());
}

export function isClaudeConfigured(): boolean {
  return !!getAnthropicApiKey();
}

export function getClaudeModel(): string {
  return process.env.CLAUDE_MODEL?.trim() || "claude-opus-5-5";
}

// Models that take the server-side refusal fallback ("default" picks the fallback model by refusal category).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"]);

let cached: { key: string; client: Anthropic } | null = null;
function client(): Anthropic {
  const key = getAnthropicApiKey();
  if (!key) throw new Error("Anthropic is not configured");
  if (cached?.key !== key) cached = { key, client: new Anthropic({ apiKey: key, maxRetries: 2 }) };
  return cached.client;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
const mimeOf = (p: { mime_type: string }) => {
  const m = (p.mime_type || "").split(";")[0].trim().toLowerCase();
  return m === "image/jpg" ? "image/jpeg" : m;
};
const strip = (b64: string) => b64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");

/** Claude reads text, JPEG / PNG / GIF / WebP photos and PDFs. Audio and other formats (e.g. iPhone HEIC photos) it can't. */
export function claudeCanRead(parts: AIPart[]): boolean {
  return parts.every((p) => p.type === "text" || (p.type === "document" && mimeOf(p) === "application/pdf") || (p.type === "image" && (IMAGE_TYPES as readonly string[]).includes(mimeOf(p))));
}

function toContent(parts: AIPart[]): Anthropic.Beta.BetaContentBlockParam[] {
  const files: Anthropic.Beta.BetaContentBlockParam[] = [];
  const texts: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      if (p.text.trim()) texts.push({ type: "text", text: p.text });
    } else if (p.type === "document" || mimeOf(p) === "application/pdf") {
      files.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: strip(p.data) } });
    } else if (p.type === "image") {
      files.push({ type: "image", source: { type: "base64", media_type: mimeOf(p) as ImageType, data: strip(p.data) } });
    } else {
      throw new Error("Claude can't listen to audio");
    }
  }
  // Documents and photos first, then the instructions about them.
  return [...files, ...texts];
}

/** The API's own reason, readable: "401 invalid x-api-key", "429 rate limited"… */
export function claudeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic API key not valid";
  if (e instanceof Anthropic.PermissionDeniedError) return "Anthropic API key has no access to this model";
  if (e instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached, try again shortly";
  if (e instanceof Anthropic.APIError) return `Anthropic ${e.status ?? ""} ${e.message}`.trim().slice(0, 300);
  return ((e as Error)?.message || "unknown error").slice(0, 300);
}

/** The JSON object in a reply (tolerates a stray code fence or a sentence around it). */
export function jsonFrom(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

/**
 * One request to Claude; returns the reply text (with `json`, just the JSON object). Throws with a readable reason.
 * Streaming is used so long documents and long outputs don't hit HTTP timeouts.
 */
export async function claudeText(system: string, parts: AIPart[], opts: { json?: boolean; effort?: Effort; maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
  const model = getClaudeModel();
  const sys = opts.json ? `${system}\n\nReply with only the JSON object: no text before or after it, no code fences.` : system;
  const stream = client().beta.messages.stream(
    {
      model,
      max_tokens: opts.maxTokens ?? 32000,
      system: sys,
      messages: [{ role: "user", content: toContent(parts) }],
      output_config: { effort: opts.effort ?? "medium" },
      ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    },
    { timeout: opts.timeoutMs ?? 5 * 60_000 },
  );
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to process this");
  if (msg.stop_reason === "max_tokens") throw new Error("The AI's answer was too long and got cut off");
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  if (!text) throw new Error("The AI returned nothing");
  return opts.json ? jsonFrom(text) : text;
}
