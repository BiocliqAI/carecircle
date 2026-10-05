import { cookies } from "next/headers";
import { now } from "@/lib/clock";
import { addStaff, checklist, getClinic, listStaff, resetClinic, setupClinic, updateClinic, type StaffInput } from "@/lib/clinic";
import { LIVE, MODE } from "@/lib/mode";
import { err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  await ready();
  return json({ mode: MODE, clinic: getClinic(), staff: listStaff(), checklist: checklist() });
}

// Clinic administration. With the persona switcher there is no admin role: any clinician may manage
// staff, and the first-run setup is open until a clinic exists.
export async function POST(req: Request) {
  await ready();
  const body = (await req.json()) as {
    action: "setup" | "update" | "addStaff" | "reset";
    clinic?: { name: string; address: string; phone: string };
    doctor?: Omit<StaffInput, "role">;
    staff?: StaffInput;
    confirm?: string;
  };
  const t = now();
  try {
    if (body.action === "setup") {
      if (!LIVE) return err("Clinic setup is only available in live mode (npm run clinic)");
      if (!body.clinic || !body.doctor) return err("Clinic and first doctor are required");
      const id = setupClinic(body.clinic, body.doctor, t);
      (await cookies()).set("cc_user", id, { httpOnly: true, sameSite: "lax", path: "/" });
      return json({ ok: true, userId: id });
    }
    if (body.action === "reset") {
      // Allowed from the home page without a persona: the typed clinic name is the safeguard
      // (and APP_PASSWORD gates the whole site when hosted).
      if (!LIVE) return err("Reset clinic is only available in live mode");
      const clinic = getClinic();
      if (!clinic || body.confirm?.trim() !== clinic.name) return err("Type the clinic name exactly to confirm");
      resetClinic();
      (await cookies()).delete("cc_user");
      return json({ ok: true });
    }
    const user = await sessionUser();
    if (!isClinician(user)) return err("Sign in as a doctor or PA to manage the clinic", 403);
    if (body.action === "update") {
      updateClinic(body.clinic ?? {}, t, user!.id);
      return json({ ok: true });
    }
    if (body.action === "addStaff") {
      if (!body.staff) return err("Staff details are required");
      return json({ ok: true, id: addStaff(body.staff, t, user!.id) });
    }
    return err("Unknown action");
  } catch (e) {
    return err((e as Error).message, 409);
  }
}
