"use client";
// One WhatsApp phone (simulator). Used on the patient and caregiver pages and in the presenter's
// multi-phone view. Supports text, quick-reply buttons, documents, voice notes and an SOS call.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, useSession } from "./client";
import { dayKey, fmtDate, fmtTime } from "@/lib/time";
import { speechCtor, type SpeechRec } from "./speech";

export interface Contact {
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
export interface Msg { id: number; direction: "IN" | "OUT"; body: string; quick: string[] | null; created_at: number; kind: string; parser: string | null }

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

export function Phone({
  userId,
  contact,
  slotLabel,
  tagColor,
  onSent,
  bump,
  onClose,
  role,
}: {
  userId: string;
  role?: string;
  contact?: Contact;
  slotLabel?: string;
  tagColor?: string;
  onSent: () => void;
  bump: number;
  onClose?: () => void;
}) {
  const { mode, clinic, clock } = useSession();
  const aiVoice = !!clock?.ai;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [rec, setRec] = useState<null | { state: "recording" | "review"; started: number; secs: number; blob?: Blob; url?: string; transcript: string; noMic?: boolean; live?: boolean }>(null);
  const [sos, setSos] = useState<null | "confirm" | "calling" | "sent">(null);
  const [sosTarget, setSosTarget] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const speechRef = useRef<SpeechRec | null>(null);
  const [live, setLive] = useState<{ final: string; interim: string; on: boolean } | null>(null);
  const [speechLang, setSpeechLang] = useState("en-IN");
  const chunks = useRef<Blob[]>([]);
  const isPatient = (contact?.role ?? role) === "PATIENT";

  useEffect(() => {
    if (rec?.state !== "recording") return;
    const i = setInterval(() => setRec((r) => (r && r.state === "recording" ? { ...r, secs: Math.round((Date.now() - r.started) / 1000) } : r)), 250);
    return () => clearInterval(i);
  }, [rec?.state]);

  async function startVoice() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunks.current, { type: mr.mimeType || "audio/webm" });
        setRec((r) => (r ? { ...r, state: "review", blob, url: URL.createObjectURL(blob) } : r));
      };
      mediaRef.current = mr;
      mr.start();
      setRec({ state: "recording", started: Date.now(), secs: 0, transcript: "" });
      startSpeech();
    } catch {
      // No microphone (or permission denied): let the presenter type what the voice note says.
      setRec({ state: "review", started: Date.now(), secs: 5, transcript: "", noMic: true });
    }
  }
  /** Live transcription with the browser's speech recognition (Chrome / Edge). Words appear as you speak. */
  function startSpeech() {
    const Ctor = speechCtor();
    if (!Ctor) { setLive(null); return; }
    const r = new Ctor();
    r.lang = speechLang;
    r.continuous = true;
    r.interimResults = true;
    let final = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) final = `${final} ${res[0].transcript}`.trim();
        else interim += res[0].transcript;
      }
      setLive({ final, interim, on: true });
    };
    r.onerror = () => setLive((l) => (l ? { ...l, on: false } : null));
    r.onend = () => setLive((l) => (l ? { ...l, on: false, interim: "" } : null));
    try {
      r.start();
      speechRef.current = r;
      setLive({ final: "", interim: "", on: true });
    } catch {
      setLive(null);
    }
  }
  function stopSpeech(): string {
    const r = speechRef.current;
    speechRef.current = null;
    if (r) { r.onresult = null; try { r.stop(); } catch { /* already stopped */ } }
    let text = "";
    setLive((l) => { text = l ? `${l.final} ${l.interim}`.trim() : ""; return null; });
    return text;
  }
  function stopVoice() {
    // Take the transcript so far (final + interim words) into the editable field.
    const words = live ? `${live.final} ${live.interim}`.trim() : "";
    stopSpeech();
    setRec((r) => (r ? { ...r, transcript: words || r.transcript, live: !!words } : r));
    mediaRef.current?.state === "recording" ? mediaRef.current.stop() : undefined;
  }
  function cancelVoice() {
    stopSpeech();
    if (mediaRef.current?.state === "recording") {
      mediaRef.current.onstop = null;
      mediaRef.current.stop();
      mediaRef.current.stream.getTracks().forEach((tr) => tr.stop());
    }
    if (rec?.url) URL.revokeObjectURL(rec.url);
    setRec(null);
  }
  async function sendVoice() {
    if (!rec) return;
    setSending(true);
    setError(null);
    try {
      const blob = rec.blob ?? silentWav(rec.secs);
      const base64 = await blobToDataUrl(blob);
      await api("/api/whatsapp/media", { body: { userId, kind: "voice", base64, mime: blob.type || "audio/webm", durationSec: Math.max(1, rec.secs), transcript: rec.transcript.trim() || undefined, transcriptSource: rec.live ? "browser" : "typed" } });
      cancelVoice();
      await load();
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function sendFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return setError("Files are limited to 5 MB");
    setSending(true);
    setError(null);
    try {
      await api("/api/whatsapp/media", { body: { userId, kind: "document", base64: await blobToDataUrl(file), mime: file.type, filename: file.name } });
      setShowDocPicker(false);
      await load();
      onSent();
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function callForHelp() {
    setSos("calling");
    try {
      const r = await api<{ calling: string | null }>("/api/whatsapp/sos", { body: { userId } });
      setSosTarget(r.calling);
      await load();
      onSent();
      setTimeout(() => setSos("sent"), 3500);
    } catch (e) {
      setError((e as Error).message);
      setSos(null);
    }
  }
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
            {isPatient && <button className="wa-sos" onClick={() => setSos("confirm")} title="Call for help (emergency)">🆘</button>}
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
                          style={/^(miss|pass)/i.test(q) ? { color: "#b45309", fontWeight: 700 } : undefined}
                          title={/^(miss|pass)/i.test(q) ? "Pass this alert to the next person in the care circle" : undefined}
                        >
                          {q}
                        </button>
                      ))}
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
                <b style={{ color: "#111b21" }}>📎 Attach</b>
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
                <label className="btn sm primary" style={{ textAlign: "center", cursor: "pointer", display: "block" }}>
                  📎 Send a photo or PDF
                  <input type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={sendFile} disabled={sending} />
                </label>
                <small style={{ color: "#54656f" }}>Or let Gemini read it and chart the values:</small>
                <label className="btn sm alt" style={{ textAlign: "center", cursor: "pointer", display: "block" }}>
                  🔍 Scan a prescription / lab photo
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

          {rec && (
            <div className="wa-voice">
              {rec.state === "recording" ? (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="row between">
                    <span className="rec-dot" /> <b>Recording… {fmtSecs(rec.secs)}</b>
                    <div className="row" style={{ gap: 6, marginLeft: "auto" }}>
                      <button type="button" className="btn sm" onClick={cancelVoice}>Cancel</button>
                      <button type="button" className="btn sm primary" onClick={stopVoice}>■ Stop</button>
                    </div>
                  </div>
                  {live ? (
                    <div className="wa-live" aria-live="polite">
                      {live.final || live.interim ? <>{live.final} <span style={{ color: "#8696a0" }}>{live.interim}</span></> : <span style={{ color: "#8696a0" }}>{live.on ? "Listening… start speaking" : "Transcription paused"}</span>}
                    </div>
                  ) : speechCtor() ? null : <small style={{ color: "#54656f" }}>Live transcription needs Chrome or Edge. You can type what was said after stopping.</small>}
                </div>
              ) : (
                <div className="stack" style={{ gap: 6 }}>
                  {rec.url ? <audio src={rec.url} controls style={{ width: "100%", height: 32 }} /> : <small style={{ color: "#54656f" }}>{rec.noMic ? "No microphone here, so type what the voice note says." : ""}</small>}
                  {rec.live && <small style={{ color: "#54656f" }}>{aiVoice && !rec.noMic ? "Live preview. When you send, the clinic’s AI transcribes the recording itself, so small mistakes here don’t matter." : "Transcribed while you spoke. Fix anything that’s wrong, then send."}</small>}
                  {!rec.live && aiVoice && !rec.noMic && <small style={{ color: "#54656f" }}>The clinic’s AI will transcribe the recording when you send. Typing is optional.</small>}
                  <input value={rec.transcript} onChange={(e) => setRec({ ...rec, transcript: e.target.value })} placeholder={rec.noMic ? "What was said, e.g. “BP 150 by 95, feeling dizzy”" : aiVoice ? "Optional" : "What was said (it is logged and acted on when you send)"} />
                  <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                    <button type="button" className="btn sm" onClick={cancelVoice}>Discard</button>
                    <button type="button" className="btn sm primary" disabled={sending || (rec.noMic && !rec.transcript.trim())} onClick={sendVoice}>{sending ? <><span className="spin" /> {aiVoice && !rec.noMic ? "Transcribing…" : "Sending…"}</> : "➤ Send voice note"}</button>
                  </div>
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
            {text.trim() ? (
              <button type="submit" disabled={sending || ocrBusy}>{sending ? <span className="spin" /> : "➤"}</button>
            ) : (
              <>
                {speechCtor() && !rec && (
                  <select aria-label="Voice note language" value={speechLang} onChange={(e) => setSpeechLang(e.target.value)} className="wa-lang" title="Language for live transcription">
                    <option value="en-IN">EN</option><option value="hi-IN">HI</option><option value="ta-IN">TA</option><option value="te-IN">TE</option><option value="kn-IN">KN</option><option value="ml-IN">ML</option>
                  </select>
                )}
                <button type="button" disabled={sending || ocrBusy || !!rec} onClick={startVoice} title="Record a voice note">🎤</button>
              </>
            )}
          </form>

          {sos && (
            <div className="wa-call">
              {sos === "confirm" && (
                <div className="wa-call-card">
                  <div className="big">🆘</div>
                  <b>Call for help?</b>
                  <p>Your care circle is alerted immediately, and the primary caregiver is called.</p>
                  <div className="row" style={{ gap: 8, justifyContent: "center" }}>
                    <button className="btn" onClick={() => setSos(null)}>Cancel</button>
                    <button className="btn danger" onClick={callForHelp}>Call for help</button>
                  </div>
                </div>
              )}
              {sos === "calling" && (
                <div className="wa-call-card calling">
                  <div className="ring">📞</div>
                  <b>Calling {sosTarget ?? "your care circle"}…</b>
                  <p>WhatsApp voice call</p>
                </div>
              )}
              {sos === "sent" && (
                <div className="wa-call-card">
                  <div className="big">✅</div>
                  <b>Your care circle has been alerted</b>
                  <p>If it's severe, call <b>108</b> now.</p>
                  <button className="btn" onClick={() => setSos(null)}>Close</button>
                </div>
              )}
            </div>
          )}
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

const fmtSecs = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(b);
  });
}

/** A short silent WAV, used as the audio when a voice note is simulated without a microphone. */
function silentWav(seconds: number): Blob {
  const rate = 8000;
  const n = Math.max(1, Math.min(10, seconds)) * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o: number, str: string) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return new Blob([buf], { type: "audio/wav" });
}

