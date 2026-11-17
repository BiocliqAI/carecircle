"use client";
// Record maintenance tabs on Patient 360 (doctor / PA): profile & care circle, notes, documents.
import { useEffect, useState } from "react";
import { api } from "./client";
import { ConsentList, type ConsentView, type DeliveryMap } from "./baseline";
import { Dictate } from "./Dictate";
import { ClinicalHistoryCard } from "./ClinicalHistoryCard";
import { fmtDate, fmtDateTime } from "@/lib/time";
import { LAB_META, MAX_CAREGIVERS } from "@/lib/types";
import { DOCUMENT_ACCEPT, mimeFor, readableType } from "@/lib/mimetypes";

export interface ProfilePatient { id: string; name: string; age: number | null; sex: string; phone: string; conditions: string; address: string; user_id?: string | null; doctor_id?: string; hospital_id?: string | null }
export interface ProfileCaregiver { id: string; name: string; relation: string | null; phone: string; level: number; user_id: string | null; dashboard?: number }
export interface NoteItem { id: number; author_id: string; author_name: string | null; author_role: string | null; kind: string; body: string; created_at: number; updated_at: number }
export interface DocItem { id: number; title: string; category: string; mime: string; size: number; notes: string | null; source: string; uploaded_by_name: string | null; uploaded_at: number; filed_at: number | null; filed_by_name: string | null; extract: string | null; filed_labs?: number; filed_visits?: number; onboarding_id?: number | null }

const CATS: [string, string][] = [["prescription", "Prescription"], ["lab", "Lab report"], ["discharge", "Discharge summary"], ["imaging", "Imaging"], ["voice", "Voice note"], ["other", "Other"]];
const catLabel = (c: string) => CATS.find((x) => x[0] === c)?.[1] ?? "Other";
const MAX_UPLOAD_MB = 50; // matches MAX_DOC_BYTES in lib/records.ts (server-only module)
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ---------------------------------------------------------------- profile + care circle
export function ProfileTab({ patient, caregivers, consents, delivery, onChange, children }: { patient: ProfilePatient; caregivers: ProfileCaregiver[]; consents: ConsentView[]; delivery?: DeliveryMap; onChange: () => void; children?: React.ReactNode }) {
  return (
    <div className="grid side">
      <div className="stack gap16">
        <DetailsCard p={patient} onChange={onChange} />
        <ClinicalHistoryCard pid={patient.id} />
        <CareCircleCard pid={patient.id} patient={patient} caregivers={caregivers} consents={consents} delivery={delivery} onChange={onChange} />
      </div>
      <div className="stack gap16">{children}</div>
    </div>
  );
}

export function DetailsCard({ p, onChange }: { p: ProfilePatient; onChange: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ name: p.name, age: p.age?.toString() ?? "", sex: p.sex || "F", phone: p.phone, address: p.address || "", conditions: p.conditions || "", doctorId: p.doctor_id ?? "" });
  const [doctors, setDoctors] = useState<{ id: string; name: string; role: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (edit) api<{ staff: { id: string; name: string; role: string }[] }>("/api/clinic").then((r) => setDoctors(r.staff.filter((s) => s.role === "DOCTOR"))).catch(() => undefined);
  }, [edit]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/patients/${p.id}`, { method: "PATCH", body: { ...f, age: f.age ? Number(f.age) : null } });
      setEdit(false);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h3>Patient details</h3>
        {!edit && <button className="btn sm" onClick={() => { setF({ name: p.name, age: p.age?.toString() ?? "", sex: p.sex || "F", phone: p.phone, address: p.address || "", conditions: p.conditions || "", doctorId: p.doctor_id ?? "" }); setEdit(true); }}>Edit</button>}
      </div>
      {!edit ? (
        <dl className="kv">
          <dt>Name</dt><dd>{p.name}</dd>
          <dt>Age / sex</dt><dd>{p.age ?? "—"} · {p.sex === "M" ? "Male" : p.sex === "F" ? "Female" : p.sex || "—"}</dd>
          <dt>WhatsApp</dt><dd>{p.phone}</dd>
          {p.hospital_id && <><dt>Hospital ID</dt><dd>{p.hospital_id}</dd></>}
          <dt>Address</dt><dd>{p.address || "—"}</dd>
          <dt>Conditions</dt><dd>{p.conditions || "—"}</dd>
        </dl>
      ) : (
        <div className="stack">
          <div className="grid g2">
            <label className="f">Full name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="f">WhatsApp number<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
            <label className="f">Age<input type="number" min={0} max={120} value={f.age} onChange={(e) => setF({ ...f, age: e.target.value })} /></label>
            <label className="f">Sex
              <select value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value })}><option value="F">Female</option><option value="M">Male</option><option value="O">Other</option></select>
            </label>
            <label className="f">Address / area<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
            <label className="f">Treating doctor
              <select value={f.doctorId} onChange={(e) => setF({ ...f, doctorId: e.target.value })}>
                {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="f" style={{ gridColumn: "1 / -1" }}>Conditions<input value={f.conditions} onChange={(e) => setF({ ...f, conditions: e.target.value })} placeholder="Hypertension, CKD stage 3…" /></label>
          </div>
          {f.phone.replace(/\D/g, "") !== p.phone.replace(/\D/g, "") && <div className="alert warn"><div>Changing the number moves the patient’s WhatsApp conversation to the new number.</div></div>}
          {err && <div className="alert bad">{err}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? <span className="spin" /> : null} Save</button>
            <button className="btn" onClick={() => { setEdit(false); setErr(null); }}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Removes the patient and their whole record, after typing their name. Shown to the patient's doctor only. */
/** Clears chosen kinds of records while keeping the patient, their profile, care circle and care team. */
export function ClearRecordsCard({ p, onChange }: { p: ProfilePatient; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<{ parts: Record<string, string>; counts: Record<string, number> } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === p.name.trim().toLowerCase();
  async function load() {
    try { setInfo(await api(`/api/patients/${p.id}/clear`)); } catch (e) { setErr((e as Error).message); }
  }
  async function clear() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ removed: Record<string, number> }>(`/api/patients/${p.id}/clear`, { body: { parts: picked, confirmName: typed } });
      const total = Object.values(r.removed).reduce((a, b) => a + b, 0);
      setDone(`Cleared ${total} record${total === 1 ? "" : "s"}.`);
      setOpen(false); setPicked([]); setTyped("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <h3>Clear records</h3>
        {!open && <button className="btn sm" onClick={() => { setOpen(true); setDone(null); load(); }}>Clear…</button>}
      </div>
      {!open ? (
        <p className="muted">Removes chosen records (visits, labs, documents…) but keeps {p.name}, the profile, care circle and care team.{done ? ` ${done}` : ""}</p>
      ) : !info ? (err ? <div className="alert bad">{err}</div> : <span className="spin" />) : (
        <div className="stack">
          {Object.entries(info.parts).map(([k, label]) => (
            <label key={k} className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "center" }}>
              <input type="checkbox" style={{ width: 16, height: 16, minHeight: 0, margin: 0, flex: "none" }} disabled={!info.counts[k]} checked={picked.includes(k)} onChange={(e) => setPicked(e.target.checked ? [...picked, k] : picked.filter((x) => x !== k))} />
              <span style={{ flex: 1 }}>{label}</span>
              <span className="muted">{info.counts[k] || "none"}</span>
            </label>
          ))}
          {picked.length > 0 && <div className="alert bad"><div>This permanently deletes the ticked records for {p.name}. It can&rsquo;t be undone. The patient, profile, care circle, consents and care team are kept.</div></div>}
          <label className="f">Type <b>{p.name}</b> to confirm<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
          {err && <div className="alert bad">{err}</div>}
          <div className="row">
            <button className="btn danger" disabled={!matches || !picked.length || busy} onClick={clear}>{busy ? <span className="spin" /> : null} Clear {picked.length ? `${picked.length} kind${picked.length > 1 ? "s" : ""} of record` : "records"}</button>
            <button className="btn" onClick={() => { setOpen(false); setPicked([]); setTyped(""); setErr(null); }}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

export function DeletePatientCard({ p }: { p: ProfilePatient }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === p.name.trim().toLowerCase();

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/patients/${p.id}`, { method: "DELETE", body: { confirmName: typed } });
      window.location.assign("/patients");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h3>Delete patient</h3>
        {!open && <button className="btn sm" onClick={() => setOpen(true)}>Delete…</button>}
      </div>
      {!open ? (
        <p className="muted">Removes {p.name} and their whole record. This can't be undone.</p>
      ) : (
        <div className="stack">
          <div className="alert bad"><div>This permanently deletes {p.name}&rsquo;s visits, readings, labs, alerts, documents, notes, care circle and WhatsApp conversation. It can&rsquo;t be undone.</div></div>
          <label className="f">Type <b>{p.name}</b> to confirm<input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus /></label>
          {err && <div className="alert bad">{err}</div>}
          <div className="row">
            <button className="btn danger" disabled={!matches || busy} onClick={remove}>{busy ? <span className="spin" /> : null} Delete {p.name}</button>
            <button className="btn" onClick={() => { setOpen(false); setTyped(""); setErr(null); }}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

interface CgDraft { id?: string; name: string; relation: string; phone: string; dashboard: boolean }

export function CareCircleCard({ pid, patient, caregivers, consents, delivery, onChange }: { pid: string; patient: ProfilePatient; caregivers: ProfileCaregiver[]; consents: ConsentView[]; delivery?: DeliveryMap; onChange: () => void }) {
  const [edit, setEdit] = useState(false);
  const [rows, setRows] = useState<CgDraft[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = () => {
    setRows(caregivers.map((c) => ({ id: c.id, name: c.name, relation: c.relation ?? "", phone: c.phone, dashboard: c.dashboard !== 0 })));
    setErr(null);
    setEdit(true);
  };
  const set = (i: number, patch: Partial<CgDraft>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/patients/${pid}/caregivers`, { body: { caregivers: rows } });
      setEdit(false);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const people = [{ user_id: patient.user_id ?? null, label: `${patient.name} (patient)` }, ...caregivers.map((c) => ({ user_id: c.user_id, label: `${c.level === 1 ? "Primary" : "Backup"} · ${c.name}` }))];

  return (
    <section className="card">
      <div className="card-head">
        <div><h3>Care circle</h3><small>Alerts go to the primary caregiver first, then the backup. The clinic is never auto-alerted.</small></div>
        {!edit && <button className="btn sm" onClick={start}>Edit</button>}
      </div>
      {!edit ? (
        <div className="stack">
          {caregivers.map((c) => (
            <div key={c.id} className="cg-view">
              <span className={`lvl ${c.level === 1 ? "" : "backup"}`}>{c.level === 1 ? "Primary" : "Backup"}</span>
              <div style={{ flex: 1 }}>
                <b>{c.name}</b> <span className="muted">({c.relation || "Family"})</span>
                <div className="muted">{c.phone} · {c.dashboard === 0 ? "WhatsApp only" : "WhatsApp + dashboard"}</div>
              </div>
            </div>
          ))}
          {consents.length > 0 && (
            <>
              <h4 style={{ marginTop: 6 }}>WhatsApp consent</h4>
              <ConsentList consents={consents} people={people} delivery={delivery} />
            </>
          )}
        </div>
      ) : (
        <div className="stack">
          {rows.map((r, i) => (
            <div key={r.id ?? `new${i}`} className="cg-edit">
              <div className="row between">
                <b>{i === 0 ? "Primary caregiver" : "Backup caregiver"}{!r.id ? <span className="badge info" style={{ marginLeft: 6 }}>new</span> : null}</b>
                <div className="row" style={{ gap: 4 }}>
                  {rows.length > 1 && <button className="btn sm ghost" title="Swap primary and backup" onClick={() => setRows((x) => [...x].reverse())}>⇅ Swap</button>}
                  {rows.length > 1 && <button className="btn sm ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>Remove</button>}
                </div>
              </div>
              <div className="grid g3">
                <label className="f">Name<input value={r.name} onChange={(e) => set(i, { name: e.target.value })} /></label>
                <label className="f">Relation<input value={r.relation} onChange={(e) => set(i, { relation: e.target.value })} placeholder="Daughter, Son…" /></label>
                <label className="f">WhatsApp number<input value={r.phone} onChange={(e) => set(i, { phone: e.target.value })} /></label>
              </div>
              <label className={`check ${r.dashboard ? "on" : ""}`} style={{ marginTop: 6 }}><input type="checkbox" checked={r.dashboard} onChange={(e) => set(i, { dashboard: e.target.checked })} /> Dashboard access</label>
            </div>
          ))}
          {rows.length < MAX_CAREGIVERS && <div><button className="btn sm" onClick={() => setRows((x) => [...x, { name: "", relation: "", phone: "+91 ", dashboard: true }])}>+ Add {rows.length === 0 ? "primary" : "backup"} caregiver</button></div>}
          <small className="muted">New people (or a new number) get a WhatsApp welcome asking them to reply YES. Anyone removed is told they’ve left the care circle.</small>
          {err && <div className="alert bad">{err}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? <span className="spin" /> : null} Save care circle</button>
            <button className="btn" onClick={() => setEdit(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- notes
export function NotesTab({ pid, notes, viewerId, viewerRole, onChange }: { pid: string; notes: NoteItem[]; viewerId: string; viewerRole: string; onChange: () => void }) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/patients/${pid}/notes`, { body });
      onChange();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid side">
      <div className="stack gap16">
        <section className="card">
          <div className="card-head"><h3>{viewerRole === "DOCTOR" ? "Add a clinical note" : "Add a note"}</h3><small>Visible to the care team only, never to the patient or family</small></div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={viewerRole === "DOCTOR" ? "Assessment, plan, counselling given…" : "Call summary, logistics, follow-ups…"} style={{ minHeight: 90 }} />
          {err && <div className="alert bad" style={{ marginTop: 8 }}>{err}</div>}
          <div className="row" style={{ marginTop: 8, alignItems: "flex-start" }}>
            <button className="btn primary" disabled={busy || !text.trim()} onClick={async () => { if (await act({ action: "add", body: text })) setText(""); }}>Save note</button>
            <div style={{ flex: 1, minWidth: 240 }}><Dictate patientId={pid} onText={(t) => setText((cur) => (cur.trim() ? `${cur.trim()}\n${t}` : t))} /></div>
          </div>
          <small className="muted" style={{ display: "block", marginTop: 6 }}>Dictated text is added to the box above. Check it, especially doses, before saving.</small>
        </section>
        {notes.length === 0 ? <div className="card muted">No notes yet.</div> : (
          <section className="card" style={{ padding: 0 }}>
            {notes.map((n) => (
              <article key={n.id} className="note">
                <div className="row between">
                  <div>
                    <b>{n.author_name ?? "Unknown"}</b> <span className={`badge ${n.kind === "clinical" ? "brand" : ""}`}>{n.kind === "clinical" ? "Clinical note" : n.author_role === "PA" ? "PA note" : "Note"}</span>
                    <div className="muted">{fmtDateTime(n.created_at)}{n.updated_at !== n.created_at ? ` · edited ${fmtDateTime(n.updated_at)}` : ""}</div>
                  </div>
                  {n.author_id === viewerId && editing?.id !== n.id && (
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn sm ghost" onClick={() => setEditing({ id: n.id, body: n.body })}>Edit</button>
                      <button className="btn sm ghost" onClick={() => window.confirm("Delete this note?") && act({ action: "delete", id: n.id })}>Delete</button>
                    </div>
                  )}
                </div>
                {editing?.id === n.id ? (
                  <div className="stack" style={{ marginTop: 8 }}>
                    <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} style={{ minHeight: 80 }} />
                    <div className="row">
                      <button className="btn sm primary" disabled={busy} onClick={async () => { if (await act({ action: "edit", id: n.id, body: editing.body })) setEditing(null); }}>Save</button>
                      <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : <p className="note-body">{n.body}</p>}
              </article>
            ))}
          </section>
        )}
      </div>
      <div className="callout">Notes are part of the clinical record and every change is audited. You can only edit or delete notes you wrote.</div>
    </div>
  );
}

// ---------------------------------------------------------------- documents

type TextRow = { test: string; group?: string; result: string; reference?: string };
type VisitRow = { date: string | null; doctorName: string; specialty?: string; hospital?: string; reason?: string; findings?: string; advice?: string; tests?: string; nextVisitDate?: string | null; medChanges?: { medName: string; change: string; newDose?: string; frequency?: string; detail?: string }[]; kind: "outside" | "treating" | "skip"; recorded?: string | null; nearby?: string | null };
const shortDay = (d: string) => fmtDate(Date.parse(`${d}T12:00:00+05:30`), { day: "numeric", month: "short", year: "numeric" });
interface ReadOut { title: string; date: string | null; prescriber: string | null; labs: { marker: string; value: number; unit: string; date?: string }[]; texts?: TextRow[]; visits?: VisitRow[]; meds: number; medList?: string[]; note: string | null; reread?: boolean; done?: boolean }
const readOut = (raw: string | null): ReadOut | null => { try { return raw ? (JSON.parse(raw) as ReadOut) : null; } catch { return null; } };
const READ_WINDOW_MS = 3 * 60_000; // after this, an unread document is treated as "couldn't be read"
const readable = (d: DocItem) => readableType(d.mime, d.title);
/** A reading still waiting for a person: on an unchecked document, or one read again on request. */
const awaitingCheck = (d: DocItem) => { const x = readOut(d.extract); return !d.filed_at || (!!x && !!x.reread && !x.done); };

/** What the AI read, for the checker to compare with the original, correct, and confirm or reject. */
function ReadPanel({ d, pid, busy, act, refresh }: { d: DocItem; pid: string; busy: boolean; act: (b: Record<string, unknown>) => Promise<boolean>; refresh: () => void }) {
  const x = readOut(d.extract);
  const waiting = !x && !d.filed_at && Date.now() - d.uploaded_at < READ_WINDOW_MS;
  useEffect(() => { if (!waiting) return; const i = setInterval(refresh, 5000); return () => clearInterval(i); }, [waiting, refresh]);
  const [rows, setRows] = useState<{ marker: string; value: string; date?: string }[]>([]);
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [date, setDate] = useState("");
  const [adding, setAdding] = useState("");
  const [texts, setTexts] = useState<TextRow[]>([]);
  useEffect(() => { setRows(x?.labs.map((l) => ({ marker: l.marker, value: String(l.value), ...(l.date ? { date: l.date } : {}) })) ?? []); setTexts(x?.texts ?? []); setVisits(x?.visits ?? []); setDate(x?.date ?? ""); }, [d.extract]); // eslint-disable-line react-hooks/exhaustive-deps
  if (waiting) return <div className="callout" style={{ marginTop: 8 }}><span className="spin" /> Reading the document…</div>;
  if (!x) return <div className="callout" style={{ marginTop: 8 }}>The document couldn't be read automatically. Press Read again, or open it, enter any values by hand, then press Mark checked.</div>;
  const unit = (m: string) => x.labs.find((l) => l.marker === m)?.unit || LAB_META[m]?.unit || "";
  const toRecord = visits.filter((v) => v.kind === "outside");
  const bad = rows.some((r) => r.value.trim() === "" || !Number.isFinite(Number(r.value)) || Number(r.value) < 0) || texts.some((r) => !r.result.trim()) || toRecord.some((v) => !v.date || !v.doctorName.trim());
  const setVisit = (i: number, patch: Partial<VisitRow>) => setVisits(visits.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  const xt = x.texts ?? [];
  const changed = date !== (x.date ?? "") || rows.length !== x.labs.length || rows.some((r, i) => r.marker !== x.labs[i]?.marker || Number(r.value) !== x.labs[i]?.value)
    || texts.length !== xt.length || texts.some((r, i) => r.test !== xt[i]?.test || r.result !== xt[i]?.result)
    || rows.some((r, i) => (r.date ?? "") !== (x.labs[i]?.date ?? ""))
    || JSON.stringify(visits) !== JSON.stringify(x.visits ?? []);
  const groups = [...new Set(texts.map((r) => r.group ?? ""))];
  const unused = Object.keys(LAB_META).filter((m) => !rows.some((r) => r.marker === m));
  return (
    <div className="callout" style={{ marginTop: 8 }}>
      <b>Read by AI. Compare with the original, correct anything wrong, then confirm.</b>
      <div>{x.title}{x.prescriber ? ` · ${x.prescriber}` : ""}</div>
      <label className="f" style={{ maxWidth: 220, marginTop: 6 }}>Report date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {rows.length === 0 && <div className="muted" style={{ marginTop: 4 }}>No lab values found. Add any that are on the report.</div>}
      {rows.map((r, i) => (
        <div key={`${r.marker}|${r.date ?? ""}`} className="row" style={{ gap: 6, marginTop: 4, flexWrap: "nowrap", alignItems: "center" }}>
          <span style={{ minWidth: 130 }}>{LAB_META[r.marker]?.label ?? r.marker}{r.date ? <span className="muted" style={{ fontSize: 12.5 }}> · taken {shortDay(r.date)}</span> : null}</span>
          <input className="num" inputMode="decimal" aria-label={`${LAB_META[r.marker]?.label ?? r.marker} value`} value={r.value} style={{ width: 90 }} onChange={(e) => setRows(rows.map((o, k) => (k === i ? { ...o, value: e.target.value } : o)))} />
          <span className="muted">{unit(r.marker)}</span>
          <button type="button" className="btn sm ghost" aria-label={`Remove ${LAB_META[r.marker]?.label ?? r.marker}`} onClick={() => setRows(rows.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      {unused.length > 0 && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a lab value"><option value="">+ Add a value the AI missed…</option>{unused.map((m) => <option key={m} value={m}>{LAB_META[m].label}</option>)}</select>
          {adding && <button type="button" className="btn sm" onClick={() => { setRows([...rows, { marker: adding, value: "" }]); setAdding(""); }}>Add</button>}
        </div>
      )}
      {visits.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <b style={{ fontSize: 13 }}>{visits.length === 1 ? "Visit in this document" : `${visits.length} visits in this document`}</b>
          {visits.map((v, i) => (
            <div key={i} className="card" style={{ marginTop: 6, padding: 10 }}>
              <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <input type="date" aria-label="Visit date" value={v.date ?? ""} style={{ width: 160 }} onChange={(e) => setVisit(i, { date: e.target.value || null })} />
                <input aria-label="Doctor" value={v.doctorName} placeholder="Doctor's name" style={{ width: 200 }} onChange={(e) => setVisit(i, { doctorName: e.target.value })} />
                {v.specialty && <span className="muted">{v.specialty}</span>}
                <select aria-label="Where this visit goes" value={v.kind} onChange={(e) => setVisit(i, { kind: e.target.value as VisitRow["kind"] })}>
                  <option value="outside">{v.recorded ? "Update the recorded visit" : "Record as a visit to another doctor"}</option>
                  <option value="treating">Treating doctor&rsquo;s visit (enter on the visit form)</option>
                  <option value="skip">Don&rsquo;t record</option>
                </select>
              </div>
              {(v.recorded || v.nearby) && <div className="muted" style={{ marginTop: 4, color: "var(--c-amber)" }}>⚠ {v.recorded ?? v.nearby}</div>}
              <div style={{ marginTop: 4, fontSize: 13.5 }}>
                {v.reason && <div><b>Reason:</b> {v.reason}</div>}
                {v.findings && <div><b>Findings:</b> {v.findings}</div>}
                {v.advice && <div><b>Advice:</b> {v.advice}</div>}
                {v.tests && <div><b>Tests ordered:</b> {v.tests}</div>}
                {v.medChanges?.length ? <div><b>Medicines:</b> {v.medChanges.map((m) => `${m.medName} ${m.change.replace("_", " ")}${m.newDose ? ` ${m.newDose}` : ""}${m.frequency ? ` ${m.frequency}` : ""}`).join("; ")}</div> : null}
                {v.nextVisitDate && <div><b>Next visit:</b> {shortDay(v.nextVisitDate)}</div>}
              </div>
              {v.kind === "outside" && !v.date && <div className="muted" style={{ color: "var(--c-red)" }}>Enter the date to record this visit.</div>}
              {v.kind === "treating" && (
                v.date
                  ? <a className="btn sm" style={{ marginTop: 6 }} href={`/patients/${pid}/visit?date=${v.date}&fromDoc=${d.id}&v=${i}`}>Open the visit form for {shortDay(v.date)} ↗</a>
                  : <div className="muted">Enter the date, then open the visit form.</div>
              )}
            </div>
          ))}
          <small className="muted">Visits to another doctor are recorded on their own dates when you file; nothing is sent to the family, and older medicine changes are kept as history. The treating doctor&rsquo;s visits set the care plan, so they&rsquo;re entered on the visit form.</small>
        </div>
      )}
      {texts.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <b style={{ fontSize: 13 }}>Other results, as printed ({texts.length})</b>
          {groups.map((g) => (
            <div key={g || "-"} style={{ marginTop: 4 }}>
              {g && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{g}</div>}
              {texts.map((r, i) => (r.group ?? "") !== g ? null : (
                <div key={i} className="row" style={{ gap: 6, marginTop: 4, flexWrap: "nowrap", alignItems: "center" }}>
                  <span style={{ minWidth: 130 }}>{r.test}</span>
                  <input aria-label={`${r.test} result`} value={r.result} style={{ width: 200 }} onChange={(e) => setTexts(texts.map((o, k) => (k === i ? { ...o, result: e.target.value } : o)))} />
                  {r.reference && <span className="muted" style={{ fontSize: 12.5 }}>ref. {r.reference}</span>}
                  <button type="button" className="btn sm ghost" aria-label={`Remove ${r.test}`} onClick={() => setTexts(texts.filter((_, k) => k !== i))}>✕</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {x.medList && x.medList.length > 0 && <div className="muted" style={{ marginTop: 6 }}>Medicines seen (not entered from here): {x.medList.join("; ")}</div>}
      {x.note && <div className="muted" style={{ marginTop: 4 }}>Note: {x.note}</div>}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn sm primary" disabled={busy || bad} title={bad ? "Every value needs a number, every result some text, and every visit to record a date and a doctor" : undefined} onClick={() => act({ action: "autofile", id: d.id, date: date || null, labs: rows.map((r) => ({ marker: r.marker, value: Number(r.value), date: r.date ?? null })), texts, visits })}>
          ✓ {changed ? "Save corrections" : "Reading is correct"}: file{rows.length + texts.length ? ` and enter ${[rows.length ? `${rows.length} value${rows.length > 1 ? "s" : ""}` : "", texts.length ? `${texts.length} other result${texts.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ")}` : ""}{toRecord.length ? `, record ${toRecord.length} visit${toRecord.length > 1 ? "s" : ""}` : ""}
        </button>
        <button className="btn sm" disabled={busy} title="Files the document and enters nothing; add the values by hand" onClick={() => act({ action: "autofile", id: d.id, reject: true })}>✗ Not usable: file without values</button>
      </div>
    </div>
  );
}

export function DocumentsTab({ pid, docs, canEdit, onChange }: { pid: string; docs: DocItem[]; canEdit: boolean; onChange: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [fileKey, setFileKey] = useState(0); // remounts the file input so it clears after an upload
  const [meta, setMeta] = useState({ title: "", category: "lab", notes: "" });
  const [editing, setEditing] = useState<{ id: number; title: string; category: string; notes: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rereading, setRereading] = useState<number | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/patients/${pid}/documents`, { body });
      onChange();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }  // A document with values or visits filed from it: offer to remove those too, so nothing is left pointing at a deleted file.
  async function deleteDoc(d: DocItem) {
    const labs = d.filed_labs ?? 0, visits = d.filed_visits ?? 0;
    if (!labs && !visits) {
      if (window.confirm(`Delete “${d.title}”?`)) await act({ action: "delete", id: d.id });
      return;
    }
    const what = [labs ? `${labs} lab value${labs > 1 ? "s" : ""}` : "", visits ? `${visits} visit${visits > 1 ? "s" : ""} to other doctors` : ""].filter(Boolean).join(" and ");
    if (window.confirm(`Delete “${d.title}” AND the ${what} filed from it?\n\nOK: delete both. Cancel: choose to keep them.`)) await act({ action: "delete", id: d.id, withData: true });
    else if (window.confirm(`Delete only the document “${d.title}”, keeping the ${what} in the record?`)) await act({ action: "delete", id: d.id });
  }

  // One request per file, so each stays under the server's per-request limit and one bad file doesn't sink the rest.
  async function upload() {
    if (!files.length) return;
    const tooBig = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
    if (tooBig.length) return setErr(`Files are limited to ${MAX_UPLOAD_MB} MB: ${tooBig.map((f) => f.name).join(", ")}`);
    const single = files.length === 1;
    const failed: File[] = [];
    const errors: string[] = [];
    setBusy(true);
    setErr(null);
    for (const [i, file] of files.entries()) {
      setProgress(single ? null : `Uploading ${i + 1} of ${files.length}…`);
      try {
        const base64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(file); });
        const title = single ? meta.title || file.name : file.name.replace(/\.[^.]+$/, "");
        await api(`/api/patients/${pid}/documents`, { body: { action: "add", base64, mime: mimeFor(file.type, file.name), title, category: meta.category, notes: meta.notes } });
      } catch (e) {
        failed.push(file);
        errors.push(`${file.name}: ${(e as Error).message}`);
      }
    }
    setProgress(null);
    setBusy(false);
    onChange();
    setFiles(failed);
    if (failed.length) setErr(`${failed.length} of ${files.length} didn't upload. ${errors.join(" · ")}`);
    else {
      setMeta({ title: "", category: "lab", notes: "" });
      setFileKey((k) => k + 1);
    }
  }

  return (
    <div className="stack gap16">
      {canEdit && (
        <section className="card">
          <div className="card-head"><h3>Add a document</h3><small>Photos, PDFs or scans up to {MAX_UPLOAD_MB} MB each. Pick several at once to upload them together. Every upload must be checked by a person before it counts as filed.</small></div>
          <div className="grid g4" style={{ alignItems: "end" }}>
            <label className="f">Files<input key={fileKey} type="file" multiple accept={`${DOCUMENT_ACCEPT},audio/*`} onChange={(e) => { const fs = [...(e.target.files ?? [])]; setFiles(fs); setErr(null); if (fs.length === 1 && !meta.title) setMeta((m) => ({ ...m, title: fs[0].name.replace(/\.[^.]+$/, "") })); }} /></label>
            <label className="f">Title{files.length > 1 ? <input disabled value="" placeholder="Each file keeps its own name" /> : <input value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} placeholder="e.g. RFT 20 Sep" />}</label>
            <label className="f">Type
              <select value={meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value })}>{CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
            <label className="f">Notes<input value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} placeholder="Optional" /></label>
          </div>
          {err && <div className="alert bad" style={{ marginTop: 8 }}>{err}</div>}
          {files.length > 1 && <div className="muted" style={{ marginTop: 8 }}>{files.length} files: {files.map((f) => `${f.name} (${kb(f.size)})`).join(", ")}</div>}
          <div className="row" style={{ marginTop: 10, gap: 10 }}>
            <button className="btn primary" disabled={!files.length || busy} onClick={upload}>{busy ? <span className="spin" /> : "⬆"} Upload{files.length > 1 ? ` ${files.length} files` : ""}</button>
            {progress && <span className="muted">{progress}</span>}
          </div>
        </section>
      )}
      {canEdit && docs.some(readable) && (
        <div className="callout row between" style={{ gap: 10 }}>
          <span>Read these documents into the baseline: history, conditions, current medicines and labs. You check everything before it is saved.</span>
          <a className="btn sm" href={`/patients/${pid}/baseline`}>✨ Fill baseline from documents</a>
        </div>
      )}
      {docs.length === 0 ? <div className="card muted">No documents yet. Documents sent by the patient or family on WhatsApp also appear here.</div> : (
        <section className="card" style={{ padding: 0 }}>
          {docs.map((d) => (
            <div key={d.id} className="doc-row">
              <span className="doc-ic" aria-hidden>{d.category === "voice" ? "🎤" : d.mime.startsWith("image/") ? "🖼️" : d.mime === "application/pdf" ? "📄" : "📎"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {editing?.id === d.id ? (
                  <div className="grid g3" style={{ alignItems: "end" }}>
                    <label className="f">Title<input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
                    <label className="f">Type<select value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>{CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                    <label className="f">Notes<input value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></label>
                  </div>
                ) : (
                  <>
                    <b>{d.title}</b> <span className="badge">{catLabel(d.category)}</span> {d.source === "whatsapp" && <span className="badge good">via WhatsApp</span>} {d.filed_at ? <span className="badge good" title={fmtDateTime(d.filed_at)}>Checked{d.filed_by_name ? ` by ${d.filed_by_name.split(" ").slice(0, 2).join(" ")}` : ""}</span> : <span className="badge warn">Needs check</span>}
                    <div className="muted">{fmtDateTime(d.uploaded_at)}{d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ""} · {kb(d.size)}</div>
                    {d.notes && <div style={{ marginTop: 2 }}>{d.notes}</div>}
                    {canEdit && readable(d) && awaitingCheck(d) && (d.onboarding_id && !d.filed_at
                      ? <div className="callout" style={{ marginTop: 8 }}>Brought at onboarding: it&rsquo;s checked with the other records. <a href={`/patients/${pid}/onboarding`}>Open the onboarding</a></div>
                      : <ReadPanel d={d} pid={pid} busy={busy} act={act} refresh={onChange} />)}
                    {d.mime.startsWith("audio/") && <audio src={`/api/documents/${d.id}`} controls preload="none" style={{ marginTop: 6, height: 32 }} />}
                  </>
                )}
              </div>
              <div className="row" style={{ gap: 4 }}>
                {editing?.id === d.id ? (
                  <>
                    <button className="btn sm primary" disabled={busy} onClick={async () => { if (await act({ action: "update", ...editing })) setEditing(null); }}>Save</button>
                    <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <a className="btn sm" href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer">View</a>
                    {canEdit && readable(d) && <button className="btn sm ghost" disabled={busy} title="Have the AI read this document again and show what it finds for checking" onClick={async () => { setRereading(d.id); await act({ action: "reread", id: d.id }); setRereading(null); }}>{rereading === d.id ? <><span className="spin" /> Reading…</> : "↻ Read again"}</button>}
                    {canEdit && !d.filed_at && <button className="btn sm primary" disabled={busy} title="I have opened the original and the details are right" onClick={() => act({ action: "verify", id: d.id })}>Mark checked</button>}
                    {canEdit && <button className="btn sm ghost" onClick={() => setEditing({ id: d.id, title: d.title, category: d.category, notes: d.notes ?? "" })}>Edit</button>}
                    {canEdit && <button className="btn sm ghost" onClick={() => deleteDoc(d)}>Delete</button>}
                  </>
                )}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
