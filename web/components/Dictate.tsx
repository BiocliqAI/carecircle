"use client";
// Dictate a clinical note: record, show a live preview, then the server (Gemini, clinical vocabulary)
// transcribes the recording and the text is added to the note box for the clinician to review and save.
import { useEffect, useRef, useState } from "react";
import { api } from "./client";
import { Icon } from "./Icon";
import { blobToDataUrl, speechCtor, type SpeechRec } from "./speech";

type State = "idle" | "recording" | "transcribing";

export function Dictate({ patientId, onText, label = "Dictate" }: { patientId: string; onText: (text: string) => void; label?: string }) {
  const [state, setState] = useState<State>("idle");
  const [secs, setSecs] = useState(0);
  const [preview, setPreview] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const speech = useRef<SpeechRec | null>(null);
  const finalText = useRef("");
  const started = useRef(0);

  useEffect(() => {
    if (state !== "recording") return;
    const i = setInterval(() => setSecs(Math.round((Date.now() - started.current) / 1000)), 250);
    return () => clearInterval(i);
  }, [state]);
  useEffect(() => () => { try { speech.current?.stop(); } catch { /* noop */ } rec.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  async function start() {
    setErr(null);
    setPreview("");
    finalText.current = "";
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setErr("Microphone not available. Allow microphone access for this site, or type the note.");
      return;
    }
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setErr("Couldn't start recording on this device. Please type the note.");
      return;
    }
    chunks.current = [];
    mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    mr.onstop = () => finish(mr.mimeType || "audio/webm");
    rec.current = mr;
    mr.start();
    started.current = Date.now();
    setSecs(0);
    setState("recording");
    const Ctor = speechCtor();
    if (Ctor) {
      const r = new Ctor();
      r.lang = "en-IN";
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) finalText.current = `${finalText.current} ${res[0].transcript}`.trim();
          else interim += res[0].transcript;
        }
        setPreview(`${finalText.current} ${interim}`.trim());
      };
      r.onerror = () => undefined;
      r.onend = () => undefined;
      try { r.start(); speech.current = r; } catch { /* preview unavailable */ }
    }
  }

  function stop() {
    try { speech.current?.stop(); } catch { /* noop */ }
    speech.current = null;
    if (rec.current?.state === "recording") rec.current.stop();
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    setState("transcribing");
  }

  function cancel() {
    try { speech.current?.stop(); } catch { /* noop */ }
    speech.current = null;
    if (rec.current) { rec.current.onstop = null; if (rec.current.state === "recording") rec.current.stop(); rec.current.stream.getTracks().forEach((t) => t.stop()); }
    setState("idle");
    setPreview("");
  }

  async function finish(mime: string) {
    try {
      const blob = new Blob(chunks.current, { type: mime });
      const base64 = await blobToDataUrl(blob);
      const r = await api<{ text: string; via: string | null; aiError?: string }>(`/api/patients/${patientId}/dictate`, { body: { base64, mime, hint: finalText.current || preview } });
      if (r.text) onText(r.text);
      else setErr(r.aiError ? "Couldn't transcribe the dictation. Please type the note." : "No speech was detected.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setState("idle");
      setPreview("");
    }
  }

  return (
    <div className="dict">
      {state === "idle" && <button type="button" className="v2-btn" onClick={start} title="Dictate this note"><Icon name="mic" size={16} />{label}</button>}
      {state === "recording" && (
        <div className="dict-live">
          <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <span className="rec-dot" /> <b className="num">Dictating {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</b>
            <span style={{ flex: 1 }} />
            <button type="button" className="v2-btn" onClick={cancel}>Cancel</button>
            <button type="button" className="v2-btn primary" onClick={stop}>Stop</button>
          </div>
          <div className="dict-preview" aria-live="polite">{preview || <span className="v2-sub">Listening… say “full stop” or “new line” for punctuation.</span>}</div>
        </div>
      )}
      {state === "transcribing" && <div className="dict-live"><span className="spin" /> Transcribing with clinical vocabulary…</div>}
      {err && <div className="v2-sub" style={{ color: "var(--c-red)", marginTop: 6 }}>{err}</div>}
    </div>
  );
}
