"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, use, useEffect, useState } from "react";
import { api, useSession } from "@/components/client";
import { AdherenceHeatmap, EscalationCard, Highlights, KpiRow, SymptomTable, VitalCharts, visitDayKeys } from "@/components/interval";
import { KidneyBrief } from "@/components/kidney";
import type { IntervalSummary, VisitDiff } from "@/lib/summary";
import type { Visit } from "@/lib/types";
import { fmtDate, relDays } from "@/lib/time";

interface Data {
  patient: { id: string; name: string; conditions: string };
  visits: { id: string; visit_at: number; diagnosis: string }[];
  a: Visit;
  b: Visit | null;
  to: number;
  diff: VisitDiff | null;
  interval: IntervalSummary;
}

const SYM: Record<string, string> = { added: "+", removed: "−", changed: "~", same: "=" };

export default function ComparePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<main className="page"><div className="empty"><span className="spin" /></div></main>}>
      <Compare id={id} />
    </Suspense>
  );
}

function Compare({ id }: { id: string }) {
  const sp = useSearchParams();
  const router = useRouter();
  const { loading, bump, user } = useSession();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const qa = sp.get("a") || "";
  const qb = sp.get("b") || "";

  useEffect(() => {
    if (loading) return;
    const q = new URLSearchParams();
    if (qa) q.set("a", qa);
    if (qb) q.set("b", qb);
    api<Data>(`/api/patients/${id}/compare?${q}`).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message));
  }, [id, qa, qb, loading, bump, user?.id]);

  if (err) return <main className="page"><div className="alert bad">{err}. <Link href={`/patients/${id}`}>Back</Link></div></main>;
  if (!d) return <main className="page"><div className="empty"><span className="spin" /> Loading…</div></main>;

  const idx = (vid: string) => d.visits.findIndex((v) => v.id === vid) + 1;
  const aNo = idx(d.a.id);
  const bNo = d.b ? idx(d.b.id) : null;
  const go = (a: string, b: string) => router.push(`/patients/${id}/compare?a=${a}&b=${b}`);
  const s = d.interval;
  const df = d.diff;
  const clinician = user?.role === "DOCTOR" || user?.role === "PA";
  const markers = d.visits.map((v, i) => ({ t: v.visit_at, label: `Visit ${i + 1}` }));
  const changedMeds = df?.meds.filter((m) => m.change !== "same").length ?? 0;

  return (
    <main className="page">
      <div className="page-head row between">
        <div>
          <small><Link href={`/patients/${id}`}>← {d.patient.name}</Link></small>
          <h1>
            Visit {aNo} → {bNo ? `Visit ${bNo}` : "Today"}
          </h1>
          <div className="muted">
            {fmtDate(d.a.visit_at)} → {fmtDate(d.to)} · {relDays(d.a.visit_at, d.to)} days between
          </div>
        </div>
        <div className="row">
          <label className="row" style={{ gap: 6 }}>
            <small>From</small>
            <select value={d.a.id} onChange={(e) => go(e.target.value, d.b?.id ?? "now")}>
              {d.visits.map((v, i) => (
                <option key={v.id} value={v.id} disabled={!!d.b && v.visit_at >= d.b.visit_at}>Visit {i + 1} · {fmtDate(v.visit_at)}</option>
              ))}
            </select>
          </label>
          <label className="row" style={{ gap: 6 }}>
            <small>To</small>
            <select value={d.b?.id ?? "now"} onChange={(e) => go(d.a.id, e.target.value)}>
              {d.visits.map((v, i) => (
                <option key={v.id} value={v.id} disabled={v.visit_at <= d.a.visit_at}>Visit {i + 1} · {fmtDate(v.visit_at)}</option>
              ))}
              <option value="now">Today (since Visit {aNo})</option>
            </select>
          </label>
          {clinician && <Link className="btn primary" href={`/patients/${id}/visit`}>🩺 Start Visit {d.visits.length + 1}</Link>}
        </div>
      </div>

      {!df && (
        <div className="alert info" style={{ marginBottom: 14 }}>
          <div>
            Showing what happened <b>since Visit {aNo}</b>. Once the next visit is recorded, this page will also show the visit-to-visit diff (medicines, clinic vitals, plan changes).
          </div>
        </div>
      )}

      {df && (
        <div className="stack gap16" style={{ marginBottom: 18 }}>
          <div className="grid g4">
            <Kpi l="Medicine changes" v={changedMeds} sub={`${df.meds.filter((m) => m.change === "added").length} added · ${df.meds.filter((m) => m.change === "removed").length} stopped · ${df.meds.filter((m) => m.change === "changed").length} dose/time`} />
            <Kpi l="Plan changes" v={df.physio.filter((x) => x.change !== "same").length + df.lifestyle.filter((x) => x.change !== "same").length + df.monitoring.filter((x) => x.change !== "same").length} sub="physio · lifestyle · monitoring" />
            <Kpi l="Alert limits changed" v={df.thresholds.length} sub="doctor-set thresholds" />
            <Kpi l="Care-circle alerts between" v={s.escalations.length} sub={`${s.escalations.filter((e) => e.type !== "COMPLIANCE").length} deviations / urgent`} />
          </div>

          <div className="card">
            <div className="card-head"><h3>Diagnosis</h3></div>
            {df.diagnosis.before === df.diagnosis.after ? (
              <div>{df.diagnosis.after} <span className="badge">unchanged</span></div>
            ) : (
              <div className="stack">
                <div className="diff-row removed"><span className="sym">−</span><span className="name">Visit {aNo}</span><span className="after" style={{ gridColumn: "span 2" }}>{df.diagnosis.before}</span></div>
                <div className="diff-row added"><span className="sym">+</span><span className="name">Visit {bNo}</span><span style={{ gridColumn: "span 2" }}>{df.diagnosis.after}</span></div>
              </div>
            )}
          </div>

          <div className="grid g2">
            <div className="card">
              <div className="card-head"><h3>💊 Medicines</h3><small>Visit {aNo} → Visit {bNo}</small></div>
              <DiffHead a={`Visit ${aNo}`} b={`Visit ${bNo}`} />
              {df.meds.map((m) => (
                <div key={m.name + m.change} className={`diff-row ${m.change}`}>
                  <span className="sym">{SYM[m.change]}</span>
                  <span className="name"><b>{m.name}</b></span>
                  <span className="before">{m.before ?? "—"}</span>
                  <span className="after">{m.change === "removed" ? "stopped" : m.after}</span>
                </div>
              ))}
            </div>
            <div className="card">
              <div className="card-head"><h3>🩺 Clinic vitals</h3><small>measured at the visits</small></div>
              <table className="t">
                <thead><tr><th /><th>Visit {aNo}</th><th>Visit {bNo}</th><th>Change</th></tr></thead>
                <tbody>
                  {df.vitals.map((v) => (
                    <tr key={v.key}>
                      <td>{v.label}</td>
                      <td>{v.before ?? "—"}</td>
                      <td><b>{v.after ?? "—"}</b> <small>{v.unit}</small></td>
                      <td className={v.better === true ? "delta good" : v.better === false ? "delta bad" : ""}>
                        {v.delta == null ? "—" : `${v.delta > 0 ? "+" : ""}${v.delta}${v.key === "bp" ? " sys" : ""}`} {v.better === true ? "✓" : v.better === false ? "▲" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {df.thresholds.length > 0 && (
                <>
                  <h4 style={{ marginTop: 14 }}>Alert limits changed</h4>
                  {df.thresholds.map((t) => (
                    <div key={t.label} className="diff-row changed"><span className="sym">~</span><span className="name">{t.label}</span><span className="before">{t.before ?? "—"}</span><span className="after">{t.after ?? "—"}</span></div>
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="grid g3">
            <PlanDiff title="🏃 Physio / exercise" rows={df.physio.map((p) => ({ k: p.name, change: p.change, label: p.name, before: p.before, after: p.after }))} />
            <PlanDiff title="📏 Home monitoring" rows={df.monitoring.map((p) => ({ k: p.label, change: p.change, label: p.label, before: p.before, after: p.after }))} />
            <div className="card">
              <div className="card-head"><h3>🥗 Lifestyle advice</h3></div>
              {df.lifestyle.map((l) => (
                <div key={l.text} className={`diff-row ${l.change}`} style={{ gridTemplateColumns: "22px 1fr" }}>
                  <span className="sym">{SYM[l.change]}</span><span className="name">{l.text}</span>
                </div>
              ))}
              {!df.lifestyle.length && <div className="muted">—</div>}
            </div>
          </div>
        </div>
      )}

      <h2 style={{ margin: "8px 0 12px" }}>
        What happened between {df ? "the visits" : `Visit ${aNo} and today`} <span className="muted" style={{ fontWeight: 500 }}>(logged on WhatsApp)</span>
      </h2>
      <div className="stack gap16">
        <KpiRow s={s} />
        <div className="grid side">
          <div className="card">
            <div className="card-head"><h3>Highlights</h3></div>
            <Highlights items={s.highlights} />
          </div>
          <div className="card">
            <div className="card-head"><h3>Symptoms</h3></div>
            <SymptomTable s={s} />
          </div>
        </div>
        {s.kidney && <KidneyBrief k={s.kidney} plan={d.b?.plan ?? d.a.plan} />}
        <div className="card">
          <div className="card-head"><h3>Adherence, day by day</h3></div>
          <AdherenceHeatmap s={s} visitDays={visitDayKeys(d.visits)} />
        </div>
        <VitalCharts s={s} plan={d.a.plan} base={d.a.vitals} markers={markers} />
        <div className="card">
          <div className="card-head"><h3>Care-circle alerts in this interval</h3><small>{s.escalations.length} total · handled by family, not the clinic</small></div>
          <div className="stack">
            {[...s.escalations].filter((e) => e.type !== "COMPLIANCE").reverse().map((e) => <EscalationCard key={e.id} e={e} caregivers={[]} compact />)}
            {s.escalations.filter((e) => e.type === "COMPLIANCE").length > 0 && (
              <small>+ {s.escalations.filter((e) => e.type === "COMPLIANCE").length} compliance follow-ups (missed doses / skipped exercise).</small>
            )}
            {!s.escalations.length && <div className="muted">None.</div>}
          </div>
        </div>
      </div>
    </main>
  );
}

function Kpi({ l, v, sub }: { l: string; v: number; sub: string }) {
  return (
    <div className="card tight">
      <div className="stat">
        <span className="l">{l}</span>
        <span className={`v ${v ? "warn" : "good"}`}>{v}</span>
        <span className="l">{sub}</span>
      </div>
    </div>
  );
}

function DiffHead({ a, b }: { a: string; b: string }) {
  return (
    <div className="diff-row" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--ink-3)", fontWeight: 700 }}>
      <span /> <span>Item</span> <span>{a}</span> <span>{b}</span>
    </div>
  );
}

function PlanDiff({ title, rows }: { title: string; rows: { k: string; change: string; label: string; before: string | null; after: string | null }[] }) {
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3></div>
      {rows.map((r) => (
        <div key={r.k} className={`diff-row ${r.change}`} style={{ gridTemplateColumns: "22px 1fr" }}>
          <span className="sym">{SYM[r.change]}</span>
          <span className="name">
            <b>{r.label}</b>
            <div className="muted" style={{ fontSize: 12 }}>
              {r.change === "changed" ? `${r.before} → ${r.after}` : r.change === "removed" ? `stopped (${r.before})` : r.after}
            </div>
          </span>
        </div>
      ))}
      {!rows.length && <div className="muted">—</div>}
    </div>
  );
}
