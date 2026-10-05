"use client";
// Record maintenance tabs on Patient 360 (doctor / PA): profile & care circle, notes, documents.
import { useEffect, useState } from "react";
import { api } from "./client";
import { ConsentList, type ConsentView } from "./baseline";
import { Dictate } from "./Dictate";
import { fmtDateTime } from "@/lib/time";
import { MAX_CAREGIVERS } from "@/lib/types";

export interface ProfilePatient { id: string; name: string; age: number | null; sex: string; phone: string; conditions: string; address: string; user_id?: string | null; doctor_id?: string }
export interface ProfileCaregiver { id: string; name: string; relation: string | null; phone: string; level: number; user_id: string | null; dashboard?: number }
export interface NoteItem { id: number; author_id: string; author_name: string | null; author_role: string | null; kind: string; body: string; created_at: number; updated_at: number }
export interface DocItem { id: number; title: string; category: string; mime: string; size: number; notes: string | null; source: string; uploaded_by_name: string | null; uploaded_at: number }

const CATS: [string, string][] = [["prescription", "Prescription"], ["lab", "Lab report"], ["discharge", "Discharge summary"], ["imaging", "Imaging"], ["voice", "Voice note"], ["other", "Other"]];
const catLabel = (c: string) => CATS.find((x) => x[0] === c)?.[1] ?? "Other";
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ---------------------------------------------------------------- profile + care circle
export function ProfileTab({ patient, caregivers, consents, onChange, children }: { patient: ProfilePatient; caregivers: ProfileCaregiver[]; consents: ConsentView[]; onChange: () => void; children?: React.ReactNode }) {
  return (
    <div className="grid side">
      <div className="stack gap16">
        <DetailsCard p={patient} onChange={onChange} />
        <CareCircleCard pid={patient.id} patient={patient} caregivers={caregivers} consents={consents} onChange={onChange} />
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

interface CgDraft { id?: string; name: string; relation: string; phone: string; dashboard: boolean }

export function CareCircleCard({ pid, patient, caregivers, consents, onChange }: { pid: string; patient: ProfilePatient; caregivers: ProfileCaregiver[]; consents: ConsentView[]; onChange: () => void }) {
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
              <ConsentList consents={consents} people={people} />
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
export function DocumentsTab({ pid, docs, canEdit, onChange }: { pid: string; docs: DocItem[]; canEdit: boolean; onChange: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState({ title: "", category: "lab", notes: "" });
  const [editing, setEditing] = useState<{ id: number; title: string; category: string; notes: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  }
  async function upload() {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return setErr("Files are limited to 5 MB");
    const base64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(file); });
    if (await act({ action: "add", base64, mime: file.type, title: meta.title || file.name, category: meta.category, notes: meta.notes })) {
      setFile(null);
      setMeta({ title: "", category: "lab", notes: "" });
    }
  }

  return (
    <div className="stack gap16">
      {canEdit && (
        <section className="card">
          <div className="card-head"><h3>Add a document</h3><small>Photos, PDFs or scans up to 5 MB</small></div>
          <div className="grid g4" style={{ alignItems: "end" }}>
            <label className="f">File<input type="file" accept="image/*,application/pdf,audio/*" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !meta.title) setMeta((m) => ({ ...m, title: f.name.replace(/\.[^.]+$/, "") })); }} /></label>
            <label className="f">Title<input value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} placeholder="e.g. RFT 20 Sep" /></label>
            <label className="f">Type
              <select value={meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value })}>{CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
            <label className="f">Notes<input value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} placeholder="Optional" /></label>
          </div>
          {err && <div className="alert bad" style={{ marginTop: 8 }}>{err}</div>}
          <div style={{ marginTop: 10 }}><button className="btn primary" disabled={!file || busy} onClick={upload}>{busy ? <span className="spin" /> : "⬆"} Upload</button></div>
        </section>
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
                    <b>{d.title}</b> <span className="badge">{catLabel(d.category)}</span> {d.source === "whatsapp" && <span className="badge good">via WhatsApp</span>}
                    <div className="muted">{fmtDateTime(d.uploaded_at)}{d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ""} · {kb(d.size)}</div>
                    {d.notes && <div style={{ marginTop: 2 }}>{d.notes}</div>}
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
                    {canEdit && <button className="btn sm ghost" onClick={() => setEditing({ id: d.id, title: d.title, category: d.category, notes: d.notes ?? "" })}>Edit</button>}
                    {canEdit && <button className="btn sm ghost" onClick={() => window.confirm(`Delete “${d.title}”?`) && act({ action: "delete", id: d.id })}>Delete</button>}
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
