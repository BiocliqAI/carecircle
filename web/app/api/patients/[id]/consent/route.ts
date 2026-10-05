import { now } from "@/lib/clock";
import { resendConsent } from "@/lib/records";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Resend the WhatsApp consent request to everyone still pending (or one person via userId).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !canView(user!, id)) return err("Care team only", 403);
  const body = (await req.json().catch(() => ({}))) as { userId?: string };
  return json({ sent: resendConsent(id, body.userId ?? null, now(), user!.id) });
}
