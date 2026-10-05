"use client";
// Clinic admin: create / edit the clinic and manage doctors and assistants. No patient data here.
import { useEffect, useState } from "react";
import { api, useSession } from "@/components/client";
import { EraseClinic } from "@/components/EraseClinic";
import { GeminiSettingsModal } from "@/components/GeminiSettingsModal";
import { StaffManager } from "@/components/StaffManager";
import { fmtDate } from "@/lib/time";

export default function Admin() {
  const { user, loading, clinic, clock, refresh, notifyChange } = useSession();
  const [f, setF] = useState({ name: "", address: "", phone: "+91 " });
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [gemini, setGemini] = useState(false);

  useEffect(() => {
    if (clinic) setF({ name: clinic.name, address: clinic.address, phone: clinic.phone });
  }, [clinic]);

  if (loading) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  if (user?.role !== "ADMIN") return <main className="page"><div className="alert bad">This page is for the clinic admin.</div></main>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/clinic", { body: clinic ? { action: "update", clinic: f } : { action: "setup", clinic: f } });
      setMsg({ kind: "good", text: clinic ? "Clinic details saved." : "Clinic created. Now add its doctors and assistants." });
      await refresh();
      notifyChange();
    } catch (x) {
      setMsg({ kind: "bad", text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div>
          <h1>{clinic ? clinic.name : "Set up your clinic"}</h1>
          <div className="muted">{clinic ? `Clinic admin · set up ${fmtDate(clinic.setupAt)}` : "Create the clinic, then add its doctors and assistants."}</div>
        </div>
      </div>
      {msg && <div className={`alert ${msg.kind}`} style={{ marginBottom: 14 }}>{msg.text}</div>}
      <div className="stack gap16">
        <form className="card" onSubmit={save}>
          <div className="card-head"><h3>{clinic ? "Clinic details" : "1 · Clinic"}</h3><small>Shown in WhatsApp messages to patients and families</small></div>
          <div className="grid g3">
            <label className="f">Clinic name *<input required autoFocus={!clinic} value={f.name} placeholder="e.g. Sunrise Heart & Kidney Clinic" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="f">Area / address<input value={f.address} placeholder="Jayanagar, Bengaluru" onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
            <label className="f">Front-desk phone<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          </div>
          <div style={{ marginTop: 12 }}><button className="btn primary" disabled={busy}>{busy ? <span className="spin" /> : null} {clinic ? "Save details" : "Create clinic →"}</button></div>
        </form>

        {clinic && <StaffManager roles={["DOCTOR", "PA"]} />}

        {clinic && (
          <div className="grid g2">
            <section className="card">
              <div className="card-head"><h3>AI assistance</h3><span className={`badge ${clock?.ai ? "good" : ""}`}>{clock?.ai ? `On · ${clock.model}` : "Off · rule-based"}</span></div>
              <p className="muted" style={{ marginTop: 0 }}>Gemini reads free-text WhatsApp messages and voice notes, drafts the pre-visit brief and reads photos of prescriptions and lab reports. Rules, not AI, decide every alert.</p>
              <button className="btn" onClick={() => setGemini(true)}>✨ Configure Gemini</button>
            </section>
            <section className="card danger-zone">
              <div className="card-head"><h3>Start afresh</h3></div>
              <EraseClinic />
            </section>
          </div>
        )}
      </div>
      <GeminiSettingsModal open={gemini} onClose={() => setGemini(false)} />
    </main>
  );
}
