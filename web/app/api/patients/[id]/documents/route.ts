import { now } from "@/lib/clock";
import { addDocument, deleteDocument, listDocuments, updateDocument } from "@/lib/records";
import { get } from "@/lib/db";
import { canView, err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || !canView(user, id)) return err("No access", 403);
  return json({ documents: listDocuments(id) });
}

// Upload / edit / delete documents. Doctor / PA on the care team.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!user || (user.role !== "DOCTOR" && user.role !== "PA") || !canView(user, id)) return err("Only the care team can manage documents", 403);
  const body = (await req.json()) as { action: "add" | "update" | "delete"; id?: number; title?: string; category?: string; notes?: string; mime?: string; base64?: string };
  const t = now();
  try {
    if (body.action === "add") {
      if (!body.base64) return err("Choose a file to upload");
      return json({ id: addDocument(id, { title: body.title ?? "Document", category: body.category ?? "other", mime: body.mime ?? "application/octet-stream", base64: body.base64, notes: body.notes }, t, user.id) });
    }
    if (!body.id || !get("SELECT 1 FROM patient_documents WHERE id = ? AND patient_id = ?", body.id, id)) return err("Document not found", 404);
    if (body.action === "update") updateDocument(body.id, { title: body.title, category: body.category, notes: body.notes }, t, user.id);
    else if (body.action === "delete") deleteDocument(body.id, t, user.id);
    else return err("Unknown action");
    return json({ ok: true });
  } catch (e) {
    return err((e as Error).message, 409);
  }
}
