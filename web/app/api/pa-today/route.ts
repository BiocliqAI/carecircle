import { now } from "@/lib/clock";
import { paToday } from "@/lib/patasks";
import { err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  await ready();
  const user = await sessionUser();
  if (!isClinician(user)) return err("Care team only", 403);
  return json(paToday(now(), user!.id));
}
