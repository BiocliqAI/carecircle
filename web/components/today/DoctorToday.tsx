"use client";
// Doctor's Today: a triage queue. One reason per patient, sorted by priority; "Mark reviewed" clears it
// until something new happens. Pull-based only: CareCircle never pages the clinic.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, useSession } from "../client";
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

interface Activity { at: number; kind: string; patientId: string; patient: string; text: string }
type DTab = "review" | "visits" | "onboarding";

export function DoctorToday() {
  const { user } = useSession();
  const { data, error, reload } = useDashboard();
  const { drafts } = useDrafts();
  const [tab, setTab] = useState<DTab>("review");

  const L = useMemo(() => {
    if (!data) return null;
    const t = data.now;
    const ps = data.patients;
    const inWeek = (p: PatientRow) => p.nextVisitAt != null && relDays(t, p.nextVisitAt) >= 0 && relDays(t, p.nextVisitAt) <= 7;
    const review = ps.filter((p) => p.triage.needsReview).sort((a, b) => RANK[a.status] - RANK[b.status] || (b.triage.lastEventAt ?? 0) - (a.triage.lastEventAt ?? 0));
    const reviewedToday = ps.filter((p) => !p.triage.needsReview && p.triage.review && relDays(p.triage.review.at, t) === 0);
    const visits = ps.filter(inWeek).sort((a, b) => (a.nextVisitAt ?? 0) - (b.nextVisitAt ?? 0));
    const onboarding = ps.filter((p) => !p.onboarding.hasVisit || p.onboarding.consentsPending > 0);
    const handling = ps.filter((p) => p.open.length > 0);
    const activity = ((data as unknown as { activity?: Activity[] }).activity ?? []);
    const closedToday = activity.filter((a) => a.kind === "closed").length;
    return { t, ps, review, reviewedToday, visits, onboarding, handling, activity, closedToday, next: visits[0] ?? null };
  }, [data]);

  if (error) return <main className="page"><div className="alert bad">{error}. <Link href="/">Switch persona</Link></div></main>;
  if (!data || !L) return <main className="page"><div className="empty"><span className="spin" /></div></main>;

  async function review(pid: string, undo = false) {
    await api(`/api/patients/${pid}/review`, { body: { undo } }).catch(() => undefined);
    reload();
  }
  const name = user?.name.replace(/^Dr\.?\s*/, "").split(" ").slice(-1)[0];
  const summary = [
    L.review.length ? `${L.review.length} patient${L.review.length > 1 ? "s need" : " needs"} your review` : "Nothing needs your review",
    L.closedToday ? `families closed ${L.closedToday} alert${L.closedToday > 1 ? "s" : ""} today` : L.handling.length ? `${L.handling.length} alert${L.handling.length > 1 ? "s are" : " is"} with families` : "",
  ].filter(Boolean).join(" · ");
  const list = tab === "review" ? L.review : tab === "visits" ? L.visits : L.onboarding;

  return (
    <main className="page dt" style={{ maxWidth: 1280 }}>
      <header className="dt-head">
        <div>
          <div className="dt-date">{fmtDate(L.t, { weekday: "long", day: "numeric", month: "long" })}</div>
          <h1>{greeting(L.t)}{user?.role === "DOCTOR" ? `, Dr. ${name}` : ""}</h1>
          <p className="dt-summary">{summary}.</p>
        </div>
        {L.next && (
          <Link href={`/patients/${L.next.id}/visit`} className="dt-next">
            <span className="dt-next-k">Next visit</span>
            <span className="dt-next-v">{L.next.name}</span>
            <span className="dt-next-t num">{relDays(L.t, L.next.nextVisitAt!) === 0 ? "Today" : fmtDate(L.next.nextVisitAt!, { weekday: "short", day: "numeric", month: "short" })}, {fmtTime(L.next.nextVisitAt!)} · {L.next.prep?.readyAt ? "brief ready" : "not prepared yet"}</span>
            <Icon name="arrowRight" size={18} />
          </Link>
        )}
      </header>

      <section className="dt-tiles">
        <button className={`dt-tile ${tab === "review" ? "on" : ""} ${L.review.length ? "hot" : ""}`} onClick={() => setTab("review")}>
          <span className="dt-tile-n num">{L.review.length}</span>
          <span className="dt-tile-l">Need your review</span>
          <span className="dt-tile-d">{L.review[0] ? `${L.review[0].name.split(" ")[0]}: ${L.review[0].triage.reason.title.toLowerCase()}` : "All caught up"}</span>
        </button>
        <div className="dt-tile static">
          <span className="dt-tile-n num">{L.handling.length}</span>
          <span className="dt-tile-l">Alerts families are handling</span>
          <span className="dt-tile-d">{L.handling.length ? L.handling.map((p) => p.name.split(" ")[0]).join(", ") : "None open"} · the clinic is never paged</span>
        </div>
        <button className={`dt-tile ${tab === "visits" ? "on" : ""}`} onClick={() => setTab("visits")}>
          <span className="dt-tile-n num">{L.visits.length}</span>
          <span className="dt-tile-l">Visits this week</span>
          <span className="dt-tile-d">{L.visits.length ? `${L.visits.filter((v) => v.prep?.readyAt).length} of ${L.visits.length} prepared` : "None booked"}</span>
        </button>
      </section>

      <div className="v2-grid12">
        <section className="span8 stack gap16">
          <div className="dt-seg" role="tablist" aria-label="Lists">
            <button role="tab" aria-selected={tab === "review"} className={tab === "review" ? "on" : ""} onClick={() => setTab("review")}>Needs review <span className="num">{L.review.length}</span></button>
            <button role="tab" aria-selected={tab === "visits"} className={tab === "visits" ? "on" : ""} onClick={() => setTab("visits")}>Visits this week <span className="num">{L.visits.length}</span></button>
            <button role="tab" aria-selected={tab === "onboarding"} className={tab === "onboarding" ? "on" : ""} onClick={() => setTab("onboarding")}>Onboarding <span className="num">{L.onboarding.length + (drafts?.length ?? 0)}</span></button>
            <Link href="/patients" className="dt-all">All patients ({L.ps.length}) <Icon name="arrowRight" size={15} /></Link>
          </div>

          {list.length === 0 && tab === "review" && (
            <div className="dt-clear">
              <span className="dt-clear-ic"><Icon name="check" size={22} stroke={2.4} /></span>
              <div><b>You’re all caught up.</b><div className="v2-sub" style={{ fontSize: 14 }}>{L.handling.length ? "Families are handling the open alerts. They’ll contact the clinic if needed." : "No alerts or concerning readings need you right now."}</div></div>
            </div>
          )}
          {list.length === 0 && tab !== "review" && <div className="v2-card pad v2-sub" style={{ fontSize: 14 }}>{tab === "visits" ? "No visits in the next 7 days." : "No one is being onboarded."}</div>}

          {list.map((p) => <PatientCard key={p.id} p={p} t={L.t} onReview={tab === "review" ? () => review(p.id) : undefined} />)}

          {tab === "onboarding" && (drafts ?? []).map((d) => (
            <div key={d.id} className="dt-card dt-draft">
              <div style={{ flex: 1 }}><b>{d.name}</b><div className="v2-sub">Onboarding draft · saved {fmtDate(d.updated_at, { day: "numeric", month: "short" })}{d.updated_by_name ? ` by ${shortName(d.updated_by_name)}` : ""}</div></div>
              <Link className="v2-btn" href={`/patients/new?draft=${d.id}`}>Resume</Link>
            </div>
          ))}

          {tab === "review" && L.reviewedToday.length > 0 && (
            <div className="dt-reviewed">
              <div className="dt-reviewed-h">Reviewed today · {L.reviewedToday.length}</div>
              {L.reviewedToday.map((p) => (
                <div key={p.id} className="dt-reviewed-row">
                  <Link href={`/patients/${p.id}`} style={{ fontWeight: 600, color: "var(--c-ink2)" }}>{p.name}</Link>
                  <span className="v2-sub" style={{ flex: 1 }}>{p.triage.reason.title} · reviewed {fmtTime(p.triage.review!.at)} by {p.triage.review!.byId === user?.id ? "you" : p.triage.review!.by}</span>
                  {p.triage.review!.byId === user?.id && <button className="tq-link" onClick={() => review(p.id, true)}>Undo</button>}
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="span4 stack gap16">
          <section className="v2-card pad">
            <div className="row between" style={{ marginBottom: 6 }}><h2>Today in the care circles</h2><span className="v2-sub">last 24 h</span></div>
            {L.activity.length === 0 && <div className="v2-sub" style={{ padding: "6px 0", fontSize: 13.5 }}>Quiet so far. Alerts, family actions and reports sent on WhatsApp appear here.</div>}
            <ol className="dt-feed">
              {L.activity.map((a, i) => (
                <li key={i} className={`k-${a.kind}`}>
                  <span className="dt-feed-dot" aria-hidden />
                  <div>
                    <div className="dt-feed-t">{a.text}</div>
                    <div className="v2-sub num"><Link href={`/patients/${a.patientId}`}>{a.patient}</Link> · {fmtTime(a.at)}</div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <section className="v2-card pad">
            <div className="row between" style={{ marginBottom: 6 }}><h2>This week’s visits</h2><span className="v2-sub">{L.visits.length}</span></div>
            {L.visits.length === 0 && <div className="v2-sub" style={{ fontSize: 13.5 }}>No visits in the next 7 days.</div>}
            {L.visits.map((p) => (
              <Link key={p.id} href={`/patients/${p.id}/visit`} className="v2-list-row num">
                <span className="dt-cal"><b>{fmtDate(p.nextVisitAt!, { day: "numeric" })}</b><small>{fmtDate(p.nextVisitAt!, { month: "short" })}</small></span>
                <span style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{p.name}</b><span className="v2-sub" style={{ display: "block" }}>{fmtTime(p.nextVisitAt!)} · {p.prep?.readyAt ? "brief ready" : "not prepared yet"}</span></span>
                {p.prep?.readyAt ? <span style={{ color: "var(--c-green)" }}><Icon name="check" stroke={2.4} title="Prepared" /></span> : <span className="pl-open" />}
              </Link>
            ))}
          </section>
        </aside>
      </div>
    </main>
  );
}

function PatientCard({ p, t, onReview }: { p: PatientRow; t: number; onReview?: () => void }) {
  const tr = p.triage;
  const sev = !p.onboarding.hasVisit ? "none" : p.status;
  const meds = p.overall?.meds;
  return (
    <article className={`dt-card sev-${sev}`}>
      <div className="dt-card-top">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 10 }}>
            <span className={`dt-sev sev-${sev}`} title={sev} />
            <Link href={`/patients/${p.id}`} className="dt-name">{p.name}</Link>
            <span className="v2-sub">{[p.age ? `${p.age} ${p.sex}` : p.sex, shortConditions(p.conditions)].filter(Boolean).join(" · ")}</span>
          </div>
          <h3 className="dt-reason">{tr.reason.title}</h3>
          <div className="v2-sub" style={{ fontSize: 13.5 }}>{tr.reason.detail}</div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "nowrap", alignSelf: "flex-start" }}>
          <Link href={`/patients/${p.id}`} className="v2-btn">Open chart</Link>
          {onReview && <button className="v2-btn primary" onClick={onReview}>Mark reviewed</button>}
        </div>
      </div>
      <div className="dt-card-mid">
        {tr.trend ? (
          <>
            <div className="dt-reading">
              <span className="v2-sub">{tr.trend.label}</span>
              <span className={`dt-reading-v num ${tr.trend.bad ? "bad" : ""}`}>{tr.trend.latest}<small>{tr.trend.unit}</small></span>
              <span className="v2-sub num">{relDays(tr.trend.latestAt, t) === 0 ? fmtTime(tr.trend.latestAt) : fmtDate(tr.trend.latestAt, { day: "numeric", month: "short" })}{tr.trend.hi != null && tr.trend.type === "bp" ? ` · limit ${tr.trend.hi}` : ""}</span>
            </div>
            <div className="dt-spark"><Spark points={tr.trend.points} lo={tr.trend.lo} hi={tr.trend.hi} tone={tr.trend.bad ? (p.status === "urgent" ? "red" : "amber") : "brand"} width={260} height={56} label={`${tr.trend.label}, last 14 days`} /><span className="v2-sub">14 days · shaded = target</span></div>
          </>
        ) : <div className="v2-sub" style={{ fontSize: 13.5 }}>No readings yet.</div>}
      </div>
      <div className="dt-card-foot num">
        <span className={`v2-pill ${tr.circle.tone}`}>{tr.circle.tone === "green" && <Icon name="check" size={13} stroke={2.4} />}{(tr.circle.tone === "amber" || tr.circle.tone === "red") && <Icon name="clock" size={13} stroke={2.2} />}{tr.circle.label}</span>
        {tr.circle.detail && <span className="v2-sub">{tr.circle.detail}</span>}
        <span className="dt-foot-sp" />
        <span className="v2-sub">Adherence <b style={{ color: meds != null && meds < 80 ? "var(--c-amber)" : "var(--c-ink)" }}>{meds != null ? `${meds}%` : "—"}</b></span>
        <span className="v2-sub">Next visit <b style={{ color: "var(--c-ink)" }}>{p.nextVisitAt ? fmtDate(p.nextVisitAt, { day: "numeric", month: "short" }) : "—"}</b></span>
      </div>
    </article>
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
