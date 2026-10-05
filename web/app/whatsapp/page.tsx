"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api, avatarColor, initials, useSession } from "@/components/client";
import { dayKey, fmtDate, fmtTime } from "@/lib/time";

interface Contact {
  id: string;
  name: string;
  role: string;
  title: string;
  phone: string;
  last_at: number | null;
  last_body: string | null;
  n: number;
  peer_user_id: string | null;
  peer2_user_id?: string | null;
  caregiver_level?: number | null;
}
interface Msg { id: number; direction: "IN" | "OUT"; body: string; quick: string[] | null; created_at: number; kind: string; parser: string | null }

const EXAMPLES: Record<string, string[]> = {
  PATIENT: [
    "BP 138/86, weight 72.4, took morning tablets",
    "Took all tablets ✅",
    "Missed my evening tablets",
    "Walked 30 min",
    "Skipped walk, knee pain",
    "Feeling a bit dizzy today",
    "Ankles are swollen",
    "sugar 210 after lunch",
    "spo2 89, more breathless",
    "Chest pain since morning",
  ],
  CAREGIVER: [
    "ACK",
    "Miss",
    "1",
    "2",
    "Called the clinic, asked to increase diuretic",
    "Appa's BP 182/112, he has headache",
    "Amma took her tablets, BP 132/84",
    "Pain 7/10 after exercises",
  ],
  u_gopal: [
    "Weight 59.4, BP 138/82, took morning tablets and Lasix",
    "Drank 200 ml tea",
    "Water 950 ml total, urine 850 ml",
    "Took evening tablets",
    "A bit dizzy when standing up",
    "Ankles look swollen",
    "creat 2.1 urea 68 K 4.9",
    "Dr Manoj Shah reduced Prizide to 30 mg",
  ],
  u_mom: [
    "ACK",
    "Miss",
    "1",
    "2",
    "Gave Gopal his morning Lasix and tea",
    "Gopal had some dizziness when standing up",
    "Drank 200 ml warm water",
    "Gopal BP 132/84, weight 59.4 kg",
  ],
  u_durai: [
    "ACK",
    "Miss",
    "1",
    "2",
    "Spoke with Appa, gave him ORS and rest",
    "Appa weight 60.5 kg, drank 1200 ml fluid today",
    "Appa loose stools 3 times, feeling weak",
    "Appa creatinine 2.4, urea 78, K 5.2 from Vijaya lab",
    "Dr Satish stopped Dytor and started Lasix 40 mg",
  ],
  u_lakshmi: [
    "ACK",
    "Miss",
    "1",
    "2",
    "Gave Ramesh his morning BP tablets",
    "Ramesh BP 136/84, weight 77.2 kg",
    "Ramesh feeling fine today, followed salt diet",
  ],
  u_arjun: [
    "ACK",
    "Miss",
    "1",
    "2",
    "Called Dr. Meera Rao's clinic about Appa's BP",
    "Appa took his evening tablets, ankles normal",
    "Reminded Appa about salt and fluid limit",
  ],
};

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

function Phone({
  userId,
  contact,
  slotLabel,
  tagColor,
  onSent,
  bump,
  onClose,
}: {
  userId: string;
  contact?: Contact;
  slotLabel?: string;
  tagColor?: string;
  onSent: () => void;
  bump: number;
  onClose?: () => void;
}) {
  const { mode, clinic } = useSession();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);

  const load = useCallback(
    () =>
      api<{ messages: Msg[] }>(`/api/whatsapp?userId=${userId}&limit=150`)
        .then((r) => setMsgs(r.messages))
        .catch(() => undefined),
    [userId],
  );
  useEffect(() => {
    lastId.current = 0;
    load();
    const i = setInterval(load, 3000);
    return () => clearInterval(i);
  }, [load, bump]);
  useEffect(() => {
    const last = msgs[msgs.length - 1]?.id ?? 0;
    if (last !== lastId.current && body.current) body.current.scrollTop = body.current.scrollHeight;
    lastId.current = last;
  }, [msgs]);

  async function send(t: string) {
    const v = t.trim();
    if (!v) return;
    setSending(true);
    setError(null);
    setText("");
    try {
      await api("/api/whatsapp", { body: { userId, body: v } });
      await load();
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function sendDocument({ sampleId, base64, mimeType }: { sampleId?: string; base64?: string; mimeType?: string }) {
    setOcrBusy(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; transcript?: string; parsedSummary?: string; error?: string }>("/api/ocr", {
        body: {
          sampleId,
          imageBase64: base64,
          mimeType: mimeType || "image/png",
          userId,
          commit: true,
        },
      });
      if (res.error) throw new Error(res.error);
      setShowDocPicker(false);
      await load();
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOcrBusy(false);
    }
  }

  function handleFileAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      sendDocument({ base64: reader.result as string, mimeType: file.type || "image/png" });
    };
    reader.readAsDataURL(file);
  }

  let lastDay = "";
  const lastOutWithQuick = [...msgs].reverse().find((m) => m.direction === "OUT")?.id;
  const examples = EXAMPLES[userId] ?? EXAMPLES[contact?.role ?? "PATIENT"] ?? EXAMPLES.PATIENT;
  const clinicName = mode === "live" ? (clinic?.name ?? "Your clinic") : contact?.title?.toLowerCase().includes("gopal") || userId === "u_gopal" || userId === "u_durai" || userId === "u_mom" ? "Dr. Dileep’s clinic" : "Dr. Meera Rao’s clinic";
  return (
    <div className="stack" style={{ alignItems: "center", minWidth: 0, width: "100%", maxWidth: 420 }}>
      <div className="phone-tag row between" style={{ width: "100%", maxWidth: 400, padding: "0 4px 6px", alignItems: "center" }}>
        <div className="row" style={{ gap: 6, alignItems: "center", minWidth: 0 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              padding: "3px 8px",
              borderRadius: 6,
              background: tagColor || (contact?.role === "PATIENT" ? "#0f766e" : contact?.caregiver_level === 2 ? "#b45309" : "#0369a1"),
              color: "#fff",
              whiteSpace: "nowrap",
            }}
          >
            {slotLabel || (contact?.role === "PATIENT" ? "👤 Patient" : contact?.caregiver_level === 2 ? "⚡ Level 2 Escalation" : "🛡️ Level 1 Caregiver")}
          </span>
          <b style={{ fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {contact?.name ?? userId}
          </b>
        </div>
        {onClose && (
          <button
            className="btn sm"
            style={{ padding: "2px 8px", fontSize: 11, height: 22, lineHeight: "18px", background: "var(--line-2)", border: 0 }}
            onClick={onClose}
            title="Close this screen"
          >
            ✕ Hide
          </button>
        )}
      </div>

      <div className="phone">
        <div className="phone-inner">
          <div className="wa-head">
            <span className="avatar" style={{ background: "#25d366" }}>CC</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t">CareCircle · {clinicName}</div>
              <small style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                on {contact ? `${contact.name}’s phone (${contact.title})` : userId}
              </small>
            </div>
            {onClose && <button className="btn sm" style={{ background: "transparent", color: "#fff", border: 0, fontSize: 15 }} onClick={onClose} title="Close screen">✕</button>}
          </div>
          <div className="wa-body" ref={body}>
            {msgs.map((m) => {
              const dk = dayKey(m.created_at);
              const sep = dk !== lastDay ? ((lastDay = dk), <div className="wa-day"><span>{fmtDate(m.created_at, { weekday: "short", day: "numeric", month: "short" })}</span></div>) : null;
              const urgent = m.kind === "escalation" && /URGENT/.test(m.body);
              return (
                <div key={m.id}>
                  {sep}
                  <div className={`bubble ${m.direction === "IN" ? "in" : "out"} ${m.kind === "escalation" ? "escalation" : ""} ${urgent ? "urgent" : ""}`}>
                    <Formatted text={m.body} />
                    <div className="meta">
                      {m.parser ? `${m.parser} · ` : ""}
                      {fmtTime(m.created_at)}
                      {m.direction === "IN" ? " ✓✓" : ""}
                    </div>
                  </div>
                  {m.quick && m.id === lastOutWithQuick && (
                    <div className="quick">
                      {m.quick.map((q) => (
                        <button
                          key={q}
                          disabled={sending}
                          onClick={() => send(q)}
                          style={q.toLowerCase().includes("miss") ? { color: "#b45309", fontWeight: 700 } : undefined}
                          title={q.toLowerCase().includes("miss") ? "Simulate caregiver missing this alert (triggers timeout escalation)" : undefined}
                        >
                          {q}
                        </button>
                      ))}
                      {/* If the message had an ACK quick button but no Miss button yet, ensure Miss is shown next to it */}
                      {m.quick.some((q) => q.toLowerCase().includes("ack")) && !m.quick.some((q) => q.toLowerCase().includes("miss")) && (
                        <button
                          key="miss-fallback"
                          disabled={sending}
                          onClick={() => send("Miss")}
                          style={{ color: "#b45309", fontWeight: 700 }}
                          title="Simulate caregiver missing this alert (triggers timeout escalation)"
                        >
                          Miss
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!msgs.length && <div className="wa-day"><span>No messages yet</span></div>}
          </div>

          {showDocPicker && (
            <div style={{ background: "#f0f2f5", padding: "10px 12px", borderTop: "1px solid #d1d7db", fontSize: 12.5 }}>
              <div className="row between" style={{ marginBottom: 6 }}>
                <b style={{ color: "#111b21" }}>📷 Intake Document (Gemini Vision OCR)</b>
                <button
                  type="button"
                  className="btn sm"
                  style={{ border: 0, background: "transparent", cursor: "pointer", padding: "0 4px" }}
                  onClick={() => setShowDocPicker(false)}
                >
                  ✕
                </button>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <label className="btn sm alt" style={{ textAlign: "center", cursor: "pointer", display: "block" }}>
                  📤 Upload Prescription / Lab Photo
                  <input type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileAttach} disabled={ocrBusy} />
                </label>
                <button
                  type="button"
                  className="btn sm"
                  disabled={ocrBusy}
                  onClick={() => sendDocument({ sampleId: "RX_MANOJ_SHAH" })}
                  style={{ textAlign: "left" }}
                >
                  📄 Sample: Dr. Manoj Shah Rx (Prizide MR 30mg)
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={ocrBusy}
                  onClick={() => sendDocument({ sampleId: "LAB_VIJAYA" })}
                  style={{ textAlign: "left" }}
                >
                  🧪 Sample: Vijaya Lab Report (Creat 3.01 mg/dL)
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={ocrBusy}
                  onClick={() => sendDocument({ sampleId: "DIARY_HOME" })}
                  style={{ textAlign: "left" }}
                >
                  📝 Sample: Home Monitoring Sugar & BP Diary
                </button>
              </div>
              {ocrBusy && (
                <div className="row center" style={{ marginTop: 8, color: "#54656f", gap: 6 }}>
                  <span className="spin" /> Transcribing handwriting with Gemini Vision…
                </div>
              )}
            </div>
          )}

          <form className="wa-input" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <button
              type="button"
              onClick={() => setShowDocPicker(!showDocPicker)}
              title="Attach handwritten prescription or lab report (Gemini Vision OCR)"
              style={{ background: "transparent", border: 0, fontSize: 18, cursor: "pointer", padding: "0 6px" }}
            >
              📷
            </button>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message" disabled={sending || ocrBusy} />
            <button type="submit" disabled={sending || ocrBusy}>{sending ? <span className="spin" /> : "➤"}</button>
          </form>
        </div>
      </div>
      {error && <small style={{ color: "var(--bad)" }}>{error}</small>}
      <div className="chips" style={{ maxWidth: 420, justifyContent: "center" }}>
        {examples.map((x) => (
          <button key={x} className="chip-btn" disabled={sending || ocrBusy} onClick={() => send(x)}>{x}</button>
        ))}
      </div>
    </div>
  );
}

// Minimal WhatsApp formatting: *bold*
function Formatted({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*)/g);
  return <>{parts.map((p, i) => (p.startsWith("*") && p.endsWith("*") && p.length > 2 ? <b key={i}>{p.slice(1, -1)}</b> : <span key={i}>{p}</span>))}</>;
}
