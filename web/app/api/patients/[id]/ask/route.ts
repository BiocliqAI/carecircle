import { now } from "@/lib/clock";
import { audit } from "@/lib/db";
import { getPatient } from "@/lib/engine";
import { askRecord } from "@/lib/askrecord";
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
    return json(await askRecord(id, q, t));
  } catch (e) {
    return err((e as Error).message, 500);
  }
}
