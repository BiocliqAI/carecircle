"use client";
// Today: the clinic's landing page. Pull-based visibility only; CareCircle never pages the clinic.
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useSession } from "@/components/client";
import { GettingStarted } from "@/components/GettingStarted";
import { PatientTable, type PatientRow } from "@/components/PatientTable";
import { fmtDate, relDays } from "@/lib/time";
import { shortName } from "@/lib/types";

export default function Today() {
  const { user, bump, loading } = useSession();
  const [data, setData] = useState<{ now: number; patients: PatientRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    api<{ now: number; patients: PatientRow[] }>("/api/dashboard").then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [bump, loading, user?.id]);

  if (error) return <main className="page"><div className="alert bad">{error}. <Link href="/">Sign in</Link></div></main>;
  if (!data) return <main className="page"><div className="empty"><span className="spin" /> Loading…</div></main>;
  const t = data.now;
  const ps = data.patients;
  const dueSoon = ps.filter((p) => p.nextVisitAt && relDays(t, p.nextVisitAt) <= 1 && relDays(t, p.nextVisitAt) >= 0);
  const attention = ps.filter((p) => p.status !== "stable" && p.onboarding.hasVisit);
  const onboarding = ps.filter((p) => !p.onboarding.hasVisit || p.onboarding.consentsPending > 0);
  const openAlerts = ps.flatMap((p) => p.open.map((o) => ({ ...o, patient: p })));

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <div className="muted">{fmtDate(t, { weekday: "long", day: "numeric", month: "long" })} · {user?.name}</div>
        </div>
        <Link href="/patients/new" className="btn primary">+ Onboard patient</Link>
      </div>

      <div className="stack gap16">
        <GettingStarted />

        <div className="grid stats-grid">
          <Stat label="Patients under monitoring" value={ps.length} href="/patients" />
          <Stat label="Visits today / tomorrow" value={dueSoon.length} detail={dueSoon.map((p) => shortName(p.name)).join(", ")} />
          <Stat label="Open alerts (family handling)" value={openAlerts.length} tone={openAlerts.length ? "warn" : "good"} detail={openAlerts.map((o) => `${shortName(o.patient.name)}: ${o.title}`).join(" · ")} />
          <Stat label="Onboarding in progress" value={onboarding.length} tone={onboarding.length ? "warn" : undefined} detail={onboarding.map((p) => shortName(p.name)).join(", ")} />
        </div>

        {ps.length === 0 ? (
          <div className="card empty-state">
            <h2>No patients yet</h2>
            <p className="muted">Onboard a patient with their family care circle and baseline. Their WhatsApp starts working after Visit 1.</p>
            <Link href="/patients/new" className="btn primary">+ Onboard your first patient</Link>
          </div>
        ) : (
          <>
            <Section title="Needs attention" sub="Open alerts, recent deviations or low adherence, most urgent first" rows={attention} now={t} empty="Nobody needs attention right now." />
            {dueSoon.length > 0 && <Section title="Visits today & tomorrow" sub="Open a patient for the pre-visit brief" rows={dueSoon} now={t} />}
            {onboarding.length > 0 && <Section title="Onboarding in progress" sub="Waiting for Visit 1 or for WhatsApp consent" rows={onboarding} now={t} />}
            <div className="callout">
              You only see this information here. CareCircle never pages the clinic. When a reading drifts from the doctor’s limits, the patient’s family care circle is alerted on WhatsApp and asked to contact you.
            </div>
            <div><Link href="/patients">All patients ({ps.length}) →</Link></div>
          </>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value, detail, tone, href }: { label: string; value: number; detail?: string; tone?: "good" | "warn"; href?: string }) {
  const body = (
    <div className="stat">
      <span className="l">{label}</span>
      <span className={`v ${tone ?? ""}`}>{value}</span>
      {detail ? <span className="l clamp">{detail}</span> : null}
    </div>
  );
  return href ? <Link href={href} className="card stat-card">{body}</Link> : <div className="card">{body}</div>;
}

function Section({ title, sub, rows, now, empty }: { title: string; sub: string; rows: PatientRow[]; now: number; empty?: string }) {
  return (
    <section className="stack">
      <div className="section-head"><h2>{title}</h2><small>{sub}</small></div>
      {rows.length ? <PatientTable rows={rows} now={now} /> : <div className="card muted">{empty}</div>}
    </section>
  );
}
