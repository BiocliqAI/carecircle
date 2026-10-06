"use client";
// Visits to other doctors: the family's card and form (/me) and the clinic's review panel (patient chart).
// The family records; the primary doctor's team applies medicine changes to the plan.
import { useEffect, useRef, useState } from "react";
import { api, useSession } from "./client";
import { blobToDataUrl } from "./speech";
import { fmtDate } from "@/lib/time";
import type { OutsideVisitView } from "@/lib/outside";

interface PlanMed { key: string; name: string; now: string; times: string[] }
interface OVData {
  visits: OutsideVisitView[];
  careTeam: { name: string; specialty: string | null; hospital: string | null }[];
  primaryDoctor: string | null;
  planMeds: PlanMed[];
  viewer: { id: string; role: string };
}

export function useOutsideVisits(pid: string) {
  const { bump } = useSession();
  const [d, setD] = useState<OVData | null>(null);
  const load = () => api<OVData>(`/api/patients/${pid}/outside-visits`).then(setD).catch(() => undefined);
  useEffect(() => {
    load();
    const i = setInterval(load, 10_000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, bump]);
  return { d, reload: load };
}

const CHANGE_WORD: Record<string, string> = { started: "Started", stopped: "Stopped", dose_changed: "Dose changed", other: "Changed" };
const short = (ms: number) => fmtDate(ms, { day: "numeric", month: "short" });
const t12 = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
};
const timesText = (t: string[] | null) => (t?.length ? t.map(t12).join(", ") : "");

function familyStatus(c: OutsideVisitView["changes"][number], primary: string | null): { text: string; tone: string } {
  if (c.status === "REPORTED") return { text: `Waiting for ${primary ?? "the clinic"}`, tone: "amber" };
  if (c.applied_at) return { text: "Added to the plan", tone: "green" };
  if (c.status === "REJECTED") return { text: "Not added to the plan", tone: "grey" };
  return { text: "Seen by the clinic", tone: "blue" };
}

function DateTile({ ms }: { ms: number }) {
  return (
    <div className="ov-date" aria-hidden>
      <b>{fmtDate(ms, { day: "numeric" })}</b>
      <span>{fmtDate(ms, { month: "short" })}</span>
    </div>
  );
}

// ---------------------------------------------------------------- family (patient / caregiver page)
export function FamilyOutsideVisits({ pid, patientFirst, you }: { pid: string; patientFirst: string; you: boolean }) {
  const { user } = useSession();
  const { d, reload } = useOutsideVisits(pid);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileFor = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!d) return null;
  const now = Date.now();
  const upcoming = d.visits.filter((v) => v.next_visit_at && v.next_visit_at >= now - 12 * 3600_000).sort((a, b) => a.next_visit_at! - b.next_visit_at!);
  const shown = d.visits.slice(0, 6);

  async function addFiles(files: FileList | null) {
    const vid = fileFor.current;
    if (!vid || !files?.length) return;
    setBusy(vid);
    try {
      await api(`/api/patients/${pid}/outside-visits`, { body: { action: "addFiles", id: vid, files: await Promise.all([...files].map(async (f) => ({ base64: await blobToDataUrl(f), mime: f.type, filename: f.name }))) } });
      setMsg("Added to the visit.");
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function remove(id: number) {
    if (!confirm("Remove this visit from the record?")) return;
    setBusy(id);
    try {
      await api(`/api/patients/${pid}/outside-visits`, { body: { action: "delete", id } });
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="fh-card ov-card">
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div>
          <h2>Other doctors</h2>
          <p className="fh-sub" style={{ margin: "4px 0 0" }}>Visits to specialists, hospitals or the local doctor. {d.primaryDoctor ?? "Your doctor"} sees them too and checks medicine changes before reminders change.</p>
        </div>
        <button className="fh-btn primary" onClick={() => setAdding(true)}>+ Add a visit</button>
      </div>

      {upcoming.length > 0 && (
        <div className="ov-upcoming">
          {upcoming.map((v) => (
            <div key={v.id}><span className="ov-cal">📅</span><div><b>{v.doctor_name ?? "Doctor"}{v.specialty ? ` · ${v.specialty}` : ""}</b><span>{fmtDate(v.next_visit_at!, { weekday: "long", day: "numeric", month: "long" })}{v.next_visit_note ? ` · ${v.next_visit_note}` : ""}</span></div></div>
          ))}
        </div>
      )}

      {msg && <div className="fh-sub" role="status" style={{ marginTop: 10 }}>{msg}</div>}
      <input ref={fileInput} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => addFiles(e.target.files)} />

      {!shown.length && (
        <div className="ov-empty">
          <p>No visits to other doctors yet.</p>
          <p className="fh-sub">After a visit, add it here, or just tell the WhatsApp assistant in your own words, e.g. <i>“We took {you ? "me" : patientFirst} to the cardiologist today, he reduced Lasix…”</i> It will ask for anything missing.</p>
        </div>
      )}

      <div className="ov-list">
        {shown.map((v) => (
          <article key={v.id} className="ov-item">
            <DateTile ms={v.visit_at} />
            <div className="ov-body">
              <div className="ov-head">
                <b>{v.doctor_name ?? "Doctor not named yet"}</b>
                <span className="fh-sub">{[v.specialty, v.hospital].filter(Boolean).join(" · ")}</span>
                {v.status === "COLLECTING" && <span className="v2-pill blue">Being recorded on WhatsApp…</span>}
              </div>
              {v.reason && <p className="ov-line"><span>Why</span>{v.reason}</p>}
              {v.changes.map((c) => {
                const st = familyStatus(c, d.primaryDoctor);
                return (
                  <div key={c.id} className="ov-change">
                    <span className="ov-pill-k">{CHANGE_WORD[c.change] ?? "Changed"}</span>
                    <span className="ov-change-t"><b>{c.med_name}</b>{c.new_dose ? ` ${c.new_dose}` : ""}{c.new_times?.length ? ` · ${timesText(c.new_times)}` : ""}{c.detail && !c.new_dose ? ` · ${c.detail}` : ""}</span>
                    <span className={`v2-pill ${st.tone}`}>{st.text}</span>
                  </div>
                );
              })}
              {v.advice && <p className="ov-line"><span>Advice</span>{v.advice}</p>}
              {v.tests && <p className="ov-line"><span>Tests</span>{v.tests}</p>}
              {(v.next_visit_at || v.next_visit_note) && <p className="ov-line"><span>Next</span>{[v.next_visit_at && fmtDate(v.next_visit_at, { weekday: "short", day: "numeric", month: "short" }), v.next_visit_note].filter(Boolean).join(" · ")}</p>}
              <div className="ov-foot">
                {v.documents.map((doc) => <a key={doc.id} className="ov-doc" href={`/api/documents/${doc.id}`} target="_blank" rel="noreferrer">📄 {doc.title}</a>)}
                <button className="tq-link" disabled={busy === v.id} onClick={() => { fileFor.current = v.id; fileInput.current?.click(); }}>{v.documents.length ? "+ Add photo" : "+ Add prescription photo"}</button>
                {(v.reported_by === user?.id) && !v.changes.some((c) => c.status !== "REPORTED") && <button className="tq-link ov-muted" disabled={busy === v.id} onClick={() => remove(v.id)}>Remove</button>}
                <span className="fh-sub ov-by">Added by {v.reported_by === user?.id ? "you" : v.reported_by_name ?? "the family"} · {v.source === "web" ? "here" : "WhatsApp"}</span>
              </div>
            </div>
          </article>
        ))}
      </div>
      {d.visits.length > shown.length && <p className="fh-sub" style={{ marginTop: 8 }}>{d.visits.length - shown.length} earlier visit{d.visits.length - shown.length > 1 ? "s" : ""} are on the record.</p>}

      {adding && <OutsideVisitForm pid={pid} data={d} patientFirst={patientFirst} you={you} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setMsg("Saved. Everyone in the care circle and the clinic can see it."); reload(); }} />}
    </section>
  );
}

// ---------------------------------------------------------------- the form (describe it → we fill it → check → save)
interface ChangeRow { medName: string; change: string; newDose: string; freq: string; times: string[] | null; detail: string }
const FREQS: [string, string, string[] | null][] = [
  ["same", "Same times as now", null], ["OD", "Once a day (morning)", ["08:00"]], ["BD", "Twice a day", ["08:00", "20:00"]],
  ["TDS", "Three times a day", ["08:00", "14:00", "20:00"]], ["HS", "At night", ["21:00"]], ["SOS", "Only if needed", null],
];
const freqOf = (times: string[] | null) => FREQS.find(([, , t]) => t && times && t.join() === times.join())?.[0] ?? (times?.length ? "custom" : "same");
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function OutsideVisitForm({ pid, data, patientFirst, you, onClose, onSaved }: { pid: string; data: OVData; patientFirst: string; you: boolean; onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState<"tell" | "form">("tell");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [f, setF] = useState({ doctorName: "", specialty: "", hospital: "", visitDate: today(), reason: "", advice: "", tests: "", nextVisitDate: "", nextVisitNote: "" });
  const [rows, setRows] = useState<ChangeRow[]>([]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const encode = () => Promise.all(files.map(async (x) => ({ base64: await blobToDataUrl(x), mime: x.type, filename: x.name })));

  async function fill() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ via: string; note: string | null; draft: typeof f; medChanges: { medName: string; change: string; newDose: string | null; times: string[] | null; detail: string }[] }>(`/api/patients/${pid}/outside-visits`, { body: { action: "draft", text, files: await encode() } });
      setF({ ...r.draft, visitDate: r.draft.visitDate || today() });
      setRows(r.medChanges.map((c) => ({ medName: c.medName, change: c.change, newDose: c.newDose ?? "", freq: freqOf(c.times), times: c.times, detail: c.detail })));
      setNote(r.note || (r.via === "rules" ? "Filled what I could. Please check and complete the details." : null));
      setStep("form");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const medChanges = rows.filter((r) => r.medName.trim()).map((r) => ({
        medName: r.medName, change: r.change, newDose: r.newDose || null, detail: r.detail || undefined,
        times: r.freq === "custom" ? r.times : FREQS.find(([k]) => k === r.freq)?.[2] ?? null,
      }));
      await api(`/api/patients/${pid}/outside-visits`, { body: { action: "save", visit: { ...f, medChanges }, files: await encode() } });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const row = (i: number, patch: Partial<ChangeRow>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const who = you ? "you" : patientFirst;

  return (
    <div className="ov-backdrop" onClick={onClose}>
      <div className="ov-modal" role="dialog" aria-modal="true" aria-labelledby="ov-title" onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <h2 id="ov-title">Visit to another doctor</h2>
          <button className="ov-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {step === "tell" && (
          <div className="stack" style={{ gap: 14 }}>
            <p className="fh-sub" style={{ margin: 0 }}>Tell us what happened in your own words and add a photo of the prescription. We'll fill the form for you to check.</p>
            <label className="stack" style={{ gap: 6, fontWeight: 600, fontSize: 15 }}>What did the doctor say?
              <textarea className="fh-input" style={{ minHeight: 110 }} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={`e.g. Took ${who === "you" ? "me" : patientFirst} to Dr Ezhilan (cardiologist) at Apollo today. He reduced Lasix to half in the morning and added Nifedipine 10 mg three times a day. Review after 3 weeks with an echo.`} />
            </label>
            <FilePick files={files} setFiles={setFiles} />
            {err && <div className="alert bad">{err}</div>}
            <div className="row" style={{ gap: 10 }}>
              <button className="fh-btn primary" disabled={busy || (!text.trim() && !files.length)} onClick={fill}>{busy ? <><span className="spin" /> Reading…</> : "Fill the form for me"}</button>
              <button className="fh-btn" disabled={busy} onClick={() => setStep("form")}>I'll fill it myself</button>
            </div>
          </div>
        )}

        {step === "form" && (
          <div className="stack" style={{ gap: 14 }}>
            {note && <div className="ov-note">✨ {note}</div>}
            <div className="ov-grid">
              <label className="ov-f">Doctor<input list="ov-team" value={f.doctorName} onChange={set("doctorName")} placeholder="Dr …" /></label>
              <label className="ov-f">Speciality<input value={f.specialty} onChange={set("specialty")} placeholder="e.g. Cardiology" /></label>
              <label className="ov-f">Hospital / clinic<input value={f.hospital} onChange={set("hospital")} /></label>
              <label className="ov-f">Date of visit<input type="date" max={today()} value={f.visitDate} onChange={set("visitDate")} /></label>
            </div>
            <datalist id="ov-team">{data.careTeam.map((c) => <option key={c.name} value={c.name}>{c.specialty ?? ""}</option>)}</datalist>
            <label className="ov-f">Why they went (optional)<input value={f.reason} onChange={set("reason")} placeholder="e.g. Breathlessness, routine review" /></label>

            <fieldset className="ov-meds">
              <legend>Medicine changes</legend>
              {!rows.length && <p className="fh-sub" style={{ margin: "0 0 8px" }}>None added. If the doctor started, stopped or changed a medicine, add it here.</p>}
              {rows.map((r, i) => {
                const cur = data.planMeds.find((m) => m.name.toLowerCase() === r.medName.toLowerCase());
                return (
                  <div key={i} className="ov-medrow">
                    <label className="ov-f">Medicine<input list="ov-plan" value={r.medName} onChange={(e) => row(i, { medName: e.target.value })} /></label>
                    <label className="ov-f">Change<select value={r.change} onChange={(e) => row(i, { change: e.target.value })}><option value="started">Started (new)</option><option value="dose_changed">Dose / timing changed</option><option value="stopped">Stopped</option><option value="other">Other</option></select></label>
                    {r.change !== "stopped" && <label className="ov-f">New dose<input value={r.newDose} onChange={(e) => row(i, { newDose: e.target.value })} placeholder="e.g. 20 mg" /></label>}
                    {r.change !== "stopped" && (
                      <label className="ov-f">When<select value={r.freq} onChange={(e) => row(i, { freq: e.target.value })}>
                        {FREQS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        {r.freq === "custom" && <option value="custom">{timesText(r.times)}</option>}
                      </select></label>
                    )}
                    <button className="ov-x sm" aria-label={`Remove ${r.medName || "medicine"}`} onClick={() => setRows(rows.filter((_, k) => k !== i))}>×</button>
                    {cur && <span className="ov-now">Now: {cur.now}</span>}
                  </div>
                );
              })}
              <datalist id="ov-plan">{data.planMeds.map((m) => <option key={m.key} value={m.name}>{m.now}</option>)}</datalist>
              <button className="tq-link" onClick={() => setRows([...rows, { medName: "", change: "started", newDose: "", freq: "same", times: null, detail: "" }])}>+ Add a medicine change</button>
            </fieldset>

            <label className="ov-f">Other advice<textarea className="fh-input" style={{ minHeight: 60 }} value={f.advice} onChange={set("advice")} placeholder="Diet, activity, anything else the doctor said" /></label>
            <div className="ov-grid">
              <label className="ov-f">Tests ordered<input value={f.tests} onChange={set("tests")} placeholder="e.g. Echo, kidney function" /></label>
              <label className="ov-f">Next visit<input type="date" min={today()} value={f.nextVisitDate} onChange={set("nextVisitDate")} /></label>
            </div>
            <label className="ov-f">About the next visit<input value={f.nextVisitNote} onChange={set("nextVisitNote")} placeholder="e.g. next month with HbA1c report" /></label>
            <FilePick files={files} setFiles={setFiles} />
            {err && <div className="alert bad">{err}</div>}
            <div className="row between">
              <span className="fh-sub">{rows.length ? `${data.primaryDoctor ?? "The clinic"}'s team will check the medicine changes before reminders change.` : "Everyone in the care circle and the clinic will see this."}</span>
              <div className="row" style={{ gap: 10 }}>
                <button className="fh-btn" disabled={busy} onClick={() => setStep("tell")}>Back</button>
                <button className="fh-btn primary" disabled={busy || !f.doctorName.trim()} onClick={save}>{busy ? <span className="spin" /> : null} Save visit</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FilePick({ files, setFiles }: { files: File[]; setFiles: (f: File[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="ov-files">
      <input ref={ref} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => { setFiles([...files, ...[...(e.target.files ?? [])]].slice(0, 6)); if (ref.current) ref.current.value = ""; }} />
      <button type="button" className="fh-btn" onClick={() => ref.current?.click()}>📎 Prescription / reports</button>
      {files.map((x, i) => <span key={i} className="ov-chip">{x.name}<button aria-label={`Remove ${x.name}`} onClick={() => setFiles(files.filter((_, k) => k !== i))}>×</button></span>)}
    </div>
  );
}

// ---------------------------------------------------------------- clinic (doctor / PA)
interface Draft { dose: string; times: string }
export function ClinicOutsideVisits({ pid, visits, onChange }: { pid: string; visits: OutsideVisitView[]; onChange: () => void }) {
  const [edit, setEdit] = useState<Record<number, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const val = (c: OutsideVisitView["changes"][number]): Draft => edit[c.id] ?? { dose: c.new_dose ?? "", times: (c.new_times ?? []).join(", ") };

  async function apply(ids: OutsideVisitView["changes"]) {
    setBusy(true);
    setMsg(null);
    try {
      const edits = ids.map((c) => {
        const v = val(c);
        return { id: c.id, dose: v.dose || undefined, times: v.times ? v.times.split(/[\s,]+/).filter(Boolean).map((x) => (/^\d:/.test(x) ? "0" + x : x)) : undefined };
      });
      const r = await api<{ applied: string[] }>(`/api/patients/${pid}/outside-visits`, { body: { action: "apply", edits } });
      setMsg({ ok: true, text: `Plan updated: ${r.applied.join("; ")}. Reminders rebuilt; the patient and family were told on WhatsApp.` });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function mark(id: number, status: "REVIEWED" | "REJECTED") {
    await api(`/api/patients/${pid}/med-changes`, { body: { action: "review", id, status } });
    onChange();
  }
  async function reviewed(id: number) {
    await api(`/api/patients/${pid}/outside-visits`, { body: { action: "review", id } });
    onChange();
  }

  return (
    <section className="v2-card pad" id="outside-visits">
      <div className="row between" style={{ marginBottom: 4 }}>
        <h2>Visits to other doctors</h2>
        <span className="v2-sub">Reported by the patient and family · medicine changes reach reminders only when applied here</span>
      </div>
      {msg && <div className={`alert ${msg.ok ? "good" : "bad"}`} style={{ margin: "8px 0" }}>{msg.text}</div>}
      {!visits.length && <p className="v2-sub" style={{ margin: "10px 0 0" }}>None yet. The family can add them from their page or on WhatsApp.</p>}
      {visits.map((v) => {
        const pending = v.changes.filter((c) => c.status === "REPORTED");
        return (
          <article key={v.id} className="ov-citem">
            <div className="row between" style={{ alignItems: "flex-start", gap: 12 }}>
              <div className="row" style={{ gap: 12, alignItems: "flex-start", flexWrap: "nowrap" }}>
                <DateTile ms={v.visit_at} />
                <div>
                  <div className="row" style={{ gap: 8 }}>
                    <b style={{ fontSize: 15 }}>{v.doctor_name ?? "Doctor not named"}</b>
                    {v.specialty && <span className="pc-chip">{v.specialty}</span>}
                    {v.hospital && <span className="v2-sub">{v.hospital}</span>}
                    {v.status === "COLLECTING" && <span className="v2-pill blue">Family still answering on WhatsApp</span>}
                  </div>
                  <div className="v2-sub" style={{ marginTop: 2 }}>Reported by {v.reported_by_name ?? "family"} via {v.source === "web" ? "their page" : "WhatsApp"} · {short(v.created_at)}{v.next_visit_at ? ` · next visit ${fmtDate(v.next_visit_at, { weekday: "short", day: "numeric", month: "short" })}` : ""}</div>
                </div>
              </div>
              {v.reviewed_at ? <span className="v2-pill green">Reviewed by {v.reviewed_by_name?.split(" ").slice(0, 2).join(" ")}</span> : !pending.length && v.status === "COMPLETE" ? <button className="v2-btn" onClick={() => reviewed(v.id)}>Mark reviewed</button> : null}
            </div>
            {(v.reason || v.advice || v.tests) && (
              <div className="ov-ctext">
                {v.reason && <div><span>Why</span>{v.reason}</div>}
                {v.advice && <div><span>Advice</span>{v.advice}</div>}
                {v.tests && <div><span>Tests</span>{v.tests}</div>}
              </div>
            )}
            {v.changes.length > 0 && (
              <table className="ov-table">
                <thead><tr><th>Medicine</th><th>Reported change</th><th>Dose</th><th>Times</th><th /></tr></thead>
                <tbody>
                  {v.changes.map((c) => {
                    const d = val(c);
                    const open = c.status === "REPORTED";
                    return (
                      <tr key={c.id} className={open ? "" : "done"}>
                        <td><b>{c.med_name}</b><div className="v2-sub">{CHANGE_WORD[c.change]}{c.med_key ? "" : c.change === "stopped" ? "" : " · not in plan"}</div></td>
                        <td className="ov-detail">{c.detail}</td>
                        <td>{open && c.change !== "stopped" ? <input aria-label={`New dose for ${c.med_name}`} value={d.dose} onChange={(e) => setEdit({ ...edit, [c.id]: { ...d, dose: e.target.value } })} placeholder={c.change === "dose_changed" ? "e.g. 20 mg" : "dose"} /> : c.new_dose ?? "—"}</td>
                        <td>{open && c.change !== "stopped" ? <input aria-label={`Times for ${c.med_name}`} value={d.times} onChange={(e) => setEdit({ ...edit, [c.id]: { ...d, times: e.target.value } })} placeholder={c.change === "started" ? "08:00, 20:00" : "keep current"} /> : timesText(c.new_times) || "—"}</td>
                        <td className="ov-acts">
                          {open ? (
                            <>
                              <button className="v2-btn primary" disabled={busy} onClick={() => apply([c])}>Apply to plan</button>
                              <button className="tq-link" onClick={() => mark(c.id, "REVIEWED")}>Note only</button>
                              <button className="tq-link ov-muted" onClick={() => mark(c.id, "REJECTED")}>Reject</button>
                            </>
                          ) : <span className={`v2-pill ${c.applied_at ? "green" : c.status === "REJECTED" ? "grey" : "blue"}`}>{c.applied_at ? "Applied" : c.status === "REJECTED" ? "Rejected" : "Noted"}{c.reviewed_by_name ? ` · ${c.reviewed_by_name.split(" ").slice(0, 2).join(" ")}` : ""}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {pending.length > 1 && <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="v2-btn primary" disabled={busy} onClick={() => apply(pending)}>Apply all {pending.length} to the plan</button></div>}
            {v.documents.length > 0 && <div className="row" style={{ gap: 6, marginTop: 8 }}>{v.documents.map((doc) => <a key={doc.id} className="ov-doc" href={`/api/documents/${doc.id}`} target="_blank" rel="noreferrer">📄 {doc.title}</a>)}</div>}
          </article>
        );
      })}
    </section>
  );
}
