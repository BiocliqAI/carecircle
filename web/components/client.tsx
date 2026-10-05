"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export async function api<T = unknown>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(path, {
    method: opts?.method || (opts?.body ? "POST" : "GET"),
    headers: opts?.body ? { "Content-Type": "application/json" } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `Request failed (${r.status})`);
  return data as T;
}

export interface SessionUser {
  id: string;
  name: string;
  role: "DOCTOR" | "PA" | "PATIENT" | "CAREGIVER";
  title: string;
  phone: string;
}

export interface ClinicInfo {
  name: string;
  address: string;
  phone: string;
  setupAt: number;
}

interface SessionCtx {
  user: SessionUser | null;
  mode: "demo" | "live";
  clinic: ClinicInfo | null;
  personas: SessionUser[];
  patientIds: string[];
  loading: boolean;
  switchTo: (id: string | null) => Promise<{ patientIds: string[] } | null>;
  refresh: () => Promise<void>;
  clock: { now: number; offsetMs: number; ai: boolean; model: string | null } | null;
  refreshClock: () => Promise<void>;
  bump: number; // increments when demo state changes so pages can reload
  notifyChange: () => void;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [personas, setPersonas] = useState<SessionUser[]>([]);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [clinic, setClinic] = useState<ClinicInfo | null>(null);
  const [patientIds, setPatientIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState<SessionCtx["clock"]>(null);
  const [bump, setBump] = useState(0);

  const refresh = useCallback(async () => {
    const s = await api<{ user: SessionUser | null; personas: SessionUser[]; patientIds: string[]; mode: "demo" | "live"; clinic: ClinicInfo | null }>("/api/session");
    setUser(s.user);
    setMode(s.mode);
    setClinic(s.clinic);
    setPersonas(s.personas);
    setPatientIds(s.patientIds);
    setLoading(false);
  }, []);
  const refreshClock = useCallback(async () => {
    setClock(await api("/api/demo"));
  }, []);
  useEffect(() => {
    refresh().catch(() => setLoading(false));
    refreshClock().catch(() => undefined);
    const i = setInterval(() => refreshClock().catch(() => undefined), 30_000);
    return () => clearInterval(i);
  }, [refresh, refreshClock]);

  const switchTo = useCallback(async (id: string | null) => {
    const r = await api<{ user?: SessionUser; patientIds?: string[] }>("/api/session", { body: { userId: id } });
    setUser(r.user ?? null);
    setPatientIds(r.patientIds ?? []);
    return r.patientIds ? { patientIds: r.patientIds } : null;
  }, []);

  const notifyChange = useCallback(() => {
    setBump((b) => b + 1);
    refreshClock().catch(() => undefined);
    refresh().catch(() => undefined); // personas / clinic change when staff or patients are onboarded
  }, [refreshClock, refresh]);

  return <Ctx.Provider value={{ user, mode, clinic, personas, patientIds, loading, switchTo, refresh, clock, refreshClock, bump, notifyChange }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("SessionProvider missing");
  return c;
}

export function homeFor(user: SessionUser | null, patientIds: string[]): string {
  if (!user) return "/";
  if (user.role === "DOCTOR" || user.role === "PA") return "/doctor";
  return patientIds.length === 1 ? `/patients/${patientIds[0]}` : "/home";
}

const COLORS = ["#0f766e", "#7c3aed", "#db2777", "#ea580c", "#2563eb", "#059669", "#9333ea", "#0891b2", "#c2410c"];
export function avatarColor(s: string): string {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
export const initials = (n: string) => n.replace(/^Dr\.?\s+/, "").split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase();
export const ROLE_LABEL: Record<string, string> = { DOCTOR: "Doctor", PA: "Physician Assistant", PATIENT: "Patient", CAREGIVER: "Caregiver" };
