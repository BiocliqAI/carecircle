"use client";
// Patient list used by Today (filtered) and Patients (all). Pull-based: nothing here notifies the clinic.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ClinicalSummaryCard } from "./ClinicalSummaryCard";
import { fmtDate, fmtDateTime, relDays } from "@/lib/time";
import { VITAL_META, type VitalType } from "@/lib/types";
import type { Triage } from "@/lib/triage";

export interface PatientRow {
  id: string;
  name: string;
  age: number;
  sex: string;
  conditions: string;
  lastVisitAt: number | null;
  nextVisitAt: number | null;
  overall: { meds: number | null; physio: number | null; monitoring: number | null } | null;
  alertsSinceVisit: number;
  deviationsSinceVisit: number;
  symptoms: string[];
  latest: { type: VitalType; v1: number; v2: number | null; flag: string | null; observed_at: number }[];
  lastLog: number | null;
  status: "urgent" | "attention" | "stable";
  kidney?: {
    labOverdue: boolean;
    fluidYesterday: { in: number; out: number | null; limit: number | null } | null;
    pendingMedChanges: number;
    creatinine: { value: number; flag: string | null } | null;
  } | null;
  onboarding: { hasVisit: boolean; hasBaseline: boolean; consentsPending: number; consentsDeclined: number };
  doctorName: string | null;
  triage: Triage;
  prep?: { readyAt: number | null; readyBy: string | null } | null;
  open: { id: number; type: string; title: string; state: string; level: number; levelName: string | null; since: number; levelAt: number; ackBy: string | null }[];
}

const pctCls = (p: number | null | undefined) => (p == null ? "" : p >= 90 ? "good" : p >= 75 ? "warn" : "bad");

export function PatientTable({ rows, now: t, empty = "No patients match." }: { rows: PatientRow[]; now: number; empty?: string }) {
  const router = useRouter();
  const [selectedPatient, setSelectedPatient] = useState<PatientRow | null>(null);
  return (
    <>
      <div className="card" style={{ padding: 0 }}>
        <div className="pt-row" style={{ cursor: "default", fontSize: 12, color: "var(--ink-3)", fontWeight: 600 }}>
          <span />
          <span>Patient</span>
          <span>Latest readings</span>
          <span>Adherence since last visit</span>
          <span>Visits</span>
          <span>Care-circle status</span>
        </div>
        {rows.map((p) => (
          <div key={p.id} className="pt-row" onClick={() => router.push(`/patients/${p.id}`)}>
            <span className={`dot ${!p.onboarding.hasVisit ? "" : p.status === "urgent" ? "bad" : p.status === "attention" ? "warn" : "good"}`} title={!p.onboarding.hasVisit ? "No care plan yet" : p.status} />
            <div>
              <div className="name">{p.name}</div>
              <small>{[p.age ? `${p.age} ${p.sex}` : p.sex, p.conditions, p.doctorName].filter(Boolean).join(" · ")}</small>
              {!p.onboarding.hasVisit && <div><span className="badge info">Awaiting Visit 1</span></div>}
              {p.onboarding.consentsPending > 0 && <div><span className="badge warn">{p.onboarding.consentsPending} consent{p.onboarding.consentsPending > 1 ? "s" : ""} pending</span></div>}
              {p.symptoms.length > 0 && <div><small>Symptoms: {p.symptoms.join(", ")}</small></div>}
              {p.kidney && (
                <div className="row" style={{ marginTop: 4, gap: 4 }}>
                  {p.kidney.creatinine && <span className={`badge ${p.kidney.creatinine.flag ? "bad" : "brand"}`}>Creat {p.kidney.creatinine.value}</span>}
                  {p.kidney.labOverdue && <span className="badge bad">🧪 Lab overdue</span>}
                  {p.kidney.fluidYesterday && <span className={`badge ${p.kidney.fluidYesterday.limit && p.kidney.fluidYesterday.in > p.kidney.fluidYesterday.limit ? "bad" : ""}`}>💧 Yday {p.kidney.fluidYesterday.in} ml</span>}
                  {p.kidney.pendingMedChanges > 0 && <span className="badge warn">💊 {p.kidney.pendingMedChanges} med change{p.kidney.pendingMedChanges > 1 ? "s" : ""} to reconcile</span>}
                </div>
              )}
            </div>
            <div>
              {p.latest.map((v) => (
                <span key={v.type} className={`vchip ${v.flag || ""}`} title={`${VITAL_META[v.type]?.label} · ${fmtDateTime(v.observed_at)}`}>
                  {v.type === "bp" ? "BP" : v.type === "spo2" ? "SpO₂" : v.type === "hr" ? "HR" : v.type === "glucose" ? "Sugar" : v.type === "weight" ? "Wt" : VITAL_META[v.type]?.label}
                  <b>{v.v1}{v.v2 ? `/${v.v2}` : ""}</b>
                </span>
              ))}
              <div><small>Last WhatsApp log {p.lastLog ? fmtDateTime(p.lastLog) : "—"}</small></div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <span className={`badge ${pctCls(p.overall?.meds)}`}>💊 {p.overall?.meds ?? "—"}%</span>
              {p.overall?.physio != null && <span className={`badge ${pctCls(p.overall?.physio)}`}>🏃 {p.overall.physio}%</span>}
              <span className={`badge ${pctCls(p.overall?.monitoring)}`}>📏 {p.overall?.monitoring ?? "—"}%</span>
            </div>
            <div>
              <div><small>Last:</small> {p.lastVisitAt ? `${fmtDate(p.lastVisitAt, { day: "numeric", month: "short" })} (${relDays(p.lastVisitAt, t)}d ago)` : "—"}</div>
              <div>
                <small>Next:</small>{" "}
                {p.nextVisitAt ? (
                  <b style={{ color: relDays(t, p.nextVisitAt) <= 0 ? "var(--brand)" : undefined }}>
                    {relDays(t, p.nextVisitAt) === 0 ? `Today ${fmtDate(p.nextVisitAt, { hour: "numeric", minute: "2-digit" })}` : fmtDate(p.nextVisitAt, { day: "numeric", month: "short" })}
                  </b>
                ) : "—"}
              </div>
              {p.onboarding.hasVisit && <div style={{ marginTop: 4 }}>
                <button
                  className="btn sm"
                  style={{ fontSize: 11, padding: "2px 7px" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedPatient(p);
                  }}
                  title="View AI pre-visit clinical summary"
                >
                  ✨ AI Summary
                </button>
              </div>}
            </div>
            <div>
              {p.open.length ? (
                p.open.map((o) => (
                  <div key={o.id} className="row" style={{ gap: 6, marginBottom: 4 }}>
                    <span className={`badge ${o.type === "URGENT" ? "bad" : o.type === "DEVIATION" ? "warn" : "info"}`}>{o.title}</span>
                    <small>
                      {o.state === "ACKNOWLEDGED" ? `owned by ${o.ackBy}` : `L${o.level} ${o.levelName?.split(" ")[0] ?? ""} · ${Math.round((t - o.levelAt) / 60000)} min, no reply yet`}
                    </small>
                  </div>
                ))
              ) : (
                <small>No open alerts · {p.alertsSinceVisit} since last visit ({p.deviationsSinceVisit} deviations)</small>
              )}
            </div>
          </div>
        ))}
        {!rows.length && <div className="empty">{empty}</div>}
      </div>

      {selectedPatient && (
        <div className="modal-backdrop" onClick={() => setSelectedPatient(null)} style={{ zIndex: 9999 }}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 840, maxHeight: "90vh", overflowY: "auto" }}>
            <div className="row between" style={{ marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0 }}>Pre-Consultation Clinical Synthesis</h3>
                <small className="muted">{selectedPatient.name} · {selectedPatient.conditions}</small>
              </div>
              <button className="btn sm" style={{ background: "transparent", border: 0 }} onClick={() => setSelectedPatient(null)}>✕</button>
            </div>
            <ClinicalSummaryCard patientId={selectedPatient.id} patientName={selectedPatient.name} />
            <div className="row end" style={{ marginTop: 14 }}>
              <button className="btn" onClick={() => setSelectedPatient(null)}>Close</button>
              <button className="btn primary" onClick={() => router.push(`/patients/${selectedPatient.id}`)}>Open Full Patient Chart →</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
