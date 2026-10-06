// Replies in the person's own language. The language comes from how they write (script, or the AI's read of
// romanised Hindi/Tamil etc.) or from asking ("reply in Tamil"). Messages are written in English by the engine and
// translated just before delivery; the tapped English button text is mapped back so "YES", "ACK" and the like
// keep working. Safety words, numbers, doses, names and emojis are kept exactly. If translation is unavailable or
// fails, the English message stands.
import { all, get, getSetting, run, setSetting } from "./db";

export const LANGS: Record<string, string> = { hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam", bn: "Bengali", gu: "Gujarati", pa: "Punjabi", mr: "Marathi" };
const SCRIPTS: [string, RegExp][] = [["ta", /[஀-௿]/], ["te", /[ఀ-౿]/], ["kn", /[ಀ-೿]/], ["ml", /[ഀ-ൿ]/], ["bn", /[ঀ-৿]/], ["gu", /[઀-૿]/], ["pa", /[਀-੿]/], ["hi", /[ऀ-ॿ]/]];

/** The language of a message from its script, when it is written in an Indian script. */
export function detectScript(text: string): string | null {
  for (const [code, re] of SCRIPTS) if (re.test(text)) return code;
  return null;
}
/** Normalises an AI-reported language code to one we support; English and unknown return null. */
export const normaliseLang = (c: string | null | undefined): string | null => { const x = (c ?? "").toLowerCase().slice(0, 2); return LANGS[x] ? x : null; };

const NAMES: Record<string, string> = { english: "en", hindi: "hi", tamil: "ta", telugu: "te", kannada: "kn", malayalam: "ml", bengali: "bn", bangla: "bn", gujarati: "gu", punjabi: "pa", marathi: "mr" };
/** "Reply in Tamil", "Hindi mein reply karo", "english please". Returns the code, or null. */
export function explicitLang(body: string): string | null {
  const t = body.toLowerCase().trim();
  const names = Object.keys(NAMES).join("|");
  let m = t.match(new RegExp(`^(?:please\\s+)?(?:reply|respond|talk|speak|write|message|send)(?:\\s+to me)?\\s+in\\s+(${names})\\b`));
  m = m ?? t.match(new RegExp(`^(${names})\\s+(?:please|pls|mein|me|mai)\\b(?:.*\\b(?:reply|bolo|baat|likho))?`));
  m = m ?? t.match(new RegExp(`\\b(${names})\\s+(?:mein|me)\\s+(?:reply|bolo|baat|likho|batao)`));
  return m ? NAMES[m[1]] : null;
}

export const langOf = (userId: string): string => getSetting(`lang:${userId}`) || "en";
export function setLang(userId: string, code: string) { setSetting(`lang:${userId}`, code); run("DELETE FROM settings WHERE key = ?", `langvote:${userId}`); }

/**
 * Learns the language from how someone writes. Indian script = clear signal (1 message). Romanised text read by the AI
 * needs 2 in a row. Three longer English messages in a row switch back to English. A stray word never flips it.
 */
export function recordLang(userId: string, detected: string | null, words: number, strong: boolean): string {
  const cur = langOf(userId);
  const raw = getSetting(`langvote:${userId}`);
  const vote = raw ? (JSON.parse(raw) as { lang: string; n: number }) : { lang: "", n: 0 };
  if (detected) {
    const n = vote.lang === detected ? vote.n + 1 : 1;
    if (strong || n >= 2) { if (cur !== detected) setSetting(`lang:${userId}`, detected); run("DELETE FROM settings WHERE key = ?", `langvote:${userId}`); return detected; }
    setSetting(`langvote:${userId}`, JSON.stringify({ lang: detected, n }));
  } else if (words >= 4 && cur !== "en") {
    const n = vote.lang === "en" ? vote.n + 1 : 1;
    if (n >= 3) { setSetting(`lang:${userId}`, "en"); run("DELETE FROM settings WHERE key = ?", `langvote:${userId}`); return "en"; }
    setSetting(`langvote:${userId}`, JSON.stringify({ lang: "en", n }));
  }
  return cur;
}

// ---------------------------------------------------------------- translation at delivery
export type Translator = (text: string, quick: string[], lang: string) => Promise<{ body: string; quick: string[] } | null>;
let translator: Translator | null = null;
/** Tests inject a fake; production uses Gemini. */
export const setTranslator = (t: Translator | null) => { translator = t; };
const cache = new Map<string, { body: string; quick: string[] }>();
const pending = new Set<Promise<void>>();
export const settled = () => Promise.all([...pending]);

/** Called right after a message is stored: translates it in the background and updates it in place. */
export function scheduleTranslation(msgId: number, lang: string) {
  if (lang === "en" || !LANGS[lang]) return;
  const p = translateRow(msgId, lang).catch(() => undefined).finally(() => pending.delete(p));
  pending.add(p);
}

async function translateRow(id: number, lang: string) {
  const row = get<{ body: string; quick: string | null; body_en: string | null }>("SELECT body, quick, body_en FROM messages WHERE id = ?", id);
  if (!row || row.body_en) return;
  if (!/[A-Za-z]{3}/.test(row.body)) return; // emoji, numbers only
  const quick = row.quick ? (JSON.parse(row.quick) as string[]) : [];
  const key = `${lang}\u0000${row.body}\u0000${quick.join("|")}`;
  let out = cache.get(key) ?? null;
  if (!out) {
    const fn = translator ?? (await import("./gemini")).translateAI;
    out = await fn(row.body, quick, lang);
    if (!out || !out.body.trim() || out.quick.length !== quick.length) return; // keep the English rather than risk a wrong message
    cache.set(key, out);
  }
  run("UPDATE messages SET body = ?, quick = ?, body_en = ?, quick_en = ? WHERE id = ?", out.body, out.quick.length ? JSON.stringify(out.quick) : null, row.body, quick.length ? JSON.stringify(quick) : null, id);
}

/** A tapped (translated) button comes back as its translated label: map it to the English one the engine understands. */
export function mapButtonReply(userId: string, body: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const b = norm(body);
  for (const r of all<{ quick: string | null; quick_en: string | null }>("SELECT quick, quick_en FROM messages WHERE user_id = ? AND direction = 'OUT' AND quick_en IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 6", userId)) {
    const q = JSON.parse(r.quick ?? "[]") as string[], en = JSON.parse(r.quick_en ?? "[]") as string[];
    const i = q.findIndex((x) => norm(x) === b);
    if (i >= 0 && en[i]) return en[i];
  }
  return null;
}
