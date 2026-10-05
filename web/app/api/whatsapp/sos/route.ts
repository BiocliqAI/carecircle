import { now } from "@/lib/clock";
import { runScheduler } from "@/lib/engine";
import { raiseSos } from "@/lib/records";
import { err, json, ready } from "@/lib/server";

export const dynamic = "force-dynamic";

// WhatsApp simulator: the emergency "Call for help" button.
export async function POST(req: Request) {
  await ready();
  const { userId } = (await req.json()) as { userId?: string };
  if (!userId) return err("userId required");
  try {
    const r = raiseSos(userId, now());
    runScheduler();
    return json({ ok: true, ...r });
  } catch (e) {
    return err((e as Error).message, 400);
  }
}
