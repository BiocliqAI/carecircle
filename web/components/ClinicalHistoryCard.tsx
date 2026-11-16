"use client";
// Profile tab: the patient history put together from past records at onboarding (once the doctor has confirmed it),
// or the way in to onboarding for a patient whose old records haven't been added yet.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./client";
import { HistoryView } from "./HistorySections";
import { fmtDateTime } from "@/lib/time";
import type { History } from "@/lib/historyspec";

interface Resp {
  onboarding: { status: string; confirmedAt: number | null; confirmedBy: string | null } | null;
  progress: { total: number } | null;
  isUpdate: boolean;
  /** The history as last confirmed (also while an update to it is being checked). */
  confirmed: { confirmedAt: number | null; confirmedBy: string | null; summary: History | null; points: { title: string; answer?: string }[] } | null;
}

const LABEL: Record<string, string> = { COLLECTING: "Records being added and read", REVIEW: "Being checked by the assistant", RETURNED: "Sent back by the doctor", SENT: "Waiting for the doctor to confirm" };

export function ClinicalHistoryCard({ pid }: { pid: string }) {
  const router = useRouter();
  const [d, setD] = useState<Resp | null>(null);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<Resp>(`/api/patients/${pid}/onboarding`).then(setD).catch((e) => setErr((e as Error).message)); }, [pid]);

  async function start(action: "start" | "update") {
    setBusy(true);
    try {
      await api(`/api/patients/${pid}/onboarding`, { body: { action } });
      router.push(`/patients/${pid}/onboarding`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const o = d?.onboarding;
  const c = d?.confirmed;
  const open = o && o.status !== "CONFIRMED" ? o : null;
  return (
    <section className="card">
      <div className="card-head">
        <h3>Clinical history</h3>
        <span className="row" style={{ gap: 6 }}>
          {c && !open && <button className="btn sm" disabled={busy} onClick={() => start("update")}>{busy ? <span className="spin" /> : null} Add records</button>}
          {o && <Link className="btn sm" href={`/patients/${pid}/onboarding`}>{open ? "Open" : "Edit"}</Link>}
        </span>
      </div>
      {err && <div className="alert bad"><div>{err}</div></div>}
      {!d ? <span className="spin" /> : !o ? (
        <div className="stack">
          <span className="muted">Add the old records the family brought (notes, prescriptions, discharge summaries, lab reports, BP and sugar diaries). They&rsquo;re read and put together into one history for the doctor to confirm.</span>
          <div><button className="btn primary" disabled={busy} onClick={() => start("start")}>{busy ? <span className="spin" /> : null} Add past records</button></div>
        </div>
      ) : (
        <div className="stack">
          {open && <span><span className="badge warn">{d.isUpdate ? `Adding records: ${(LABEL[open.status] ?? open.status).toLowerCase()}` : LABEL[open.status] ?? open.status}</span> <span className="muted">{d.progress?.total ?? 0} record{d.progress?.total === 1 ? "" : "s"} added</span></span>}
          {c?.summary && (
            <>
              <small className="muted">Confirmed by {c.confirmedBy ?? "the doctor"}{c.confirmedAt ? ` · ${fmtDateTime(c.confirmedAt)}` : ""}. Built from past records; each entry links to its source.{open ? " Records being added show here once the doctor confirms them." : ""}</small>
              <HistoryView history={c.summary} only={full ? undefined : ["snapshot", "alerts", "conditions", "medicines"]} />
              {full && c.points.some((p) => p.answer?.trim()) && (
                <div>
                  <h4 style={{ margin: "0 0 6px" }}>Confirmed at onboarding</h4>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{c.points.filter((p) => p.answer?.trim()).map((p, i) => <li key={i}><b>{p.title}:</b> {p.answer}</li>)}</ul>
                </div>
              )}
              <div><button className="btn sm ghost" onClick={() => setFull(!full)}>{full ? "Show less" : "Show the full history (all 13 sections)"}</button></div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
