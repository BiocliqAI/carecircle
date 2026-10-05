"use client";
// Unfinished onboardings saved from the wizard. Resume reopens the wizard at the saved step.
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useSession } from "./client";
import { fmtDateTime } from "@/lib/time";

export interface Draft {
  id: string;
  name: string;
  step: number;
  updated_at: number;
  updated_by_name: string | null;
}

const STEP = ["Patient details", "Care circle", "Baseline", "Review"];

export function useDrafts() {
  const { bump, loading } = useSession();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const load = () => api<{ drafts: Draft[] }>("/api/drafts").then((r) => setDrafts(r.drafts)).catch(() => setDrafts([]));
  useEffect(() => {
    if (!loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump, loading]);
  return { drafts, reload: load };
}

export function DraftList({ drafts, onChange }: { drafts: Draft[]; onChange: () => void }) {
  if (!drafts.length) return null;
  async function discard(d: Draft) {
    if (!window.confirm(`Discard the onboarding draft for ${d.name}? Nothing has been sent to them yet.`)) return;
    await api("/api/drafts", { body: { action: "discard", id: d.id } }).catch(() => undefined);
    onChange();
  }
  return (
    <div className="card" style={{ padding: 0 }}>
      {drafts.map((d) => (
        <div key={d.id} className="draft-row">
          <span className="draft-ic" aria-hidden>📝</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>{d.name}</b>
            <div className="muted">
              Next: {STEP[d.step] ?? "Review"} · saved {fmtDateTime(d.updated_at)}{d.updated_by_name ? ` by ${d.updated_by_name}` : ""}
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm ghost" onClick={() => discard(d)}>Discard</button>
            <Link className="btn sm primary" href={`/patients/new?draft=${d.id}`}>Resume →</Link>
          </div>
        </div>
      ))}
    </div>
  );
}
