"use client";
// "Ask the record": a question about this patient, answered from their own record, with the chart.
import { useCallback, useEffect, useState } from "react";
import { api } from "./client";
import { LineChart, medMarkers } from "./charts";
import { fmtDateTime } from "@/lib/time";
import type { Answer, AskedQuestion, ChartData } from "@/lib/askrecord";

const SUGGESTIONS = ["When did creatinine start rising?", "Weight against the water tablet dose", "Which medicines changed since the last visit?", "How has BP been over the last 2 months?", "How has adherence been?"];

export function AskRecord({ pid, patientFirst }: { pid: string; patientFirst: string }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [a, setA] = useState<{ q: string; res: Answer; at: number; by?: string } | null>(null);
  const [past, setPast] = useState<AskedQuestion[]>([]);
  const [all, setAll] = useState(false);
  const [histOpen, setHistOpen] = useState(false); // earlier questions start folded away
  const [open, setOpen] = useState<AskedQuestion | null>(null);
  const [opening, setOpening] = useState<number | null>(null);

  const loadPast = useCallback(() => {
    api<{ questions: AskedQuestion[] }>(`/api/patients/${pid}/ask`).then((r) => setPast(r.questions)).catch(() => undefined);
  }, [pid]);
  useEffect(loadPast, [loadPast]);

  async function ask(text: string) {
    if (text.trim().length < 3 || busy) return;
    setBusy(true);
    setErr(null);
    setOpen(null);
    try {
      const res = await api<Answer & { id: number; at: number; by: string }>(`/api/patients/${pid}/ask`, { body: { question: text.trim() } });
      setA({ q: text.trim(), res, at: res.at, by: res.by });
      loadPast();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reopen(x: AskedQuestion) {
    if (open?.id === x.id) return setOpen(null);
    setOpening(x.id);
    try {
      setOpen(await api<AskedQuestion>(`/api/patients/${pid}/ask?q=${x.id}`));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setOpening(null);
    }
  }

  const earlier = past.filter((x) => !(a && x.at === a.at && x.question === a.q));
  const shown = all ? earlier : earlier.slice(0, 5);

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
      {a && <AnswerView q={a.q} res={a.res} at={a.at} by={a.by} />}
      {earlier.length > 0 && (
        <div className="ask-history">
          <div className="row between" style={{ alignItems: "baseline" }}>
            <button type="button" className="ask-hist-toggle" onClick={() => setHistOpen(!histOpen)} aria-expanded={histOpen}>
              <span className={`ask-chev${histOpen ? " open" : ""}`} aria-hidden>▸</span> Earlier questions <span className="v2-sub">({earlier.length})</span>
            </button>
            {histOpen && earlier.length > 5 && <button type="button" className="ask-more" onClick={() => setAll(!all)}>{all ? "Show fewer" : "Show all"}</button>}
          </div>
          {histOpen && <ul>
            {shown.map((x) => (
              <li key={x.id}>
                <button type="button" className={`ask-past${open?.id === x.id ? " on" : ""}`} onClick={() => reopen(x)} aria-expanded={open?.id === x.id}>
                  <span className="ask-past-q">“{x.question}”</span>
                  <span className="v2-sub">{fmtDateTime(x.at)} · {x.by}{opening === x.id ? " · opening…" : ""}</span>
                </button>
                {open?.id === x.id && <AnswerView q={open.question} res={open} at={open.at} by={open.by} past />}
              </li>
            ))}
          </ul>}
        </div>
      )}
    </section>
  );
}

function AnswerView({ q, res, at, by, past }: { q: string; res: { answer: string; facts: string[]; note: string | null; via: string; chart: ChartData | null; reusedFrom?: number }; at: number; by?: string; past?: boolean }) {
  return (
    <div className="ask-answer">
      {!past && <div className="ask-q">“{q}”</div>}
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
          <div className="v2-sub" style={{ fontSize: 12 }}>Amber lines are medicine changes, including other doctors'. Hover a line for details.{past ? " Chart shows the record as it was when this was asked." : ""}</div>
        </div>
      )}
      {res.note && <div className="ask-note">ℹ️ {res.note}</div>}
      {res.reusedFrom && <div className="v2-sub" style={{ fontSize: 12, marginTop: 8 }}>↺ Asked before on {fmtDateTime(res.reusedFrom)} and nothing in the record has changed since, so that answer is shown.</div>}
      <div className="v2-sub" style={{ fontSize: 12, marginTop: 8 }}>{res.via === "ai" ? "✨ Read by AI from the record. " : "Statistics from the record (AI is off). "}It shows what the record says, not advice. Check anything important against the chart. · {fmtDateTime(at)}{by ? ` · asked by ${by}` : ""}</div>
    </div>
  );
}
