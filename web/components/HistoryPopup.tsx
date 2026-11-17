"use client";
// The patient's full history (as confirmed from their own records) in a scrolling pop-up, with a PDF download.
// The download uses the browser's print dialog ("Save as PDF"): only the history is printed, not the page behind it.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./client";
import { HistoryView } from "./HistorySections";
import { fmtDate, fmtDateTime } from "@/lib/time";
import type { History } from "@/lib/historyspec";

interface Resp { confirmed: { confirmedAt: number | null; confirmedBy: string | null; summary: History | null; points: { title: string; answer?: string }[] } | null }

export function HistoryPopup({ pid, patient, fallback, onClose, onProfile }: { pid: string; patient: { name: string; age?: number | null; sex?: string }; fallback: string[]; onClose: () => void; onProfile: () => void }) {
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<Resp>(`/api/patients/${pid}/onboarding`).then(setD).catch((e) => setErr((e as Error).message)); }, [pid]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function download() {
    const title = document.title;
    const done = () => { document.body.classList.remove("print-hist"); document.title = title; window.removeEventListener("afterprint", done); };
    // The browser offers this as the PDF's file name.
    document.title = `${patient.name} - patient history`;
    document.body.classList.add("print-hist");
    window.addEventListener("afterprint", done);
    window.print();
  }

  const c = d?.confirmed ?? null;
  const answered = c?.points.filter((p) => p.answer?.trim()) ?? [];
  return createPortal(
    <div className="hx-backdrop" role="dialog" aria-modal="true" aria-label="Full history" onClick={onClose}>
      <div className="hx-box" onClick={(e) => e.stopPropagation()}>
        <header className="hx-head">
          <div>
            <h2>Patient history</h2>
            <div className="v2-sub">{[patient.name, patient.age, patient.sex === "M" ? "Male" : patient.sex === "F" ? "Female" : patient.sex].filter(Boolean).join(" · ")}{c?.confirmedAt ? ` · confirmed by ${c.confirmedBy ?? "the doctor"}, ${fmtDateTime(c.confirmedAt)}` : ""}</div>
          </div>
          <div className="row hx-actions" style={{ gap: 8 }}>
            <button className="v2-btn" disabled={!d} onClick={download} title="Opens the print dialog: choose “Save as PDF”">Download as PDF</button>
            <button className="v2-btn" onClick={onClose}>Close</button>
          </div>
        </header>
        <div className="hx-body">
          {err && <div className="alert bad">{err}</div>}
          {!d && !err && <div className="empty"><span className="spin" /></div>}
          {d && c?.summary && (
            <>
              <HistoryView history={c.summary} />
              {answered.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <h4 style={{ margin: "0 0 6px" }}>Confirmed at onboarding</h4>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{answered.map((p, i) => <li key={i}><b>{p.title}:</b> {p.answer}</li>)}</ul>
                </div>
              )}
            </>
          )}
          {d && !c?.summary && (
            <div className="stack" style={{ gap: 10 }}>
              {fallback.length > 0 ? fallback.map((x, i) => <p key={i} style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{x}</p>) : <p className="v2-sub" style={{ margin: 0 }}>No history recorded yet.</p>}
              <p className="v2-sub hx-actions" style={{ margin: 0 }}>A fuller history is built from the patient&rsquo;s past records. <button className="tq-link" onClick={onProfile}>Add past records on the Profile tab</button></p>
            </div>
          )}
          <div className="hx-printed v2-sub">Printed from CareCircle on {fmtDate(Date.now(), { day: "numeric", month: "short", year: "numeric" })}.</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
