"use client";
// "Ask the record": a question about this patient, answered from their own record, with the chart.
import { useState } from "react";
import { api } from "./client";
import { LineChart, medMarkers } from "./charts";
import { fmtDateTime } from "@/lib/time";
import type { Answer } from "@/lib/askrecord";

const SUGGESTIONS = ["When did creatinine start rising?", "Weight against the water tablet dose", "Which medicines changed since the last visit?", "How has BP been over the last 2 months?", "How has adherence been?"];

export function AskRecord({ pid, patientFirst }: { pid: string; patientFirst: string }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [a, setA] = useState<{ q: string; res: Answer; at: number } | null>(null);

  async function ask(text: string) {
    if (text.trim().length < 3 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setA({ q: text.trim(), res: await api<Answer>(`/api/patients/${pid}/ask`, { body: { question: text.trim() } }), at: Date.now() });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="v2-card pad ask-card">
      <div className="row between" style={{ marginBottom: 8, alignItems: "baseline" }}>
        <h2>Ask {patientFirst}'s record</h2>
        <span className="v2-sub">Answers come only from this record</span>
      </div>
      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. When did creatinine start rising?" aria-label="Question about this patient's record" maxLength={400} />
        <button className="v2-btn primary" disabled={busy || q.trim().length < 3}>{busy ? <><span className="spin" /> Reading the record…</> : "Ask"}</button>
      </form>
      {!a && !busy && <div className="ask-chips">{SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => { setQ(s); ask(s); }}>{s}</button>)}</div>}
      {busy && <div className="v2-sub" style={{ marginTop: 8 }}>Reading the whole record carefully. This can take up to half a minute.</div>}
      {err && <div className="alert bad" style={{ marginTop: 10 }}>{err}</div>}
      {a && (
        <div className="ask-answer">
          <div className="ask-q">“{a.q}”</div>
          <p className="ask-a">{a.res.answer}</p>
          {a.res.facts.length > 0 && <ul className="ask-facts">{a.res.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>}
          {a.res.chart && (
            <div className="ask-charts">
              {a.res.chart.panels.map((p) => (
                <div key={p.name}>
                  <div className="ask-chart-t">{p.label} <span className="v2-sub">{p.unit}</span></div>
                  <LineChart series={p.points} from={a.res.chart!.from} to={a.res.chart!.to} markers={medMarkers(a.res.chart!.changes, a.res.chart!.from, a.res.chart!.to)} dual={p.dual} unit={p.unit} height={170} />
                </div>
              ))}
              <div className="v2-sub" style={{ fontSize: 12 }}>Amber lines are medicine changes, including other doctors'. Hover a line for details.</div>
            </div>
          )}
          {a.res.note && <div className="ask-note">ℹ️ {a.res.note}</div>}
          <div className="v2-sub" style={{ fontSize: 12, marginTop: 8 }}>{a.res.via === "ai" ? "✨ Read by AI from the record. " : "Statistics from the record (AI is off). "}It shows what the record says, not advice. Check anything important against the chart. · {fmtDateTime(a.at)}</div>
        </div>
      )}
    </section>
  );
}
