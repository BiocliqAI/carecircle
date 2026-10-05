"use client";
// Doctor's Today: a triage queue. One reason per patient, sorted by priority; "Mark reviewed" clears it
// until something new happens. Pull-based only: CareCircle never pages the clinic.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, useSession } from "../client";
import { GettingStarted } from "../GettingStarted";
import { Icon } from "../Icon";
import { Spark } from "../Spark";
import type { PatientRow } from "../PatientTable";
import { useDrafts } from "../Drafts";
import { fmtDate, fmtTime, relDays } from "@/lib/time";
import { shortName } from "@/lib/types";

type Tab = "review" | "visits" | "onboarding" | "all";
const RANK: Record<string, number> = { urgent: 0, attention: 1, stable: 2 };

export function greeting(t: number) {
  const h = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(t));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function useDashboard() {
  const { bump, loading, user } = useSession();
  const [data, setData] = useState<{ now: number; patients: PatientRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ now: number; patients: PatientRow[] }>("/api/dashboard").then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => {
    if (!loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump, loading, user?.id]);
  return { data, error, reload: load };
}

export function DoctorToday() {
  const { user } = useSession();
  const { data, error, reload } = useDashboard();
  const { drafts } = useDrafts();
  const [tab, setTab] = useState<Tab>("review");
  const [q, setQ] = useState("");

  const lists = useMemo(() => {
    if (!data) return null;
    const t = data.now;
    const ps = data.patients;
    const week = (p: PatientRow) => p.nextVisitAt != null && relDays(t, p.nextVisitAt) >= 0 && relDays(t, p.nextVisitAt) <= 7;
    const review = ps.filter((p) => p.triage.needsReview).sort((a, b) => RANK[a.status] - RANK[b.status] || (b.triage.lastEventAt ?? 0) - (a.triage.lastEventAt ?? 0));
    const reviewedToday = ps.filter((p) => !p.triage.needsReview && p.triage.review && relDays(p.triage.review.at, t) === 0);
    return {
      t,
      review,
      reviewedToday,
      visits: ps.filter(week).sort((a, b) => (a.nextVisitAt ?? 0) - (b.nextVisitAt ?? 0)),
      onboarding: ps.filter((p) => !p.onboarding.hasVisit || p.onboarding.consentsPending > 0),
      all: [...ps].sort((a, b) => a.name.localeCompare(b.name)),
      openAlerts: ps.reduce((n, p) => n + p.open.length, 0),
      total: ps.length,
    };
  }, [data]);

  if (error) return <main className="page"><div className="alert bad">{error}. <Link href="/">Switch persona</Link></div></main>;
  if (!data || !lists) return <main className="page"><div className="empty"><span className="spin" /></div></main>;

  async function review(pid: string, undo = false) {
    await api(`/api/patients/${pid}/review`, { body: { undo } }).catch(() => undefined);
    reload();
  }
  const needle = q.trim().toLowerCase();
  const filt = (rows: PatientRow[]) => (needle ? rows.filter((p) => p.name.toLowerCase().includes(needle) || (p.conditions || "").toLowerCase().includes(needle)) : rows);
  const rows = filt(tab === "review" ? lists.review : tab === "visits" ? lists.visits : tab === "onboarding" ? lists.onboarding : lists.all);
  const name = user?.name.replace(/^Dr\.?\s*/, "").split(" ").slice(-1)[0];

  return (
    <main className="page" style={{ maxWidth: 1240 }}>
      <header className="v2-head">
        <div>
          <div className="date">{fmtDate(lists.t, { weekday: "long", day: "numeric", month: "long" })}</div>
          <h1>{greeting(lists.t)}{user?.role === "DOCTOR" ? `, Dr. ${name}` : ""}</h1>
        </div>
        <div className="v2-strip">
          <div><b style={{ color: lists.review.length ? "var(--c-red)" : undefined }}>{lists.review.length}</b><span>need review</span></div>
          <div><b>{lists.visits.length}</b><span>visits this week</span></div>
          <div><b style={{ color: lists.openAlerts ? "var(--c-amber)" : undefined }}>{lists.openAlerts}</b><span>{lists.openAlerts === 1 ? "alert" : "alerts"} with family</span></div>
          <div><b>{lists.total}</b><span>patients</span></div>
        </div>
      </header>

      <div className="stack gap16">
        <GettingStarted />

        <section className="v2-card" style={{ overflow: "hidden" }}>
          <div className="row between" style={{ borderBottom: "1px solid var(--c-line)", paddingRight: 14 }}>
            <nav className="v2-tabs" style={{ borderBottom: 0 }} aria-label="Patient lists">
              <button className={tab === "review" ? "on" : ""} onClick={() => setTab("review")}>Needs review <span className={`v2-count ${lists.review.length ? "red" : ""}`}>{lists.review.length}</span></button>
              <button className={tab === "visits" ? "on" : ""} onClick={() => setTab("visits")}>Visits this week <span className="v2-count">{lists.visits.length}</span></button>
              <button className={tab === "onboarding" ? "on" : ""} onClick={() => setTab("onboarding")}>Onboarding <span className="v2-count">{lists.onboarding.length + (drafts?.length ?? 0)}</span></button>
              <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>All patients <span className="v2-count">{lists.total}</span></button>
            </nav>
            <label className="v2-search"><Icon name="search" size={16} /><input aria-label="Search patients" placeholder="Search name or condition" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          </div>

          <div className="table-wrap">
            <table className="tq">
              <thead>
                <tr><th className="sr">Priority</th><th>Patient</th><th>Why it’s here</th><th>14-day trend</th><th style={{ textAlign: "right" }}>Adherence</th><th>Care circle</th><th>Next visit</th><th className="sr">Action</th></tr>
              </thead>
              <tbody className="num">
                {rows.map((p) => <TriageRow key={p.id} p={p} t={lists.t} action={tab === "review" ? <button className="v2-btn" onClick={() => review(p.id)}>Mark reviewed</button> : <Link className="v2-btn" href={`/patients/${p.id}`}>Open</Link>} />)}
                {!rows.length && (
                  <tr><td colSpan={8} className="tq-empty">{tab === "review" ? "Nothing needs review right now." : tab === "visits" ? "No visits in the next 7 days." : tab === "onboarding" ? "No one is being onboarded." : needle ? "No patients match." : "No patients yet."}</td></tr>
                )}
                {tab === "review" && lists.reviewedToday.length > 0 && (
                  <>
                    <tr><td colSpan={8} className="tq-group">Reviewed today · {lists.reviewedToday.length}</td></tr>
                    {filt(lists.reviewedToday).map((p) => (
                      <TriageRow key={p.id} p={p} t={lists.t} muted note={`Reviewed ${fmtTime(p.triage.review!.at)} by ${p.triage.review!.byId === user?.id ? "you" : p.triage.review!.by}`}
                        action={p.triage.review!.byId === user?.id ? <button className="tq-link" onClick={() => review(p.id, true)}>Undo</button> : <Link className="tq-link" href={`/patients/${p.id}`}>Open</Link>} />
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
          <div className="row between tq-foot">
            <span>Sorted by priority, then most recent. Patients return here when something new happens.</span>
            <span>Alerts go to the family care circle. The clinic is never paged.</span>
          </div>
        </section>

        <div className="grid g2">
          <section className="v2-card pad">
            <div className="row between" style={{ marginBottom: 6 }}><h2>Visits this week</h2><span className="v2-sub">{lists.visits.length}</span></div>
            {lists.visits.length === 0 && <div className="v2-sub" style={{ padding: "8px 0" }}>No visits in the next 7 days.</div>}
            {lists.visits.map((p) => (
              <Link key={p.id} href={`/patients/${p.id}/visit`} className="v2-list-row num">
                <span style={{ width: 64, fontWeight: 600 }}>{relDays(lists.t, p.nextVisitAt!) === 0 ? "Today" : fmtDate(p.nextVisitAt!, { weekday: "short", day: "numeric" })}</span>
                <span style={{ width: 48, color: "var(--c-mute)" }}>{fmtTime(p.nextVisitAt!)}</span>
                <span style={{ flex: 1, fontWeight: 600 }}>{p.name}</span>
                <span className="v2-sub">{p.prep?.readyAt ? "Brief ready" : "Not prepared yet"}</span>
              </Link>
            ))}
          </section>
          <section className="v2-card pad">
            <div className="row between" style={{ marginBottom: 6 }}><h2>Onboarding</h2><Link href="/patients/new" className="v2-sub" style={{ color: "var(--c-brand)", fontWeight: 600 }}>New patient</Link></div>
            {(drafts ?? []).map((d) => (
              <div key={d.id} className="v2-list-row"><span style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{d.name}</b><span className="v2-sub" style={{ display: "block" }}>Draft · saved {fmtDate(d.updated_at, { day: "numeric", month: "short" })}{d.updated_by_name ? ` by ${shortName(d.updated_by_name)}` : ""}</span></span><Link className="v2-btn" href={`/patients/new?draft=${d.id}`}>Resume</Link></div>
            ))}
            {lists.onboarding.map((p) => (
              <div key={p.id} className="v2-list-row"><span style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{p.name}</b><span className="v2-sub" style={{ display: "block" }}>{!p.onboarding.hasVisit ? "Awaiting Visit 1" : "Active"}{p.onboarding.consentsPending ? ` · ${p.onboarding.consentsPending} consent${p.onboarding.consentsPending > 1 ? "s" : ""} pending` : ""}</span></span><Link className="v2-btn" href={`/patients/${p.id}`}>Open</Link></div>
            ))}
            {!(drafts ?? []).length && !lists.onboarding.length && <div className="v2-sub" style={{ padding: "8px 0" }}>No one is being onboarded.</div>}
          </section>
        </div>
      </div>
    </main>
  );
}

export function TriageRow({ p, t, action, muted, note }: { p: PatientRow; t: number; action: React.ReactNode; muted?: boolean; note?: string }) {
  const tr = p.triage;
  const bar = muted || !p.onboarding.hasVisit ? "#C9D3D0" : p.status === "urgent" ? "#B42318" : p.status === "attention" ? "#D97706" : "#C9D3D0";
  const tone = muted ? "grey" : tr.trend?.bad ? (p.status === "urgent" ? "red" : "amber") : "brand";
  const meds = p.overall?.meds;
  return (
    <tr className={muted ? "muted" : ""}>
      <td style={{ paddingRight: 0, width: 6 }}><span className="tq-bar" style={{ background: bar }} title={p.status} /></td>
      <td>
        <Link href={`/patients/${p.id}`} className="tq-name">{p.name}</Link>
        <div className="v2-sub">{[p.age ? `${p.age} ${p.sex}` : p.sex, shortConditions(p.conditions)].filter(Boolean).join(" · ")}</div>
      </td>
      <td style={{ maxWidth: 300 }}>
        <div style={{ fontWeight: muted ? 500 : 600 }}>{tr.reason.title}</div>
        <div className="v2-sub">{note ?? tr.reason.detail}</div>
      </td>
      <td>{tr.trend ? <Spark points={tr.trend.points} lo={tr.trend.lo} hi={tr.trend.hi} tone={tone} label={`${tr.trend.label} over 14 days`} /> : <span className="v2-sub">—</span>}</td>
      <td style={{ textAlign: "right", fontWeight: 600, color: meds != null && meds < 80 && !muted ? "var(--c-amber)" : undefined }}>{meds != null ? `${meds}%` : "—"}</td>
      <td>
        <span className={`v2-pill ${muted ? "grey" : tr.circle.tone}`}>{tr.circle.tone === "green" && <Icon name="check" size={13} stroke={2.4} />}{tr.circle.tone === "amber" && <Icon name="clock" size={13} stroke={2.2} />}{tr.circle.label}</span>
        {tr.circle.detail && <div className="v2-sub" style={{ marginTop: 3 }}>{tr.circle.detail}</div>}
      </td>
      <td>{p.nextVisitAt ? <><div style={{ fontWeight: 600 }}>{relDays(t, p.nextVisitAt) === 0 ? "Today" : fmtDate(p.nextVisitAt, { weekday: "short", day: "numeric", month: "short" })}</div><div className="v2-sub">{fmtTime(p.nextVisitAt)}</div></> : <span className="v2-sub">—</span>}</td>
      <td style={{ textAlign: "right" }}>{action}</td>
    </tr>
  );
}

/** "Hypertension, Heart failure (EF 35%), Type 2 diabetes" → "Hypertension, Heart failure +1". */
export function shortConditions(c: string | null | undefined): string {
  const parts = (c || "").split(/,\s*|\s+·\s+/).map((x) => x.replace(/\s*\([^)]*\)/g, "").trim()).filter(Boolean);
  if (parts.length <= 2) return parts.join(", ");
  return `${parts.slice(0, 2).join(", ")} +${parts.length - 2}`;
}
