"use client";
// Assistant's Today: a work queue of things that need a person (finish onboarding, chase consents,
// prepare visits, file documents, reconcile medicine changes, fix unresponsive care circles).
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useSession } from "../client";
import { GettingStarted } from "../GettingStarted";
import { Icon } from "../Icon";
import { greeting } from "./DoctorToday";
import { fmtDate, fmtTime, relDays } from "@/lib/time";
import type { PaTask, TaskKind } from "@/lib/patasks";

interface Data {
  now: number;
  tasks: PaTask[];
  pipeline: { label: string; names: string[] }[];
  visits: { id: string; name: string; at: number; ready: boolean; doctor: string | null }[];
  doneToday: { at: number; text: string }[];
  counts: { tasks: number; drafts: number; consents: number; visits: number };
}

const KIND: Record<TaskKind, { icon: string; color: string; bg: string }> = {
  onboarding: { icon: "draft", color: "#0F5C55", bg: "#E1EFEC" },
  consent: { icon: "chat", color: "#9A4A06", bg: "#FEF0E1" },
  visit: { icon: "calendar", color: "#1D4ED8", bg: "#E8EEFB" },
  document: { icon: "clip", color: "#3D4B48", bg: "#EEF1F0" },
  medchange: { icon: "pill", color: "#6B3FA0", bg: "#F3EDFA" },
  circle: { icon: "userx", color: "#A01D14", bg: "#FDE8E7" },
  baseline: { icon: "draft", color: "#0F5C55", bg: "#E1EFEC" },
};
type Tab = "todo" | "onboarding" | "visits" | "done";

export function PaToday() {
  const { user, bump, loading, notifyChange } = useSession();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("todo");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const load = () => api<Data>("/api/pa-today").then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => {
    if (!loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump, loading, user?.id]);

  if (err) return <main className="page"><div className="alert bad">{err}. <Link href="/">Switch persona</Link></div></main>;
  if (!d) return <main className="page"><div className="empty"><span className="spin" /></div></main>;

  async function run(task: PaTask, a: PaTask["actions"][number]) {
    if (!a.api) return;
    setBusy(task.id + a.label);
    try {
      await api(a.api.path, { body: a.api.body });
      setToast(a.label === "Resend" ? `Consent reminder sent for ${task.patient}.` : `${task.patient}: flagged for the doctor at the next visit.`);
      notifyChange();
      await load();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const list = tab === "todo" ? d.tasks : tab === "onboarding" ? d.tasks.filter((x) => x.kind === "onboarding" || x.kind === "consent") : tab === "visits" ? d.tasks.filter((x) => x.kind === "visit") : [];
  const first = user?.name.split(" ")[0];

  return (
    <main className="page" style={{ maxWidth: 1240 }}>
      <header className="v2-head">
        <div>
          <div className="date">{fmtDate(d.now, { weekday: "long", day: "numeric", month: "long" })}</div>
          <h1>{greeting(d.now)}, {first}</h1>
        </div>
        <div className="v2-strip">
          <div><b>{d.counts.tasks}</b><span>tasks</span></div>
          <div><b>{d.counts.drafts}</b><span>drafts to finish</span></div>
          <div><b style={{ color: d.counts.consents ? "var(--c-amber)" : undefined }}>{d.counts.consents}</b><span>consents pending</span></div>
          <div><b>{d.counts.visits}</b><span>visits to prepare</span></div>
        </div>
      </header>
      {toast && <div className="alert good" style={{ marginBottom: 14 }}><div>{toast}</div></div>}

      <div className="stack gap16">
        <GettingStarted />
        <div className="v2-grid12">
          <section className="v2-card span8" style={{ overflow: "hidden" }}>
            <div className="row between" style={{ borderBottom: "1px solid var(--c-line)", paddingRight: 18 }}>
              <nav className="v2-tabs" style={{ borderBottom: 0 }} aria-label="Work queue">
                <button className={tab === "todo" ? "on" : ""} onClick={() => setTab("todo")}>To do <span className={`v2-count ${d.tasks.length ? "brand" : ""}`}>{d.tasks.length}</span></button>
                <button className={tab === "onboarding" ? "on" : ""} onClick={() => setTab("onboarding")}>Onboarding <span className="v2-count">{d.tasks.filter((x) => x.kind === "onboarding" || x.kind === "consent").length}</span></button>
                <button className={tab === "visits" ? "on" : ""} onClick={() => setTab("visits")}>Visit prep <span className="v2-count">{d.tasks.filter((x) => x.kind === "visit").length}</span></button>
                <button className={tab === "done" ? "on" : ""} onClick={() => setTab("done")}>Done today <span className="v2-count">{d.doneToday.length}</span></button>
              </nav>
              <span className="v2-sub">Oldest first</span>
            </div>
            {tab === "done" ? (
              <div style={{ padding: "4px 18px 10px" }}>
                {d.doneToday.length === 0 && <div className="v2-sub" style={{ padding: "18px 0", textAlign: "center" }}>Nothing yet today.</div>}
                {d.doneToday.map((x, i) => <div key={i} className="v2-list-row num"><span style={{ width: 52, color: "var(--c-mute)" }}>{fmtTime(x.at)}</span><span>{x.text}</span></div>)}
              </div>
            ) : list.length === 0 ? (
              <div className="tq-empty" style={{ padding: 32, textAlign: "center", color: "var(--c-mute)" }}>{tab === "todo" ? "All caught up." : "Nothing here."}</div>
            ) : (
              list.map((x, i) => {
                const k = KIND[x.kind];
                return (
                  <div key={x.id} className="pa-task" style={i === 0 ? { borderTop: 0 } : undefined}>
                    <span className="pa-ic" style={{ background: k.bg, color: k.color }}><Icon name={k.icon} /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="pa-kind" style={{ color: k.color }}>{x.label}</div>
                      {x.patientId ? <Link href={`/patients/${x.patientId}`} className="pa-name">{x.patient}</Link> : <div className="pa-name">{x.patient}</div>}
                      <div className="v2-sub" style={{ fontSize: 13 }}>{x.detail}</div>
                    </div>
                    <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                      {x.actions.map((a) => a.href ? (
                        <a key={a.label} className={`v2-btn ${a.primary ? "primary" : ""}`} href={a.href}>{a.label}</a>
                      ) : (
                        <button key={a.label} className={`v2-btn ${a.primary ? "primary" : ""}`} disabled={busy === x.id + a.label} onClick={() => run(x, a)}>{busy === x.id + a.label ? <span className="spin" /> : null}{a.label}</button>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <div className="span4 stack gap16">
            <section className="v2-card pad">
              <div className="row between" style={{ marginBottom: 12 }}><h2>Onboarding pipeline</h2><Link href="/patients/new" className="v2-sub" style={{ color: "var(--c-brand)", fontWeight: 600 }}>New patient</Link></div>
              <ol className="pipeline num">
                {d.pipeline.map((s, i) => (
                  <li key={s.label}>
                    <span className="pl-n" style={i === 2 && s.names.length ? { background: "var(--c-amber-soft)", color: "var(--c-amber)" } : i === 3 ? { background: "var(--c-blue-soft)", color: "var(--c-blue)" } : undefined}>{i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row between"><span style={{ fontWeight: 600, fontSize: 14 }}>{s.label}</span><b>{s.names.length}</b></div>
                      <div className="v2-sub">{s.names.length ? s.names.slice(0, 3).join(", ") + (s.names.length > 3 ? ` +${s.names.length - 3}` : "") : i === 3 ? "Book with the treating doctor once everyone consents" : "None"}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <section className="v2-card pad">
              <div className="row between" style={{ marginBottom: 6 }}><h2>Visits this week</h2><span className="v2-sub">{d.visits.length}</span></div>
              {d.visits.length === 0 && <div className="v2-sub" style={{ padding: "8px 0" }}>No visits in the next 7 days.</div>}
              {d.visits.map((v) => (
                <Link key={v.id} href={`/patients/${v.id}/visit`} className="v2-list-row num">
                  <span style={{ width: 54, fontWeight: 600 }}>{relDays(d.now, v.at) === 0 ? "Today" : fmtDate(v.at, { weekday: "short", day: "numeric" })}</span>
                  <span style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{v.name}</b><span className="v2-sub" style={{ display: "block" }}>{fmtTime(v.at)}{v.doctor ? ` · ${v.doctor}` : ""} · {v.ready ? "ready" : "not prepared"}</span></span>
                  {v.ready ? <span style={{ color: "var(--c-green)" }}><Icon name="check" stroke={2.4} title="Prepared" /></span> : <span className="pl-open" aria-label="Not prepared" role="img" />}
                </Link>
              ))}
            </section>
            {d.doneToday.length > 0 && (
              <section className="v2-card pad">
                <h2 style={{ marginBottom: 6 }}>Done today</h2>
                {d.doneToday.slice(0, 5).map((x, i) => <div key={i} className="v2-list-row num" style={{ fontSize: 13.5, color: "var(--c-ink2)" }}>{fmtTime(x.at)} · {x.text}</div>)}
              </section>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
