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

interface Resp { onboarding: { status: string; confirmedAt: number | null; confirmedBy: string | null } | null; draft: { summary: History; points: { title: string; answer?: string }[] } | null; progress: { total: number } | null }

const LABEL: Record<string, string> = { COLLECTING: "Records being added and read", REVIEW: "Being checked by the assistant", RETURNED: "Sent back by the doctor", SENT: "Waiting for the doctor to confirm" };

export function ClinicalHistoryCard({ pid }: { pid: string }) {
  const router = useRouter();
  const [d, setD] = useState<Resp | null>(null);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<Resp>(`/api/patients/${pid}/onboarding`).then(setD).catch((e) => setErr((e as Error).message)); }, [pid]);

  async function start() {
    setBusy(true);
    try {
      await api(`/api/patients/${pid}/onboarding`, { body: { action: "start" } });
      router.push(`/patients/${pid}/onboarding`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const o = d?.onboarding;
  return (
    <section className="card">
      <div className="card-head">
        <h3>Clinical history</h3>
        {o && <Link className="btn sm" href={`/patients/${pid}/onboarding`}>{o.status === "CONFIRMED" ? "Edit" : "Open"}</Link>}
      </div>
      {err && <div className="alert bad"><div>{err}</div></div>}
      {!d ? <span className="spin" /> : !o ? (
        <div className="stack">
          <span className="muted">Add the old records the family brought (notes, prescriptions, discharge summaries, lab reports, BP and sugar diaries). They&rsquo;re read and put together into one history for the doctor to confirm.</span>
          <div><button className="btn primary" disabled={busy} onClick={start}>{busy ? <span className="spin" /> : null} Add past records</button></div>
        </div>
      ) : o.status !== "CONFIRMED" ? (
        <div className="stack">
          <span><span className="badge warn">{LABEL[o.status] ?? o.status}</span> <span className="muted">{d.progress?.total ?? 0} record{d.progress?.total === 1 ? "" : "s"} added</span></span>
        </div>
      ) : d.draft ? (
        <div className="stack">
          <small className="muted">Confirmed by {o.confirmedBy ?? "the doctor"}{o.confirmedAt ? ` · ${fmtDateTime(o.confirmedAt)}` : ""}. Built from past records; each entry links to its source.</small>
          <HistoryView history={d.draft.summary} only={full ? undefined : ["snapshot", "alerts", "conditions", "medicines"]} />
          {full && d.draft.points.some((p) => p.answer?.trim()) && (
            <div>
              <h4 style={{ margin: "0 0 6px" }}>Confirmed at onboarding</h4>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{d.draft.points.filter((p) => p.answer?.trim()).map((p, i) => <li key={i}><b>{p.title}:</b> {p.answer}</li>)}</ul>
            </div>
          )}
          <div><button className="btn sm ghost" onClick={() => setFull(!full)}>{full ? "Show less" : "Show the full history (all 13 sections)"}</button></div>
        </div>
      ) : null}
    </section>
  );
}
