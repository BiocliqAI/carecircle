import { now } from "@/lib/clock";
import { audit } from "@/lib/db";
import { getPatient } from "@/lib/engine";
import { askRecord, getQuestion, listQuestions, saveQuestion } from "@/lib/askrecord";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// "Ask the record": a question about this one patient, answered from their own record. Care team only.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !isClinician(user) || !getPatient(id) || !canView(user, id)) return err("Care team only", 403);
  const b = (await req.json().catch(() => ({}))) as { question?: string };
  const q = (b.question ?? "").trim();
  if (q.length < 3) return err("Ask a question, for example “when did creatinine start rising?”");
  const t = now();
  audit(t, user.id, "RECORD_ASKED", "patient", id, { question: q.slice(0, 200) });
  try {
    const a = await askRecord(id, q, t);
    const qid = saveQuestion(id, user.id, q, a, t);
    return json({ ...a, id: qid, at: t, by: user.name });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}

// Questions asked about this patient and their answers (newest first), or one of them with its chart (?q=<id>).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !isClinician(user) || !getPatient(id) || !canView(user, id)) return err("Care team only", 403);
  const qid = new URL(req.url).searchParams.get("q");
  if (qid) {
    const one = getQuestion(id, Number(qid));
    return one ? json(one) : err("Not found", 404);
  }
  return json({ questions: listQuestions(id) });
}
