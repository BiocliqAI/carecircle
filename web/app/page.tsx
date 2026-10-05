"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, avatarColor, homeFor, initials, ROLE_LABEL, useSession } from "@/components/client";
import { LiveHome } from "@/components/LiveHome";

export default function Landing() {
  const { mode, loading } = useSession();
  if (loading) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  return mode === "live" ? <LiveHome /> : <DemoLanding />;
}

function DemoLanding() {
  const { personas, switchTo, notifyChange, clock } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function go(id: string) {
    const r = await switchTo(id);
    const u = personas.find((p) => p.id === id) ?? null;
    notifyChange();
    router.push(homeFor(u, r?.patientIds ?? []));
  }
  async function reset() {
    if (!confirm("Reset all demo data to the starting story? (Takes a few seconds)")) return;
    setBusy("reset");
    try {
      await api("/api/demo", { body: { action: "reset" } });
      notifyChange();
    } finally {
      setBusy(null);
    }
  }
  const group = (roles: string[]) => personas.filter((p) => roles.includes(p.role));

  return (
    <main className="page">
      <section className="hero">
        <h1 style={{ fontSize: 30 }}>CareCircle — the between-visit record, built on WhatsApp</h1>
        <p>
          Patients and their family log medicines, readings, exercises and symptoms by simply chatting on WhatsApp. If something drifts from the doctor’s
          baseline, the <b>family care circle</b> is alerted (Level 1 → 2 → 3) and asked to take it to the doctor — the doctor is never paged. At the next visit,
          the doctor opens one screen and sees exactly what changed.
        </p>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={() => go("u_dr_dileep")}>Dr. Dileep (Nephrology) →</button>
          <button className="btn" onClick={() => go("u_dr_rao")}>Dr. Meera Rao (Cardio) →</button>
          <button className="btn" onClick={() => router.push("/whatsapp")}>Open WhatsApp simulator</button>
          {clock && <span className="badge" style={{ background: "rgba(255,255,255,0.12)", color: "#e6fffb" }}>{clock.ai ? `🤖 AI parsing: ${clock.model}` : "🧩 Rule-based parsing (set GEMINI_API_KEY for Gemini)"}</span>}
        </div>
      </section>

      <div className="grid side">
        <div className="stack gap16">
          {(
            [
              ["Care team (web dashboard)", ["DOCTOR", "PA"]],
              ["Patients (WhatsApp + read-only dashboard)", ["PATIENT"]],
              ["Caregivers / care circle (WhatsApp + dashboard)", ["CAREGIVER"]],
            ] as [string, string[]][]
          ).map(([title, roles]) => (
            <div key={title} className="card">
              <div className="card-head"><h3>{title}</h3></div>
              <div className="grid g3">
                {group(roles).map((p) => (
                  <button key={p.id} className="persona" onClick={() => go(p.id)}>
                    <span className="avatar" style={{ background: avatarColor(p.name) }}>{initials(p.name)}</span>
                    <span>
                      <b>{p.name}</b>
                      <br />
                      <small>{p.role === "CAREGIVER" || p.role === "PATIENT" ? p.title : ROLE_LABEL[p.role]}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="stack gap16">
          <div className="card">
            <div className="card-head"><h3>🎬 10-minute demo script</h3></div>
            <ol className="steps">
              <li><b>Dr. Rao → Command Centre.</b> Three patients. Abdul’s low-oxygen alert is with his family at Level 2. It shows on the dashboard, but the doctor gets no message.</li>
              <li><b>Open Ramesh → Pre-visit brief.</b> 4 weeks since Visit 1: adherence, BP trend, a weight-gain episode the son took to the clinic, and knee pain that stopped his walks.</li>
              <li><b>WhatsApp simulator → Ramesh:</b> type <i>“BP 172/104, feeling dizzy”</i>. Wife Lakshmi (L1) gets the alert. Click <b>+1h</b>: it moves to son Arjun (L2). Arjun replies <i>ACK</i>, then <i>2</i>, then a note.</li>
              <li><b>Back to Ramesh → Start Visit 2.</b> Adjust the medicines and save. You’ll see the <b>Visit 1 → Visit 2 diff</b> and what happened in between.</li>
              <li><b>Sunita</b> already has two visits. Open <b>Compare visits</b> to see the full diff, and the physio adherence improving between the two periods.</li>
              <li><b>Kidney Failure (A Gopal & Durai):</b> Sign in as <b>Dr. Dileep</b>. Open A Gopal’s page: dry weight 59.2 kg (±1 kg band), Lasix 40/20 split dose, fluid restriction (1000 ml/day), and long-range kidney labs (creatinine, urea, eGFR, K). See overdue lab alert and reported Prizide dose change waiting for clinic reconciliation.</li>
              <li>Optional: <b>+ New patient</b> → record Visit 1 → <b>Simulate 14 days</b> in the WhatsApp simulator → record Visit 2 → compare.</li>
            </ol>
          </div>
          <div className="card">
            <div className="card-head"><h3>Demo controls</h3></div>
            <p className="muted" style={{ marginTop: 0 }}>The demo clock can be moved forward to show reminders and escalation timeouts. Reset restores the starting story.</p>
            <button className="btn danger" disabled={busy === "reset"} onClick={reset}>
              {busy === "reset" ? <span className="spin" /> : "↺"} Reset demo data
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
