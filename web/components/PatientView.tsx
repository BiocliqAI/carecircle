"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, avatarColor, initials, useSession } from "./client";
import { AdherenceHeatmap, EscalationCard, Highlights, KpiRow, SymptomTable, VitalCharts, visitDayKeys } from "./interval";
import { CareTeamChips, CareTeamPanel, KidneyBadges, KidneyBrief, KidneyTab, type CareTeamRow, type FluidToday, type LabDue } from "./kidney";
import type { EscalationView, IntervalSummary, LongRange, MedChangeRow } from "@/lib/summary";
import type { OutsideVisitView } from "@/lib/outside";
import type { Visit } from "@/lib/types";
import { LAB_META, SYMPTOMS, VITAL_META, shortName, type VitalType } from "@/lib/types";
import { describeMed } from "@/lib/meds";
import { dayKey, fmtDate, fmtDateTime, fmtTime, relDays } from "@/lib/time";
import { ClinicalSummaryCard } from "./ClinicalSummaryCard";
import { DocumentOcrModal } from "./DocumentOcrModal";
import { BaselineCard, ConsentList, type ConsentView } from "./baseline";
import { DocumentsTab, NotesTab, ProfileTab, type DocItem, type NoteItem } from "./PatientRecordTabs";
import type { Baseline } from "@/lib/types";

interface Caregiver { id: string; name: string; relation: string | null; phone: string; level: number; user_id: string | null; dashboard?: number }
type LabChip = { marker: string; value: number; flag: string | null };
export type TL =
  | { kind: "log"; at: number; id: number; by: string; role: string; body: string; parser: string | null; obs: { type: string; v1: number | null; v2: number | null; text: string | null; flag: string | null; severity: string | null }[]; tasks: { label: string; status: string; late: number }[]; labs: LabChip[] }
  | { kind: "alert"; at: number; escalationId: number; title: string; type: string; event: string; level: number | null; actor: string | null; note: string | null }
  | { kind: "visit"; at: number; id: string; diagnosis: string; notes: string }
  | { kind: "missed"; at: number; label: string; taskKind: string }
  | { kind: "lab"; at: number; by: string | null; labs: LabChip[] }
  | { kind: "medchange"; at: number; change: MedChangeRow };
export interface Data {
  now: number;
  viewer: { id: string; role: string; name: string; isCaregiverHere: boolean };
  patient: { id: string; name: string; age: number; sex: string; phone: string; conditions: string; address: string; user_id?: string | null; doctor_id?: string };
  doctor: { name: string; title: string };
  caregivers: Caregiver[];
  visits: Visit[];
  current: Visit | null;
  summary: IntervalSummary | null;
  open: EscalationView[];
  timeline: TL[];
  careTeam: CareTeamRow[];
  medChanges: MedChangeRow[];
  outsideVisits: OutsideVisitView[];
  labDue: LabDue | null;
  fluidToday: FluidToday | null;
  kidney: LongRange | null;
  baseline: (Baseline & { capturedAt: number; capturedBy: string | null; updatedAt: number }) | null;
  consents: ConsentView[];
  notes: NoteItem[];
  documents: DocItem[];
  latestLabs?: { marker: string; value: number; at: number; flag: string | null; prev: number | null }[];
  prep?: { readyAt: number | null; readyByName: string | null; flags: { id: string; text: string }[]; questions: string } | null;
}

/** Patient 360. `embedded` = shown beside the WhatsApp phone on the patient / caregiver page. */
export function PatientView({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const { bump, loading, user, notifyChange } = useSession();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState("brief");
  const [brief, setBrief] = useState<{ text: string; source: string } | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [showOcr, setShowOcr] = useState(false);

  const load = () => api<Data>(`/api/patients/${id}`).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => {
    if (!loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, bump, loading, user?.id]);

  const Wrap = embedded ? "div" : "main";
  const wrapCls = embedded ? "pv-embedded" : "page";
  if (err) return <Wrap className={wrapCls}><div className="alert bad">{err}. <Link href="/">Switch persona</Link></div></Wrap>;
  if (!d) return <Wrap className={wrapCls}><div className="empty"><span className="spin" /> Loading…</div></Wrap>;

  const clinician = d.viewer.role === "DOCTOR" || d.viewer.role === "PA";
  const isPatient = d.viewer.role === "PATIENT";
  const s = d.summary;
  const cur = d.current;
  const prevVisits = d.visits;
  const visitMarkers = prevVisits.map((v, i) => ({ t: v.visit_at, label: `Visit ${i + 1}` }));
  const alertsAll = s?.escalations ?? [];
  const nextIn = cur?.next_visit_at ? relDays(d.now, cur.next_visit_at) : null;
  const primaryCg = d.caregivers.find((c) => c.level === 1) ?? d.caregivers[0];
  const myCg = d.caregivers.find((c) => c.user_id === d.viewer.id);
  const waHref = myCg
    ? `/whatsapp?u=${myCg.user_id}&u2=${d.patient.user_id ?? ""}`
    : isPatient
      ? `/whatsapp?u=${d.viewer.id}&u2=${primaryCg?.user_id ?? ""}`
      : `/whatsapp?u=${d.patient.user_id ?? ""}&u2=${primaryCg?.user_id ?? ""}`;

  async function genBrief() {
    setBriefBusy(true);
    try {
      setBrief(await api(`/api/patients/${id}/brief`, { method: "POST" }));
    } finally {
      setBriefBusy(false);
    }
  }

  const clinicalTabs: [string, string, number?][] = cur && s ? [
    ["brief", isPatient ? "My summary" : "Since last visit"],
    ["trends", "Trends"],
    ...(d.kidney ? [["kidney", "🫘 Kidney & labs", d.medChanges.filter((m) => m.status === "REPORTED").length] as [string, string, number]] : []),
    ["adherence", "Adherence"],
    ["alerts", "Care-circle alerts", alertsAll.length],
    ["timeline", "Timeline"],
    ["plan", "Visits & care plan", d.visits.length],
  ] : [];
  const recordTabs: [string, string, number?][] = clinician
    ? [["profile", "Profile & care circle"], ["notes", "Notes", d.notes.length], ["documents", "Documents", d.documents.length]]
    : d.documents.length ? [["documents", "Documents", d.documents.length]] : [];
  const tabs = [...clinicalTabs, ...recordTabs];
  const activeTab = tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0] ?? "";

  return (
    <Wrap className={wrapCls}>
      {/* ---------- header */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
            <span className="avatar" style={{ width: 52, height: 52, fontSize: 18, background: avatarColor(d.patient.name) }}>{initials(d.patient.name)}</span>
            <div>
              <h1>{d.patient.name}</h1>
              <div className="muted">{d.patient.age} yrs · {d.patient.sex === "M" ? "Male" : d.patient.sex === "F" ? "Female" : d.patient.sex} · WhatsApp {d.patient.phone}</div>
              <div style={{ marginTop: 4 }}>{d.patient.conditions}</div>
              <div className="row" style={{ marginTop: 8, gap: 6 }}>
                <small>Care circle:</small>
                {d.caregivers.map((c) => (
                  <span key={c.id} className="badge brand" title={c.phone}>{c.level === 1 ? "Primary" : "Backup"} · {c.name} ({c.relation})</span>
                ))}
                <KidneyBadges labDue={d.labDue} fluidToday={d.fluidToday} pending={d.medChanges.filter((m) => m.status === "REPORTED").length} now={d.now} />
              </div>
              <CareTeamChips team={d.careTeam} />
            </div>
          </div>
          <div className="stack" style={{ alignItems: "flex-end" }}>
            <div className="row">
              {clinician && <button
                className="btn"
                onClick={() => setShowOcr(true)}
                title="Intake handwritten prescriptions, lab sheets, or vitals diaries via Gemini Vision OCR"
              >
                📷 Document OCR & Intake
              </button>}
              {clinician && <Link className="btn primary" href={`/patients/${id}/visit`}>🩺 {d.visits.length ? `Start Visit ${d.visits.length + 1}` : "Record first visit"}</Link>}
              {d.visits.length >= 1 && <Link className="btn" href={`/patients/${id}/compare`}>⇄ Compare visits</Link>}
              {!embedded && <Link className="btn" href={waHref}>💬 WhatsApp</Link>}
            </div>
            <small>
              {d.doctor?.name} · Last visit {cur ? `${fmtDate(cur.visit_at)} (${relDays(cur.visit_at, d.now)} days ago)` : "—"}
              {cur?.next_visit_at ? ` · Next ${nextIn === 0 ? "today " + fmtTime(cur.next_visit_at) : fmtDate(cur.next_visit_at)}` : ""}
            </small>
          </div>
        </div>
      </div>

      {/* ---------- open alerts banner */}
      {d.open.length > 0 && (
        <div className="stack" style={{ marginBottom: 12 }}>
          {d.open.map((e) => (
            <EscalationCard key={e.id} e={e} caregivers={d.caregivers} canAct={d.viewer.isCaregiverHere} onDone={() => { load(); notifyChange(); }} />
          ))}
          {clinician && <div className="callout">Shown for visibility only. {shortName(d.patient.name)}’s care circle owns this alert and will contact the clinic if needed. No notification was sent to the care team.</div>}
        </div>
      )}

      {!cur && (
        <div className="stack gap16">
          <div className="alert info">
            <div>
              <b>No visit recorded yet.</b> {clinician ? "Record the first visit to set the care plan. WhatsApp reminders start automatically after that." : "Your care plan will appear after your first visit."}
            </div>
          </div>
          {!clinician && (
            <div className="grid side">
              <BaselineCard b={d.baseline} pid={id} canEdit={false} now={d.now} />
              <OnboardingCard d={d} />
            </div>
          )}
        </div>
      )}

      {tabs.length > 0 && (
        <div className="tabs">
          {tabs.map(([k, l, n]) => (
            <button key={k} className={activeTab === k ? "active" : ""} onClick={() => setTab(k)}>
              {l}
              {n ? <span className="badge">{n}</span> : null}
            </button>
          ))}
        </div>
      )}

      {activeTab === "profile" && clinician && (
        <ProfileTab patient={d.patient} caregivers={d.caregivers} consents={d.consents} onChange={() => { load(); notifyChange(); }}>
          <BaselineCard b={d.baseline} pid={id} canEdit={clinician} now={d.now} />
        </ProfileTab>
      )}
      {activeTab === "notes" && clinician && <NotesTab pid={id} notes={d.notes} viewerId={d.viewer.id} viewerRole={d.viewer.role} onChange={load} />}
      {activeTab === "documents" && <DocumentsTab pid={id} docs={d.documents} canEdit={clinician} onChange={load} />}

      {cur && s && (
        <>

          {activeTab === "brief" && (
            <div className="stack gap16">
              <div className="row between">
                <h2>
                  {isPatient ? "How you’ve been doing" : "Pre-visit brief"} · {fmtDate(cur.visit_at, { day: "numeric", month: "short" })} → today{" "}
                  <span className="muted" style={{ fontWeight: 500 }}>({s.days.length} days)</span>
                </h2>
              </div>
              <ClinicalSummaryCard patientId={id} patientName={d.patient.name} />
              <KpiRow s={s} />
              <div className="grid side">
                <div className="card">
                  <div className="card-head">
                    <h3>What changed since the last visit</h3>
                    {clinician && (
                      <button className="btn sm" onClick={genBrief} disabled={briefBusy}>
                        {briefBusy ? <span className="spin" /> : "✨"} AI brief
                      </button>
                    )}
                  </div>
                  <Highlights items={s.highlights} />
                  {brief && (
                    <div className="alert info" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
                      <div>
                        <b>Brief ({brief.source === "rules" ? "rule-based — set GEMINI_API_KEY for AI" : brief.source})</b>
                        <div>{brief.text}</div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="stack gap16">
                  <div className="card">
                    <div className="card-head"><h3>Clinic baseline (last visit)</h3></div>
                    <BaselineVsNow v={cur} s={s} />
                  </div>
                  <div className="card">
                    <div className="card-head"><h3>Symptoms</h3></div>
                    <SymptomTable s={s} />
                  </div>
                </div>
              </div>
              {s.kidney && <KidneyBrief k={s.kidney} plan={cur.plan} />}
              <div className="card">
                <div className="card-head"><h3>Care-circle alerts in this period</h3><small>{s.escalations.length} total</small></div>
                <div className="stack">
                  {s.escalations.filter((e) => e.type !== "COMPLIANCE").slice(-4).reverse().map((e) => <EscalationCard key={e.id} e={e} caregivers={d.caregivers} compact />)}
                  {s.escalations.filter((e) => e.type === "COMPLIANCE").length > 0 && (
                    <small>+ {s.escalations.filter((e) => e.type === "COMPLIANCE").length} compliance follow-ups (missed doses / skipped exercise) handled by family — see the Care-circle alerts tab.</small>
                  )}
                  {!s.escalations.length && <div className="muted">None — no deviations from the doctor’s limits.</div>}
                </div>
              </div>
              <div className="card">
                <div className="card-head"><h3>Key trends</h3></div>
                <VitalCharts s={{ ...s, vitals: s.vitals.filter((v) => ["bp", "weight", "spo2", "pain"].includes(v.type)).slice(0, 2) }} plan={cur.plan} base={cur.vitals} markers={visitMarkers} />
              </div>
            </div>
          )}

          {activeTab === "trends" && <VitalCharts s={s} plan={cur.plan} base={cur.vitals} markers={visitMarkers} />}

          {activeTab === "kidney" && d.kidney && (
            <KidneyTab lr={d.kidney} plan={cur.plan} sinceVisit={cur.visit_at} now={d.now} clinician={clinician} pid={id} medChanges={d.medChanges} team={d.careTeam} onChange={() => { load(); notifyChange(); }} />
          )}

          {activeTab === "adherence" && (
            <div className="card">
              <AdherenceHeatmap s={s} visitDays={visitDayKeys(d.visits)} />
              <p className="muted" style={{ marginBottom: 0 }}>
                “Not logged” (no reply even after a reminder) is shown separately from “reported not done” (the patient said they skipped it). Hover a row for details.
              </p>
            </div>
          )}

          {activeTab === "alerts" && (
            <div className="stack">
              <div className="callout">
                <b>How alerts work:</b> when something is missed, the patient is reminded first. Missed medicines, or readings outside {d.doctor?.name}’s limits, alert Level 1 on WhatsApp. If Level 1 doesn’t acknowledge within {cur.plan.escalation.deviationMin} min (deviations) / {cur.plan.escalation.complianceMin} min (missed tasks) / {cur.plan.escalation.urgentMin} min (urgent), the alert moves to Level 2, then Level 3. The family records what they did.
              </div>
              {[...alertsAll].reverse().map((e) => (
                <EscalationCard key={e.id} e={e} caregivers={d.caregivers} canAct={d.viewer.isCaregiverHere} onDone={() => { load(); notifyChange(); }} />
              ))}
              {!alertsAll.length && <div className="empty">No alerts since the last visit.</div>}
            </div>
          )}

          {activeTab === "timeline" && <Timeline items={d.timeline} />}

          {activeTab === "plan" && <PlanTab d={d} canEdit={clinician || d.viewer.isCaregiverHere} onChange={load} />}
        </>
      )}
      <DocumentOcrModal
        open={showOcr}
        onClose={() => setShowOcr(false)}
        patientId={id}
        patientName={d.patient.name}
        onCommitted={() => { load(); notifyChange(); }}
      />
    </Wrap>
  );
}

function BaselineVsNow({ v, s }: { v: Visit; s: IntervalSummary }) {
  const rows: { label: string; base: string; now: string; worse?: boolean; better?: boolean }[] = [];
  const bp = s.vitals.find((x) => x.type === "bp");
  if (v.vitals.sys) rows.push({ label: "Blood pressure", base: `${v.vitals.sys}/${v.vitals.dia}`, now: bp?.lateAvg ? `${Math.round(bp.lateAvg)}/${Math.round(bp.lateAvgV2 ?? 0)} avg` : "—", better: !!bp?.lateAvg && bp.lateAvg < v.vitals.sys - 5, worse: !!bp?.lateAvg && bp.lateAvg > v.vitals.sys + 5 });
  for (const k of ["weight", "glucose", "hr", "spo2", "pain"] as VitalType[]) {
    const b = (v.vitals as Record<string, number | undefined>)[k];
    const x = s.vitals.find((y) => y.type === k);
    if (b == null && !x) continue;
    const nowV = x?.last ?? null;
    const lowerBetter = k !== "spo2";
    const diff = b != null && nowV != null ? nowV - b : 0;
    rows.push({ label: VITAL_META[k].label, base: b != null ? `${b}` : "—", now: nowV != null ? `${nowV} latest` : "—", better: diff !== 0 && (lowerBetter ? diff < 0 : diff > 0) && Math.abs(diff) > 0.4, worse: diff !== 0 && (lowerBetter ? diff > 0 : diff < 0) && Math.abs(diff) > 0.4 });
  }
  return (
    <div className="table-wrap">
      <table className="t compact">
        <thead><tr><th /><th>At visit</th><th style={{ textAlign: "right" }}>Now (home)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>{r.base}</td>
              <td style={{ textAlign: "right" }} className={r.better ? "delta good" : r.worse ? "delta bad" : ""}>{r.now} {r.better ? "↓" : r.worse ? "↑" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TASK_STATUS: Record<string, string> = { DONE: "✔", NOT_DONE: "✖ not done", MISSED: "missed" };

function obsLabel(o: { type: string; v1: number | null; v2: number | null; text: string | null; severity: string | null }): string {
  if (o.type === "symptom") return o.text === "none" ? "no symptoms" : `${SYMPTOMS[o.text || ""] ?? o.text} (${o.severity})`;
  if (o.type === "lifestyle") return `diet ${o.text === "ok" ? "✔" : "✖"}`;
  if (o.type === "fluid_in") return `💧 ${o.text === "total" ? "intake total" : "drank +"} ${o.v1} ml`;
  if (o.type === "urine_out") return `🚻 ${o.text === "total" ? "urine total" : "urine +"} ${o.v1} ml`;
  if (o.type === "diuretic") return `diuretic ${o.v1} mg`;
  return `${VITAL_META[o.type as VitalType]?.label ?? o.type} ${o.v1}${o.v2 ? "/" + o.v2 : ""}`;
}
const labChip = (l: LabChip, k: number) => (
  <span key={`l${k}`} className={`badge ${l.flag ? "bad" : "info"}`}>🧪 {LAB_META[l.marker]?.label ?? l.marker} {l.value}{l.flag ? ` (${l.flag})` : ""}</span>
);

export function Timeline({ items }: { items: TL[] }) {
  const [filter, setFilter] = useState("all");
  const match = (i: TL) =>
    filter === "all" || i.kind === filter ||
    (filter === "kidney" && (i.kind === "lab" || i.kind === "medchange" || (i.kind === "log" && (i.labs.length > 0 || i.obs.some((o) => o.type === "fluid_in" || o.type === "urine_out" || o.type === "weight")))));
  const shown = items.filter(match).slice(0, 250);
  const hasKidney = items.some((i) => i.kind === "lab" || i.kind === "medchange" || (i.kind === "log" && i.labs.length > 0));
  const filters = [["all", "Everything"], ["log", "WhatsApp logs"], ["alert", "Alerts"], ["missed", "Missed"], ["visit", "Visits"], ...(hasKidney ? [["kidney", "Fluids, weight & labs"], ["medchange", "Med changes"]] : [])];
  let lastDay = "";
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        {filters.map(([k, l]) => (
          <button key={k} className={`check ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{l}</button>
        ))}
        <small className="muted">Every reading links back to the original WhatsApp message it came from.</small>
      </div>
      <div className="tl">
        {shown.map((i, idx) => {
          const dk = dayKey(i.at);
          const sep = dk !== lastDay ? (lastDay = dk, <div key={`d${idx}`} className="daysep">{fmtDate(i.at, { weekday: "short", day: "numeric", month: "short" })}</div>) : null;
          return (
            <div key={idx}>
              {sep}
              <div className="tl-item">
                <div className="tl-time">{fmtTime(i.at)}</div>
                <div className={`tl-ic ${i.kind}`}>{i.kind === "log" ? "💬" : i.kind === "alert" ? "⚠️" : i.kind === "visit" ? "🩺" : i.kind === "lab" ? "🧪" : i.kind === "medchange" ? "💊" : "⏰"}</div>
                <div>
                  {i.kind === "log" && (
                    <>
                      <small><b>{i.by}</b> ({i.role === "CAREGIVER" ? "caregiver" : "patient"}) via WhatsApp {i.parser ? `· parsed by ${i.parser}` : ""}</small>
                      <div className="wa-quote">{i.body}</div>
                      <div className="chips">
                        {i.obs.map((o, k) => (
                          <span key={k} className={`badge ${o.flag === "critical" || o.flag === "high" || o.flag === "low" ? "bad" : o.flag === "watch" ? "warn" : o.type === "fluid_in" || o.type === "urine_out" ? "info" : "brand"}`}>
                            {obsLabel(o)}
                          </span>
                        ))}
                        {i.labs.map(labChip)}
                        {i.tasks.map((tk, k) => (
                          <span key={`t${k}`} className={`badge ${tk.status === "DONE" ? "good" : "bad"}`}>{tk.label} {TASK_STATUS[tk.status] ?? tk.status}{tk.late ? " (late)" : ""}</span>
                        ))}
                      </div>
                    </>
                  )}
                  {i.kind === "lab" && (
                    <>
                      <small><b>Lab report</b> entered{i.by ? ` by ${i.by}` : " (imported)"}</small>
                      <div className="chips">{i.labs.map(labChip)}</div>
                    </>
                  )}
                  {i.kind === "medchange" && (
                    <div>
                      <b>{i.change.med_name}</b> {i.change.change.replace("_", " ")}{i.change.detail ? ` — ${i.change.detail}` : ""}{i.change.prescriber ? ` (by ${i.change.prescriber})` : ""}
                      <div className="muted">{i.change.reported_by_name ? `recorded by ${i.change.reported_by_name}` : "from imported log"} · {i.change.status === "REPORTED" ? "awaiting clinic" : i.change.status.toLowerCase()}</div>
                    </div>
                  )}
                  {i.kind === "alert" && (
                    <div>
                      <b>{i.title}</b> — {i.event === "CREATED" ? "alert raised" : i.event === "NOTIFIED" ? `Level ${i.level} (${i.actor}) notified on WhatsApp` : i.event === "TIMEOUT" ? `no response from Level ${i.level} — moving up` : i.event === "ACKNOWLEDGED" ? `${i.actor} took ownership` : i.event === "RESOLVED" ? `closed by ${i.actor}` : "nobody acknowledged"}
                      {i.note && i.event !== "CREATED" && <div className="muted">{i.note}</div>}
                    </div>
                  )}
                  {i.kind === "visit" && (
                    <div>
                      <b>Clinic visit</b> — {i.diagnosis}
                      <div className="muted">{i.notes}</div>
                    </div>
                  )}
                  {i.kind === "missed" && <div className="muted">Not logged: {i.label}</div>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PlanTab({ d, canEdit, onChange }: { d: Data; canEdit: boolean; onChange: () => void }) {
  const cur = d.current!;
  const p = cur.plan;
  const th = p.thresholds;
  return (
    <div className="grid side">
      <div className="card">
        <div className="card-head"><h3>Current care plan</h3><small>since {fmtDateTime(cur.visit_at)}</small></div>
        <h4>Diagnosis</h4>
        <p style={{ marginTop: 4 }}>{cur.diagnosis}</p>
        <h4>Medicines</h4>
        <table className="t" style={{ marginBottom: 12 }}>
          <thead><tr><th>Medicine</th><th>Schedule</th><th>For</th><th>Prescribed by</th></tr></thead>
          <tbody>
            {p.medications.map((m) => (
              <tr key={m.key}>
                <td><b>{m.name}</b>{m.instructions ? <div className="muted">{m.instructions}</div> : null}</td>
                <td>{describeMed(m)}{m.prn ? <> <span className="badge">PRN</span></> : null}</td>
                <td className="muted">{m.purpose ?? ""}</td>
                <td><small>{m.prescriber ?? d.doctor?.name}</small></td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>Home readings</h4>
        <p style={{ marginTop: 4 }}>{p.monitoring.map((m) => `${VITAL_META[m.key].label} (${m.times.join(", ")}${m.days ? `, ${m.days.length}×/week` : ", daily"})`).join(" · ")}</p>
        {(p.fluid || p.labs || th.dryWeight) && (
          <>
            <h4>Kidney care</h4>
            <p style={{ marginTop: 4 }}>
              {th.dryWeight ? <>Dry weight <b>{th.dryWeight} kg</b> ± {th.weightBand ?? 1} kg · alert on +{th.weightDayGainKg ?? 1} kg overnight<br /></> : null}
              {p.fluid ? <>Fluid limit <b>{p.fluid.limitMl} ml/day</b> (all liquids) · totals asked at {p.fluid.checkTime} · urine below {p.fluid.lowOutputMl} ml/day or output/intake below {Math.round(p.fluid.ratioLow * 100)}% = alert<br /></> : null}
              {p.labs ? <>Labs: {p.labs.panel} every <b>{p.labs.everyDays} days</b><br /></> : null}
              {th.kHigh ? <>Potassium {th.kLow}–{th.kHigh} (≥ 6 urgent) · sodium {th.naLow}–{th.naHigh} · creatinine rise &gt; {th.creatRiseAbs} mg/dL or {th.creatRisePct}% · Hb &lt; {th.hbLow}</> : null}
            </p>
          </>
        )}
        <h4>Physio / exercise</h4>
        <p style={{ marginTop: 4 }}>{p.physio.map((x) => `${x.name} — ${x.detail} (${x.times.join(", ")})`).join(" · ") || "—"}</p>
        <h4>Lifestyle</h4>
        <p style={{ marginTop: 4 }}>{p.lifestyle.map((x) => x.text).join(" · ") || "—"}</p>
        <h4>Alert limits</h4>
        <p style={{ marginTop: 4 }}>
          BP &gt; {th.sysHigh}/{th.diaHigh} or &lt; {th.sysLow} · weight +{th.weightGainKg} kg in 3 days · sugar {th.glucoseLow}–{th.glucoseHigh} · pulse {th.hrLow}–{th.hrHigh} · SpO₂ &lt; {th.spo2Low} · pain ≥ {th.painHigh}
          <br />
          Watch symptoms: {p.watchSymptoms.map((k) => SYMPTOMS[k]).join(", ") || "—"}
        </p>
        <h4>Notes</h4>
        <p style={{ marginTop: 4 }}>{cur.notes}</p>
      </div>
      <div className="stack gap16">
      <CareTeamPanel team={d.careTeam} pid={d.patient.id} canEdit={canEdit} onChange={onChange} />
      <BaselineCard b={d.baseline} pid={d.patient.id} canEdit={canEdit} now={d.now} />
      {d.consents.length > 0 && <OnboardingCard d={d} />}
      <div className="card">
        <div className="card-head"><h3>Visit history</h3></div>
        {[...d.visits].reverse().map((v, i) => (
          <div key={v.id} className="hl info">
            <span className="ic">{d.visits.length - i}</span>
            <div>
              <b>{fmtDate(v.visit_at)}</b>
              <div className="muted">{v.diagnosis}</div>
              <small>
                {v.vitals.sys ? `BP ${v.vitals.sys}/${v.vitals.dia} · ` : ""}
                {v.vitals.weight ? `Wt ${v.vitals.weight} · ` : ""}
                {v.plan.medications.length} medicines
              </small>
            </div>
          </div>
        ))}
        {d.visits.length > 1 && <Link className="btn" href={`/patients/${d.patient.id}/compare`}>⇄ Compare visits</Link>}
      </div>
      </div>
    </div>
  );
}

export function OnboardingCard({ d }: { d: Data }) {
  const people = [
    { user_id: d.patient.user_id ?? null, label: `${d.patient.name} (patient)` },
    ...d.caregivers.map((c) => ({ user_id: c.user_id, label: `L${c.level} · ${c.name}` })),
  ];
  const pending = d.consents.filter((c) => c.status === "PENDING").length;
  return (
    <div className="card">
      <div className="card-head">
        <div><h3>WhatsApp consent</h3><small>Requested in the welcome message at onboarding</small></div>
        {pending > 0 && <span className="badge warn">{pending} waiting</span>}
      </div>
      {d.consents.length ? <ConsentList consents={d.consents} people={people} /> : <div className="muted">No consent requests on record.</div>}
      {pending > 0 && (d.viewer.role === "DOCTOR" || d.viewer.role === "PA") && <small className="muted" style={{ display: "block", marginTop: 8 }}>Open the WhatsApp simulator and reply <b>YES</b> from each phone.</small>}
    </div>
  );
}
