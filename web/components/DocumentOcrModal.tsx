"use client";
import { useState } from "react";
import { api } from "./client";
import type { OCROutput } from "@/lib/gemini";

interface Props {
  open: boolean;
  onClose: () => void;
  patientId: string;
  patientName: string;
  onCommitted?: () => void;
}

const SAMPLE_DOCS = [
  {
    id: "RX_MANOJ_SHAH",
    title: "Handwritten Prescription — Dr. Manoj Shah (Diabetology)",
    category: "Prescription",
    previewText: "Dr. Manoj Shah, MD · Rx for Mr. A Gopal · Tab Prizide MR 30 mg before breakfast (reduced from 60 mg) · Pantocid DSR 40 mg",
  },
  {
    id: "LAB_VIJAYA",
    title: "Biochemistry Lab Report — Vijaya Clinical Laboratories",
    category: "Lab Report",
    previewText: "Vijaya Clinical Laboratories · Patient: A Gopal (78/M) · Creatinine: 3.01 mg/dL, Blood Urea: 96 mg/dL, K: 4.9 mmol/L, eGFR: 21",
  },
  {
    id: "DIARY_HOME",
    title: "Handwritten Home Monitoring Diary — Daily Sugar & BP Log",
    category: "Vitals Diary",
    previewText: "Daily Home Monitoring Diary · Morning 7:30 AM: Wt 59.3 kg, BP 124/66, Pulse 72, Fasting Sugar 104 mg/dL · Fluid intake: 950 ml",
  },
];

export function DocumentOcrModal({ open, onClose, patientId, patientName, onCommitted }: Props) {
  const [mode, setMode] = useState<"sample" | "upload">("sample");
  const [selectedSample, setSelectedSample] = useState(SAMPLE_DOCS[0].id);
  const [uploadedBase64, setUploadedBase64] = useState<string | null>(null);
  const [uploadedMime, setUploadedMime] = useState<string>("image/png");
  const [uploadedFileName, setUploadedFileName] = useState<string>("");
  const [analyzing, setAnalyzing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<OCROutput | null>(null);
  const [committedMsg, setCommittedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedFileName(file.name);
    setUploadedMime(file.type || "image/png");
    const reader = new FileReader();
    reader.onload = () => {
      setUploadedBase64(reader.result as string);
      setResult(null);
      setCommittedMsg(null);
      setError(null);
    };
    reader.readAsDataURL(file);
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    setError(null);
    setCommittedMsg(null);
    try {
      const payload: { imageBase64?: string; sampleId?: string; mimeType: string; patientId: string } = {
        mimeType: mode === "upload" ? uploadedMime : "image/png",
        patientId,
      };
      if (mode === "upload" && uploadedBase64) {
        payload.imageBase64 = uploadedBase64;
      } else {
        payload.sampleId = selectedSample;
        payload.imageBase64 = `SAMPLE_${selectedSample}`;
      }

      const res = await api<{ ok: boolean; ocr: OCROutput }>("/api/ocr", {
        body: payload,
      });
      if (res?.ocr) {
        setResult(res.ocr);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleCommit() {
    if (!result) return;
    setCommitting(true);
    setError(null);
    try {
      const payload: { imageBase64: string; mimeType: string; patientId: string; commit: boolean } = {
        imageBase64: mode === "upload" && uploadedBase64 ? uploadedBase64 : `SAMPLE_${selectedSample}`,
        mimeType: mode === "upload" ? uploadedMime : "image/png",
        patientId,
        commit: true,
      };
      const res = await api<{ ok: boolean; committed: { labs: number; observations: number; medChanges: number } }>("/api/ocr", {
        body: payload,
      });
      const c = res.committed;
      setCommittedMsg(
        `✅ Successfully charted to ${patientName}'s record: ${c.labs} labs, ${c.observations} vitals, and ${c.medChanges} medication adjustments!`
      );
      if (onCommitted) onCommitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 9999 }}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, maxHeight: "90vh", overflowY: "auto" }}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <div className="row" style={{ gap: 10 }}>
            <span style={{ fontSize: 24 }}>📷</span>
            <div>
              <h3 style={{ margin: 0 }}>Intake Handwritten Clinical Document & OCR</h3>
              <small className="muted">
                Extract handwritten prescriptions, lab reports, and vitals diaries using Gemini Vision AI for {patientName}.
              </small>
            </div>
          </div>
          <button className="btn sm" style={{ background: "transparent", border: 0 }} onClick={onClose}>✕</button>
        </div>

        {/* Mode selector */}
        <div className="tabs" style={{ marginBottom: 16 }}>
          <button className={mode === "sample" ? "active" : ""} onClick={() => { setMode("sample"); setResult(null); setError(null); }}>
            📁 Pre-Loaded Clinical Documents (1-Click)
          </button>
          <button className={mode === "upload" ? "active" : ""} onClick={() => { setMode("upload"); setResult(null); setError(null); }}>
            📤 Upload Photo or Scan
          </button>
        </div>

        {mode === "sample" && (
          <div className="stack" style={{ gap: 10, marginBottom: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Select a sample handwritten document:</label>
            {SAMPLE_DOCS.map((doc) => (
              <div
                key={doc.id}
                onClick={() => { setSelectedSample(doc.id); setResult(null); }}
                className="card tight"
                style={{
                  cursor: "pointer",
                  border: selectedSample === doc.id ? "2px solid #1a73e8" : "1px solid var(--border-color, #e0e0e0)",
                  background: selectedSample === doc.id ? "rgba(26, 115, 232, 0.05)" : "var(--bg-subtle, #fafafa)",
                }}
              >
                <div className="row between">
                  <b>{doc.title}</b>
                  <span className="badge brand">{doc.category}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--ink-2)", fontFamily: "monospace" }}>
                  {doc.previewText}
                </div>
              </div>
            ))}
          </div>
        )}

        {mode === "upload" && (
          <div className="stack" style={{ gap: 10, marginBottom: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Upload an image file (PNG, JPG, WEBP):</label>
            <input type="file" accept="image/*" onChange={handleFileUpload} />
            {uploadedBase64 && (
              <div style={{ marginTop: 8, padding: 8, border: "1px dashed var(--border-color)", borderRadius: 6 }}>
                <small className="muted">Selected file: {uploadedFileName} ({uploadedMime})</small>
                <div style={{ marginTop: 6, maxHeight: 180, overflow: "hidden", display: "flex", justifyContent: "center", background: "#000" }}>
                  <img src={uploadedBase64} alt="Document preview" style={{ maxHeight: 180, objectFit: "contain" }} />
                </div>
              </div>
            )}
          </div>
        )}

        {error && <div className="alert bad" style={{ marginBottom: 14 }}>{error}</div>}
        {committedMsg && <div className="alert good" style={{ marginBottom: 14 }}>{committedMsg}</div>}

        {!result && (
          <div className="row end" style={{ gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={handleAnalyze} disabled={analyzing || (mode === "upload" && !uploadedBase64)}>
              {analyzing ? <span className="spin" /> : "✨"} Run Gemini Vision OCR
            </button>
          </div>
        )}

        {result && (
          <div className="stack" style={{ gap: 14, marginTop: 12, borderTop: "1px solid var(--border-color, #eee)", paddingTop: 14 }}>
            <div className="row between">
              <div>
                <b style={{ fontSize: 15 }}>{result.documentTypeName}</b>
                {result.prescriber && <div className="muted" style={{ fontSize: 12 }}>Prescriber / Doctor: {result.prescriber}</div>}
                {result.documentDate && <div className="muted" style={{ fontSize: 12 }}>Date: {result.documentDate}</div>}
              </div>
              <span className="badge brand">✨ {result.source}</span>
            </div>

            {/* Verbatim transcription block */}
            <div className="card tight" style={{ background: "#f8f9fa", border: "1px solid #e9ecef" }}>
              <b style={{ fontSize: 12, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Verbatim Document Transcription:
              </b>
              <pre style={{ margin: "6px 0 0", fontSize: 12.5, whiteSpace: "pre-wrap", fontFamily: "monospace", color: "#212529" }}>
                {result.transcription}
              </pre>
            </div>

            {/* Extracted Entities */}
            <div className="grid side" style={{ gap: 10 }}>
              {/* Labs */}
              <div className="card tight" style={{ background: "var(--bg-subtle)" }}>
                <b style={{ fontSize: 12.5 }}>🧪 Extracted Labs ({result.extracted.labs.length})</b>
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  {result.extracted.labs.map((l, i) => (
                    <span key={i} className={`badge ${l.flag === "high" || l.flag === "critical" ? "bad" : "brand"}`}>
                      {l.label}: <b>{l.value} {l.unit}</b> {l.flag ? `[${l.flag.toUpperCase()}]` : ""}
                    </span>
                  ))}
                  {!result.extracted.labs.length && <small className="muted">None in this document</small>}
                </div>
              </div>

              {/* Vitals */}
              <div className="card tight" style={{ background: "var(--bg-subtle)" }}>
                <b style={{ fontSize: 12.5 }}>📊 Extracted Vitals ({result.extracted.vitals.length})</b>
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  {result.extracted.vitals.map((v, i) => (
                    <span key={i} className="badge brand">
                      {v.label}: <b>{v.v1}{v.v2 ? `/${v.v2}` : ""} {v.unit}</b>
                    </span>
                  ))}
                  {!result.extracted.vitals.length && <small className="muted">None in this document</small>}
                </div>
              </div>
            </div>

            {/* Medications */}
            {result.extracted.medications.length > 0 && (
              <div className="card tight" style={{ background: "var(--bg-subtle)" }}>
                <b style={{ fontSize: 12.5 }}>💊 Extracted Medication Instructions ({result.extracted.medications.length})</b>
                <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                  {result.extracted.medications.map((m, i) => (
                    <div key={i} className="row between" style={{ fontSize: 13, background: "#fff", padding: "6px 10px", borderRadius: 4 }}>
                      <div>
                        <b>{m.name}</b> {m.dose} — <i>{m.instructions || m.change}</i>
                      </div>
                      {m.prescriber && <small className="muted">{m.prescriber}</small>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="row between" style={{ marginTop: 8 }}>
              <button className="btn" onClick={() => setResult(null)}>
                ← Try Another Document
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" onClick={onClose}>Close</button>
                <button className="btn primary" onClick={handleCommit} disabled={committing || !!committedMsg}>
                  {committing ? <span className="spin" /> : "📥"} Commit to Patient Chart
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
