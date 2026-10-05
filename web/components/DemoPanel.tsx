"use client";
// Presenter tools in one place: switch persona, move the clock, simulate days, open the WhatsApp
// simulator, configure Gemini and reset data. Kept out of the clinic's own screens.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, avatarColor, homeFor, initials, ROLE_LABEL, useSession } from "./client";
import { EraseClinic } from "./EraseClinic";
import { GeminiSettingsModal } from "./GeminiSettingsModal";
import { fmtDateTime } from "@/lib/time";

export function DemoPanel({ open, onClose, onHide }: { open: boolean; onClose: () => void; onHide: () => void }) {
  const { user, personas, switchTo, notifyChange, clock, mode } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [gemini, setGemini] = useState(false);

  async function viewAs(id: string | null) {
    const r = await switchTo(id).catch(() => null);
    const u = personas.find((p) => p.id === id) ?? null;
    notifyChange();
    onClose();
    router.push(id ? homeFor(u, r?.patientIds ?? []) : "/");
  }
  async function demo(key: string, body: unknown) {
    setBusy(key);
    try {
      await api("/api/demo", { body });
      notifyChange();
    } finally {
      setBusy(null);
    }
  }

  const groups: [string, string[]][] = [
    ["Care team", ["DOCTOR", "PA"]],
    ["Patients", ["PATIENT"]],
    ["Caregivers", ["CAREGIVER"]],
  ];

  return (
    <>
      {open && <div className="drawer-scrim" onClick={onClose} />}
      <aside className={`drawer ${open ? "open" : ""}`} inert={!open} aria-label="Demo tools">
        <div className="drawer-head">
          <div>
            <h3>Demo tools</h3>
            <small>Presenter controls · Shift+D</small>
          </div>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close demo tools">✕</button>
        </div>

        <section>
          <h4>View as</h4>
          {personas.length === 0 && <small className="muted">No one yet. Set up the clinic first.</small>}
          {groups.map(([label, roles]) => {
            const ps = personas.filter((p) => roles.includes(p.role));
            if (!ps.length) return null;
            return (
              <div key={label} className="drawer-group">
                <small className="muted">{label}</small>
                {ps.map((p) => (
                  <button key={p.id} className={`drawer-persona ${user?.id === p.id ? "on" : ""}`} onClick={() => viewAs(p.id)}>
                    <span className="avatar" style={{ background: avatarColor(p.name), width: 26, height: 26, fontSize: 10 }}>{initials(p.name)}</span>
                    <span><b>{p.name}</b><small>{p.role === "CAREGIVER" || p.role === "PATIENT" ? p.title : ROLE_LABEL[p.role]}</small></span>
                  </button>
                ))}
              </div>
            );
          })}
          {user && <button className="btn sm" style={{ marginTop: 6 }} onClick={() => viewAs(null)}>Sign out</button>}
        </section>

        <section>
          <h4>WhatsApp</h4>
          <Link className="btn" href="/whatsapp" onClick={onClose}>💬 Open WhatsApp simulator</Link>
          <small className="muted" style={{ display: "block", marginTop: 6 }}>Patients and caregivers reply here as if on their own phones.</small>
        </section>

        <section>
          <h4>Clock</h4>
          <div className="muted" style={{ marginBottom: 6 }}>{clock ? <>{clock.offsetMs ? "⏩ Demo clock" : "Clinic time"}: <b>{fmtDateTime(clock.now)}</b></> : "—"}</div>
          <div className="row" style={{ gap: 6 }}>
            {[[15, "+15 min"], [60, "+1 h"], [360, "+6 h"]].map(([m, l]) => (
              <button key={m} className="btn sm" disabled={!!busy} onClick={() => demo(`adv${m}`, { action: "advance", minutes: m })}>{busy === `adv${m}` ? <span className="spin" /> : l}</button>
            ))}
            <button className="btn sm" disabled={!!busy} onClick={() => demo("sim", { action: "simulate", days: 7 })} title="Realistic WhatsApp replies for every patient">{busy === "sim" ? <span className="spin" /> : "Simulate 7 days"}</button>
          </div>
          <small className="muted" style={{ display: "block", marginTop: 6 }}>Fires reminders and escalation timeouts, e.g. Level 1 → Level 2.</small>
        </section>

        <section>
          <h4>AI</h4>
          <div className="row between">
            <small>{clock?.ai ? `Gemini on · ${clock.model}` : "Rule-based parsing"}</small>
            <button className="btn sm" onClick={() => setGemini(true)}>✨ Gemini key</button>
          </div>
        </section>

        <section>
          <h4>{mode === "live" ? "Start afresh" : "Demo data"}</h4>
          <EraseClinic compact />
          {mode === "demo" && <Link href="/" onClick={onClose} style={{ display: "block", marginTop: 8 }}>Demo guide →</Link>}
        </section>

        <div className="drawer-foot">
          <button className="btn sm ghost" onClick={onHide}>Hide the Demo button</button>
          <small className="muted">Press Shift+D to bring it back.</small>
        </div>
      </aside>
      <GeminiSettingsModal open={gemini} onClose={() => setGemini(false)} />
    </>
  );
}
