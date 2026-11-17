"use client";
// "Ask the record": a question about this patient, answered from their own record, with the chart.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./client";
import { Dictate } from "./Dictate";
import { LineChart, medMarkers } from "./charts";
import { fmtDateTime } from "@/lib/time";
import type { Answer, AskedQuestion, ChartData } from "@/lib/askrecord";

const SUGGESTIONS = ["When did creatinine start rising?", "Weight against the water tablet dose", "Which medicines changed since the last visit?", "How has BP been over the last 2 months?", "How has adherence been?"];

export function AskRecord({ pid, patientFirst }: { pid: string; patientFirst: string }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [byVoice, setByVoice] = useState(false); // the current question was spoken, so say what was heard
  const [err, setErr] = useState<string | null>(null);
  const [a, setA] = useState<{ q: string; res: Answer; at: number; by?: string } | null>(null);
  const [past, setPast] = useState<AskedQuestion[]>([]);
  const [show, setShow] = useState(false); // the answer opens in a pop-up over the chart
  const [asking, setAsking] = useState("");

  const loadPast = useCallback(() => {
    api<{ questions: AskedQuestion[] }>(`/api/patients/${pid}/ask`).then((r) => setPast(r.questions)).catch(() => undefined);
  }, [pid]);
  useEffect(loadPast, [loadPast]);
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShow(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  /** `fresh` reads the record again instead of showing the answer kept from the last time this was asked. */
  async function ask(text: string, fresh = false) {
    if (text.trim().length < 3 || busy) return;
    setBusy(true);
    setErr(null);
    setAsking(text.trim());
    setShow(true);
    try {
      const res = await api<Answer & { id: number; at: number; by: string }>(`/api/patients/${pid}/ask`, { body: { question: text.trim(), fresh } });
      setA({ q: text.trim(), res, at: res.at, by: res.by });
      loadPast();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function heard(t: string) {
    const text = t.replace(/\s+/g, " ").trim().slice(0, 400);
    setQ(text);
    setByVoice(true);
    ask(text);
  }

  function pick(text: string, fresh = false) {
    setQ(text);
    setByVoice(false);
    ask(text, fresh);
  }

  // Each earlier question once (newest wording first), leaving out the samples and the one on screen.
  const key = (x: string) => x.toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "");
  const seen = new Set([...SUGGESTIONS.map(key), ...(a ? [key(a.q)] : [])]);
  const earlier = past.filter((x) => { const k = key(x.question); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);

  return (
    <section className="v2-card pad ask-card">
      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => { setQ(e.target.value); setByVoice(false); }} placeholder={`Ask ${patientFirst}'s record, e.g. When did creatinine start rising?`} aria-label="Question about this patient's record" maxLength={400} />
        <button className="v2-btn primary" disabled={busy || q.trim().length < 3}>{busy ? <><span className="spin" /> Reading…</> : "Ask"}</button>
        {/* Speak the question: stopping the recording asks it. What was heard stays in the box to edit and re-ask. */}
        <Dictate patientId={pid} label="Speak your question" noun="question" onText={heard} compact />
      </form>
      <div className="ask-line" aria-label="Sample questions">
        <span className="ask-line-k">Try</span>
        {SUGGESTIONS.map((s) => <button key={s} type="button" disabled={busy} onClick={() => pick(s)}>{s}</button>)}
      </div>
      {earlier.length > 0 && (
        <div className="ask-line" aria-label="Earlier questions">
          <span className="ask-line-k">Earlier</span>
          {earlier.map((x) => <button key={x.id} type="button" disabled={busy} title={`${x.question} · asked ${fmtDateTime(x.at)} by ${x.by}. Select to answer it again from the record as it is now.`} onClick={() => pick(x.question, true)}>{x.question}</button>)}
        </div>
      )}
      {!show && a && !busy && <div className="v2-sub" style={{ marginTop: 8 }}>Last answer: “{a.q}” <button type="button" className="tq-link" onClick={() => setShow(true)}>Show</button></div>}
      {!show && err && <div className="alert bad" style={{ marginTop: 10 }}>{err}</div>}
      {show && createPortal(
        <div className="hx-backdrop" role="dialog" aria-modal="true" aria-label="Answer from the record" onClick={() => setShow(false)}>
          <div className="hx-box ask-pop" onClick={(e) => e.stopPropagation()}>
            <header className="hx-head">
              <div>
                <h2>{patientFirst}&rsquo;s record</h2>
                <div className="v2-sub">Answers come only from this record</div>
              </div>
              <button type="button" className="v2-btn" onClick={() => setShow(false)}>Close</button>
            </header>
            <div className="hx-body" aria-live="polite">
              {busy && <div className="ask-wait"><span className="spin" /><div><div className="ask-q">“{asking}”</div><div className="v2-sub">Reading the whole record carefully. This can take up to half a minute.</div></div></div>}
              {!busy && err && <div className="alert bad">{err}</div>}
              {!busy && !err && a && (
                <>
                  {byVoice && <div className="v2-sub" style={{ marginBottom: 8 }}>Heard: “{a.q}”. If that isn&rsquo;t what you said, close this, correct it in the box and press Ask.</div>}
                  <AnswerView q={a.q} res={a.res} at={a.at} by={a.by} />
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}

function AnswerView({ q, res, at, by }: { q: string; res: { answer: string; facts: string[]; note: string | null; via: string; chart: ChartData | null; reusedFrom?: number }; at: number; by?: string }) {
  return (
    <div className="ask-answer">
      <div className="ask-q">“{q}”</div>
      <p className="ask-a">{res.answer}</p>
      {res.facts.length > 0 && <ul className="ask-facts">{res.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>}
      {res.chart && (
        <div className="ask-charts">
          {res.chart.panels.map((p) => (
            <div key={p.name}>
              <div className="ask-chart-t">{p.label} <span className="v2-sub">{p.unit}</span></div>
              <LineChart series={p.points} from={res.chart!.from} to={res.chart!.to} markers={medMarkers(res.chart!.changes, res.chart!.from, res.chart!.to)} dual={p.dual} unit={p.unit} height={170} />
            </div>
          ))}
          <div className="v2-sub" style={{ fontSize: 12 }}>Amber lines are medicine changes, including other doctors'. Hover a line for details.</div>
        </div>
      )}
      {res.note && <div className="ask-note">ℹ️ {res.note}</div>}
      {res.reusedFrom && <div className="v2-sub" style={{ fontSize: 12, marginTop: 8 }}>↺ Asked before on {fmtDateTime(res.reusedFrom)} and nothing in the record has changed since, so that answer is shown.</div>}
      <div className="v2-sub" style={{ fontSize: 12, marginTop: 8 }}>{res.via === "ai" ? "✨ Read by AI from the record. " : "Statistics from the record (AI is off). "}It shows what the record says, not advice. Check anything important against the chart. · {fmtDateTime(at)}{by ? ` · asked by ${by}` : ""}</div>
    </div>
  );
}
