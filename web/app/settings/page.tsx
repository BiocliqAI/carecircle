"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useSession } from "@/components/client";
import { EraseClinic } from "@/components/EraseClinic";
import { GeminiSettingsModal } from "@/components/GeminiSettingsModal";
import { fmtDate } from "@/lib/time";

export default function Settings() {
  const { user, loading, mode, clinic, clock, notifyChange } = useSession();
  const [details, setDetails] = useState<{ name: string; address: string; phone: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [gemini, setGemini] = useState(false);

  useEffect(() => {
    if (clinic) setDetails({ name: clinic.name, address: clinic.address, phone: clinic.phone });
  }, [clinic]);

  const clinician = user && (user.role === "DOCTOR" || user.role === "PA");
  if (!loading && !clinician) return <main className="page"><div className="alert bad">Sign in as a doctor or PA to change clinic settings. <Link href="/">Sign in</Link></div></main>;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/clinic", { body: { action: "update", clinic: details } });
      setMsg({ kind: "good", text: "Clinic details saved." });
      notifyChange();
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <h1>Clinic settings</h1>
          <div className="muted">{mode === "live" ? (clinic ? `Live clinic · set up ${fmtDate(clinic.setupAt)}` : "Live clinic") : "Sample demo data"}</div>
        </div>
      </div>
      {msg && <div className={`alert ${msg.kind}`} style={{ marginBottom: 14 }}>{msg.text}</div>}
      <div className="stack gap16">
        {details && (
          <section className="card">
            <div className="card-head"><h3>Clinic details</h3><small>Shown in WhatsApp messages to patients and families</small></div>
            <div className="grid g2">
              <label className="f">Clinic name<input value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} /></label>
              <label className="f">Front-desk phone<input value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} /></label>
              <label className="f" style={{ gridColumn: "1 / -1" }}>Address<textarea value={details.address} onChange={(e) => setDetails({ ...details, address: e.target.value })} style={{ minHeight: 50 }} /></label>
            </div>
            <div style={{ marginTop: 12 }}><button className="btn primary" disabled={busy} onClick={save}>Save details</button></div>
          </section>
        )}

        <section className="card">
          <div className="card-head"><h3>AI assistance (Google Gemini)</h3><span className={`badge ${clock?.ai ? "good" : ""}`}>{clock?.ai ? `On · ${clock.model}` : "Off · rule-based parsing"}</span></div>
          <p className="muted" style={{ marginTop: 0 }}>Gemini reads free-text WhatsApp messages, drafts the pre-visit brief and extracts values from photos of prescriptions and lab reports. Rules, not AI, decide every alert. On a hosted deployment, prefer the <code>GEMINI_API_KEY</code> environment variable.</p>
          <button className="btn" onClick={() => setGemini(true)}>✨ Configure Gemini</button>
        </section>

        <section className="card danger-zone">
          <div className="card-head"><h3>{mode === "live" ? "Start afresh" : "Demo data"}</h3></div>
          <EraseClinic />
        </section>
      </div>
      <GeminiSettingsModal open={gemini} onClose={() => setGemini(false)} />
    </main>
  );
}
