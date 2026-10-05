import { now } from "@/lib/clock";
import { deleteDraft, getDraft, listDrafts, saveDraft } from "@/lib/clinic";
import { audit } from "@/lib/db";
import { err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Onboarding drafts are shared across the clinic's doctors and PAs (single-clinic MVP).
export async function GET(req: Request) {
  await ready();
  const user = await sessionUser();
  if (!isClinician(user)) return err("Doctor / PA only", 403);
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const d = getDraft(id);
    return d ? json({ draft: d }) : err("This draft no longer exists (it may have been completed or discarded)", 404);
  }
  return json({ drafts: listDrafts() });
}

export async function POST(req: Request) {
  await ready();
  const user = await sessionUser();
  if (!isClinician(user)) return err("Doctor / PA only", 403);
  const body = (await req.json()) as { action?: "save" | "discard"; id?: string | null; step?: number; data?: unknown };
  const t = now();
  try {
    if (body.action === "discard") {
      if (!body.id) return err("Draft id is required");
      deleteDraft(body.id);
      audit(t, user!.id, "ONBOARDING_DRAFT_DISCARDED", "draft", body.id);
      return json({ ok: true });
    }
    return json({ id: saveDraft(body.id ?? null, body.step ?? 0, body.data, t, user!.id), savedAt: t });
  } catch (e) {
    return err((e as Error).message);
  }
}
