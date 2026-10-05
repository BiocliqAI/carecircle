"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api, homeFor, ROLE_LABEL, useSession } from "./client";
import { fmtDateTime } from "@/lib/time";
import { GeminiSettingsModal } from "./GeminiSettingsModal";

export function TopBar() {
  const { user, personas, switchTo, clock, notifyChange, mode, clinic } = useSession();
  const path = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showGemini, setShowGemini] = useState(false);
  const clinician = user && (user.role === "DOCTOR" || user.role === "PA");

  async function onSwitch(id: string) {
    const r = await switchTo(id || null);
    const u = personas.find((p) => p.id === id) ?? null;
    router.push(homeFor(u, r?.patientIds ?? []));
    notifyChange();
  }
  async function advance(minutes: number) {
    setBusy(true);
    try {
      await api("/api/demo", { body: { action: "advance", minutes } });
      notifyChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="topbar">
      <Link href={homeFor(user, [])} className="brand">
        <span className="brand-mark">💚</span> CareCircle
        {mode === "live" && clinic && <span className="brand-clinic">{clinic.name}</span>}
      </Link>
      <nav>
        {clinician && <Link href="/doctor" className={path === "/doctor" ? "active" : ""}>Command Centre</Link>}
        {clinician && <Link href="/clinic" className={path === "/clinic" ? "active" : ""}>Clinic</Link>}
        {user && !clinician && <Link href="/home" className={path?.startsWith("/patients") || path === "/home" ? "active" : ""}>My dashboard</Link>}
        <Link href="/whatsapp" className={path === "/whatsapp" ? "active" : ""}>WhatsApp simulator</Link>
        <Link href="/" className={path === "/" ? "active" : ""}>{mode === "live" ? "Home" : "Demo guide"}</Link>
      </nav>
      <div className="spacer" />
      <button
        className="btn sm"
        style={{ marginRight: 10, display: "inline-flex", alignItems: "center", gap: 5, background: "var(--card-bg, #fff)", border: "1px solid var(--border-color, #e0e0e0)" }}
        onClick={() => setShowGemini(true)}
        title="Configure Google Gemini API Key & Vision OCR"
      >
        <span style={{ color: "#1a73e8" }}>✨</span> Gemini AI
      </button>
      {clock && (
        <div className="row" style={{ gap: 10 }}>
          <div className="clock">
            {clock.offsetMs ? "⏩ demo clock" : "clinic time"}
            <br />
            <b>{fmtDateTime(clock.now)}</b>
          </div>
          <button className="btn sm" disabled={busy} onClick={() => advance(60)} title="Fast-forward 1 hour (escalation timers, reminders)">
            +1h
          </button>
        </div>
      )}
      <div className="who">
        <select value={user?.id ?? ""} onChange={(e) => onSwitch(e.target.value)} aria-label="Switch persona">
          <option value="">— Sign in as… —</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {ROLE_LABEL[p.role]}
            </option>
          ))}
        </select>
      </div>
      <GeminiSettingsModal open={showGemini} onClose={() => setShowGemini(false)} />
    </header>
  );
}
