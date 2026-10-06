// When a WhatsApp reply can't be read, ask a short question instead of just saying "sorry".
// Pure functions (no database) so the wording and the guesses are easy to test; the engine supplies what's pending.
import type { VitalType } from "./types";

export interface ClarifyInput {
  body: string;
  firstName: string; // patient's first name
  forCaregiver: boolean;
  pendingVitals: VitalType[]; // vitals the plan is waiting for now
  planVitals: VitalType[]; // vitals in the plan at all
  pendingMeds: string[]; // e.g. "Furosemide 40 mg (8:00 am)"
  pendingOther: string[];
}
export interface ClarifyOption { label: string; text: string }
export interface Clarification { text: string; quick: string[]; options: ClarifyOption[] | null }

// What a lone number could be, with the range that makes sense for it.
const NUMBER_KINDS: { type: VitalType; word: string; unit: string; lo: number; hi: number }[] = [
  { type: "weight", word: "weight", unit: "kg", lo: 20, hi: 250 },
  { type: "glucose", word: "sugar", unit: "mg/dL", lo: 30, hi: 600 },
  { type: "hr", word: "pulse", unit: "bpm", lo: 30, hi: 220 },
  { type: "spo2", word: "spo2", unit: "%", lo: 70, hi: 100 },
];
const VITAL_WORD: Record<string, string> = { bp: "BP", weight: "weight", glucose: "sugar", hr: "pulse", spo2: "oxygen", temp: "temperature", pain: "pain score" };

export function clarify(i: ClarifyInput): Clarification | null {
  const who = i.forCaregiver ? i.firstName : "your";
  const t = i.body.trim().replace(/\s*(kg|kgs|mg\/dl|bpm|%)$/i, "");

  // "132 84" or "132,84": two numbers that look like a blood pressure.
  const two = t.match(/^(\d{2,3})\s*[ ,]\s*(\d{2,3})$/);
  if (two && Number(two[1]) > Number(two[2]) && Number(two[1]) >= 80 && Number(two[1]) <= 260 && Number(two[2]) >= 40 && Number(two[2]) <= 160) {
    const text = `BP ${two[1]}/${two[2]}`;
    return { text: `I read that as ${who === "your" ? "your" : who + "'s"} blood pressure ${two[1]}/${two[2]}. Is that right?`, quick: ["Yes, that's BP", "No"], options: [{ label: "Yes, that's BP", text }] };
  }

  // A lone number: offer the readings it could be, those the plan is waiting for first.
  const one = t.match(/^(\d{2,3}(?:\.\d{1,2})?)$/);
  if (one) {
    const v = Number(one[1]);
    const fits = NUMBER_KINDS.filter((k) => v >= k.lo && v <= k.hi);
    const asked = fits.filter((k) => i.pendingVitals.includes(k.type));
    const planned = fits.filter((k) => i.planVitals.includes(k.type));
    const pool = (asked.length ? asked : planned.length ? planned : fits).slice(0, 3);
    if (pool.length) {
      const options = pool.map((k) => ({ label: `${cap(k.word)} (${v} ${k.unit})`, text: `${k.word} ${v}` }));
      return { text: `I got *${v}* but I'm not sure what it is. Which one is it?`, quick: [...options.map((o) => o.label), "None of these"], options };
    }
  }

  // Nothing to guess: say what we're waiting for, and show the exact way to reply.
  const waiting = [...i.pendingVitals.map((v) => `📏 ${cap(VITAL_WORD[v] ?? v)}`), ...i.pendingMeds.map((m) => `💊 ${m}`), ...i.pendingOther.map((o) => `• ${o}`)].slice(0, 6);
  const example = i.pendingVitals.length
    ? `“${[i.pendingVitals.includes("bp") && "BP 132/84", i.pendingVitals.includes("weight") && "weight 72.8", i.pendingVitals.includes("glucose") && "sugar 110"].filter(Boolean).slice(0, 2).join(", ") || "BP 132/84"}, took all tablets”`
    : "“BP 130/80, weight 76.5, took all tablets, no swelling”";
  const lines = [`🤔 Sorry, I couldn't pick that up${i.forCaregiver ? "" : ", but no problem"}.`];
  if (waiting.length) lines.push(`Right now I'm waiting for:\n${waiting.join("\n")}`);
  lines.push(`You can write it your own way, for example:\n${example}`);
  lines.push("If you need help, just reply *HELP*.");
  return { text: lines.join("\n\n"), quick: i.pendingMeds.length ? ["Took all tablets ✅", "Missed my tablets ❌"] : ["Feeling fine, no symptoms"], options: null };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Matches the user's reply to the options we offered: a number, the label, or part of it. Null = "none". */
export function pickOption(options: ClarifyOption[], reply: string): ClarifyOption | null | "unclear" {
  const r = reply.trim().toLowerCase();
  if (/^(no|none|none of these|nope|wrong|neither)\b/.test(r)) return null;
  if (options.length === 1 && /^(yes|y|yeah|yep|correct|right|ok|okay|haan|ha)\b|^yes,/.test(r)) return options[0];
  const n = r.match(/^([1-9])\b/);
  if (n && options[Number(n[1]) - 1]) return options[Number(n[1]) - 1];
  const hit = options.find((o) => r === o.label.toLowerCase() || r.startsWith(o.label.toLowerCase().split(" (")[0]));
  return hit ?? "unclear";
}
