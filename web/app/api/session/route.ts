import { cookies } from "next/headers";
import { all } from "@/lib/db";
import { patientIdsForUser, getUser } from "@/lib/engine";
import { err, json, ready, sessionUser } from "@/lib/server";
import { getClinic } from "@/lib/clinic";
import { MODE } from "@/lib/mode";

export const dynamic = "force-dynamic";

export async function GET() {
  await ready();
  const user = await sessionUser();
  const personas = all<{ id: string; name: string; role: string; title: string; phone: string }>(
    "SELECT id, name, role, title, phone FROM users ORDER BY CASE role WHEN 'DOCTOR' THEN 0 WHEN 'PA' THEN 1 WHEN 'PATIENT' THEN 2 ELSE 3 END, name",
  );
  return json({ user, patientIds: user ? patientIdsForUser(user) : [], personas, mode: MODE, clinic: getClinic() });
}

export async function POST(req: Request) {
  await ready();
  const { userId } = (await req.json()) as { userId?: string };
  const c = await cookies();
  if (!userId) {
    c.delete("cc_user");
    return json({ ok: true });
  }
  const user = getUser(userId);
  if (!user) return err("Unknown user", 404);
  c.set("cc_user", user.id, { httpOnly: true, sameSite: "lax", path: "/" });
  return json({ user, patientIds: patientIdsForUser(user) });
}
