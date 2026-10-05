"use client";
// The patient's or caregiver's own page: their WhatsApp phone beside their record.
import { useEffect, useState } from "react";
import { useSession } from "@/components/client";
import { PatientView } from "@/components/PatientView";
import { Phone } from "@/components/WhatsAppPhone";
import { shortName } from "@/lib/types";

export default function Me() {
  const { user, patientIds, loading, bump, notifyChange } = useSession();
  const [pid, setPid] = useState<string | null>(null);
  useEffect(() => {
    if (patientIds.length && (!pid || !patientIds.includes(pid))) setPid(patientIds[0]);
  }, [patientIds, pid]);

  if (loading) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  if (!user || (user.role !== "PATIENT" && user.role !== "CAREGIVER")) return <main className="page"><div className="alert bad">This page is for patients and caregivers.</div></main>;

  return (
    <main className="page me-page">
      <div className="me-grid">
        <aside className="me-phone">
          <div className="me-hint">
            <b>{user.role === "PATIENT" ? "Your WhatsApp" : `${shortName(user.name)}’s WhatsApp`}</b>
            <small>{user.role === "PATIENT" ? "Send readings in your own words, tap the buttons, attach reports, record a voice note, or press 🆘 in an emergency." : "Alerts about your family member arrive here. Reply ACK to take ownership, or Miss to pass it on (demo)."}</small>
          </div>
          <Phone userId={user.id} role={user.role} slotLabel={user.role === "PATIENT" ? "👤 Patient" : "👪 Caregiver"} tagColor={user.role === "PATIENT" ? "#0f766e" : "#4d7c0f"} contact={{ id: user.id, name: user.name, role: user.role, title: user.title, phone: user.phone, last_at: null, last_body: null, n: 0, peer_user_id: null }} bump={bump} onSent={notifyChange} />
        </aside>
        <section className="me-record">
          {patientIds.length > 1 && (
            <div className="row" style={{ marginBottom: 10, gap: 6 }}>
              <small className="muted">Viewing:</small>
              {patientIds.map((id) => <button key={id} className={`chip-btn ${id === pid ? "on" : ""}`} onClick={() => setPid(id)}>{id.replace(/^p_/, "").split("_")[0]}</button>)}
            </div>
          )}
          {pid ? <PatientView id={pid} embedded /> : <div className="card muted">You’re not linked to a patient’s dashboard yet. The clinic can turn on dashboard access for you.</div>}
        </section>
      </div>
    </main>
  );
}
