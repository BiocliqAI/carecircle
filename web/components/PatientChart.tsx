"use client";
// Patient deep dive for the care team: persistent banner (identity, allergy, care circle, visits),
// seven sections, and a one-screen Overview.
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, avatarColor, initials, useSession } from "./client";
import { AdherenceHeatmap, EscalationCard, VitalCharts, visitDayKeys } from "./interval";
import { KidneyTab } from "./kidney";
import { ClinicalSummaryCard } from "./ClinicalSummaryCard";
import { DocumentOcrModal } from "./DocumentOcrModal";
import { BaselineCard } from "./baseline";
import { CareCircleCard, DetailsCard, DocumentsTab, NotesTab } from "./PatientRecordTabs";
import { PlanTab, Timeline, type Data, type TL } from "./PatientView";
import { Icon } from "./Icon";
import { Spark } from "./Spark";
import { describeMed } from "@/lib/meds";
import { fmtDate, fmtDateTime, fmtTime, relDays } from "@/lib/time";
import { LAB_META, VITAL_META, type CarePlan, type Medication, type VitalType } from "@/lib/types";
import type { IntervalSummary } from "@/lib/summary";

type Section = "overview" | "vitals" | "meds" | "alerts" | "visits" | "documents" | "profile";
const SECTIONS: [Section, string][] = [["overview", "Overview"], ["vitals", "Vitals & labs"], ["meds", "Medications"], ["alerts", "Alerts & care circle"], ["visits", "Visits & notes"], ["documents", "Documents"], ["profile", "Profile"]];

export function PatientChart({ id }: { id: string }) {
  const { bump, loading, user, notifyChange } = useSession();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sec, setSec] = useState<Section>("overview");
  const [showOcr, setShowOcr] = useState(false);
  const [showAi, setShowAi] = useState(false);

  const load = () => api<Data>(`/api/patients/${id}`).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => {
    if (!loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, bump, loading, user?.id]);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    const map: Record<string, Section> = { documents: "documents", profile: "profile", notes: "visits", alerts: "alerts", meds: "meds", vitals: "vitals" };
    if (t && map[t]) setSec(map[t]);
  }, []);

  if (err) return <main className="page"><div className="alert bad">{err}. <Link href="/patients">Back to patients</Link></div></main>;
  if (!d) return <main className="page"><div className="empty"><span className="spin" /></div></main>;

  const changed = () => { load(); notifyChange(); };
  const isDoctor = d.viewer.role === "DOCTOR";
  const cur = d.current;
  const s = d.summary;
  const allergy = d.baseline?.allergies && !/^(none|nil|nkda|no)/i.test(d.baseline.allergies) ? d.baseline.allergies : null;
  const conditions = (d.patient.conditions || "").split(/,\s*|\s+·\s+/).map((c) => c.replace(/\s*\([^)]*\)/g, "").trim()).filter(Boolean);
  const primary = d.caregivers.find((c) => c.level === 1);
  const waHref = `/whatsapp?u=${d.patient.user_id ?? ""}&u2=${primary?.user_id ?? ""}`;
  const visitLabel = isDoctor ? (d.visits.length ? `Start visit ${d.visits.length + 1}` : "Record Visit 1") : "Prepare visit";

  return (
    <main className="pc">
      {/* ---------- banner */}
      <div className="pc-banner">
        <div className="pc-inner">
          <nav aria-label="Breadcrumb" className="v2-sub" style={{ fontSize: 13, marginBottom: 10 }}><Link href="/patients">Patients</Link> <span aria-hidden>/</span> {d.patient.name}</nav>
          <div className="row between" style={{ alignItems: "flex-start", gap: 16 }}>
            <div className="row" style={{ gap: 14, alignItems: "flex-start", flexWrap: "nowrap" }}>
              <span className="avatar" style={{ width: 48, height: 48, fontSize: 17, background: avatarColor(d.patient.name) }}>{initials(d.patient.name)}</span>
              <div className="stack" style={{ gap: 6 }}>
                <div className="row" style={{ gap: 10 }}>
                  <h1 style={{ fontSize: 24, fontWeight: 700 }}>{d.patient.name}</h1>
                  <span className="num v2-sub" style={{ fontSize: 14 }}>{[d.patient.age, d.patient.sex === "M" ? "Male" : d.patient.sex === "F" ? "Female" : d.patient.sex, d.patient.phone].filter(Boolean).join(" · ")}</span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {allergy && <span className="pc-chip red"><Icon name="alert" size={13} stroke={2.4} />Allergy: {allergy}</span>}
                  {conditions.map((c) => <span key={c} className="pc-chip">{c}</span>)}
                </div>
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Link href={waHref} className="v2-btn"><Icon name="chat" size={16} />WhatsApp thread</Link>
              <Link href={isDoctor ? `/patients/${id}/plan` : `/patients/${id}/visit`} className="v2-btn primary">{visitLabel}</Link>
            </div>
          </div>
          <div className="pc-facts num">
            <div><span className="v2-sub">Treating doctor</span><b>{d.doctor?.name ?? "—"}</b></div>
            <div><span className="v2-sub">Care circle</span><b>{d.caregivers.map((c) => `${c.name.split(" ")[0]} (${(c.relation || "family").toLowerCase()})`).join(" · ") || "—"}</b></div>
            <div><span className="v2-sub">Last visit</span><b>{cur ? `${fmtDate(cur.visit_at, { day: "numeric", month: "short" })} · ${relDays(cur.visit_at, d.now)} days ago` : "No visit yet"}</b></div>
            <div><span className="v2-sub">Next visit</span><b>{cur?.next_visit_at ? `${fmtDate(cur.next_visit_at, { weekday: "short", day: "numeric", month: "short" })}, ${fmtTime(cur.next_visit_at)}` : "—"}{d.prep?.readyAt ? " · brief ready" : ""}</b></div>
          </div>
          <nav className="pc-tabs" aria-label="Patient record">
            {SECTIONS.map(([k, l]) => (
              <button key={k} className={sec === k ? "on" : ""} onClick={() => setSec(k)}>
                {l}
                {k === "alerts" && d.open.length > 0 && <span className="v2-count red">{d.open.length}</span>}
                {k === "documents" && d.documents.length > 0 && <span className="v2-count">{d.documents.length}</span>}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div className="pc-body">
        <div className="pc-inner stack gap16">
          {/* open alerts strip */}
          {d.open.map((e) => (
            <div key={e.id} className={`pc-alert ${e.type === "URGENT" ? "red" : e.type === "DEVIATION" ? "amber" : "blue"}`}>
              <span className="pc-alert-k">{e.type === "URGENT" ? "Urgent" : e.type === "DEVIATION" ? "Outside limits" : "Missed task"}</span>
              <b className="num">{e.title}</b>
              <span className="v2-sub" style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
                {e.state === "ACKNOWLEDGED" ? `${e.ack_by_name ?? "A caregiver"} is handling it${e.ack_at ? ` since ${fmtTime(e.ack_at)}` : ""}. ` : `Waiting on ${d.caregivers.find((c) => c.level === e.level)?.name ?? "the care circle"}. `}
                Handled by the care circle; the clinic is not paged.
              </span>
              <button className="tq-link" onClick={() => setSec("alerts")}>View alert</button>
            </div>
          ))}

          {sec === "overview" && <Overview d={d} s={s} onSec={setSec} showAi={showAi} setShowAi={setShowAi} />}

          {sec === "vitals" && (
            cur && s ? (
              <div className="stack gap16">
                <section className="v2-card pad"><VitalCharts s={s} plan={cur.plan} base={cur.vitals} markers={d.visits.map((v, i) => ({ t: v.visit_at, label: `Visit ${i + 1}` }))} /></section>
                {d.kidney ? <KidneyTab lr={d.kidney} plan={cur.plan} sinceVisit={cur.visit_at} now={d.now} clinician pid={id} medChanges={d.medChanges} team={d.careTeam} onChange={changed} /> : <LabsCard d={d} />}
              </div>
            ) : <Empty text="Vitals appear here once Visit 1 sets the care plan and readings start coming in." extra={<LabsCard d={d} />} />
          )}

          {sec === "meds" && (
            cur && s ? (
              <div className="stack gap16">
                <MedsTable plan={cur.plan} prescriber={d.doctor?.name} />
                <section className="v2-card pad"><h2 style={{ marginBottom: 10 }}>Adherence since the last visit</h2><AdherenceHeatmap s={s} visitDays={visitDayKeys(d.visits)} /></section>
                {d.medChanges.length > 0 && (
                  <section className="v2-card pad">
                    <h2 style={{ marginBottom: 6 }}>Changes reported by other doctors</h2>
                    {d.medChanges.map((m) => <div key={m.id} className="v2-kv"><span><b style={{ fontWeight: 600 }}>{m.med_name}</b> · {m.change.replace("_", " ")}{m.detail ? ` (${m.detail})` : ""}{m.prescriber ? ` · ${m.prescriber}` : ""}</span><span className={`v2-pill ${m.status === "REPORTED" ? "amber" : "grey"}`}>{m.status === "REPORTED" ? "To reconcile" : m.status.toLowerCase()}</span></div>)}
                  </section>
                )}
              </div>
            ) : <Empty text="Medicines become a care plan at Visit 1." extra={d.baseline?.currentMeds.length ? <section className="v2-card pad"><h2 style={{ marginBottom: 6 }}>Medicines at onboarding</h2>{d.baseline.currentMeds.map((m, i) => <div key={i} className="v2-kv"><span><b style={{ fontWeight: 600 }}>{m.name}</b> {m.dose}</span><span className="v2-sub">{m.frequency}</span></div>)}</section> : null} />
          )}

          {sec === "alerts" && (
            <div className="v2-grid12">
              <div className="span8 stack gap16">
                {d.open.map((e) => <EscalationCard key={e.id} e={e} caregivers={d.caregivers} onDone={changed} />)}
                <section className="v2-card pad">
                  <h2 style={{ marginBottom: 8 }}>Alert history since the last visit</h2>
                  {(s?.escalations ?? []).filter((e) => e.state === "RESOLVED" || e.state === "EXHAUSTED").reverse().map((e) => <EscalationCard key={e.id} e={e} caregivers={d.caregivers} compact />)}
                  {!(s?.escalations ?? []).some((e) => e.state === "RESOLVED" || e.state === "EXHAUSTED") && <div className="v2-sub">No closed alerts in this period.</div>}
                </section>
              </div>
              <div className="span4"><CareCircleCard pid={id} patient={d.patient} caregivers={d.caregivers} consents={d.consents} onChange={changed} /></div>
            </div>
          )}

          {sec === "visits" && (
            <div className="stack gap16">
              {cur ? <PlanTab d={d} canEdit onChange={load} /> : <Empty text="No visits recorded yet." />}
              <NotesTab pid={id} notes={d.notes} viewerId={d.viewer.id} viewerRole={d.viewer.role} onChange={load} />
              <section className="v2-card pad"><h2 style={{ marginBottom: 8 }}>Full timeline</h2><Timeline items={d.timeline} /></section>
            </div>
          )}

          {sec === "documents" && (
            <div className="stack gap16">
              <div className="row" style={{ justifyContent: "flex-end" }}><button className="v2-btn" onClick={() => setShowOcr(true)}><Icon name="file" size={16} />Read a prescription or report with AI</button></div>
              <DocumentsTab pid={id} docs={d.documents} canEdit onChange={load} />
            </div>
          )}

          {sec === "profile" && (
            <div className="v2-grid12">
              <div className="span7"><DetailsCard p={d.patient} onChange={changed} /></div>
              <div className="span5"><BaselineCard b={d.baseline} pid={id} canEdit now={d.now} /></div>
            </div>
          )}
        </div>
      </div>
      <DocumentOcrModal open={showOcr} onClose={() => setShowOcr(false)} patientId={id} patientName={d.patient.name} onCommitted={changed} />
    </main>
  );
}

function Empty({ text, extra }: { text: string; extra?: React.ReactNode }) {
  return <div className="stack gap16"><div className="v2-card pad v2-sub" style={{ fontSize: 14 }}>{text}</div>{extra}</div>;
}

// ---------------------------------------------------------------- overview
const ORDER: VitalType[] = ["bp", "weight", "glucose", "spo2", "hr", "pain", "temp"];

function targetFor(type: VitalType, plan: CarePlan): { text: string; lo: number | null; hi: number | null } {
  const th = plan.thresholds;
  if (type === "bp") return { text: `target < ${th.sysHigh}/${th.diaHigh}`, lo: th.sysLow, hi: th.sysHigh };
  if (type === "weight") return th.dryWeight ? { text: `target ${th.dryWeight} ± ${th.weightBand ?? 1}`, lo: th.dryWeight - (th.weightBand ?? 1), hi: th.dryWeight + (th.weightBand ?? 1) } : { text: `alert on +${th.weightGainKg} kg in 3 days`, lo: null, hi: null };
  if (type === "glucose") return { text: `target ${th.glucoseLow}–${th.glucoseHigh}`, lo: th.glucoseLow, hi: th.glucoseHigh };
  if (type === "spo2") return { text: `alert below ${th.spo2Low}%`, lo: th.spo2Low, hi: 100 };
  if (type === "hr") return { text: `target ${th.hrLow}–${th.hrHigh}`, lo: th.hrLow, hi: th.hrHigh };
  if (type === "pain") return { text: `alert at ${th.painHigh}/10`, lo: 0, hi: th.painHigh };
  return { text: "", lo: null, hi: null };
}

function Overview({ d, s, onSec, showAi, setShowAi }: { d: Data; s: IntervalSummary | null; onSec: (x: Section) => void; showAi: boolean; setShowAi: (b: boolean) => void }) {
  const cur = d.current;
  if (!cur || !s) {
    return (
      <div className="v2-grid12">
        <div className="span8 stack gap16">
          <section className="v2-card pad">
            <h2 style={{ marginBottom: 6 }}>No visit yet</h2>
            <p className="v2-sub" style={{ fontSize: 14, margin: 0 }}>Reminders and readings start once Visit 1 sets the care plan. {d.prep?.readyAt ? "The visit has been prepared." : "An assistant can prepare it first."}</p>
          </section>
          <BaselineCard b={d.baseline} pid={d.patient.id} canEdit now={d.now} />
        </div>
        <div className="span4 stack gap16"><SideCards d={d} onSec={onSec} /></div>
      </div>
    );
  }
  const vitals = ORDER.map((k) => s.vitals.find((v) => v.type === k && v.count > 0)).filter(Boolean).slice(0, 3) as IntervalSummary["vitals"];
  const meds = s.adherence.filter((a) => a.kind === "med");
  const days = s.days.slice(-14);
  return (
    <div className="v2-grid12">
      <div className="span8 stack gap16">
        <section className="v2-card pad">
          <div className="row between" style={{ marginBottom: 8 }}>
            <h2>Since last visit</h2>
            <div className="row" style={{ gap: 10 }}><span className="v2-sub">{fmtDate(cur.visit_at, { day: "numeric", month: "short" })} → today · {s.days.length} days</span><button className="tq-link" onClick={() => setShowAi(!showAi)}>{showAi ? "Hide AI summary" : "AI summary"}</button></div>
          </div>
          <ul className="pc-bullets num">{s.highlights.slice(0, 5).map((h, i) => <li key={i} className={h.tone === "bad" ? "bad" : h.tone === "warn" ? "warn" : ""}>{h.text}</li>)}</ul>
          {showAi && <div style={{ marginTop: 12 }}><ClinicalSummaryCard patientId={d.patient.id} patientName={d.patient.name} /></div>}
        </section>

        {vitals.length > 0 && (
          <section className="pc-vitals">
            {vitals.map((v) => {
              const last = v.series[v.series.length - 1];
              const tg = targetFor(v.type, cur.plan);
              const bad = !!last?.flag;
              return (
                <div key={v.type} className="v2-card pad num">
                  <div className="v2-sub" style={{ fontWeight: 600 }}>{VITAL_META[v.type].label}</div>
                  <div className="row" style={{ gap: 6, alignItems: "baseline", margin: "4px 0 2px", flexWrap: "nowrap" }}><span style={{ fontSize: 28, fontWeight: 700, color: bad ? "var(--c-red)" : undefined }}>{last ? `${last.v1}${last.v2 ? `/${last.v2}` : ""}` : "—"}</span><span className="v2-sub">{VITAL_META[v.type].unit}</span></div>
                  <div className="v2-sub">{last ? `${relDays(last.t, d.now) === 0 ? "Today" : fmtDate(last.t, { day: "numeric", month: "short" })} ${fmtTime(last.t)}` : ""}{tg.text ? ` · ${tg.text}` : ""}</div>
                  <div style={{ marginTop: 10 }}><Spark points={v.series.slice(-20).map((x) => x.v1)} lo={tg.lo} hi={tg.hi} tone={bad ? "red" : "brand"} width={260} height={52} label={`${VITAL_META[v.type].label} trend`} /></div>
                </div>
              );
            })}
          </section>
        )}

        {meds.length > 0 && (
          <section className="v2-card pad">
            <div className="row between" style={{ marginBottom: 12 }}>
              <h2>Medicine adherence · last {days.length} days</h2>
              <div className="row v2-sub" style={{ gap: 12 }}><span className="row" style={{ gap: 5 }}><span className="adh" style={{ background: "#0F5C55" }} />Taken</span><span className="row" style={{ gap: 5 }}><span className="adh" style={{ background: "#F59E0B" }} />Missed</span><span className="row" style={{ gap: 5 }}><span className="adh" style={{ background: "#E3E8E6" }} />Not due / pending</span></div>
            </div>
            <div className="stack num" style={{ gap: 10 }}>
              {meds.map((m) => (
                <div key={m.key} className="row" style={{ flexWrap: "nowrap", gap: 12 }}>
                  <div style={{ width: 200, flex: "none" }}><div style={{ fontWeight: 600, fontSize: 14 }}>{m.label}</div></div>
                  <div className="row" style={{ gap: 3, flex: 1, flexWrap: "nowrap" }}>
                    {days.map((dk) => { const st = m.byDay[dk]; return <span key={dk} className="adh" title={`${dk}: ${st ?? "not due"}`} style={{ background: st === "all" ? "#0F5C55" : st === "partial" ? "#F8C471" : st === "none" ? "#F59E0B" : "#E3E8E6" }} />; })}
                  </div>
                  <b style={{ width: 44, textAlign: "right", color: m.pct != null && m.pct < 80 ? "var(--c-amber)" : undefined }}>{m.pct != null ? `${m.pct}%` : "—"}</b>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="v2-card pad">
          <div className="row between" style={{ marginBottom: 4 }}><h2>Recent activity</h2><button className="tq-link" onClick={() => onSec("visits")}>Full timeline</button></div>
          {d.timeline.slice(0, 6).map((i, k) => <div key={k} className="v2-list-row num" style={{ alignItems: "flex-start" }}><span style={{ width: 104, flex: "none", color: "var(--c-mute)" }}>{relDays(i.at, d.now) === 0 ? `Today ${fmtTime(i.at)}` : fmtDate(i.at, { day: "numeric", month: "short" })}</span><span style={{ flex: 1 }}>{activityText(i)}</span></div>)}
          {!d.timeline.length && <div className="v2-sub">No activity yet.</div>}
        </section>
      </div>
      <div className="span4 stack gap16">
        <MedsCard plan={cur.plan} onSec={onSec} />
        <SideCards d={d} onSec={onSec} />
      </div>
    </div>
  );
}

function activityText(i: TL): React.ReactNode {
  if (i.kind === "log") return <>“{i.body.slice(0, 90)}{i.body.length > 90 ? "…" : ""}” <span className="v2-sub">· {i.by}</span></>;
  if (i.kind === "alert") return <>{i.event === "RESOLVED" ? "Closed: " : i.event === "ACKNOWLEDGED" ? "Acknowledged: " : i.event === "TIMEOUT" ? "No reply, passed on: " : "Alert: "}{i.title}{i.actor ? <span className="v2-sub"> · {i.actor}</span> : null}</>;
  if (i.kind === "visit") return <>Visit recorded{i.diagnosis ? `: ${i.diagnosis}` : ""}</>;
  if (i.kind === "missed") return <span className="v2-sub">Not logged: {i.label}</span>;
  if (i.kind === "lab") return <>Labs: {i.labs.map((l) => `${LAB_META[l.marker]?.label ?? l.marker} ${l.value}`).join(", ")}</>;
  return <>Medicine change: {i.change.med_name}</>;
}

/** 1–0–1 style schedule (morning–afternoon–night). */
export function shorthand(m: Medication): string {
  if (m.prn) return "As needed";
  const slots = [0, 0, 0];
  m.times.forEach((t) => { const h = Number(t.slice(0, 2)); slots[h < 12 ? 0 : h < 17 ? 1 : 2]++; });
  const base = slots.join("–");
  return m.everyNDays === 2 ? `${base} · alternate days` : m.everyNDays === 7 ? `${base} · weekly` : m.courseDays ? `${base} · ${m.courseDays} days` : base;
}

function MedsCard({ plan, onSec }: { plan: CarePlan; onSec: (x: Section) => void }) {
  return (
    <section className="v2-card pad">
      <div className="row between" style={{ marginBottom: 4 }}><h2>Current medicines</h2><button className="tq-link" onClick={() => onSec("meds")}>Details</button></div>
      {plan.medications.map((m) => <div key={m.key} className="v2-kv"><span><b style={{ fontWeight: 600 }}>{m.name}</b> {m.dose}</span><span className="v2-sub num">{shorthand(m)}</span></div>)}
      {!plan.medications.length && <div className="v2-sub">None in the plan.</div>}
    </section>
  );
}

function MedsTable({ plan, prescriber }: { plan: CarePlan; prescriber?: string }) {
  return (
    <section className="v2-card" style={{ overflow: "hidden" }}>
      <div style={{ padding: "14px 18px 6px" }}><h2>Current care plan medicines</h2></div>
      <div className="table-wrap">
        <table className="tq" style={{ minWidth: 640 }}>
          <thead><tr><th>Medicine</th><th>Schedule</th><th>For</th><th>Instructions</th><th>Prescribed by</th></tr></thead>
          <tbody className="num">
            {plan.medications.map((m) => <tr key={m.key}><td><b style={{ fontWeight: 600 }}>{m.name}</b> {m.dose}</td><td>{shorthand(m)}<div className="v2-sub">{describeMed(m)}</div></td><td className="v2-sub">{m.purpose ?? "—"}</td><td className="v2-sub">{m.instructions || "—"}</td><td className="v2-sub">{m.prescriber ?? prescriber ?? "—"}</td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LabsCard({ d }: { d: Data }) {
  const labs = d.latestLabs ?? [];
  return (
    <section className="v2-card pad">
      <div className="row between" style={{ marginBottom: 4 }}><h2>Latest labs</h2>{labs[0] && <span className="v2-sub">{fmtDate(labs[0].at, { day: "numeric", month: "short" })}</span>}</div>
      {labs.slice(0, 8).map((l) => {
        const meta = LAB_META[l.marker];
        const arrow = l.prev == null ? "" : l.value > l.prev ? "↑" : l.value < l.prev ? "↓" : "→";
        return <div key={l.marker} className="v2-kv num"><span>{meta?.label ?? l.marker}</span><span><b style={{ fontWeight: 600, color: l.flag && l.flag !== "up" ? "var(--c-red)" : undefined }}>{l.value}</b> <span className="v2-sub">{meta?.unit}{l.prev != null ? ` · ${arrow} from ${l.prev}` : ""}</span></span></div>;
      })}
      {!labs.length && <div className="v2-sub">No lab results yet.</div>}
    </section>
  );
}

function SideCards({ d, onSec }: { d: Data; onSec: (x: Section) => void }) {
  const consent = (uid: string | null) => d.consents.find((c) => c.user_id === uid)?.status;
  return (
    <>
      <LabsCard d={d} />
      <section className="v2-card pad">
        <div className="row between" style={{ marginBottom: 4 }}><h2>Care circle</h2><button className="tq-link" onClick={() => onSec("alerts")}>Manage</button></div>
        {d.caregivers.map((c) => {
          const st = consent(c.user_id);
          return <div key={c.id} className="v2-kv"><span><b style={{ fontWeight: 600 }}>{c.name}</b> <span className="v2-sub">{c.relation} · {c.level === 1 ? "primary" : "backup"}</span></span><span style={{ fontSize: 12.5, fontWeight: 600, color: st === "GIVEN" ? "var(--c-green)" : st === "DECLINED" ? "var(--c-red)" : st === "PENDING" ? "var(--c-amber)" : "var(--c-mute)" }}>{st === "GIVEN" ? "Consented" : st === "DECLINED" ? "Declined" : st === "PENDING" ? "Awaiting YES" : ""}</span></div>;
        })}
        {!d.caregivers.length && <div className="v2-sub">No caregivers.</div>}
      </section>
      <section className="v2-card pad">
        <div className="row between" style={{ marginBottom: 6 }}><h2>Notes</h2><button className="tq-link" onClick={() => onSec("visits")}>Add note</button></div>
        {d.notes.slice(0, 2).map((n) => <div key={n.id} style={{ padding: "10px 0", borderTop: "1px solid var(--c-line2)" }}><div className="v2-sub" style={{ marginBottom: 3 }}>{fmtDateTime(n.created_at)} · {n.author_name}</div><div style={{ fontSize: 14, lineHeight: 1.5 }}>{n.body.slice(0, 220)}{n.body.length > 220 ? "…" : ""}</div></div>)}
        {!d.notes.length && <div className="v2-sub">No notes yet.</div>}
      </section>
    </>
  );
}

