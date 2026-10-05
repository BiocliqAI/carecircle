import { cookies } from "next/headers";
import { now } from "@/lib/clock";
import { addStaff, checklist, getClinic, listStaff, removeStaff, resetClinic, setupClinic, updateClinic, updateStaff, type StaffInput } from "@/lib/clinic";
import { getUser } from "@/lib/engine";
import { LIVE, MODE } from "@/lib/mode";
import { err, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  await ready();
  return json({ mode: MODE, clinic: getClinic(), staff: listStaff(), checklist: checklist() });
}

// Clinic administration.
//  - Admin: create/edit the clinic, add/edit/remove doctors and assistants.
//  - Doctor: add/edit/remove assistants (PAs).
//  - Reset: anyone who can reach the site, guarded by typing the clinic name (and APP_PASSWORD when hosted).
export async function POST(req: Request) {
  await ready();
  const body = (await req.json()) as {
    action: "setup" | "update" | "addStaff" | "updateStaff" | "removeStaff" | "reset";
    clinic?: { name: string; address: string; phone: string };
    doctor?: Omit<StaffInput, "role"> | null;
    staff?: StaffInput;
    id?: string;
    confirm?: string;
  };
  const t = now();
  try {
    if (body.action === "reset") {
      if (!LIVE) return err("Reset clinic is only available in live mode");
      const clinic = getClinic();
      if (!clinic || body.confirm?.trim() !== clinic.name) return err("Type the clinic name exactly to confirm");
      resetClinic();
      (await cookies()).delete("cc_user");
      return json({ ok: true });
    }

    const user = await sessionUser();
    const isAdmin = user?.role === "ADMIN";
    const isDoctor = user?.role === "DOCTOR";

    if (body.action === "setup") {
      if (!LIVE) return err("Clinic setup is only available in live mode");
      if (!isAdmin) return err("Only the clinic admin can set up the clinic", 403);
      if (!body.clinic) return err("Clinic details are required");
      return json({ ok: true, doctorId: setupClinic(body.clinic, body.doctor ?? null, t, user!.id) });
    }
    if (body.action === "update") {
      if (!isAdmin) return err("Only the clinic admin can edit the clinic", 403);
      updateClinic(body.clinic ?? {}, t, user!.id);
      return json({ ok: true });
    }

    // Staff management: admin for anyone, doctors for assistants only.
    const targetRole = body.action === "addStaff" ? body.staff?.role : body.id ? getUser(body.id)?.role : undefined;
    if (!isAdmin && !(isDoctor && targetRole === "PA")) return err(isDoctor ? "Doctors can manage assistants only. Ask the clinic admin to add doctors." : "Only the clinic admin or a doctor can manage staff", 403);
    if (body.action === "addStaff") {
      if (!body.staff) return err("Staff details are required");
      return json({ ok: true, id: addStaff(body.staff, t, user!.id) });
    }
    if (body.action === "updateStaff") {
      if (!body.id || !body.staff) return err("Staff id and details are required");
      updateStaff(body.id, body.staff, t, user!.id);
      return json({ ok: true });
    }
    if (body.action === "removeStaff") {
      if (!body.id) return err("Staff id is required");
      if (body.id === user!.id) return err("You can't remove yourself");
      removeStaff(body.id, t, user!.id);
      return json({ ok: true });
    }
    return err("Unknown action");
  } catch (e) {
    return err((e as Error).message, 409);
  }
}
