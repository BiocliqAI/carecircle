import { getUser } from "@/lib/engine";
import { receiveMedia, type MediaIn } from "@/lib/inbox";
import { err, json, ready } from "@/lib/server";

export const dynamic = "force-dynamic";

// WhatsApp simulator: a patient or caregiver sends a document or a voice note (see lib/inbox.ts).
export async function POST(req: Request) {
  await ready();
  const b = (await req.json()) as Partial<MediaIn> & { userId?: string };
  const user = b.userId ? getUser(b.userId) : undefined;
  if (!user || (user.role !== "PATIENT" && user.role !== "CAREGIVER")) return err("Unknown WhatsApp user", 404);
  if (!b.base64) return err("Nothing to send");
  try {
    return json(await receiveMedia(user, { ...b, base64: b.base64 }));
  } catch (e) {
    return err((e as Error).message, 400);
  }
}
