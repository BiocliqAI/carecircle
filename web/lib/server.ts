// Server-side helpers for route handlers: readiness (seed + lazy scheduler), session and authorization.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ensureSeeded } from "./seed";
import { getPatient, getUser, runScheduler, type UserRow } from "./engine";
import { get } from "./db";

export async function ready() {
  await ensureSeeded();
  runScheduler();
}

export async function sessionUser(): Promise<UserRow | null> {
  try {
    const c = await cookies();
    const id = c.get("cc_user")?.value;
    return id ? getUser(id) ?? null : null;
  } catch {
    return null;
  }
}

/** Server-side authorization: UI hiding is not authorization. */
export function canView(user: UserRow, pid: string): boolean {
  const p = getPatient(pid);
  if (!p) return false;
  if (user.role === "DOCTOR") return p.doctor_id === user.id;
  if (user.role === "PA") return true; // PA works for the clinic's doctor in this single-clinic demo
  if (user.role === "PATIENT") return p.user_id === user.id;
  if (user.role === "CAREGIVER") return !!get("SELECT 1 FROM caregivers WHERE patient_id = ? AND user_id = ? AND dashboard = 1", pid, user.id);
  return false;
}

export const isClinician = (u: UserRow | null) => !!u && (u.role === "DOCTOR" || u.role === "PA");

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
