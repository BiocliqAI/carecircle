// Fallback for browser speech recognition when Gemini isn't available: fix the everyday words it
// commonly mis-hears in health updates. Only applied to voice-note transcripts, never to typed text.
const FIXES: [RegExp, string][] = [
  [/\bfeel(ing|s)?\s+(very\s+|a\s+bit\s+|little\s+|so\s+)?(busy|dizzie|tizzy|dissy|easy)\b/gi, "feel$1 $2dizzy"],
  [/\b(busy|dizzie|dissy)\s+(spell|today|since|in the morning)\b/gi, "dizzy $2"],
  [/\bbusiness\b(?=.*\b(feel|head|morning|since)\b)/gi, "dizziness"],
  [/\b(painting|fainted|feinting|fanting|planting)\b/gi, "fainting"],
  [/\b(painted|feinted)\b(?=\s+(today|yesterday|in|at|this|once|twice))/gi, "fainted"],
  [/\b(gritty|kiddy|giddy up)\b/gi, "giddy"],
  [/\b(breath less|breathe less|brethless)\b/gi, "breathless"],
  [/\b(sugar|suger|shugar)\s+(is\s+)?/gi, "sugar "],
  [/\bb\.?\s?p\.?\b/gi, "BP"],
  [/\bpressure\s+(is\s+)?(\d{2,3})\s+(by|over|on|and)\s+(\d{2,3})\b/gi, "BP $2/$4"],
  [/\bBP\s+(is\s+)?(\d{2,3})\s+(by|over|on)\s+(\d{2,3})\b/gi, "BP $2/$4"],
  [/\b(tablet|tablets|medicine|medicines)\s+(taken|took)\b/gi, "took $1"],
  [/\bchest pane\b/gi, "chest pain"],
  [/\bpalpatations?\b/gi, "palpitations"],
];

export function fixHealthWords(text: string): string {
  let out = text;
  for (const [re, rep] of FIXES) out = typeof rep === "string" ? out.replace(re, rep) : out;
  return out.replace(/\s{2,}/g, " ").trim();
}
