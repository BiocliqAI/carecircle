"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api, avatarColor, initials, useSession } from "@/components/client";
import { Phone, type Contact } from "@/components/WhatsAppPhone";
import { fmtDate, fmtTime } from "@/lib/time";



const DEFAULT_PEERS: Record<string, string> = {
  u_gopal: "u_mom",
  u_mom: "u_gopal",
  u_durai: "u_gopal",
  u_ramesh: "u_lakshmi",
  u_lakshmi: "u_ramesh",
  u_arjun: "u_ramesh",
  u_kavya: "u_ramesh",
  u_abdul: "u_imran",
  u_imran: "u_abdul",
  u_farah: "u_abdul",
  u_joseph: "u_abdul",
  u_sunita: "u_neha",
  u_neha: "u_sunita",
  u_vikram: "u_sunita",
};

const DEFAULT_L2_PEERS: Record<string, string> = {
  u_gopal: "u_durai",
  u_mom: "u_durai",
  u_durai: "u_mom",
  u_ramesh: "u_arjun",
  u_lakshmi: "u_arjun",
  u_arjun: "u_lakshmi",
  u_kavya: "u_arjun",
  u_abdul: "u_farah",
  u_imran: "u_farah",
  u_farah: "u_imran",
  u_joseph: "u_farah",
  u_sunita: "u_vikram",
  u_neha: "u_vikram",
  u_vikram: "u_neha",
};

export default function WhatsAppPage() {
  return (
    <Suspense fallback={<main className="page"><div className="empty"><span className="spin" /></div></main>}>
      <Simulator />
    </Suspense>
  );
}

function Simulator() {
  const sp = useSearchParams();
  const router = useRouter();
  const { bump, notifyChange, clock } = useSession();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const rawU1 = sp.get("u");
  const rawU2 = sp.get("u2");
  const rawU3 = sp.get("u3");
  const u1 = rawU1 || "u_gopal";
  const u2 = rawU2 !== null ? rawU2 : (DEFAULT_PEERS[u1] ?? "u_mom");
  const u3 = rawU3 !== null ? rawU3 : (DEFAULT_L2_PEERS[u1] ?? "u_durai");

  const loadContacts = useCallback(() => api<{ contacts: Contact[] }>("/api/whatsapp").then((r) => setContacts(r.contacts)).catch(() => undefined), []);
  useEffect(() => {
    loadContacts();
    const i = setInterval(loadContacts, 5000);
    return () => clearInterval(i);
  }, [loadContacts, bump]);

  const setParams = (a: string, b: string, c?: string) => {
    const q = new URLSearchParams();
    if (a) q.set("u", a);
    if (b !== undefined) q.set("u2", b);
    if (c !== undefined) q.set("u3", c);
    router.replace(`/whatsapp?${q.toString()}`);
  };

  const pick = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey) {
      setParams(u1, id, u3);
    } else if (e.altKey || e.metaKey) {
      setParams(u1, u2, id);
    } else {
      const target = contacts.find((c) => c.id === id);
      if (target?.role === "PATIENT") {
        const p1 = target.peer_user_id ?? DEFAULT_PEERS[id] ?? "";
        const p2 = target.peer2_user_id ?? DEFAULT_L2_PEERS[id] ?? "";
        setParams(id, p1, p2);
      } else {
        const patId = target?.peer_user_id ?? DEFAULT_PEERS[id] ?? "";
        const otherCg = target?.peer2_user_id ?? DEFAULT_L2_PEERS[id] ?? "";
        if (target?.caregiver_level === 2) {
          setParams(patId, otherCg, id);
        } else {
          setParams(patId, id, otherCg);
        }
      }
    }
  };

  async function demo(body: Record<string, unknown>, label: string) {
    setBusy(label);
    try {
      await api("/api/demo", { body });
      notifyChange();
      loadContacts();
      setToast(label === "reset" ? "Demo data reset" : `Done: ${label}`);
      setTimeout(() => setToast(null), 2500);
    } finally {
      setBusy(null);
    }
  }

  const byRole = (r: string) => contacts.filter((c) => c.role === r);
  const isSelected = (id: string) => id === u1 || id === u2 || id === u3;
  const slotBadge = (id: string) => {
    if (id === u1) return <span style={{ fontSize: 9.5, background: "#0f766e", color: "#fff", padding: "1px 5px", borderRadius: 4, fontWeight: 700 }}>Slot 1 · Patient</span>;
    if (id === u2) return <span style={{ fontSize: 9.5, background: "#0369a1", color: "#fff", padding: "1px 5px", borderRadius: 4, fontWeight: 700 }}>Slot 2 · L1</span>;
    if (id === u3) return <span style={{ fontSize: 9.5, background: "#b45309", color: "#fff", padding: "1px 5px", borderRadius: 4, fontWeight: 700 }}>Slot 3 · L2</span>;
    return null;
  };

  const patientContact = contacts.find((c) => c.id === u1);
  const l1Contact = contacts.find((c) => c.id === u2);
  const l2Contact = contacts.find((c) => c.id === u3);

  return (
    <main className="page" style={{ maxWidth: 1680 }}>
      <div className="page-head row between">
        <div>
          <div className="row" style={{ gap: 10, alignItems: "center" }}>
            <h1>WhatsApp simulator</h1>
            <span style={{ fontSize: 12, background: "var(--brand-soft)", color: "var(--brand)", padding: "3px 10px", borderRadius: 999, fontWeight: 700 }}>
              Live 3-Tier Escalation
            </span>
          </div>
          <div className="muted" style={{ maxWidth: 880 }}>
            Live WhatsApp threads across the entire CareCircle: <b>Patient</b>, <b>Level 1 Caregiver</b>, and <b>Level 2 Escalation Caregiver</b> side by side.
            Type readings or trigger deviations on the patient’s phone to watch alerts route to Level 1 and escalate to Level 2 in real time.
          </div>
        </div>
        <div className="card tight demo-bar">
          <small><b>Demo clock</b> {clock ? `${fmtDate(clock.now, { weekday: "short", day: "numeric", month: "short" })} ${fmtTime(clock.now)}` : ""}</small>
          {[15, 60, 360].map((m) => (
            <button key={m} className="btn sm" disabled={!!busy} onClick={() => demo({ action: "advance", minutes: m }, `+${m < 60 ? m + "m" : m / 60 + "h"}`)}>
              {busy === `+${m < 60 ? m + "m" : m / 60 + "h"}` ? <span className="spin" /> : `+${m < 60 ? m + " min" : m / 60 + " h"}`}
            </button>
          ))}
          <button className="btn sm" disabled={!!busy} onClick={() => demo({ action: "simulate", days: 7 }, "simulate 7 days")} title="Generates a week of realistic patient replies for all patients">
            {busy === "simulate 7 days" ? <span className="spin" /> : "⏩ Simulate 7 days"}
          </button>
          <div className="row" style={{ gap: 4, marginLeft: 4 }}>
            <button
              className={`btn sm ${u3 ? "primary" : ""}`}
              disabled={!!busy}
              onClick={() => {
                const p1 = patientContact?.peer_user_id || DEFAULT_PEERS[u1] || "u_mom";
                const p2 = patientContact?.peer2_user_id || DEFAULT_L2_PEERS[u1] || "u_durai";
                setParams(u1, p1, p2);
              }}
              title="Show all 3 screens: Patient, Level 1 Caregiver, and Level 2 Caregiver"
            >
              📱📱📱 3 Screens
            </button>
            {u3 && (
              <button
                className="btn sm"
                disabled={!!busy}
                onClick={() => setParams(u1, u2, "")}
                title="Hide Level 2 screen"
              >
                📱📱 2 Screens
              </button>
            )}
          </div>
          <small className="muted">AI parser: {clock?.ai ? clock.model : "off (rules)"}</small>
        </div>
      </div>

      <div className="wa-wrap">
        <div className="card contacts" style={{ padding: 8, maxHeight: 780, overflowY: "auto" }}>
          {(["PATIENT", "CAREGIVER"] as const).map((r) => (
            <div key={r}>
              <h4 style={{ margin: "8px 8px 4px" }}>{r === "PATIENT" ? "Patients" : "Caregivers"}</h4>
              {byRole(r).map((c) => (
                <div key={c.id} className={`ct ${isSelected(c.id) ? "on" : ""}`} onClick={(e) => pick(c.id, e)}>
                  <span className="avatar" style={{ background: avatarColor(c.name) }}>{initials(c.name)}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row between" style={{ alignItems: "center" }}>
                      <b style={{ fontSize: 13.5 }}>{c.name}</b>
                      <div className="row" style={{ gap: 4, alignItems: "center" }}>
                        {slotBadge(c.id)}
                        <small>{c.last_at ? fmtTime(c.last_at) : ""}</small>
                      </div>
                    </div>
                    <small style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {c.caregiver_level ? `[Level ${c.caregiver_level}] ` : ""}{c.title} · {c.last_body?.split("\n")[0] ?? "no messages"}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <Phone
          userId={u1}
          contact={patientContact}
          slotLabel={patientContact?.role === "PATIENT" ? "👤 Patient" : "👤 User"}
          tagColor="#0f766e"
          onSent={() => { loadContacts(); notifyChange(); }}
          bump={bump}
        />

        {u2 && u2 !== u1 && (
          <Phone
            userId={u2}
            contact={l1Contact}
            slotLabel={l1Contact?.caregiver_level ? `🛡️ Level ${l1Contact.caregiver_level} Caregiver` : "🛡️ Level 1 Caregiver"}
            tagColor="#0369a1"
            onSent={() => { loadContacts(); notifyChange(); }}
            bump={bump}
            onClose={() => setParams(u1, "", u3)}
          />
        )}

        {u3 && u3 !== u1 && u3 !== u2 && (
          <Phone
            userId={u3}
            contact={l2Contact}
            slotLabel={l2Contact?.caregiver_level ? `⚡ Level ${l2Contact.caregiver_level} Escalation Caregiver` : "⚡ Level 2 Escalation Caregiver"}
            tagColor="#b45309"
            onSent={() => { loadContacts(); notifyChange(); }}
            bump={bump}
            onClose={() => setParams(u1, u2, "")}
          />
        )}

        {(!u3 || u3 === u1 || u3 === u2) && (patientContact?.peer2_user_id || DEFAULT_L2_PEERS[u1]) && (
          <div className="stack center" style={{ alignSelf: "center", padding: "20px 10px", minWidth: 200, textAlign: "center" }}>
            <div className="card tight" style={{ padding: 16, border: "2px dashed var(--line-2)" }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>⚡</div>
              <b>Level 2 Escalation</b>
              <div className="muted" style={{ fontSize: 12, margin: "6px 0 12px" }}>
                Add the Level 2 caregiver screen to monitor multi-tier alerts.
              </div>
              <button
                className="btn sm primary"
                onClick={() => setParams(u1, u2, patientContact?.peer2_user_id || DEFAULT_L2_PEERS[u1] || "u_durai")}
              >
                + Open Level 2 Screen
              </button>
            </div>
          </div>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

