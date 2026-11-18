import { now } from "@/lib/clock";
import { addDocument, deleteDocument, listDocuments, updateDocument, verifyDocument } from "@/lib/records";
import { autoFile, extractDocument, type DocVisit } from "@/lib/docauto";
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
  const body = (await req.json()) as { action: "add" | "update" | "delete" | "autofile" | "verify" | "reread"; id?: number; labs?: { marker: string; value: number; date?: string | null }[]; visits?: DocVisit[]; texts?: { test: string; group?: string; result: string; reference?: string }[]; date?: string | null; reject?: boolean; skipReadings?: boolean; withData?: boolean; title?: string; category?: string; notes?: string; mime?: string; base64?: string };
  const t = now();
  try {
    if (body.action === "add") {
      if (!body.base64) return err("Choose a file to upload");
      const docId = addDocument(id, { title: body.title ?? "Document", category: body.category ?? "other", mime: body.mime ?? "application/octet-stream", base64: body.base64, notes: body.notes }, t, user.id);
      void extractDocument(docId); // read in the background; the checker confirms the reading before anything is entered
      return json({ id: docId });
    }
    if (!body.id || !get("SELECT 1 FROM patient_documents WHERE id = ? AND patient_id = ?", body.id, id)) return err("Document not found", 404);
    if (body.action === "autofile") return json({ ok: true, ...autoFile(body.id, user.id, t, { labs: body.labs, visits: body.visits, texts: body.texts, date: body.date, reject: body.reject, skipReadings: body.skipReadings }) });
    if (body.action === "reread") {
      if (!(await extractDocument(body.id, { reread: true }))) return err("Couldn't read the document this time. Check that AI is switched on, or enter the values by hand.", 422);
      return json({ ok: true });
    }
    if (body.action === "verify") verifyDocument(body.id, t, user.id);
    else if (body.action === "update") updateDocument(body.id, { title: body.title, category: body.category, notes: body.notes }, t, user.id);
    else if (body.action === "delete") return json({ ok: true, ...deleteDocument(body.id, t, user.id, body.withData === true) });
    else return err("Unknown action");
    return json({ ok: true });
  } catch (e) {
    return err((e as Error).message, 409);
  }
}
