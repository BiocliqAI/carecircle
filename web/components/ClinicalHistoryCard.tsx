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
  versions: { id: number; n: number; confirmedAt: number; confirmedBy: string | null; records: number; kind: "first" | "update" }[];
}

const LABEL: Record<string, string> = { COLLECTING: "Records being added and read", REVIEW: "Being checked by the assistant", RETURNED: "Sent back by the doctor", SENT: "Waiting for the doctor to confirm" };

export function ClinicalHistoryCard({ pid }: { pid: string }) {
  const router = useRouter();
  const [d, setD] = useState<Resp | null>(null);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [old, setOld] = useState<{ n: number; summary: History; confirmedBy: string | null; confirmedAt: number } | null>(null);
  async function view(v: Resp["versions"][number]) {
    try {
      const r = await api<{ summary: History }>(`/api/patients/${pid}/onboarding?version=${v.id}`);
      setOld({ n: v.n, summary: r.summary, confirmedBy: v.confirmedBy, confirmedAt: v.confirmedAt });
    } catch (e) { setErr((e as Error).message); }
  }
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
          {c && !open && <button className="btn sm" disabled={busy} title="Corrections and new records are marked for the doctor to confirm; this version is kept" onClick={() => start("update")}>{busy ? <span className="spin" /> : null} Correct or add records</button>}
          {open && <Link className="btn sm" href={`/patients/${pid}/onboarding`}>Open</Link>}
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
          {(d.versions?.length ?? 0) > 0 && (
            <details>
              <summary className="muted">Versions ({d.versions.length}) · locked once confirmed</summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {d.versions.map((v, i) => (
                  <li key={v.id} style={{ padding: "2px 0" }}>
                    <b>v{v.n}</b> · {v.kind === "first" ? "first history" : "update"}, {v.records} record{v.records === 1 ? "" : "s"} · confirmed by {v.confirmedBy ?? "the doctor"}, {fmtDateTime(v.confirmedAt)}{i === 0 ? " · current" : ""}
                    {" "}<button className="tq-link" onClick={() => view(v)}>View</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {old && (
            <div className="card" style={{ background: "var(--bg-2, #F7F9F8)" }}>
              <div className="card-head"><h4 style={{ margin: 0 }}>Version {old.n} · confirmed by {old.confirmedBy ?? "the doctor"}, {fmtDateTime(old.confirmedAt)}</h4><button className="btn sm ghost" onClick={() => setOld(null)}>Close</button></div>
              <HistoryView history={old.summary} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
