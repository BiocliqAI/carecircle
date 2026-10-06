"use client";
// Assistant prepares the next visit: attendance, check-in vitals, new reports, medicine changes and the
// family's questions, then "Ready for the doctor". Saved as you go; the doctor's consult view reads it.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, avatarColor, initials, useSession } from "./client";
import { Icon } from "./Icon";
import { shorthand } from "./PatientChart";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/time";
import { LAB_META, type Visit } from "@/lib/types";

interface Prep {
  attendance: boolean;
  attendanceNote: string;
  vitals: { bp?: string; weight?: string; hr?: string; glucose?: string; spo2?: string };
  vitalsAt: number | null;
  vitalsByName: string | null;
  docsChecked: boolean;
  flags: { id: string; text: string; medChangeId?: number }[];
  questions: string;
  readyAt: number | null;
  readyByName: string | null;
}
interface Data {
  now: number;
  patient: { id: string; name: string; age: number | null; sex: string };
  doctor: { name: string } | null;
  current: Visit | null;
  visits: Visit[];
  summary: { highlights: { tone: string; text: string }[] } | null;
  documents: { id: number; title: string; category: string; source: string; uploaded_at: number; filed_at: number | null; uploaded_by_name: string | null }[];
  latestLabs: { marker: string; value: number; at: number }[];
  medChanges: { id: number; med_name: string; change: string; detail: string | null; prescriber: string | null; reported_by_name: string | null; at: number; status: string }[];
  baseline: { allergies: string } | null;
  prep: Prep | null;
}

const VITALS: [keyof Prep["vitals"], string][] = [["bp", "BP (mmHg)"], ["weight", "Weight (kg)"], ["hr", "Pulse (bpm)"], ["glucose", "Sugar (mg/dL)"], ["spo2", "SpO₂ (%)"]];

export function VisitPrepare({ id }: { id: string }) {
  const { notifyChange } = useSession();
  const [d, setD] = useState<Data | null>(null);
  const [p, setP] = useState<Prep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [flagText, setFlagText] = useState("");
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const vitalsDraft = useRef<Prep["vitals"] | null>(null);

  const load = () => api<Data>(`/api/patients/${id}`).then((x) => { setD(x); setP(x.prep ?? null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);
  const [brief, setBrief] = useState<{ executiveSummary: string; consultationDiscussionPoints: string[] } | null>(null);
  useEffect(() => { api<{ summary: { executiveSummary: string; consultationDiscussionPoints: string[] } | null }>(`/api/patients/${id}/ai-summary?stored=1`).then((r) => setBrief(r.summary)).catch(() => undefined); }, [id]);

  async function save(patch: Record<string, unknown>) {
    setSaving("saving");
    try {
      const r = await api<{ prep: Prep }>(`/api/patients/${id}/prep`, { body: patch });
      setP((cur) => ({ ...(cur as Prep), ...r.prep }));
      setSaving("saved");
    } catch (e) {
      setErr((e as Error).message);
      setSaving("idle");
    }
  }
  /** Debounced save for typing fields (one timer per field, so edits to different fields don't cancel each other). */
  function saveSoon(key: string, patch: () => Record<string, unknown>) {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => save(patch()), 600);
  }

  if (err && !d) return <main className="page"><div className="alert bad">{err}</div></main>;
  if (!d || !p) return <main className="page"><div className="empty"><span className="spin" /></div></main>;

  const cur = d.current;
  const since = cur?.visit_at ?? 0;
  const newDocs = d.documents.filter((x) => x.uploaded_at > since);
  const newLabs = d.latestLabs.filter((l) => l.at > since);
  const reported = d.medChanges.filter((m) => m.status === "REPORTED");
  const hasVitals = Object.values(p.vitals).some(Boolean);
  const steps = [p.attendance, hasVitals, p.docsChecked || (!newDocs.length && !newLabs.length), true, true];
  const done = steps.filter(Boolean).length - 2 + (reported.every((m) => p.flags.some((f) => f.medChangeId === m.id)) ? 1 : 0) + (p.questions.trim() ? 1 : 0);
  const total = 5;
  const next = cur?.next_visit_at;
  const allergy = d.baseline?.allergies && !/^(none|nil|nkda|no)/i.test(d.baseline.allergies) ? d.baseline.allergies : null;

  return (
    <main className="pc">
      <div className="pc-banner" style={{ paddingBottom: 16 }}>
        <div className="pc-inner row between" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 14, flexWrap: "nowrap" }}>
            <span className="avatar" style={{ width: 44, height: 44, background: avatarColor(d.patient.name) }}>{initials(d.patient.name)}</span>
            <div>
              <div className="row" style={{ gap: 10 }}>
                <Link href={`/patients/${id}`} style={{ color: "var(--c-ink)" }}><h1 style={{ fontSize: 22, fontWeight: 700 }}>{d.patient.name}</h1></Link>
                <span className="v2-sub num" style={{ fontSize: 14 }}>{[d.patient.age, d.patient.sex === "M" ? "Male" : d.patient.sex === "F" ? "Female" : d.patient.sex].filter(Boolean).join(" · ")}</span>
                {allergy && <span className="pc-chip red">Allergy: {allergy}</span>}
              </div>
              <div className="v2-sub num" style={{ fontSize: 14, marginTop: 2 }}>Preparing <b style={{ color: "var(--c-ink)" }}>Visit {d.visits.length + 1}</b>{next ? ` · ${fmtDate(next, { weekday: "short", day: "numeric", month: "short" })}, ${fmtTime(next)}` : ""}{d.doctor ? ` · ${d.doctor.name}` : ""}</div>
            </div>
          </div>
          <div className="stack" style={{ alignItems: "flex-end", gap: 4 }}>
            <span className="v2-sub" style={{ fontWeight: 600 }}>{Math.min(done, total)} of {total} done</span>
            <div className="prep-bar"><span style={{ width: `${(Math.min(done, total) / total) * 100}%` }} /></div>
          </div>
        </div>
      </div>

      <div className="pc-body">
        <div className="pc-inner v2-grid12">
          <section className="v2-card span8" style={{ overflow: "hidden" }}>
            <div className="row between" style={{ padding: "14px 18px" }}><h2 className="v2-h2">Visit preparation</h2><span className="v2-sub">{saving === "saving" ? "Saving…" : saving === "saved" ? "Saved" : "Saved as you go"}</span></div>

            <Step n={1} done={p.attendance} title="Attendance confirmed">
              <label className={`check ${p.attendance ? "on" : ""}`}><input type="checkbox" checked={p.attendance} onChange={(e) => save({ attendance: e.target.checked })} /> The patient or family confirmed they’re coming</label>
              <input className="prep-input" style={{ marginTop: 8 }} placeholder="Note, e.g. Suresh confirmed on WhatsApp" defaultValue={p.attendanceNote} onChange={(e) => { const v = e.target.value; saveSoon("note", () => ({ attendanceNote: v })); }} />
            </Step>

            <Step n={2} done={hasVitals} title="Clinic vitals at check-in" sub={p.vitalsAt ? `Saved ${fmtDateTime(p.vitalsAt)}${p.vitalsByName ? ` by ${p.vitalsByName}` : ""}` : undefined}>
              <div className="prep-vitals">
                {VITALS.map(([k, l]) => (
                  <label key={k} className="f">{l}<input className="num" defaultValue={p.vitals[k] ?? ""} placeholder={k === "bp" ? "138/86" : ""} onChange={(e) => {
                    vitalsDraft.current = { ...(vitalsDraft.current ?? p.vitals), [k]: e.target.value.trim() };
                    saveSoon("vitals", () => ({ vitals: vitalsDraft.current }));
                  }} /></label>
                ))}
              </div>
            </Step>

            <Step n={3} done={steps[2]} title="New labs and documents filed">
              {newLabs.length === 0 && newDocs.length === 0 && <div className="v2-sub" style={{ fontSize: 13.5 }}>Nothing new since the last visit.</div>}
              <div className="row" style={{ gap: 8 }}>
                {newLabs.length > 0 && <span className="prep-chip num">Labs · {fmtDate(newLabs[0].at, { day: "numeric", month: "short" })} · {newLabs.slice(0, 4).map((l) => `${LAB_META[l.marker]?.label ?? l.marker} ${l.value}`).join(", ")}</span>}
                {newDocs.map((x) => <span key={x.id} className="prep-chip">{x.title} · {fmtDate(x.uploaded_at, { day: "numeric", month: "short" })}{x.source === "whatsapp" ? " · WhatsApp" : ""}{!x.filed_at && <b style={{ color: "var(--c-amber)", marginLeft: 6 }}>not filed</b>}</span>)}
              </div>
              {(newLabs.length > 0 || newDocs.length > 0) && (
                <div className="row" style={{ marginTop: 10 }}>
                  <label className={`check ${p.docsChecked ? "on" : ""}`}><input type="checkbox" checked={p.docsChecked} onChange={(e) => save({ docsChecked: e.target.checked })} /> All new reports are filed</label>
                  {newDocs.some((x) => !x.filed_at) && <Link href={`/patients/${id}?tab=documents`} className="tq-link">Open documents</Link>}
                </div>
              )}
            </Step>

            <Step n={4} done={reported.every((m) => p.flags.some((f) => f.medChangeId === m.id))} title="Medicine changes and flags for the doctor">
              {reported.map((m) => {
                const flagged = p.flags.some((f) => f.medChangeId === m.id);
                return (
                  <div key={m.id} className="prep-flagrow">
                    <span style={{ flex: 1, fontSize: 14 }}><b>{m.med_name}</b> {m.change.replace("_", " ")}{m.detail ? ` (${m.detail})` : ""}{m.prescriber ? ` by ${m.prescriber}` : ""}. <span className="v2-sub">Reported{m.reported_by_name ? ` by ${m.reported_by_name}` : ""}, {fmtDate(m.at, { day: "numeric", month: "short" })}.</span></span>
                    {flagged ? <span className="v2-pill amber">Flagged for doctor</span> : <button className="v2-btn" onClick={() => save({ flagMedChange: m.id })}>Flag for doctor</button>}
                  </div>
                );
              })}
              {p.flags.filter((f) => !f.medChangeId).map((f) => (
                <div key={f.id} className="prep-flagrow"><span style={{ flex: 1, fontSize: 14 }}>{f.text}</span><button className="tq-link" onClick={() => save({ flags: p.flags.filter((x) => x.id !== f.id) })}>Remove</button></div>
              ))}
              <div className="row" style={{ marginTop: 8, flexWrap: "nowrap" }}>
                <input className="prep-input" placeholder="Add a flag, e.g. Stopped atorvastatin for 3 days (muscle aches)" value={flagText} onChange={(e) => setFlagText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && flagText.trim()) { save({ flags: [...p.flags, { id: `f${Date.now()}`, text: flagText.trim() }] }); setFlagText(""); } }} />
                <button className="v2-btn" disabled={!flagText.trim()} onClick={() => { save({ flags: [...p.flags, { id: `f${Date.now()}`, text: flagText.trim() }] }); setFlagText(""); }}>Add</button>
              </div>
            </Step>

            <Step n={5} done={!!p.questions.trim()} title="Questions from the patient or family" last>
              <textarea className="prep-input" style={{ minHeight: 70 }} placeholder="e.g. Is it safe to travel to Chennai on 20 Oct for a week?" defaultValue={p.questions} onChange={(e) => { const v = e.target.value; saveSoon("questions", () => ({ questions: v })); }} />
            </Step>

            <div className="row between prep-foot">
              <span className="v2-sub" style={{ fontSize: 13 }}>{p.readyAt ? `Marked ready ${fmtDateTime(p.readyAt)}${p.readyByName ? ` by ${p.readyByName}` : ""}` : "The doctor can still change anything."}</span>
              <div className="row">
                <Link href="/doctor" className="v2-btn">Save and leave</Link>
                {p.readyAt
                  ? <button className="v2-btn" onClick={() => { save({ ready: false }); notifyChange(); }}>Undo ready</button>
                  : <button className="v2-btn primary" onClick={async () => { await save({ ready: true }); notifyChange(); }}><Icon name="check" size={16} stroke={2.4} />Mark ready for {d.doctor?.name ?? "the doctor"}</button>}
              </div>
            </div>
          </section>

          <div className="span4 stack gap16">
            <section className="v2-card pad">
              <h2 style={{ marginBottom: 8 }}>What {d.doctor?.name ?? "the doctor"} will see first</h2>
              {brief && (
                <div style={{ marginBottom: 10, padding: "10px 12px", background: "#F0F8F6", border: "1px solid #CFE5DF", borderRadius: 10, fontSize: 13.5 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".05em", color: "var(--c-brand)", textTransform: "uppercase" }}>✨ AI brief, prepared automatically</div>
                  <div style={{ margin: "4px 0" }}>{brief.executiveSummary}</div>
                  {brief.consultationDiscussionPoints.slice(0, 3).map((x, i) => <div key={i} className="v2-sub" style={{ fontSize: 12.5 }}>💡 {x}</div>)}
                </div>
              )}
              <ul className="pc-bullets num" style={{ fontSize: 13.5 }}>
                {(d.summary?.highlights ?? []).slice(0, 4).map((h, i) => <li key={i}>{h.text}</li>)}
                {hasVitals && <li>Clinic today: {VITALS.filter(([k]) => p.vitals[k]).map(([k, l]) => `${l.split(" ")[0]} ${p.vitals[k]}`).join(", ")}</li>}
                {p.flags.map((f) => <li key={f.id} style={{ color: "var(--c-amber)" }}>Flag: {f.text}</li>)}
                {p.questions.trim() && <li style={{ color: "var(--c-amber)" }}>Question: {p.questions.trim()}</li>}
                {!d.summary && !hasVitals && !p.flags.length && <li className="v2-sub">First visit: no home data yet.</li>}
              </ul>
            </section>
            <section className="v2-card pad">
              <h2 style={{ marginBottom: 6 }}>Current plan{cur ? ` (from Visit ${d.visits.length})` : ""}</h2>
              {cur ? cur.plan.medications.map((m) => <div key={m.key} className="v2-kv num" style={{ fontSize: 13.5 }}><span>{m.name} {m.dose}</span><span className="v2-sub">{shorthand(m)}</span></div>) : <div className="v2-sub">No plan yet; Visit 1 creates it.</div>}
              <p className="v2-sub" style={{ margin: "10px 0 0" }}>Only the doctor can change the plan.</p>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function Step({ n, done, title, sub, children, last }: { n: number; done: boolean; title: string; sub?: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className="prep-step" style={last ? undefined : undefined}>
      <span className={`prep-dot ${done ? "done" : ""}`}>{done ? <Icon name="check" size={15} stroke={2.8} title="Done" /> : n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        {sub && <div className="v2-sub" style={{ fontSize: 13 }}>{sub}</div>}
        <div style={{ marginTop: 8 }}>{children}</div>
      </div>
    </div>
  );
}
