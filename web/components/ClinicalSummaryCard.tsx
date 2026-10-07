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

  return (
    <div className="card" style={{ border: "1px solid var(--border-color, #e0e0e0)", marginBottom: 16 }}>
      <div className="row between" style={{ alignItems: "flex-start", marginBottom: 14 }}>
        <div className="row" style={{ gap: 10 }}>
          <span style={{ fontSize: 24 }}>✨</span>
          <div>
            <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
              Comprehensive Clinical AI Summary
              {summary && (
                <span className={`badge ${isGemini ? "brand" : ""}`} style={{ fontSize: 11, fontWeight: 500 }}>
                  {isGemini ? `✨ ${summary.model}` : "🟢 Clinical Rules"}
                </span>
              )}
            </h3>
            <small className="muted">
              Pre-consultation clinical synthesis across vitals, labs, fluid balance, adherence, and cross-doctor care.
              {summary && (preparedAt ? ` Prepared automatically before the visit (${fmtDateTime(preparedAt)}). Refresh for the latest.`
                : summary.reusedFrom ? ` Generated ${fmtDateTime(summary.reusedFrom)}; nothing has changed in the record since, so it was reused.`
                : ` Generated ${fmtDateTime(summary.generatedAt)}.`)}
            </small>
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn sm"
            onClick={() => loadSummary(true)}
            disabled={loading}
            title="Regenerate summary with latest patient telemetry"
          >
            {loading ? <span className="spin" /> : "↻"} Refresh AI Summary
          </button>
        </div>
      </div>

      {error && (
        <div className="alert bad" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {loading && !summary && (
        <div className="empty" style={{ padding: "24px 0" }}>
          <span className="spin" />
          <div style={{ marginTop: 8 }}>Generating comprehensive clinical summary for {patientName}…</div>
        </div>
      )}

      {summary && (
        <div className="stack" style={{ gap: 16 }}>
          {/* 1. Executive Summary */}
          <div style={{ padding: "12px 14px", background: "rgba(26, 115, 232, 0.06)", borderRadius: 8, borderLeft: "4px solid #1a73e8" }}>
            <b style={{ color: "#1a73e8", fontSize: 13, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Executive Clinical Overview
            </b>
            <div style={{ marginTop: 4, fontSize: 14.5, lineHeight: 1.5, color: "var(--ink-1)" }}>
              {summary.executiveSummary}
            </div>
          </div>

          {/* Without AI there are no section paragraphs: the record's own key points instead */}
          {!summary.clinicalTrajectory && !summary.biometricAndFluidControl && summary.bullets?.length ? (
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: 1.5 }}>
              {summary.bullets.map((b, i) => <li key={i} style={{ marginBottom: 3 }}>{b}</li>)}
            </ul>
          ) : (
          /* 2-Column Clinical Grid */
          <div className="grid side" style={{ gap: 14 }}>
            {/* Trajectory & Biometrics */}
            <div className="stack" style={{ gap: 12 }}>
              <div className="card tight" style={{ background: "var(--bg-subtle, #f9f9f9)" }}>
                <b style={{ fontSize: 13 }}>📈 Clinical Trajectory & Stability</b>
                <p style={{ margin: "4px 0 0", fontSize: 13.5, lineHeight: 1.45 }}>{summary.clinicalTrajectory}</p>
              </div>

              <div className="card tight" style={{ background: "var(--bg-subtle, #f9f9f9)" }}>
                <b style={{ fontSize: 13 }}>⚖️ Biometric, Dry Weight & Fluid Control</b>
                <p style={{ margin: "4px 0 0", fontSize: 13.5, lineHeight: 1.45 }}>{summary.biometricAndFluidControl}</p>
              </div>

              <div className="card tight" style={{ background: "var(--bg-subtle, #f9f9f9)" }}>
                <b style={{ fontSize: 13 }}>🧪 Renal & Metabolic Panel (Creatinine / K+)</b>
                <p style={{ margin: "4px 0 0", fontSize: 13.5, lineHeight: 1.45 }}>{summary.renalMetabolicPanel}</p>
              </div>
            </div>

            {/* Adherence, Escalations, Cross-doctor */}
            <div className="stack" style={{ gap: 12 }}>
              <div className="card tight" style={{ background: "var(--bg-subtle, #f9f9f9)" }}>
                <b style={{ fontSize: 13 }}>💊 Treatment & Medication Adherence</b>
                <p style={{ margin: "4px 0 0", fontSize: 13.5, lineHeight: 1.45 }}>{summary.treatmentAdherence}</p>
              </div>

              <div className="card tight" style={{ background: "var(--bg-subtle, #f9f9f9)" }}>
                <b style={{ fontSize: 13 }}>🔔 Care Circle Escalations & Actions</b>
                <p style={{ margin: "4px 0 0", fontSize: 13.5, lineHeight: 1.45 }}>{summary.careCircleEscalations}</p>
              </div>

              <div className="card tight" style={{ background: "var(--bg-subtle, #f9f9f9)" }}>
                <b style={{ fontSize: 13 }}>🤝 Cross-Doctor Coordination</b>
                <p style={{ margin: "4px 0 0", fontSize: 13.5, lineHeight: 1.45 }}>{summary.crossDoctorReconciliation}</p>
              </div>
            </div>
          </div>
          )}

          {/* Consultation Discussion Points */}
          {summary.consultationDiscussionPoints && summary.consultationDiscussionPoints.length > 0 && (
            <div style={{ padding: "12px 14px", background: "var(--bg-subtle, #fafafa)", borderRadius: 8, border: "1px solid var(--border-color, #eee)" }}>
              <b style={{ fontSize: 13, color: "var(--ink-1)" }}>📋 Priority Discussion Points for Today&apos;s Consultation:</b>
              <ul style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 13.5, lineHeight: 1.5 }}>
                {summary.consultationDiscussionPoints.map((pt, idx) => (
                  <li key={idx} style={{ marginBottom: 4 }}>{pt}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
