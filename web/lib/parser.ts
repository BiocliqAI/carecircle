// Message intelligence: turns a free-text WhatsApp message into structured candidates.
// Gemini (if GEMINI_API_KEY is set) or a deterministic rule-based parser. Output is ALWAYS
// validated/normalised here; AI never decides escalation — rules in engine.ts do.
import type { ParsedFluid, ParsedLab, ParsedMedChange, ParsedMessage, ParsedSymptom, ParsedVital, VitalType } from "./types";
import { LAB_META, SYMPTOMS } from "./types";

interface MedRef {
  key: string;
  name: string;
}

const SYMPTOM_PATTERNS: { key: string; re: RegExp }[] = [
  { key: "chest_pain", re: /chest (pain|tight\w*|discomfort|heav\w*|pressure)|pain in (my |the )?chest/ },
  { key: "fainting", re: /faint\w*|passed out|unconscious|collaps\w*|black(ed)? ?out/ },
  { key: "confusion", re: /confus\w*|disorient\w*|drows\w*|not responding|very sleepy|not making sense/ },
  { key: "orthopnea", re: /breathless\w* (when |while |on )?lying|can'?t lie (down|flat)|cannot lie (down|flat)|propped up|extra pillows?|orthopn\w*/ },
  { key: "breathlessness", re: /breathless\w*|short(ness)? of breath|breathing (difficult\w*|problem|issue|trouble)|difficulty (in )?breathing|can'?t breathe|out of breath|\bsob\b|gasping|wheez\w*/ },
  { key: "edema", re: /swell\w*|swollen|o?edema|puff(y|iness)/ },
  { key: "calf_pain", re: /calf (pain|swelling|tender\w*)|pain in (my |the )?calf/ },
  { key: "dizziness", re: /dizz\w*|giddi\w*|giddy|light ?headed\w*|vertigo/ },
  { key: "palpitations", re: /palpitation\w*|heart (racing|pounding|fluttering)|racing heart/ },
  { key: "fatigue", re: /tired\w*|fatigue\w*|weak(ness)?|exhausted|no energy/ },
  { key: "headache", re: /head ?ache|headache/ },
  { key: "cough", re: /cough\w*|phlegm|sputum/ },
  { key: "knee_pain", re: /knee (pain|hurt\w*|ache\w*|sore\w*|stiff\w*)|pain in (my |the )?knee|joint pain/ },
  { key: "fever", re: /fever\w*|feverish|chills/ },
  { key: "wound", re: /wound (red\w*|discharge|ooz\w*|pus|hot)|stitches (red|ooz\w*)|discharge from (the )?wound/ },
  { key: "nausea", re: /nause\w*|vomit\w*|throw(ing)? up/ },
  { key: "diarrhoea", re: /loose (stools?|motions?)|diarrh\w*|motions? (many|frequent)/ },
  { key: "low_urine", re: /(less|reduced|low|very little|decreased|scanty) urine|urine (is |very )?(less|reduced|low|scanty|very little)|not passing (much )?urine/ },
  { key: "itching", re: /itch\w*|prurit\w*/ },
  { key: "cramps", re: /cramp\w*/ },
  { key: "appetite", re: /(poor|no|low|loss of|reduced|less) appetite|not eating|not hungry/ },
  { key: "hypo", re: /sweat(ing|y)|shak(y|ing|iness)|trembl\w*/ },
];

// ---------- fluids ----------
const GLASS_ML = 200;
const CUP_ML = 150;

/** Extracts intake / urine volumes and removes them from `text` (returned). */
function parseFluids(text: string): { fluids: ParsedFluid[]; text: string } {
  const fluids: ParsedFluid[] = [];
  const TOTAL = /total|so far|till now|until now|whole day|for the day|in all|24 ?h|today'?s/;
  const re = /(\d+(?:\.\d+)?)\s*(ml|mls|millilit\w*|litres?|liters?|ltrs?|l\b|glass(?:es)?|cups?|tumblers?)/g;
  let m: RegExpExecArray | null;
  const spans: [number, number][] = [];
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    const unit = m[2];
    let ml = /^(l|lit|ltr)/.test(unit) ? n * 1000 : /glass|tumbler/.test(unit) ? n * GLASS_ML : /cup/.test(unit) ? n * CUP_ML : n;
    ml = Math.round(ml);
    if (ml < 10 || ml > 6000) continue;
    const before = text.slice(Math.max(0, m.index - 32), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 16);
    const win = before + " " + after;
    const near = before.slice(-22);
    const lastIdx = (re: RegExp) => {
      let i = -1;
      for (const x of near.matchAll(re)) i = x.index ?? i;
      return i;
    };
    const ui = lastIdx(/urine|urinat|output|passed|\bpee\b|o\/p/g);
    const ii = lastIdx(/intake|input|drank|drink|had|water|tea|milk|soup|juice|i\/p/g);
    const isOut = ui > ii || (ui < 0 && /^\s*(of )?urine/.test(after));
    const total = TOTAL.test(win);
    fluids.push({ kind: isOut ? "out" : "in", ml, total });
    spans.push([m.index, m.index + m[0].length]);
  }
  // unit-less day totals: "intake 1050, output 900"
  const inNoUnit = text.match(/(?:fluid )?(?:intake|input|i\/p)\D{0,8}(\d{3,4})\b/);
  if (inNoUnit && !fluids.some((f) => f.kind === "in")) {
    fluids.push({ kind: "in", ml: Number(inNoUnit[1]), total: true });
    text = text.replace(inNoUnit[0], " ");
  }
  const outNoUnit = text.match(/(?:urine output|urine|output|o\/p)\D{0,8}(\d{3,4})\b/);
  if (outNoUnit && !fluids.some((f) => f.kind === "out")) {
    fluids.push({ kind: "out", ml: Number(outNoUnit[1]), total: true });
    text = text.replace(outNoUnit[0], " ");
  }
  for (const [a, b] of spans.reverse()) text = text.slice(0, a) + " ".repeat(b - a) + text.slice(b);
  return { fluids, text };
}

// ---------- labs ----------
const LAB_PATTERNS: { marker: string; re: RegExp; range: [number, number] }[] = [
  { marker: "hba1c", re: /hba1c\D{0,6}(\d+(?:\.\d+)?)/, range: [3, 20] },
  { marker: "ntprobnp", re: /(?:nt[- ]?pro ?bnp|\bbnp)\D{0,6}(\d+(?:\.\d+)?)/, range: [5, 70000] },
  { marker: "creatinine", re: /(?:creatinine|creat\b|s\.? ?creat\w*|\bcr\b)\D{0,6}(\d+(?:\.\d+)?)/, range: [0.2, 20] },
  { marker: "egfr", re: /e?gfr\D{0,6}(\d+(?:\.\d+)?)/, range: [2, 150] },
  { marker: "urea", re: /(?:urea|\bbun\b)\D{0,6}(\d+(?:\.\d+)?)/, range: [5, 400] },
  { marker: "uric_acid", re: /uric(?: acid)?\D{0,6}(\d+(?:\.\d+)?)/, range: [1, 20] },
  { marker: "potassium", re: /(?:potassium|\bk\b\+?)\s*(?:is|level|:|=|-)?\s*(\d(?:\.\d+)?)/, range: [1.5, 9] },
  { marker: "sodium", re: /(?:sodium|\bna\b\+?)\s*(?:is|level|:|=|-)?\s*(\d{3})/, range: [100, 180] },
  { marker: "hb", re: /(?:\bhb\b|ha?emoglobin)\s*(?:is|:|=|-)?\s*(\d+(?:\.\d+)?)/, range: [3, 22] },
  { marker: "albumin", re: /albumin\D{0,6}(\d+(?:\.\d+)?)/, range: [1, 6] },
  { marker: "phosphorus", re: /phosph\w*\D{0,6}(\d+(?:\.\d+)?)/, range: [0.5, 15] },
  { marker: "calcium", re: /calcium\D{0,6}(\d+(?:\.\d+)?)/, range: [4, 16] },
  { marker: "bicarbonate", re: /(?:bicarb\w*|hco3)\D{0,6}(\d+(?:\.\d+)?)/, range: [5, 45] },
  { marker: "chloride", re: /chloride\D{0,6}(\d+(?:\.\d+)?)/, range: [70, 130] },
  { marker: "magnesium", re: /magnesium\D{0,6}(\d+(?:\.\d+)?)/, range: [0.5, 6] },
];

function parseLabs(text: string): { labs: ParsedLab[]; text: string } {
  const labs: ParsedLab[] = [];
  for (const p of LAB_PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const v = Number(m[1]);
    if (Number.isFinite(v) && v >= p.range[0] && v <= p.range[1]) labs.push({ marker: p.marker, value: v });
    text = text.replace(m[0], " ".repeat(m[0].length));
  }
  return { labs, text };
}

// ---------- reported medicine changes (from other doctors) ----------
const CHANGE_VERBS = "stopped|discontinued|stop|started|start|added|add|introduced|restarted|reintroduced|increased|increase|reduced|reduce|decreased|decrease|changed|change|halved|halve|doubled|tapered";
function verbToChange(v: string): ParsedMedChange["change"] {
  if (/stop|discontinu/.test(v)) return "stopped";
  if (/start|add|introduc/.test(v)) return "started";
  if (/increas|reduc|decreas|chang|halv|doubl|taper/.test(v)) return "dose_changed";
  return "other";
}
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

function parseMedChanges(text: string, meds: MedRef[]): ParsedMedChange[] {
  const out: ParsedMedChange[] = [];
  const dr = text.match(/\b(?:dr\.?|doctor)\s+([a-z]+(?:\s+(?!stopped|started|added|reduced|increased|changed|has|said|asked|advised|visited|saw|came|told|suggested|prescribed)[a-z]{3,}\b)?)/);
  const prescriber = dr ? `Dr ${titleCase(dr[1])}` : null;
  const known = (w: string) => meds.find((m) => m.name.toLowerCase().split(/[\s/]+/)[0] === w || m.name.toLowerCase().includes(w));
  const re1 = new RegExp(`\\b(${CHANGE_VERBS})\\s+(?:the\\s+|his\\s+|her\\s+)?(?:tab(?:let)?s?\\.?\\s+|t\\.\\s*|cap\\.?\\s+)?([a-z][a-z0-9-]{2,})([^.,;\\n]{0,40})`, "g");
  const re2 = new RegExp(`\\b(?:tab(?:let)?\\.?\\s+|t\\.\\s*)?([a-z][a-z0-9-]{2,})\\s+(?:is\\s+|was\\s+|has been\\s+)?(${CHANGE_VERBS})\\b([^.,;\\n]{0,40})`, "g");
  const STOP = new Set(["the", "his", "her", "my", "all", "walking", "walk", "exercise", "exercises", "eating", "it", "taking", "from", "to", "dose", "dosage", "tablet", "tablets", "medicine", "medicines", "today", "and", "also", "then", "has", "have", "was", "were", "had", "new", "one", "another", "some"]);
  const push = (verb: string, word: string, rest: string) => {
    if (STOP.has(word)) return;
    rest = rest.split(/\s+(?:and|also|then|but)\s+/)[0];
    if (dr && dr[1].split(/\s+/).includes(word)) return;
    const k = known(word);
    if (!k && !prescriber && !/\bmg\b|tab/.test(text)) return;
    const name = k ? k.name : titleCase(word);
    if (out.some((o) => o.medName.toLowerCase() === name.toLowerCase())) return;
    out.push({ medName: name, change: verbToChange(verb), detail: `${verb} ${word}${rest}`.trim().slice(0, 120), prescriber });
  };
  let m: RegExpExecArray | null;
  // Resume after the medicine word so "reduced lasix … and added nifedipine" finds both.
  while ((m = re1.exec(text))) { push(m[1], m[2], m[3]); re1.lastIndex = m.index + m[0].length - m[3].length; }
  while ((m = re2.exec(text))) { push(m[2], m[1], m[3]); re2.lastIndex = m.index + m[0].length - m[3].length; }
  return out;
}

const NEG_BEFORE = /(no|not|without|none|nil|zero|denies|never|less|reduced|better|gone)\s+(\w+\s+){0,2}$/;

function negated(text: string, idx: number): boolean {
  const before = text.slice(Math.max(0, idx - 28), idx);
  return NEG_BEFORE.test(before);
}

function severityNear(text: string, idx: number): ParsedSymptom["severity"] {
  const win = text.slice(Math.max(0, idx - 30), idx + 50);
  if (/severe|very|a lot|bad(ly)?|terrible|unbearable|at rest|lying|at night|worse|worsening|increas\w*|more than/.test(win)) return "severe";
  if (/slight\w*|mild\w*|little|bit|minor/.test(win)) return "mild";
  return "moderate";
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function parseRules(input: string, meds: MedRef[]): ParsedMessage {
  let text = " " + input.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ") + " ";
  // Reported medicine changes (by other doctors) — logged, never auto-applied.
  const medChanges = parseMedChanges(text, meds);
  const changedKeys = new Set(
    meds.filter((m) => medChanges.some((c) => c.medName.toLowerCase() === m.name.toLowerCase())).map((m) => m.key),
  );
  // Fluids and labs first, removing their text so numbers aren't reused as BP / weight.
  const f = parseFluids(text);
  text = f.text;
  const l = parseLabs(text);
  text = l.text;
  const vitals: ParsedVital[] = [];
  const push = (type: VitalType, v1?: number, v2?: number) => {
    if (v1 === undefined) return;
    if (vitals.some((v) => v.type === type)) return;
    vitals.push(v2 === undefined ? { type, v1 } : { type, v1, v2 });
  };

  // Pain first (so "4/10" is not taken as BP)
  const pain = text.match(/pain\s*(?:score|level)?\s*(?:is|of|:|-|=)?\s*(\d{1,2})\s*(?:\/\s*10|out of 10)?/) || text.match(/\b(\d{1,2})\s*(?:\/\s*10|out of 10)\b/);
  if (pain) {
    const p = num(pain[1]);
    if (p !== undefined && p >= 0 && p <= 10) push("pain", p);
    text = text.replace(pain[0], " ");
  }

  const bp =
    text.match(/(\d{2,3})\s*(?:\/|over|by)\s*(\d{2,3})/) ||
    // "BP 130 80", "bp: 130-80", "blood pressure 130,80": two numbers right after the word, without a slash.
    text.match(/(?:\bbp\b|\bb\.p\.?|blood ?pressure)\s*(?:is|was|:|-|=)?\s*(\d{2,3})\s*(?:[-,\\]|\s|and)\s*(\d{2,3})\b/) ||
    text.match(/(?:sys\w*|systolic)\s*(\d{2,3})\D{0,8}(?:dia\w*|diastolic)\s*(\d{2,3})/);
  if (bp) {
    const s = num(bp[1])!, d = num(bp[2])!;
    if (s >= 70 && s <= 260 && d >= 40 && d <= 160 && s > d) push("bp", s, d);
    text = text.replace(bp[0], " ");
  }

  const spo2 = text.match(/(?:spo2|sp02|sp o2|oxygen|o2|saturation|sats?)\D{0,10}(\d{2,3})/);
  if (spo2) {
    const v = num(spo2[1])!;
    if (v >= 50 && v <= 100) push("spo2", v);
    text = text.replace(spo2[0], " ");
  }

  const hr = text.match(/(?:pulse|\bhr\b|heart ?rate|heartbeat)\s*(?:is|was|:|-|=)?\s*(\d{2,3})/);
  if (hr) {
    const v = num(hr[1])!;
    if (v >= 30 && v <= 220) push("hr", v);
    text = text.replace(hr[0], " ");
  }

  const glu = text.match(/(?:sugar|glucose|fbs|ppbs|rbs|fasting|bsl|gluco\w*)\D{0,14}(\d{2,3})/);
  if (glu) {
    const v = num(glu[1])!;
    if (v >= 20 && v <= 600) push("glucose", v);
    text = text.replace(glu[0], " ");
  }

  const temp = text.match(/(?:temp\w*|fever of)\D{0,8}(\d{2,3}(?:\.\d)?)/);
  if (temp) {
    let v = num(temp[1])!;
    if (v >= 34 && v <= 43) v = Math.round((v * 9) / 5 + 32);
    if (v >= 93 && v <= 110) push("temp", v);
    text = text.replace(temp[0], " ");
  }

  const wt = text.match(/(?:weight|\bwt\b|weigh\w*)\s*(?:is|was|:|-|=|today)?\s*(\d{2,3}(?:\.\d{1,2})?)/) || text.match(/(\d{2,3}(?:\.\d{1,2})?)\s*kgs?\b/);
  if (wt) {
    const v = num(wt[1])!;
    if (v >= 20 && v <= 250) push("weight", v);
    text = text.replace(wt[0], " ");
  }

  // Medications
  const generic = "(tablets?|tabs?|meds|medicines?|medications?|pills?|doses?|inhalers?|puffs?)";
  const missedAll = new RegExp(`(missed|forgot|skipped|didn't take|did not take|not taken|haven't taken|no)\\s+(all|my|the|his|her)?\\s*(morning|night|evening|afternoon|today's)?\\s*${generic}`).test(text);
  const tookAll =
    !missedAll &&
    (new RegExp(`(took|taken|had|take|given|gave)\\s+(all|my|the|his|her)?\\s*(the\\s+)?(morning|night|evening|afternoon|today's)?\\s*${generic}`).test(text) ||
      new RegExp(`${generic}\\s*(taken|done|given|ok)`).test(text) ||
      /\ball (taken|done)\b/.test(text) ||
      /\b(took|taken|had|gave|given) all\b/.test(text));
  const taken: string[] = [];
  const missed: string[] = [];
  for (const m of meds) {
    if (changedKeys.has(m.key)) continue;
    const token = m.name.toLowerCase().split(/[\s/]+/)[0];
    const idx = text.indexOf(token);
    if (idx < 0) continue;
    const win = text.slice(Math.max(0, idx - 30), idx + token.length + 25);
    if (/(missed|forgot|skip\w*|didn't|did not|not taken|ran out|stopped|except|but not|apart from|other than|no )/.test(win)) missed.push(m.key);
    else taken.push(m.key);
  }

  // Physiotherapy / exercise
  let physio: ParsedMessage["physio"] = null;
  if (/(no walk|didn't walk|did not walk|couldn't walk|skipped (the |my |his |her )?(walk\w*|exercis\w*|physio\w*)|no exercis\w*|couldn't (do|exercise)|missed (the |my )?(walk|exercis\w*|physio)|not (done|able to do) (the )?(exercis\w*|physio|walk))/.test(text))
    physio = "not_done";
  else if (/(walked|walk(ing)? done|went for (a |his |her )?walk|did (my |the |his |her )?(exercis\w*|physio|walk|breathing)|exercis\w* (done|completed)|physio (done|completed)|breathing (exercis\w* )?done|completed (the |all )?exercis\w*|stairs done)/.test(text))
    physio = "done";

  // Lifestyle adherence
  let lifestyle: ParsedMessage["lifestyle"] = null;
  if (/(ate|had) (outside|pickle|papad|salty|sweets|fried|junk)|too much (salt|water|fluid)|(salt|diet|fluid)\w*[^.]{0,15}(not followed|exceeded|over|cheated)/.test(text)) lifestyle = "not_ok";
  else if (/(salt|diet|fluid|water)\w*[^.]{0,20}(ok|fine|followed|under|within|limited|controlled|good|restricted)|(followed|stuck to) (the |my )?(diet|salt|fluid)/.test(text)) lifestyle = "ok";

  // Symptoms
  const symptoms: ParsedSymptom[] = [];
  let negatedAny = false;
  for (const p of SYMPTOM_PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    if (negated(text, m.index)) {
      negatedAny = true;
      continue;
    }
    if (p.key === "breathlessness" && symptoms.some((s) => s.key === "orthopnea")) continue;
    if (p.key === "breathlessness" && /\b(less|reduced|better|improv\w*)\b/.test(text.slice(m.index + m[0].length - 1, m.index + 40))) continue;
    if (p.key === "edema" && /(less|reduced|better|improv\w*|gone|down)/.test(text.slice(m.index, m.index + 40))) {
      symptoms.push({ key: p.key, severity: "mild", text: m[0] + " (improving)" });
      continue;
    }
    symptoms.push({ key: p.key, severity: severityNear(text, m.index), text: m[0] });
  }
  // knee pain also matches generic "pain" — avoid duplicate chest/calf matching handled by patterns.
  const noSymptoms = symptoms.length === 0 && (negatedAny || /(no (new )?(symptoms?|issues?|problems?|complaints?)|feeling (fine|good|well|ok|better)|all (good|fine|ok)|doing (fine|well|good))/.test(text));
  const help = /\b(help|emergency|sos|ambulance|urgent|hospital now)\b/.test(text);

  return {
    vitals,
    meds: {
      allTaken: tookAll && missed.length === 0 && !/\b(except|but not|apart from|other than)\b/.test(text),
      allMissed: missedAll,
      taken,
      missed,
    },
    physio,
    lifestyle,
    symptoms,
    noSymptoms,
    help,
    fluids: f.fluids,
    labs: l.labs,
    medChanges,
  };
}

// ---------- validation / normalisation (applies to AI output too) ----------
const RANGES: Record<VitalType, [number, number]> = {
  bp: [60, 280],
  weight: [20, 250],
  glucose: [20, 600],
  hr: [30, 220],
  spo2: [50, 100],
  temp: [93, 110],
  pain: [0, 10],
};

export function normaliseParsed(raw: unknown, meds: MedRef[]): ParsedMessage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const medKeys = new Set(meds.map((m) => m.key));
  const vitals: ParsedVital[] = [];
  for (const v of Array.isArray(r.vitals) ? r.vitals : []) {
    const type = (v as { type?: string }).type as VitalType;
    const v1 = Number((v as { v1?: unknown }).v1);
    const v2raw = (v as { v2?: unknown }).v2;
    if (!(type in RANGES) || !Number.isFinite(v1)) continue;
    const [lo, hi] = RANGES[type];
    if (v1 < lo || v1 > hi) continue;
    if (type === "bp") {
      const v2 = Number(v2raw);
      if (!Number.isFinite(v2) || v2 < 30 || v2 > 180 || v2 >= v1) continue;
      vitals.push({ type, v1, v2 });
    } else if (!vitals.some((x) => x.type === type)) vitals.push({ type, v1 });
  }
  const m = (r.meds ?? {}) as Record<string, unknown>;
  const symptoms: ParsedSymptom[] = [];
  for (const s of Array.isArray(r.symptoms) ? r.symptoms : []) {
    const key = String((s as { key?: unknown }).key || "");
    if (!(key in SYMPTOMS)) continue;
    const sev = String((s as { severity?: unknown }).severity || "moderate");
    symptoms.push({ key, severity: sev === "mild" || sev === "severe" ? sev : "moderate", text: String((s as { text?: unknown }).text || SYMPTOMS[key]).slice(0, 120) });
  }
  const physio = r.physio === "done" || r.physio === "not_done" ? r.physio : null;
  const lifestyle = r.lifestyle === "ok" || r.lifestyle === "not_ok" ? r.lifestyle : null;
  const fluids: ParsedFluid[] = [];
  for (const x of Array.isArray(r.fluids) ? r.fluids : []) {
    const o = x as Record<string, unknown>;
    const ml = Math.round(Number(o.ml));
    if ((o.kind !== "in" && o.kind !== "out") || !Number.isFinite(ml) || ml < 10 || ml > 6000) continue;
    fluids.push({ kind: o.kind, ml, total: !!o.total });
  }
  const labs: ParsedLab[] = [];
  for (const x of Array.isArray(r.labs) ? r.labs : []) {
    const o = x as Record<string, unknown>;
    const marker = String(o.marker || "");
    const value = Number(o.value);
    if (!(marker in LAB_META) || !Number.isFinite(value) || value <= 0) continue;
    if (!labs.some((q) => q.marker === marker)) labs.push({ marker, value });
  }
  const medChanges: ParsedMedChange[] = [];
  const CH = ["started", "stopped", "dose_changed", "other"];
  for (const x of Array.isArray(r.medChanges) ? r.medChanges : []) {
    const o = x as Record<string, unknown>;
    const medName = String(o.medName || "").trim().slice(0, 60);
    if (!medName) continue;
    medChanges.push({
      medName,
      change: (CH.includes(String(o.change)) ? o.change : "other") as ParsedMedChange["change"],
      detail: String(o.detail || "").slice(0, 160),
      prescriber: o.prescriber ? String(o.prescriber).slice(0, 60) : null,
    });
  }
  const changed = new Set(meds.filter((md) => medChanges.some((c) => c.medName.toLowerCase() === md.name.toLowerCase())).map((md) => md.key));
  const list = (x: unknown) => (Array.isArray(x) ? x.map(String).filter((k) => medKeys.has(k) && !changed.has(k)) : []);
  return {
    vitals,
    meds: { allTaken: !!m.allTaken, allMissed: !!m.allMissed, taken: list(m.taken), missed: list(m.missed) },
    physio,
    lifestyle,
    symptoms,
    noSymptoms: !!r.noSymptoms && symptoms.length === 0,
    help: !!r.help,
    fluids,
    labs,
    medChanges,
    outsideVisit: r.outsideVisit === true,
    language: typeof r.language === "string" ? r.language : undefined,
  };
}

// ---------- Gemini adapter ----------
const SCHEMA = {
  type: "object",
  properties: {
    vitals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["bp", "weight", "glucose", "hr", "spo2", "temp", "pain"] },
          v1: { type: "number", description: "Value. For bp this is systolic." },
          v2: { type: "number", description: "Only for bp: diastolic." },
        },
        required: ["type", "v1"],
      },
    },
    meds: {
      type: "object",
      properties: {
        allTaken: { type: "boolean" },
        allMissed: { type: "boolean" },
        taken: { type: "array", items: { type: "string" } },
        missed: { type: "array", items: { type: "string" } },
      },
      required: ["allTaken", "allMissed", "taken", "missed"],
    },
    physio: { type: "string", enum: ["done", "not_done", "none"] },
    lifestyle: { type: "string", enum: ["ok", "not_ok", "none"] },
    symptoms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", enum: Object.keys(SYMPTOMS) },
          severity: { type: "string", enum: ["mild", "moderate", "severe"] },
          text: { type: "string" },
        },
        required: ["key", "severity", "text"],
      },
    },
    noSymptoms: { type: "boolean" },
    help: { type: "boolean", description: "True only if the sender explicitly asks for help / emergency." },
    fluids: {
      type: "array",
      description: "Fluid intake ('in') or urine output ('out') in ml. 1 glass=200 ml, 1 cup=150 ml.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["in", "out"] },
          ml: { type: "number" },
          total: { type: "boolean", description: "true if this is the day's total so far; false if an amount just consumed/passed." },
        },
        required: ["kind", "ml", "total"],
      },
    },
    labs: {
      type: "array",
      items: {
        type: "object",
        properties: { marker: { type: "string", enum: Object.keys(LAB_META) }, value: { type: "number" } },
        required: ["marker", "value"],
      },
    },
    medChanges: {
      type: "array",
      description: "Medicine changes the sender reports another doctor made (started/stopped/dose changed). Not adherence.",
      items: {
        type: "object",
        properties: {
          medName: { type: "string" },
          change: { type: "string", enum: ["started", "stopped", "dose_changed", "other"] },
          detail: { type: "string" },
          prescriber: { type: "string", description: "Doctor's name if stated, else empty." },
        },
        required: ["medName", "change", "detail", "prescriber"],
      },
    },
    language: { type: "string", description: "Language the message is written in as an ISO 639-1 code: en for English (including romanised English), hi, ta, te, kn, ml, bn, gu, pa, mr. Romanised Hindi/Tamil/etc. (e.g. 'dawa le li', 'potachu') gets that language's code." },
    outsideVisit: { type: "boolean", description: "true if the sender is telling about a visit to, or advice from, a doctor other than the clinic (specialist, hospital, GP)." },
  },
  required: ["vitals", "meds", "physio", "lifestyle", "symptoms", "noSymptoms", "help", "fluids", "labs", "medChanges", "outsideVisit", "language"],
};

async function parseGemini(text: string, meds: MedRef[]): Promise<ParsedMessage | null> {
  const { getGeminiApiKey, getGeminiModel } = await import("./gemini");
  const key = getGeminiApiKey();
  if (!key) return null;
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: key });
  const modelName = getGeminiModel();
  const prompt = `You extract structured clinical health-log data from a WhatsApp message sent by a patient or their caregiver.
The message may be in English, Hindi, Tamil, Hinglish, Tanglish, colloquial shorthand, voice-to-text transcription, or mixed.
Understand natural phrasing and intent (e.g., Tamil 'potachu' / 'kuduthom' = taken, Hindi 'dawa le li' = taken, 'bhool gaye' / 'miss aaiduchu' = missed, 'loose motions' = diarrhoea, 'feet swollen' = edema).
Do not diagnose or prescribe. Only extract explicitly stated facts.
Prescribed medicines (use these keys in meds.taken / meds.missed): ${meds.map((m) => `${m.key}="${m.name}"`).join(", ") || "none"}.
Symptom keys: ${Object.entries(SYMPTOMS).map(([k, v]) => `${k}=${v}`).join("; ")}.
Rules: "took all tablets" / "morning medicines done" => meds.allTaken=true. Negated symptoms ("no swelling", "pain illa") are not symptoms; set noSymptoms=true if sender confirms they feel fine or deny symptoms.
Fluids: in ml. 1 glass/tumbler = 200 ml, 1 cup = 150 ml. Mark total=true only if total for the day is stated.
Reported medicine changes: If another doctor started, stopped or changed a medicine, extract in medChanges with prescriber name.
Message: """${text}"""`;
  const call = ai.interactions.create({
    model: modelName,
    input: prompt,
    store: false,
    response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
  } as never) as Promise<{ output_text?: string | null }>;
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), 12_000));
  const resp = await Promise.race([call, timeout]);
  if (!resp || !resp.output_text) return null;
  const raw = JSON.parse(resp.output_text);
  if (raw.physio === "none") raw.physio = null;
  if (raw.lifestyle === "none") raw.lifestyle = null;
  return normaliseParsed(raw, meds);
}

export async function parseMessage(text: string, meds: MedRef[], allowAi = true): Promise<{ parsed: ParsedMessage; parser: string }> {
  if (allowAi) {
    try {
      const p = await parseGemini(text, meds);
      if (p) {
        const { getGeminiModel } = await import("./gemini");
        return { parsed: p, parser: getGeminiModel() };
      }
    } catch (e) {
      console.warn("[parser] Gemini failed, falling back to rules:", (e as Error).message);
    }
  }
  return { parsed: normaliseParsed(parseRules(text, meds), meds), parser: "rules-v1" };
}

export function aiEnabled(): boolean {
  const { isGeminiConfigured } = require("./gemini");
  return isGeminiConfigured();
}
