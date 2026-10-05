"use client";
// All patients the signed-in clinician can see, with search and quick filters.
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useSession } from "@/components/client";
import { PatientTable, type PatientRow } from "@/components/PatientTable";

const FILTERS: [string, string, (p: PatientRow) => boolean][] = [
  ["all", "All", () => true],
  ["attention", "Needs attention", (p) => p.status !== "stable" && p.onboarding.hasVisit],
  ["novisit", "Awaiting Visit 1", (p) => !p.onboarding.hasVisit],
  ["consent", "Consent pending", (p) => p.onboarding.consentsPending > 0],
  ["nobaseline", "No baseline", (p) => !p.onboarding.hasBaseline],
];

export default function Patients() {
  const { user, bump, loading } = useSession();
  const [data, setData] = useState<{ now: number; patients: PatientRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [f, setF] = useState("all");

  useEffect(() => {
    if (loading) return;
    api<{ now: number; patients: PatientRow[] }>("/api/dashboard").then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [bump, loading, user?.id]);

  if (error) return <main className="page"><div className="alert bad">{error}. <Link href="/">Sign in</Link></div></main>;
  if (!data) return <main className="page"><div className="empty"><span className="spin" /> Loading…</div></main>;
  const filter = FILTERS.find((x) => x[0] === f)![2];
  const needle = q.trim().toLowerCase();
  const rows = data.patients
    .filter(filter)
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.conditions || "").toLowerCase().includes(needle) || (p.doctorName || "").toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Patients</h1>
          <div className="muted">{data.patients.length} {user?.role === "PA" ? "in the clinic" : "under your care"}</div>
        </div>
        <div className="row">
          <input placeholder="Search name, condition or doctor…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} />
          <Link href="/patients/new" className="btn primary">+ Onboard patient</Link>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14, gap: 6 }}>
        {FILTERS.map(([k, label, fn]) => (
          <button key={k} className={`chip-btn ${f === k ? "on" : ""}`} onClick={() => setF(k)}>
            {label} <span className="muted">{data.patients.filter(fn).length}</span>
          </button>
        ))}
      </div>
      <PatientTable rows={rows} now={data.now} empty={data.patients.length ? "No patients match." : "No patients yet. Onboard one to get started."} />
    </main>
  );
}
