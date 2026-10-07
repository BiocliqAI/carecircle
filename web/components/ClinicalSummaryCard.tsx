"use client";
import { useEffect, useState } from "react";
import { api } from "./client";
import { fmtDateTime } from "@/lib/time";
import type { ClinicalSummaryResult } from "@/lib/gemini";

interface Props {
  patientId: string;
  patientName: string;
  onOpenSettings?: () => void;
}

export function ClinicalSummaryCard({ patientId, patientName, onOpenSettings }: Props) {
  const [summary, setSummary] = useState<ClinicalSummaryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparedAt, setPreparedAt] = useState<number | null>(null);

  async function loadSummary(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; summary: ClinicalSummaryResult; auto?: boolean; preparedAt?: number }>(
        `/api/patients/${patientId}/ai-summary`,
        refresh ? { method: "POST", body: { refresh: true } } : {}
      );
      if (res?.summary) {
        setSummary(res.summary);
        setPreparedAt(res.auto && res.preparedAt ? res.preparedAt : null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const isGemini = summary?.source?.startsWith("gemini");
  // Summaries saved before the bullet format only have paragraphs: show each as one point.
  const points = summary
    ? summary.bullets?.length
      ? summary.bullets
      : ([["Trend", summary.clinicalTrajectory], ["Readings & fluids", summary.biometricAndFluidControl], ["Labs", summary.renalMetabolicPanel], ["Adherence", summary.treatmentAdherence], ["Alerts", summary.careCircleEscalations], ["Other doctors", summary.crossDoctorReconciliation]] as const)
          .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)
    : [];
  const when = summary
    ? preparedAt ? `Prepared before the visit, ${fmtDateTime(preparedAt)}`
      : summary.reusedFrom ? `Nothing has changed since ${fmtDateTime(summary.reusedFrom)}, so that summary is shown`
      : `Generated ${fmtDateTime(summary.generatedAt)}`
    : "";

  return (
    <section className="card ai-sum">
      <div className="row between" style={{ alignItems: "baseline", gap: 8 }}>
        <h3 style={{ margin: 0 }}>✨ AI summary {summary && <span className={`badge ${isGemini ? "brand" : ""}`} style={{ fontSize: 11, fontWeight: 500 }}>{isGemini ? summary.model : "From the record (AI off)"}</span>}</h3>
        <button className="btn sm" onClick={() => loadSummary(true)} disabled={loading} title="Regenerate from the latest data (reused if nothing has changed)">
          {loading ? <span className="spin" /> : "↻"} Refresh
        </button>
      </div>
      {error && <div className="alert bad" style={{ marginTop: 10 }}>{error}</div>}
      {loading && !summary && <div className="muted" style={{ marginTop: 10 }}><span className="spin" /> Summarising {patientName}&rsquo;s record…</div>}
      {summary && (
        <>
          {summary.executiveSummary && <p className="ai-sum-head">{summary.executiveSummary}</p>}
          {points.length > 0 && <ul className="ai-sum-list">{points.map((b, i) => <li key={i}>{b}</li>)}</ul>}
          {summary.consultationDiscussionPoints?.length > 0 && (
            <>
              <div className="ai-sum-sub">Discuss today</div>
              <ul className="ai-sum-list">{summary.consultationDiscussionPoints.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </>
          )}
          <small className="muted">{when}. From this patient&rsquo;s record only; check anything important against the charts.</small>
        </>
      )}
    </section>
  );
}
