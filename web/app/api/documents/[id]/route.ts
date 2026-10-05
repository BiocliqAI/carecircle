import { getDocumentFile } from "@/lib/records";
import { canView, err, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Streams a stored document (inline for viewing; ?download=1 to save).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const doc = getDocumentFile(Number(id));
  if (!doc) return err("Not found", 404);
  const user = await sessionUser();
  if (!user || !canView(user, doc.patient_id)) return err("No access", 403);
  // Only render types that can't run script; everything else is forced to download as opaque bytes.
  const viewable = /^(image\/(png|jpe?g|gif|webp|heic)|application\/pdf|audio\/[\w.+-]+)$/i.test(doc.mime);
  const download = !viewable || new URL(req.url).searchParams.get("download") === "1";
  const safe = doc.title.replace(/[^\w .-]+/g, "_");
  return new Response(new Uint8Array(doc.data), {
    headers: {
      "Content-Type": viewable ? doc.mime : "application/octet-stream",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safe}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
