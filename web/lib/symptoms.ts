// Short follow-up questions after a symptom is reported ("breathless", "swelling", "dizzy", "palpitations"):
// when, where, how much. The answers are saved for the doctor. Answers that match an existing red-flag rule
// (breathless at rest, nearly fainted) raise that same alert; nothing new is decided here.
import { audit, get, run } from "./db";
import { createEscalation, evaluateSymptom, getCaregivers, type PatientRow, type UserRow } from "./engine";
import { HOUR } from "./time";
import { SYMPTOMS, shortName, type CarePlan } from "./types";

interface Q { ask: (who: string, self: boolean) => string; options: string[] }
export const SYMPTOM_QS: Record<string, Q[]> = {
  breathlessness: [
    { ask: (w, s) => `When ${s ? "do" : "does"} ${w} feel breathless?`, options: ["At rest", "Walking or stairs", "Lying flat"] },
    { ask: (w, s) => `${s ? "Are you" : `Is ${w}`} using more pillows than usual to sleep?`, options: ["Yes", "No"] },
  ],
  edema: [
    { ask: (w, s) => `Where is the swelling${s ? "" : ` for ${w}`}?`, options: ["Feet or ankles", "Legs", "Face or belly"] },
    { ask: () => "Compared with yesterday, is it…", options: ["More", "Same", "Less"] },
  ],
  dizziness: [
    { ask: (w, s) => `${s ? "Do you" : `Does ${w}`} feel dizzy when standing up?`, options: ["Yes", "No"] },
    { ask: (w, s) => `Did ${s ? "you" : w} fall or nearly faint?`, options: ["Yes", "No"] },
  ],
  palpitations: [
    { ask: (w, s) => `How does the heartbeat feel for ${s ? "you" : w}?`, options: ["Fast", "Irregular", "Skipping beats"] },
    { ask: () => "How long does it last?", options: ["Seconds", "Minutes", "Over an hour"] },
  ],
};

interface State { key: string; step: number; answers: string[]; obsId: number | null; who: string; self: boolean }

/** Starts the questions for the first eligible symptom of a message. Returns the text to add to the reply. */
export function startSymptomQs(user: UserRow, p: PatientRow, keys: string[], obsIds: Map<string, number>, t: number): { text: string; quick: string[] } | null {
  if (get("SELECT 1 FROM convo_state WHERE user_id = ?", user.id)) return null;
  for (const key of keys) {
    const qs = SYMPTOM_QS[key];
    if (!qs) continue;
    const mark = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `sxq:${p.id}:${key}`);
    if (mark && t - Number(mark.value) < 12 * HOUR) continue; // asked recently
    run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", `sxq:${p.id}:${key}`, String(t));
    const self = user.role === "PATIENT";
    const who = self ? "you" : shortName(p.name);
    const st: State = { key, step: 0, answers: [], obsId: obsIds.get(key) ?? null, who, self };
    run("INSERT INTO convo_state(user_id, state, data) VALUES(?, 'symptom_q', ?)", user.id, JSON.stringify(st));
    return { text: `A quick question so the doctor has the full picture:\n${qs[0].ask(who, self)}`, quick: qs[0].options };
  }
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
function matchOption(options: string[], body: string): string | null {
  const b = norm(body);
  const n = b.match(/^([1-9])$/);
  if (n && options[Number(n[1]) - 1]) return options[Number(n[1]) - 1];
  const hit = options.find((o) => norm(o) === b) ?? options.find((o) => b.includes(norm(o))) ?? options.find((o) => norm(o).split(" ").some((w) => w.length > 3 && b.split(" ").includes(w)));
  return hit ?? null;
}

export interface SymptomTurn { handled: boolean; text?: string; quick?: string[] }

/** One reply to a symptom question. Anything that isn't an answer ends the questions and is handled as a normal message. */
export function answerSymptomQ(user: UserRow, p: PatientRow, plan: CarePlan, body: string, t: number): SymptomTurn {
  const row = get<{ data: string }>("SELECT data FROM convo_state WHERE user_id = ? AND state = 'symptom_q'", user.id);
  if (!row) return { handled: false };
  const st = JSON.parse(row.data) as State;
  const qs = SYMPTOM_QS[st.key];
  const q = qs?.[st.step];
  const notSure = /^\s*(not sure|don'?t know|no idea|can'?t say|skip)\b/i.test(body);
  const matched = q ? matchOption(q.options, body) : null;
  // Only a real answer counts. A reading, "took telmisartan" or anything else ends the questions and is handled normally.
  if (!q || (!matched && !notSure)) { run("DELETE FROM convo_state WHERE user_id = ?", user.id); return { handled: false }; }
  st.answers.push(matched ?? "Not sure");
  st.step++;
  if (st.step < qs.length) {
    run("UPDATE convo_state SET data = ? WHERE user_id = ?", JSON.stringify(st), user.id);
    return { handled: true, text: qs[st.step].ask(st.who, st.self), quick: qs[st.step].options };
  }
  run("DELETE FROM convo_state WHERE user_id = ?", user.id);

  const label = SYMPTOMS[st.key] ?? st.key;
  const summary = qs.map((qq, i) => `${qq.ask(st.who, st.self).replace(/\?$/, "")}: ${st.answers[i]}`).join(" · ");
  const obsId = run("INSERT INTO observations(patient_id, type, text, observed_at, logged_by, parser) VALUES(?,?,?,?,?,?)", p.id, "symptom_detail", JSON.stringify({ key: st.key, answers: st.answers, summary }), t, user.id, "followup").lastInsertRowid;
  audit(t, user.id, "SYMPTOM_DETAIL", "patient", p.id, { key: st.key, answers: st.answers });

  // Answers that match rules that already exist raise the same alerts they always would.
  const a = st.answers.map((x) => x.toLowerCase());
  const raise: { key: string; severity: string; text: string }[] = [];
  if (st.key === "breathlessness" && a[0] === "at rest") raise.push({ key: "breathlessness", severity: "severe", text: "breathless at rest" });
  if (st.key === "breathlessness" && a[0] === "lying flat") raise.push({ key: "orthopnea", severity: "moderate", text: "breathless lying flat" });
  if (st.key === "dizziness" && a[1] === "yes") raise.push({ key: "fainting", severity: "severe", text: "fell or nearly fainted with dizziness" });
  let reply = "Thank you, noted for the doctor. 🙏";
  const circle = getCaregivers(p.id)[0]?.name ?? "your care circle";
  for (const r of raise) {
    const alert = evaluateSymptom(p, plan, r.key, r.severity, r.text, obsId);
    if (!alert) continue;
    const id = createEscalation(p, alert, t + 500);
    reply += `\n\n${alert.type === "URGENT" ? "🚨" : "⚠️"} ${alert.title}: ${alert.advice}${id ? `\nI've let ${circle} know.` : ""}`;
  }
  return { handled: true, text: reply };
}
