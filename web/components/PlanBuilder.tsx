"use client";
// Care-plan builder: capture the printed prescription, the consultation and/or dictation; Gemini merges them
// into a draft with sources; the doctor resolves conflicts, confirms unclear items and sends the plan.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, avatarColor, initials, useSession } from "./client";
import { Icon } from "./Icon";
import { blobToDataUrl, speechCtor, type SpeechRec } from "./speech";
import { fmtDate, fmtTime } from "@/lib/time";
import { SYMPTOMS, VITAL_META } from "@/lib/types";
import type { DraftMed, PlanDraft, SourceKind, Tag } from "@/lib/plandraft";

interface Resp { draft: PlanDraft; blockers: { conflicts: number; toConfirm: number } | null; prep?: { flags: { text: string }[]; questions: string; readyAt: number | null }; hasVisit?: boolean }
interface PatientInfo { name: string; age: number | null; sex: string; conditions: string; visits: number; allergy: string | null }

const TAG: Record<Tag, [string, string]> = { rx: ["Prescription", "t-rx"], talk: ["Conversation", "t-talk"], keep: ["Carried forward", "t-keep"], protocol: ["Protocol", "t-prot"], pa: ["PA flag", "t-pa"] };
const CHG: Record<string, [string, string]> = { new: ["New", "c-new"], changed: ["Changed", "c-chg"], same: ["No change", "c-same"], stopped: ["Stopped", "c-stop"] };
const SRC: Record<SourceKind, { icon: string; label: string; cls: string }> = { rx: { icon: "file", label: "Prescription photo", cls: "s-rx" }, conversation: { icon: "mic", label: "Consultation", cls: "s-talk" }, dictation: { icon: "mic", label: "Dictation", cls: "s-dict" } };

function Tags({ list }: { list: Tag[] }) {
  return <>{list.map((t) => <span key={t} className={`pb-tag ${TAG[t][1]}`}>{TAG[t][0]}</span>)}</>;
}

export function PlanBuilder({ id }: { id: string }) {
  const router = useRouter();
  const { user, notifyChange } = useSession();
  const [d, setD] = useState<Resp | null>(null);
  const [p, setP] = useState<PatientInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<DraftMed | null>(null);
  const [nextVisit, setNextVisit] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api<Resp>(`/api/patients/${id}/plan-draft`).then((r) => { setD(r); if (r.draft.built?.nextVisit?.date) setNextVisit((v) => v || r.draft.built!.nextVisit!.date!); });
  useEffect(() => {
    load().catch((e) => setErr(e.message));
    api<{ patient: { name: string; age: number | null; sex: string; conditions: string }; visits: unknown[]; baseline: { allergies: string } | null }>(`/api/patients/${id}`)
      .then((x) => setP({ ...x.patient, visits: x.visits.length, allergy: x.baseline?.allergies && !/^(none|nil|nkda|no)/i.test(x.baseline.allergies) ? x.baseline.allergies : null }))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setErr(null);
    try {
      const r = await api<Resp>(`/api/patients/${id}/plan-draft`, { body });
      setD((cur) => ({ ...(cur as Resp), ...r }));
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }
  async function addFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    await act("rx", { action: "source", kind: "rx", base64: await blobToDataUrl(f), mime: f.type || "image/jpeg" });
  }
  async function send() {
    setBusy("send");
    setErr(null);
    try {
      await api(`/api/patients/${id}/plan-draft`, { body: { action: "send", nextVisit: nextVisit || null } });
      notifyChange();
      router.push(`/patients/${id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  if (!d) return <main className="page">{err ? <div className="alert bad">{err}</div> : <div className="empty"><span className="spin" /></div>}</main>;
  const b = d.draft.built;
  const stale = !!b && d.draft.sources.some((s) => s.at > b.at);
  const bl = d.blockers;
  const isDoctor = user?.role === "DOCTOR";
  const canSend = isDoctor && !!b && !stale && bl && !bl.conflicts && !bl.toConfirm;
  const changes = b ? b.medications.filter((m) => m.change !== "same").length : 0;
  const step = !b ? 1 : canSend ? 3 : 2;

  return (
    <main className="pc">
      <div className="pc-banner" style={{ paddingBottom: 14 }}>
        <div className="pc-inner row between" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 14, flexWrap: "nowrap" }}>
            {p && <span className="avatar" style={{ width: 44, height: 44, background: avatarColor(p.name) }}>{initials(p.name)}</span>}
            <div>
              <div className="row" style={{ gap: 10 }}>
                <Link href={`/patients/${id}`} style={{ color: "var(--c-ink)" }}><h1 style={{ fontSize: 22, fontWeight: 700 }}>{p?.name ?? "…"}</h1></Link>
                {p && <span className="v2-sub num" style={{ fontSize: 14 }}>{[p.age, p.sex === "M" ? "Male" : p.sex === "F" ? "Female" : p.sex, p.conditions].filter(Boolean).join(" · ")}</span>}
                {p?.allergy && <span className="pc-chip red">Allergy: {p.allergy}</span>}
              </div>
              <div className="v2-sub" style={{ fontSize: 14, marginTop: 2 }}><b style={{ color: "var(--c-ink)" }}>Visit {(p?.visits ?? 0) + 1}</b> · building the care plan from today’s consultation</div>
            </div>
          </div>
          <ol className="pb-steps">
            <li className={step === 1 ? "on" : "done"}>1 · Capture</li>
            <li className={step === 2 ? "on" : step > 2 ? "done" : ""}>2 · Review draft</li>
            <li className={step === 3 ? "on" : ""}>3 · Send</li>
          </ol>
        </div>
      </div>

      <div className="pc-body">
        <div className="pc-inner v2-grid12">
          {/* ---------- sources */}
          <div className="span4 stack gap16">
            <section className="v2-card pad">
              <div className="row between" style={{ marginBottom: 6 }}><h2>Sources</h2><span className="v2-sub">merged into one draft</span></div>
              {d.draft.sources.length === 0 && <p className="v2-sub" style={{ fontSize: 13.5, margin: "4px 0 10px" }}>Add the printed prescription, listen to the consultation, or dictate. Use any combination.</p>}
              {d.draft.sources.map((s) => (
                <div key={s.id} className="pb-src">
                  <span className={`pb-src-ic ${SRC[s.kind].cls}`}><Icon name={SRC[s.kind].icon} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row between" style={{ flexWrap: "nowrap" }}><b style={{ fontSize: 14 }}>{SRC[s.kind].label}</b><button className="pb-x" aria-label={`Remove ${SRC[s.kind].label}`} onClick={() => act(`rm${s.id}`, { action: "removeSource", id: s.id })}>✕</button></div>
                    <div className="v2-sub num">{fmtTime(s.at)}{s.seconds ? ` · ${Math.floor(s.seconds / 60)}:${String(s.seconds % 60).padStart(2, "0")} recorded` : ""} · {s.text.split(/\s+/).length} words</div>
                    <button className="tq-link" style={{ padding: "4px 0" }} onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Hide text" : s.kind === "rx" ? "Show what was read" : "Show transcript"}</button>
                    {open === s.id && <pre className="pb-text">{s.text}</pre>}
                  </div>
                </div>
              ))}
              {d.prep && (d.prep.flags.length > 0 || d.prep.questions) && (
                <div className="pb-src">
                  <span className="pb-src-ic s-pa"><Icon name="draft" /></span>
                  <div style={{ flex: 1 }}><b style={{ fontSize: 14 }}>From the assistant’s prep</b><div className="v2-sub">{[d.prep.flags.length ? `${d.prep.flags.length} flag${d.prep.flags.length > 1 ? "s" : ""}` : "", d.prep.questions ? "1 family question" : ""].filter(Boolean).join(" · ")} · plus the current plan</div></div>
                </div>
              )}

              <div className="pb-add">
                <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={addFile} />
                <button className="v2-btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy === "rx" ? <><span className="spin" /> Reading…</> : <><Icon name="file" size={16} />Prescription photo</>}</button>
                <Recorder kind="conversation" label="Listen to consultation" disabled={!!busy && busy !== "conversation"} onDone={(base64, mime, seconds) => act("conversation", { action: "source", kind: "conversation", base64, mime, seconds })} busy={busy === "conversation"} />
                <Recorder kind="dictation" label="Dictate" disabled={!!busy && busy !== "dictation"} onDone={(base64, mime, seconds) => act("dictation", { action: "source", kind: "dictation", base64, mime, seconds })} busy={busy === "dictation"} />
              </div>
              <button className="v2-btn primary pb-build" disabled={!d.draft.sources.length || !!busy} onClick={() => act("build", { action: "build" })}>
                {busy === "build" ? <><span className="spin" /> Building the draft…</> : b ? (stale ? "Rebuild draft with new sources" : "Rebuild draft") : "Build draft"}
              </button>
            </section>
            <section className="v2-card pad" style={{ background: "#F8FAF9" }}>
              <h2 style={{ marginBottom: 6 }}>How the draft is built</h2>
              <p className="v2-sub" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>Each line shows where it came from. Unclear items are highlighted and conflicts must be resolved before sending. Nothing reaches the patient until you send.</p>
            </section>
          </div>

          {/* ---------- draft */}
          <div className="span8 stack gap16">
            {err && <div className="alert bad"><div>{err}</div></div>}
            {!b && (
              <div className="v2-card pad pb-empty">
                <h2>No draft yet</h2>
                <p className="v2-sub" style={{ fontSize: 14 }}>Add at least one source, then build the draft. Typical: take a photo of the printed prescription and listen to the consultation, so advice given verbally (and answers to the family’s questions) is captured too.</p>
              </div>
            )}
            {b && stale && <div className="alert warn"><div>New sources were added after this draft was built. Rebuild to include them.</div></div>}

            {b?.conflicts.map((c) => (
              <section key={c.id} className={`v2-card pad pb-conflict ${c.chosen !== null ? "resolved" : ""}`}>
                <div className="row" style={{ gap: 10 }}>
                  <span className="pb-k">{c.chosen === null ? "Conflict" : "Resolved"}</span>
                  <b style={{ fontSize: 15 }}>{c.medName ? `${c.medName}: ` : ""}the sources disagree on {c.field}</b>
                </div>
                <div className="pb-opts">
                  {c.options.map((o, i) => (
                    <label key={i} className={`pb-opt ${c.chosen === i ? "on" : ""}`}>
                      <input type="radio" name={c.id} checked={c.chosen === i} onChange={() => act(`c${c.id}`, { action: "resolve", id: c.id, option: i })} />
                      <span><b>{o.label}</b> <Tags list={[o.source]} />{o.quote && <span className="pb-quote">“{o.quote}”</span>}</span>
                    </label>
                  ))}
                </div>
              </section>
            ))}

            {b && (
              <section className="v2-card pad">
                <div className="row between" style={{ marginBottom: 4 }}><h2>Draft care plan</h2><span className="v2-sub">{bl?.toConfirm ? `${bl.toConfirm} to confirm` : "built " + fmtTime(b.at)}</span></div>

                <div className="pb-sect">Medicines</div>
                {b.medications.map((m) => (
                  <div key={m.id} className={`pb-item num ${m.confidence === "low" && !m.confirmed ? "low" : ""}`}>
                    {edit?.id === m.id ? (
                      <div className="pb-edit">
                        <input aria-label="Medicine" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                        <input aria-label="Dose" value={edit.dose} onChange={(e) => setEdit({ ...edit, dose: e.target.value })} style={{ width: 90 }} />
                        <input aria-label="Schedule" value={edit.schedule} onChange={(e) => setEdit({ ...edit, schedule: e.target.value })} style={{ width: 80 }} />
                        <input aria-label="Instructions" value={edit.instructions} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} placeholder="Instructions" />
                        <button className="v2-btn primary" onClick={async () => { if (await act(`e${m.id}`, { action: "editMed", id: m.id, patch: { name: edit.name, dose: edit.dose, schedule: edit.schedule, instructions: edit.instructions } })) setEdit(null); }}>Save</button>
                        <button className="v2-btn" onClick={() => setEdit(null)}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          {m.change === "stopped" ? <s><b>{m.name}</b> {m.dose}</s> : <><b>{m.name}</b> {m.dose}</>} <span className="v2-sub">· {m.schedule}{m.startDay ? ` · from day ${m.startDay + 1}` : ""}{m.durationDays && m.durationDays < 28 ? ` · ${m.durationDays} days` : ""}{m.instructions ? ` · ${m.instructions}` : ""}</span>
                          {m.was && m.change === "changed" && <span className="pb-quote" style={{ fontStyle: "normal" }}>was {m.was}</span>}
                          {m.quote && <span className="pb-quote">“{m.quote}”</span>}
                          {m.confidence === "low" && !m.confirmed && <span className="pb-quote" style={{ color: "var(--c-amber)", fontStyle: "normal" }}>Not sure about this one: please check</span>}
                        </span>
                        <span className={`pb-chg ${CHG[m.change][1]}`}>{CHG[m.change][0]}</span>
                        <Tags list={m.sources} />
                        {m.confidence === "low" && !m.confirmed && <button className="v2-btn" onClick={() => act(`k${m.id}`, { action: "confirm", id: m.id })}>Confirm</button>}
                        <button className="pb-x" aria-label={`Edit ${m.name}`} title="Edit" onClick={() => setEdit(m)}>✎</button>
                      </>
                    )}
                  </div>
                ))}

                {b.monitoring.length > 0 && <div className="pb-sect">Home readings and alert limits</div>}
                {b.monitoring.map((m) => (
                  <div key={m.id} className={`pb-item num ${m.confidence === "low" && !m.confirmed ? "low" : ""}`}>
                    <span style={{ flex: 1 }}><b>{VITAL_META[m.key].label}</b> <span className="v2-sub">· {m.times.join(", ")}</span>{m.alert && <> · {m.alert}</>}{m.quote && <span className="pb-quote">“{m.quote}”</span>}</span>
                    <Tags list={m.sources} />
                    {m.confidence === "low" && !m.confirmed && <button className="v2-btn" onClick={() => act(`k${m.id}`, { action: "confirm", id: m.id })}>Confirm</button>}
                    <button className="pb-x" aria-label="Remove" onClick={() => act(`r${m.id}`, { action: "remove", id: m.id })}>✕</button>
                  </div>
                ))}

                {b.advice.length > 0 && <div className="pb-sect">Advice</div>}
                {b.advice.map((a) => (
                  <div key={a.id} className={`pb-item ${a.confidence === "low" && !a.confirmed ? "low" : ""}`}>
                    <span style={{ flex: 1 }}>{a.text}{a.quote && <span className="pb-quote">“{a.quote}”</span>}{a.confidence === "low" && !a.confirmed && <span className="pb-quote" style={{ color: "var(--c-amber)", fontStyle: "normal" }}>Heard unclearly: please confirm</span>}</span>
                    <Tags list={a.sources} />
                    {a.confidence === "low" && !a.confirmed && <button className="v2-btn" onClick={() => act(`k${a.id}`, { action: "confirm", id: a.id })}>Confirm</button>}
                    <button className="pb-x" aria-label="Remove" onClick={() => act(`r${a.id}`, { action: "remove", id: a.id })}>✕</button>
                  </div>
                ))}

                {(b.warningSigns.keys.length > 0 || b.warningSigns.text) && (
                  <>
                    <div className="pb-sect">Warning signs (alert the family urgently)</div>
                    <div className="pb-item"><span style={{ flex: 1 }}>{b.warningSigns.text || b.warningSigns.keys.map((k) => SYMPTOMS[k]).join(", ")}<span className="pb-quote" style={{ fontStyle: "normal" }}>{b.warningSigns.keys.map((k) => SYMPTOMS[k]).join(" · ")}</span></span><Tags list={b.warningSigns.sources} /></div>
                  </>
                )}

                {b.answers.length > 0 && <div className="pb-sect">Answers to the family’s questions</div>}
                {b.answers.map((a) => (
                  <div key={a.id} className="pb-item"><span style={{ flex: 1 }}><b>{a.question.replace(/^doctor,?\s*/i, "")}</b> {a.answer}{a.askedBy && <span className="pb-quote" style={{ fontStyle: "normal" }}>Asked by {a.askedBy}</span>}</span><Tags list={a.sources} /><button className="pb-x" aria-label="Remove" onClick={() => act(`r${a.id}`, { action: "remove", id: a.id })}>✕</button></div>
                ))}

                <div className="pb-sect">Tests and next visit</div>
                <div className="pb-item num">
                  <span style={{ flex: 1 }}>{b.labs ? <>{b.labs.panel}{b.labs.everyDays ? ` · every ${b.labs.everyDays} days` : ""}</> : <span className="v2-sub">No tests ordered</span>}</span>
                  <label className="row" style={{ gap: 6, fontSize: 13.5, fontWeight: 600 }}>Next visit<input type="date" value={nextVisit} onChange={(e) => setNextVisit(e.target.value)} className="pb-date" /></label>
                  {b.labs && <Tags list={b.labs.sources} />}
                </div>

                {b.note && (
                  <details className="pb-note">
                    <summary>Clinical note (drafted from today’s sources)</summary>
                    <p>{b.note}</p>
                  </details>
                )}
              </section>
            )}

            {b && (
              <section className="v2-card pad wa-preview">
                <div className="row between" style={{ marginBottom: 8 }}><h2>{p?.name.split(" ")[0] ?? "The patient"} will receive on WhatsApp</h2><span className="v2-sub">the care circle is told the plan changed</span></div>
                <div className="wa-preview-bubble">{preview(b, nextVisit)}</div>
              </section>
            )}
          </div>
        </div>

        {b && (
          <div className="consult-bar num" style={{ margin: "18px -32px -88px" }}>
            <span style={{ fontSize: 14, flex: 1 }}>
              <b>{changes} change{changes === 1 ? "" : "s"}</b>
              {bl?.conflicts ? <> · <b style={{ color: "var(--c-red)" }}>{bl.conflicts} conflict{bl.conflicts > 1 ? "s" : ""} to resolve</b></> : null}
              {bl?.toConfirm ? <> · <b style={{ color: "var(--c-amber)" }}>{bl.toConfirm} to confirm</b></> : null}
              {!isDoctor && <> · only the doctor can send</>}
            </span>
            <Link href={`/patients/${id}/visit?fromDraft=1`} className="v2-btn">Edit in full form</Link>
            <button className="v2-btn primary" style={{ minHeight: 40, padding: "0 18px", fontSize: 14 }} disabled={!canSend || busy === "send"} onClick={send}>
              {busy === "send" ? <span className="spin" /> : null}{canSend ? "Send plan" : stale ? "Rebuild first" : bl?.conflicts || bl?.toConfirm ? "Resolve items first" : "Send plan"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

function preview(b: NonNullable<PlanDraft["built"]>, nextVisit: string): string {
  const meds = b.medications.filter((m) => m.change !== "stopped").map((m) => `• ${m.name} ${m.dose} · ${m.schedule}${m.startDay ? ` from day ${m.startDay + 1}` : m.durationDays && m.durationDays < 28 ? ` for ${m.durationDays} days` : ""}${m.instructions ? ` (${m.instructions})` : ""}${m.change === "changed" ? " (changed)" : m.change === "new" ? " (new)" : ""}`);
  const stopped = b.medications.filter((m) => m.change === "stopped").map((m) => `• ${m.name}: stop for now`);
  const mon = b.monitoring.map((m) => VITAL_META[m.key].label).join(", ");
  const adv = b.advice.map((a) => `• ${a.text}`);
  const qa = b.answers.map((a) => `• ${a.question.replace(/^doctor,?\s*/i, "")}\n  ${a.answer}`);
  const next = nextVisit ? `Next visit: ${fmtDate(Date.parse(`${nextVisit}T12:00:00+05:30`), { weekday: "short", day: "numeric", month: "short" })}` : "";
  return [
    "Your doctor has updated your care plan:",
    [...meds, ...stopped].join("\n"),
    mon ? `Please send: ${mon}` : "",
    adv.length ? adv.join("\n") : "",
    b.labs ? `Blood tests: ${b.labs.panel}` : "",
    qa.length ? `Your questions:\n${qa.join("\n")}` : "",
    next,
  ].filter(Boolean).join("\n\n");
}

/** Records audio (consultation or dictation) with a live preview where the browser supports it. */
function Recorder({ kind, label, onDone, disabled, busy }: { kind: "conversation" | "dictation"; label: string; onDone: (base64: string, mime: string, seconds: number) => void; disabled?: boolean; busy?: boolean }) {
  const [on, setOn] = useState(false);
  const [secs, setSecs] = useState(0);
  const [preview, setPreview] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const mr = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const sr = useRef<SpeechRec | null>(null);
  const t0 = useRef(0);

  useEffect(() => {
    if (!on) return;
    const i = setInterval(() => setSecs(Math.round((Date.now() - t0.current) / 1000)), 500);
    return () => clearInterval(i);
  }, [on]);

  async function start() {
    setErr(null);
    setPreview("");
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { setErr("Microphone not available"); return; }
    let rec: MediaRecorder;
    try { rec = new MediaRecorder(stream); } catch { stream.getTracks().forEach((t) => t.stop()); setErr("Can't record on this device"); return; }
    chunks.current = [];
    rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
      onDone(await blobToDataUrl(blob), rec.mimeType || "audio/webm", Math.max(1, Math.round((Date.now() - t0.current) / 1000)));
    };
    mr.current = rec;
    rec.start(1000);
    t0.current = Date.now();
    setSecs(0);
    setOn(true);
    const Ctor = speechCtor();
    if (Ctor) {
      const r = new Ctor();
      r.lang = "en-IN";
      r.continuous = true;
      r.interimResults = true;
      let fin = "";
      r.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) fin = `${fin} ${x[0].transcript}`.trim(); else interim += x[0].transcript; }
        setPreview(`${fin} ${interim}`.trim().slice(-220));
      };
      r.onerror = () => undefined;
      r.onend = () => { if (sr.current === r) { try { r.start(); } catch { /* stopped */ } } };
      try { r.start(); sr.current = r; } catch { /* no preview */ }
    }
  }
  function stop() {
    const r = sr.current;
    sr.current = null;
    try { r?.stop(); } catch { /* noop */ }
    if (mr.current?.state === "recording") mr.current.stop();
    setOn(false);
  }

  if (busy) return <button className="v2-btn" disabled><span className="spin" /> {kind === "conversation" ? "Transcribing consultation…" : "Transcribing…"}</button>;
  if (!on) return (
    <span className="stack" style={{ gap: 4 }}>
      <button className="v2-btn" disabled={disabled} onClick={start}><Icon name="mic" size={16} />{label}</button>
      {err && <small style={{ color: "var(--c-red)" }}>{err}</small>}
    </span>
  );
  return (
    <div className="pb-rec">
      <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
        <span className="rec-dot" /><b className="num">{kind === "conversation" ? "Listening" : "Dictating"} {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</b>
        <span style={{ flex: 1 }} />
        <button className="v2-btn primary" onClick={stop}>Stop</button>
      </div>
      <div className="v2-sub" style={{ fontSize: 13, minHeight: 18 }}>{preview || (kind === "conversation" ? "Keep this running through the consultation." : "Speak your advice; say “full stop” for punctuation.")}</div>
    </div>
  );
}
