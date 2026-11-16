"use client";
// Onboarding from past records (steps 2–5): add the family's records, watch them being read, check the draft
// (clinical summary, doctors, labs & home readings), send it to the doctor; the doctor confirms or sends it back.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, useSession } from "./client";
import { blobToDataUrl } from "./speech";
import { DOCUMENT_ACCEPT, mimeFor } from "@/lib/mimetypes";
import { LAB_META, VITAL_META, type VitalType } from "@/lib/types";
import { fmtDate, fmtDateTime } from "@/lib/time";
import { HistoryEditor } from "./HistorySections";
import { LazyText } from "./LazyText";
import type { Draft, DoctorItem, LabItem, OnbStatus, Point, RecordView } from "@/lib/onboarding";

interface Resp {
  now: number;
  patient: { id: string; name: string; doctorId: string; doctorName: string | null };
  viewer: { id: string; role: string; name: string };
  onboarding: { id: number; status: OnbStatus; builtAt: number | null; buildError: string | null; sentAt: number | null; sentBy: string | null; returnedAt: number | null; returnedBy: string | null; returnNote: string | null; confirmedAt: number | null; confirmedBy: string | null } | null;
  progress: { total: number; read: number; failed: number; clinicalTotal: number; clinicalRead: number; building: boolean; built: boolean; found: { labValues: number; visits: number; homeReadings: number }; records: RecordView[] } | null;
  draft: Draft | null;
  open: { points: number; forDoctor: number; labs: number; merges: number } | null;
  isUpdate: boolean;
  marks: { added: number; changed: number } | null;
  removed: { section: string; text: string }[];
}
type Tab = "summary" | "doctors" | "labs";

const day = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? fmtDate(Date.parse(`${d}T12:00:00+05:30`), { day: "numeric", month: "short", year: "numeric" }) : d || "date unknown");
function reviewedLine(pr: Resp["progress"], update = false): string {
  if (!pr) return "";
  const read = pr.records.filter((r) => r.state === "read");
  const dates = read.map((r) => r.date).filter((x): x is string => !!x && /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
  const n = (k: string) => read.filter((r) => (r.pile ?? "clinical") === k).length;
  return `${update ? "Records added in this update" : "Records reviewed"}: ${read.length} (${n("clinical")} clinical, ${n("lab")} lab reports & home readings)${dates.length ? `, ${day(dates[0])} to ${day(dates[dates.length - 1])}` : ""}. Empty parts read “Not documented”.`;
}
const first = (n: string | null | undefined) => (n ?? "").split(" ").slice(0, 2).join(" ");

export function Onboarding({ pid }: { pid: string }) {
  const { notifyChange } = useSession();
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("summary");
  const [view, setView] = useState<"records" | "review" | null>(null);
  const [uploads, setUploads] = useState<{ name: string; state: "waiting" | "sending" | "done" | "failed"; error?: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Unsaved edits are never replaced by what the server sends back (refreshes while reading, after a save, etc.).
  const dirtyRef = useRef(false);
  const version = useRef(0);
  const load = useCallback(() => api<Resp>(`/api/patients/${pid}/onboarding`).then((r) => {
    setD(r);
    setErr(null);
    setDraft((cur) => (dirtyRef.current && cur ? cur : r.draft));
  }).catch((e) => setErr((e as Error).message)), [pid]);
  useEffect(() => { void load(); }, [load]);

  const status = d?.onboarding?.status ?? null;
  const reading = status === "COLLECTING" || !!d?.progress?.building || uploads.some((u) => u.state === "waiting" || u.state === "sending");
  useEffect(() => {
    if (!reading) return;
    const i = setInterval(() => void load(), 4000);
    return () => clearInterval(i);
  }, [reading, load]);
  // Which screen: records while reading, the review once the draft is ready (either can be opened by hand).
  const shown = view ?? (!status || status === "COLLECTING" ? "records" : "review");

  // Edits save themselves shortly after the last change.
  useEffect(() => {
    if (!dirty || !draft) return;
    const h = setTimeout(async () => {
      setSaving(true);
      try {
        const at = version.current;
        await api(`/api/patients/${pid}/onboarding`, { body: { action: "save", edits: draft } });
        // Only "saved" if nothing was typed while saving; otherwise the next save picks it up.
        if (version.current === at) { dirtyRef.current = false; setDirty(false); }
      } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
    }, 800);
    return () => clearTimeout(h);
  }, [dirty, draft, pid]);
  const edit = (fn: (x: Draft) => void) => {
    version.current++;
    dirtyRef.current = true;
    setDirty(true);
    setDraft((cur) => { if (!cur) return cur; const n = structuredClone(cur); fn(n); return n; });
  };

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setErr(null);
    try {
      if (dirty && draft) { await api(`/api/patients/${pid}/onboarding`, { body: { action: "save", edits: draft } }); dirtyRef.current = false; setDirty(false); }
      const r = await api<Record<string, unknown>>(`/api/patients/${pid}/onboarding`, { body });
      await load();
      notifyChange();
      return r;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function addFiles(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    setView("records");
    setUploads((u) => [...u, ...files.map((f) => ({ name: f.name, state: "waiting" as const }))]);
    for (const f of files) {
      setUploads((u) => u.map((x) => (x.name === f.name && x.state === "waiting" ? { ...x, state: "sending" } : x)));
      try {
        await api(`/api/patients/${pid}/onboarding`, { body: { action: "upload", base64: await blobToDataUrl(f), mime: mimeFor(f.type, f.name), name: f.name } });
        setUploads((u) => u.map((x) => (x.name === f.name && x.state === "sending" ? { ...x, state: "done" } : x)));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.name === f.name && x.state === "sending" ? { ...x, state: "failed", error: (e as Error).message } : x)));
      }
      void load();
    }
  }

  if (!d) return <main className="page">{err ? <div className="alert bad">{err}</div> : <div className="empty"><span className="spin" /></div>}</main>;
  const o = d.onboarding, pr = d.progress;
  const isDoctor = d.viewer.role === "DOCTOR" && d.viewer.id === d.patient.doctorId;
  const stepNo = !o ? 2 : status === "COLLECTING" ? (pr && pr.total && pr.read + pr.failed < pr.total ? 3 : 2) : status === "SENT" ? 5 : status === "CONFIRMED" ? 6 : 4;
  const locked = status === "SENT" && !isDoctor;
  const open = draft ? { points: draft.points.filter((p) => p.status === "open" && !p.old).length, labs: draft.labs.filter((l) => l.check && !l.ok && l.value !== null).length, merges: draft.merges.length } : null;
  const toCheck = open ? open.points + open.labs + open.merges : 0;

  return (
    <main className="page" style={{ maxWidth: 1240 }}>
      <div className="page-head">
        <div>
          <small><Link href={`/patients/${pid}`}>← {d.patient.name}</Link></small>
          <h1>{d.isUpdate ? `Add records to ${d.patient.name}’s history` : `Onboard ${d.patient.name}`}</h1>
          <div className="muted">Past records → a checked clinical history, the doctors involved, and every lab value and home reading. Nothing is sent on WhatsApp.</div>
        </div>
        {draft && <span className="muted">{saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}</span>}
      </div>

      <ol className="stepper" aria-label="Onboarding steps">
        {["Patient & care circle", "Add records", "Reading", "Review", "Doctor confirms"].map((s, i) => (
          <li key={s} className={i + 1 === stepNo ? "on" : i + 1 < stepNo ? "done" : ""}>
            <button type="button" disabled={i < 1 || (i >= 3 && !draft)} onClick={() => setView(i <= 2 ? "records" : "review")}>
              <span className="n">{i + 1 < stepNo ? "✓" : i + 1}</span>{s}
            </button>
          </li>
        ))}
      </ol>

      {status === "RETURNED" && <div className="alert warn" style={{ marginBottom: 12 }}><div><b>Sent back by {d.onboarding?.returnedBy ?? "the doctor"}{d.onboarding?.returnedAt ? ` · ${fmtDateTime(d.onboarding.returnedAt)}` : ""}.</b> {d.onboarding?.returnNote ?? "Please check and send again."}</div></div>}
      {status === "SENT" && !isDoctor && <div className="alert info" style={{ marginBottom: 12 }}><div><b>With {d.patient.doctorName ?? "the doctor"} for confirmation</b> since {d.onboarding?.sentAt ? fmtDateTime(d.onboarding.sentAt) : "—"}. You&rsquo;ll see it here if it comes back with questions.</div></div>}
      {status === "CONFIRMED" && <div className="alert good" style={{ marginBottom: 12 }}><div><b>Confirmed by {d.onboarding?.confirmedBy ?? "the doctor"}</b>{d.onboarding?.confirmedAt ? ` · ${fmtDateTime(d.onboarding.confirmedAt)}` : ""}. This history is locked: to correct it or add records, open an update. Every change is marked for {first(d.patient.doctorName) || "the doctor"} to confirm, and this version is kept. <Link href={`/patients/${pid}`}>Open the chart</Link></div>
        <button className="btn sm primary" disabled={!!busy} onClick={() => act("update", { action: "update" }).then((r) => { if (r) { setTab("summary"); setView(null); } })}>{busy === "update" ? <span className="spin" /> : null} Correct or add records</button></div>}
      {d.isUpdate && status !== "CONFIRMED" && <div className="alert info" style={{ marginBottom: 12 }}><div>Updating the confirmed history. Correct entries here, or <b>Add more records</b>: anything that differs from the confirmed version is marked <b>New</b> or <b>Changed</b> for {first(d.patient.doctorName) || "the doctor"} to confirm. Where a new record disagrees with a confirmed entry, it&rsquo;s raised as a point rather than changed. The confirmed version stays on the chart until then.</div></div>}
      {err && <div className="alert bad" style={{ marginBottom: 12 }}><div>{err}</div></div>}

      {shown === "records" ? (
        <Records d={d} uploads={uploads} busy={busy} act={act} onPick={() => fileRef.current?.click()} onDrop={addFiles} onReview={() => setView("review")} />
      ) : draft ? (
        <>
          {d.onboarding?.buildError && <div className="alert warn" style={{ marginBottom: 12 }}><div>{d.onboarding.buildError} <button className="btn sm" disabled={!!busy || locked} onClick={() => window.confirm("Put the history together again from the records already read? Changes made to this draft are replaced.") && act("rebuild", { action: "rebuild" }).then(() => setView(null))}>{busy === "rebuild" ? <span className="spin" /> : null} Try again</button></div></div>}
          <div className="row between" style={{ marginBottom: 8 }}>
            <nav className="v2-tabs" aria-label="Review sections" style={{ padding: 0, flex: 1 }}>
              <button className={tab === "summary" ? "on" : ""} onClick={() => setTab("summary")}>Clinical summary {open && open.points > 0 && <span className="v2-count red">{open.points} to check</span>}</button>
              <button className={tab === "doctors" ? "on" : ""} onClick={() => setTab("doctors")}>Doctors {open && open.merges > 0 && <span className="v2-count red">{open.merges} to check</span>}</button>
              <button className={tab === "labs" ? "on" : ""} onClick={() => setTab("labs")}>Labs &amp; home readings {open && open.labs > 0 && <span className="v2-count red">{open.labs} to check</span>}</button>
            </nav>
            {status !== "SENT" && status !== "CONFIRMED" && <button className="v2-btn" title="Your changes and answers so far are kept; the new records are added to them" onClick={() => setView("records")}>Add more records</button>}
          </div>
          {tab === "summary" && <SummaryTab draft={draft} edit={edit} locked={locked || status === "CONFIRMED"} confirmed={status === "CONFIRMED"} removed={d.removed} isDoctor={isDoctor} reviewed={reviewedLine(pr, d.isUpdate)} marks={d.marks} isUpdate={d.isUpdate} />}
          {tab === "doctors" && <DoctorsTab draft={draft} edit={edit} locked={locked || status === "CONFIRMED"} />}
          {tab === "labs" && <LabsTab draft={draft} edit={edit} locked={locked || status === "CONFIRMED"} />}

          {(status === "REVIEW" || status === "RETURNED") && !isDoctor && (
            <div className="card row between" style={{ marginTop: 16, position: "sticky", bottom: 12 }}>
              <span><b>{toCheck} item{toCheck === 1 ? "" : "s"} to check</b> <span className="muted">· anything you leave open is passed to {first(d.patient.doctorName) || "the doctor"}</span></span>
              <button className="btn primary" disabled={!!busy || dirty} onClick={() => act("send", { action: "send" })}>{busy === "send" ? <span className="spin" /> : null} Done: send to {first(d.patient.doctorName) || "the doctor"}</button>
            </div>
          )}
          {isDoctor && status !== "CONFIRMED" && status !== "COLLECTING" && (
            <ConfirmPanel update={d.isUpdate} draft={draft} edit={edit} busy={busy} dirty={dirty} note={note} setNote={setNote} sent={status === "SENT"}
              onConfirm={() => act("confirm", { action: "confirm" })} onReturn={() => act("return", { action: "return", note })} />
          )}
        </>
      ) : (
        <div className="empty">The draft appears here once every record is read.</div>
      )}
      <input ref={fileRef} type="file" multiple accept={DOCUMENT_ACCEPT} hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
    </main>
  );
}

// ---------------------------------------------------------------- step 2–3: records and reading
function Records({ d, uploads, busy, act, onPick, onDrop, onReview }: { d: Resp; uploads: { name: string; state: string; error?: string }[]; busy: string | null; act: (k: string, b: Record<string, unknown>) => Promise<unknown>; onPick: () => void; onDrop: (f: FileList | null) => void; onReview: () => void }) {
  const pr = d.progress;
  const recs = pr?.records ?? [];
  const sending = uploads.filter((u) => u.state === "waiting" || u.state === "sending").length;
  const failedUploads = uploads.filter((u) => u.state === "failed");
  const pile = (p: "clinical" | "lab") => recs.filter((r) => r.state !== "failed" && (r.pile ?? (p === "clinical" && r.state === "read" ? "clinical" : null)) === p);
  const unsorted = recs.filter((r) => r.state !== "failed" && !r.pile && r.state !== "read");
  const locked = d.onboarding?.status === "SENT" || d.onboarding?.status === "CONFIRMED";
  const bar = (label: string, n: number, of: number, note: string) => (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row between"><b>{label}</b><span className="muted num">{note}</span></div>
      <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={of || 1} aria-valuenow={n}><span style={{ width: `${of ? Math.round((n / of) * 100) : 0}%` }} /></div>
    </div>
  );
  return (
    <div className="stack gap16">
      {!locked && (
        <section className="card" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onDrop(e.dataTransfer.files); }} style={{ border: "2px dashed #A7D3CC" }}>
          <div className="row between" style={{ gap: 16 }}>
            <div style={{ flex: "1 1 320px" }}>
              <h3 style={{ margin: 0 }}>Drop everything the family brought</h3>
              <div className="muted">Consultation notes, prescriptions, discharge summaries, lab reports, BP and sugar diaries: photos, PDFs, Word or Excel files, in any order. They&rsquo;re sorted into two piles as they&rsquo;re read; move any that land in the wrong one.</div>
            </div>
            <button className="btn primary" onClick={onPick}>Choose files</button>
          </div>
          {sending > 0 && <div className="muted" style={{ marginTop: 8 }}><span className="spin" /> Uploading {sending} file{sending > 1 ? "s" : ""}…</div>}
          {failedUploads.map((u, i) => <div key={i} className="alert bad" style={{ marginTop: 8 }}><div><b>{u.name}</b> wasn&rsquo;t added: {u.error}</div></div>)}
        </section>
      )}

      {pr && pr.total > 0 && (
        <section className="card stack gap16">
          <div className="row between"><h3 style={{ margin: 0 }}>Reading {pr.total} record{pr.total > 1 ? "s" : ""}</h3><span className="muted">{pr.built ? "Ready to review" : "You can leave this page; reading carries on."}</span></div>
          {bar("Read", pr.read + pr.failed, pr.total, `${pr.read} of ${pr.total} files${pr.failed ? ` · ${pr.failed} couldn't be read` : ""}`)}
          {bar("Understood", pr.clinicalRead, pr.clinicalTotal, `${pr.clinicalRead} of ${pr.clinicalTotal} clinical documents`)}
          {bar("Put together", pr.built ? 1 : 0, 1, pr.built ? "done" : pr.building ? `putting the history together…${pr.total > 40 ? " (with this many records it can take 10–20 minutes)" : ""}` : "waiting for all records to be read")}
          <div className="row" style={{ gap: 24 }}>
            <span><b className="num">{pr.found.labValues}</b> <span className="muted">lab values</span></span>
            <span><b className="num">{pr.found.visits}</b> <span className="muted">visits</span></span>
            <span><b className="num">{pr.found.homeReadings}</b> <span className="muted">home readings</span></span>
          </div>
          {pr.built && <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" onClick={onReview}>Review what was read →</button></div>}
        </section>
      )}

      {recs.some((r) => r.state === "failed" || r.unclear) && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Needs your attention</h3>
          {recs.filter((r) => r.state === "failed" || r.unclear).map((r) => (
            <div key={r.id} className="row between" style={{ padding: "8px 0", borderTop: "1px solid var(--line-2)" }}>
              <span style={{ flex: "1 1 300px" }}><b>{r.title}</b><br /><small className="muted">{r.state === "failed" ? r.error : "Read, but some values were hard to read. They're flagged in the review."}</small></span>
              <span className="row">
                <a className="btn sm" href={`/api/documents/${r.id}`} target="_blank" rel="noreferrer">View</a>
                {r.state === "failed" && !locked && <button className="btn sm" disabled={!!busy} onClick={() => act(`retry${r.id}`, { action: "retry", docId: r.id })}>Try again</button>}
                {r.state === "failed" && !locked && <button className="btn sm ghost" disabled={!!busy} onClick={() => window.confirm(`Remove “${r.title}”?`) && act(`rm${r.id}`, { action: "remove", docId: r.id })}>Remove</button>}
              </span>
            </div>
          ))}
        </section>
      )}

      {recs.length > 0 && (
        <div className="grid g2">
          {(["clinical", "lab"] as const).map((p) => (
            <section key={p} className="card">
              <div className="card-head"><h3 style={{ margin: 0 }}>{p === "clinical" ? "Clinical documents" : "Lab reports & home readings"} <span className="v2-count">{pile(p).length}</span></h3></div>
              {pile(p).length === 0 && <div className="muted">None yet.</div>}
              {pile(p).map((r) => (
                <div key={r.id} className="row" style={{ padding: "7px 0", borderTop: "1px solid var(--line-2)", flexWrap: "nowrap", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><a href={`/api/documents/${r.id}`} target="_blank" rel="noreferrer">{r.title}</a></span>
                  <small className="muted">{r.state === "read" ? `${(r.kind ?? "").replace(/_/g, " ")}${r.date ? ` · ${day(r.date)}` : ""}` : r.state === "reading" ? "reading…" : "waiting"}</small>
                  {!locked && <button className="btn sm ghost" title={`Move to ${p === "clinical" ? "lab reports" : "clinical documents"}`} onClick={() => act(`mv${r.id}`, { action: "move", docId: r.id, pile: p === "clinical" ? "lab" : "clinical" })}>Move</button>}
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
      {unsorted.length > 0 && <div className="muted">{unsorted.length} record{unsorted.length > 1 ? "s" : ""} waiting to be read and sorted.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- step 4: review
type Edit = (fn: (x: Draft) => void) => void;
const Src = ({ ids }: { ids: number[] }) => (ids.length ? <small className="row" style={{ gap: 6 }}>{ids.slice(0, 3).map((id, i) => <a key={id} href={`/api/documents/${id}`} target="_blank" rel="noreferrer">source{ids.length > 1 ? ` ${i + 1}` : ""}</a>)}{ids.length > 3 && <span className="muted">+{ids.length - 3}</span>}</small> : null);
const In = ({ value, onChange, label, w, disabled, multiline }: { value: string; onChange: (v: string) => void; label: string; w?: number | string; disabled?: boolean; multiline?: boolean }) =>
  multiline ? <LazyText multiline aria-label={label} value={value} disabled={disabled} onCommit={onChange} rows={2} style={{ width: w ?? "100%", minHeight: 0 }} />
    : <LazyText aria-label={label} value={value} disabled={disabled} onCommit={onChange} style={{ width: w ?? "100%" }} />;

const Row = ({ children }: { children: React.ReactNode }) => <div className="row" style={{ gap: 8, padding: "8px 0", borderTop: "1px solid var(--line-2)", alignItems: "flex-start" }}>{children}</div>;

function SummaryTab({ draft, edit, locked, confirmed, isDoctor, reviewed, marks, isUpdate, removed }: { draft: Draft; edit: Edit; locked: boolean; confirmed: boolean; isDoctor: boolean; reviewed: string; marks: { added: number; changed: number } | null; isUpdate: boolean; removed: { section: string; text: string }[] }) {
  const any = !!marks && marks.added + marks.changed + removed.length > 0;
  const [onlyMarked, setOnlyMarked] = useState(isUpdate);
  return (
    <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
      <div className="stack gap16" style={{ flex: "999 1 560px", minWidth: 0 }}>
        <div className="muted">{reviewed}</div>
        {any && (
          <div className="callout row between" style={{ gap: 8 }}>
            <span style={{ flex: "1 1 320px" }}><b>{isUpdate ? "Differences from the confirmed history:" : "From the records just added:"}</b> {marks!.added} new, {marks!.changed} changed{removed.length ? `, ${removed.length} taken out` : ""}. They&rsquo;re marked below; a “Changed” mark shows what it said before.</span>
            <label className="row" style={{ gap: 6, flexWrap: "nowrap", whiteSpace: "nowrap" }}><input type="checkbox" checked={onlyMarked} onChange={(e) => setOnlyMarked(e.target.checked)} style={{ width: "auto" }} /> Show only new and changed</label>
          </div>
        )}
        {removed.length > 0 && (
          <div className="alert warn"><div><b>Taken out of the confirmed history</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{removed.map((r, i) => <li key={i}><span className="muted">{r.section}:</span> {r.text}</li>)}</ul>
          </div></div>
        )}
        <HistoryEditor history={draft.summary} locked={locked} onlyMarked={any && onlyMarked} change={(fn) => edit((x) => fn(x.summary))} />
      </div>
      {!confirmed && <Points draft={draft} edit={edit} locked={locked} isDoctor={isDoctor} />}
    </div>
  );
}

function Points({ draft, edit, locked, isDoctor }: { draft: Draft; edit: Edit; locked: boolean; isDoctor: boolean }) {
  const set = (i: number, patch: Partial<Point>) => edit((x) => { x.points[i] = { ...x.points[i], ...patch }; });
  return (
    <aside className="card" style={{ flex: "1 1 300px", minWidth: 0, background: "#FFFBF5", borderColor: "#F3D9B5" }}>
      <h3 style={{ marginTop: 0, color: "var(--c-amber)" }}>Points to confirm</h3>
      <small className="muted">Where the records disagree or were unclear. Answer each, or leave it for the doctor.</small>
      {draft.points.every((p) => p.old) && <div className="muted" style={{ marginTop: 8 }}>Nothing found.</div>}
      {draft.points.map((p, i) => p.old ? null : (
        <div key={p.id} className="stack" style={{ gap: 6, padding: "10px 0", borderTop: "1px solid #F3E2CB" }}>
          <div className="row between"><b>{p.title}</b><span className={`badge ${p.status === "resolved" ? "good" : p.status === "doctor" ? "info" : "warn"}`}>{p.status === "resolved" ? "Answered" : p.status === "doctor" ? "For the doctor" : "Open"}</span></div>
          <small>{p.detail}</small>
          <Src ids={p.sources} />
          <In label={`Answer: ${p.title}`} value={p.answer ?? ""} disabled={locked} onChange={(v) => set(i, { answer: v })} />
          {!locked && (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" disabled={!p.answer?.trim()} onClick={() => set(i, { status: "resolved" })}>Answered</button>
              {!isDoctor && p.status !== "doctor" && <button className="btn sm ghost" onClick={() => set(i, { status: "doctor" })}>Leave for doctor</button>}
              {p.status !== "open" && <button className="btn sm ghost" onClick={() => set(i, { status: "open" })}>Reopen</button>}
            </div>
          )}
        </div>
      ))}
      {draft.points.some((p) => p.old) && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted">{draft.points.filter((p) => p.old).length} earlier point(s), settled when the history was first confirmed</summary>
          {draft.points.filter((p) => p.old).map((p) => <div key={p.id} style={{ padding: "6px 0", borderTop: "1px solid #F3E2CB" }}><b>{p.title}</b>{p.answer ? <>: {p.answer}</> : <span className="muted"> (no answer)</span>}</div>)}
        </details>
      )}
    </aside>
  );
}

function DoctorsTab({ draft, edit, locked }: { draft: Draft; edit: Edit; locked: boolean }) {
  const set = (i: number, patch: Partial<DoctorItem>) => edit((x) => { x.doctors[i] = { ...x.doctors[i], ...patch }; });
  const merge = (a: string, b: string) => edit((x) => {
    const ia = x.doctors.findIndex((d) => d.name === a), ib = x.doctors.findIndex((d) => d.name === b);
    if (ia >= 0 && ib >= 0) {
      const keep = x.doctors[ia].seen >= x.doctors[ib].seen ? ia : ib, drop = keep === ia ? ib : ia;
      const k = x.doctors[keep], dr = x.doctors[drop];
      x.doctors[keep] = { ...k, specialty: k.specialty || dr.specialty, hospital: k.hospital || dr.hospital, seen: k.seen + dr.seen, aliases: [...new Set([...k.aliases, dr.name, ...dr.aliases])], role: k.role === "treating" || dr.role === "treating" ? "treating" : k.role, add: k.add || dr.add };
      x.doctors.splice(drop, 1);
    }
    x.merges = x.merges.filter((m) => !(m.a === a && m.b === b));
  });
  const team = draft.doctors.map((d, i) => ({ d, i })).filter(({ d }) => d.role !== "lab");
  const lab = draft.doctors.map((d, i) => ({ d, i })).filter(({ d }) => d.role === "lab");
  return (
    <div className="stack gap16">
      {draft.merges.map((m) => (
        <div key={`${m.a}|${m.b}`} className="alert warn"><div style={{ flex: 1 }}><b>Same doctor?</b> “{m.a}” and “{m.b}”. {m.reason}</div>
          {!locked && <div className="row"><button className="btn sm primary" onClick={() => merge(m.a, m.b)}>Merge</button><button className="btn sm" onClick={() => edit((x) => { x.merges = x.merges.filter((y) => !(y.a === m.a && y.b === m.b)); })}>Keep separate</button></div>}
        </div>
      ))}
      <section className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Doctors found in the records</h3><small className="muted">Ticked doctors join the care team when the doctor confirms.</small></div>
        {team.length === 0 && <div className="muted">None found.</div>}
        {team.map(({ d, i }) => (
          <Row key={i}>
            <input type="checkbox" aria-label={`Add ${d.name} to the care team`} checked={d.role === "treating" || d.add} disabled={locked || d.role === "treating"} onChange={(e) => set(i, { add: e.target.checked })} style={{ width: 18, height: 18, marginTop: 10 }} />
            <div style={{ flex: "2 1 200px" }}><In label="Name" value={d.name} disabled={locked} onChange={(v) => set(i, { name: v })} /><small className="muted">{d.role === "treating" ? "Treating doctor (already on the team)" : `${d.seen} record${d.seen === 1 ? "" : "s"}${d.aliases.length ? ` · also written ${d.aliases.join(", ")}` : ""}`}</small></div>
            <div style={{ flex: "1 1 140px" }}><In label="Specialty" value={d.specialty} disabled={locked} onChange={(v) => set(i, { specialty: v })} /></div>
            <div style={{ flex: "2 1 200px" }}><In label="Hospital or clinic" value={d.hospital} disabled={locked} onChange={(v) => set(i, { hospital: v })} /></div>
          </Row>
        ))}
        {!locked && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => edit((x) => { x.doctors.push({ name: "", specialty: "", hospital: "", role: "consultant", seen: 0, aliases: [], add: true }); })}>+ Add a doctor</button>}
      </section>
      {lab.length > 0 && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Left out of the care team</h3>
          <small className="muted">Names that appear only as signatures on lab reports. Tick to add one anyway.</small>
          <div className="row" style={{ marginTop: 8 }}>
            {lab.map(({ d, i }) => <label key={i} className={`check ${d.add ? "on" : ""}`}><input type="checkbox" checked={d.add} disabled={locked} onChange={(e) => set(i, { add: e.target.checked })} /> {d.name}{d.specialty ? ` · ${d.specialty}` : ""}</label>)}
          </div>
        </section>
      )}
    </div>
  );
}

function LabsTab({ draft, edit, locked }: { draft: Draft; edit: Edit; locked: boolean }) {
  const [onlyCheck, setOnlyCheck] = useState(false);
  const labs = draft.labs;
  const dated = labs.filter((l) => l.date);
  const dates = [...new Set(dated.map((l) => l.date!))].sort();
  const markers = [...new Set(dated.map((l) => l.marker))].sort((a, b) => Object.keys(LAB_META).indexOf(a) - Object.keys(LAB_META).indexOf(b))
    .filter((m) => !onlyCheck || dated.some((l) => l.marker === m && l.check && !l.ok));
  const setLab = (id: string, patch: Partial<LabItem>) => edit((x) => { const l = x.labs.find((y) => y.id === id); if (l) Object.assign(l, patch); });
  const freshCount = labs.filter((l) => l.fresh).length + draft.texts.filter((x) => x.fresh).length + draft.homes.filter((x) => x.fresh).length;
  const checks = labs.filter((l) => l.check && !l.ok && l.value !== null);
  const homesBy = (t: string) => draft.homes.filter((h) => h.type === t).sort((a, b) => a.date.localeCompare(b.date));
  const homeTypes = [...new Set(draft.homes.map((h) => h.type))];
  const textDates = [...new Set(draft.texts.map((x) => x.date ?? ""))].sort().reverse();
  return (
    <div className="stack gap16">
      <section className="card">
        <div className="card-head">
          <h3 style={{ margin: 0 }}>Lab values by date <small className="muted">· {markers.length} test{markers.length === 1 ? "" : "s"}, {dated.length} values</small></h3>
          {freshCount > 0 && <span className="muted"><span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid #7DB3EA", borderRadius: 2, verticalAlign: "middle" }} /> {freshCount} from the records just added</span>}
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={onlyCheck} onChange={(e) => setOnlyCheck(e.target.checked)} /> Only values to check</label>
        </div>
        {dated.length === 0 ? <div className="muted">No dated lab values found.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table className="num" style={{ borderCollapse: "collapse", minWidth: "100%" }}>
              <thead><tr><th style={{ textAlign: "left", padding: 6, position: "sticky", left: 0, background: "#fff" }}>Test</th>{dates.map((dt) => <th key={dt} style={{ padding: 6, fontSize: 12, whiteSpace: "nowrap" }}>{day(dt)}</th>)}</tr></thead>
              <tbody>
                {markers.map((m) => (
                  <tr key={m} style={{ borderTop: "1px solid var(--line-2)" }}>
                    <td style={{ padding: 6, position: "sticky", left: 0, background: "#fff", whiteSpace: "nowrap" }}><b>{LAB_META[m]?.label ?? m}</b> <small className="muted">{LAB_META[m]?.unit}</small></td>
                    {dates.map((dt) => {
                      const l = dated.find((x) => x.marker === m && x.date === dt);
                      if (!l) return <td key={dt} />;
                      const flag = !!l.check && !l.ok;
                      return (
                        <td key={dt} style={{ padding: 3 }}>
                          <LazyText aria-label={`${LAB_META[m]?.label ?? m} ${day(dt)}`} title={l.check} value={l.value === null ? "" : String(l.value)} disabled={locked} inputMode="decimal"
                            onCommit={(v) => { const t = v.trim().replace(",", "."); if (t === "") setLab(l.id, { value: null }); else if (Number.isFinite(Number(t))) setLab(l.id, { value: Number(t) }); }}
                            style={{ width: 76, textAlign: "right", background: flag ? "#FEF0E1" : l.value === null ? "#F4F6F5" : "#fff", borderColor: flag ? "#E8A55A" : l.fresh ? "#7DB3EA" : undefined, boxShadow: l.fresh ? "inset 0 0 0 1px #7DB3EA" : undefined }} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <small className="muted">Click a value to correct it; clear it to leave it out. Tests the record hadn&rsquo;t seen before were added automatically.</small>
      </section>

      {(checks.length > 0 || labs.some((l) => !l.date)) && (
        <section className="card" style={{ background: "#FFFBF5", borderColor: "#F3D9B5" }}>
          <h3 style={{ marginTop: 0, color: "var(--c-amber)" }}>Values to check</h3>
          {[...checks, ...labs.filter((l) => !l.date && !checks.includes(l))].map((l) => (
            <Row key={l.id}>
              <span style={{ flex: "1 1 260px" }}><b>{LAB_META[l.marker]?.label ?? l.marker} {l.value ?? "(left out)"}{l.date ? `, ${day(l.date)}` : ""}</b><br /><small>{l.check}</small></span>
              {!l.date && <input type="date" aria-label="Date the sample was taken" disabled={locked} onChange={(e) => setLab(l.id, { date: e.target.value || null })} style={{ width: 160 }} />}
              <Src ids={l.sources} />
              {!locked && l.date && <button className="btn sm" onClick={() => setLab(l.id, { ok: true })}>Looks right</button>}
              {!locked && <button className="btn sm ghost" onClick={() => setLab(l.id, { value: null })}>Leave out</button>}
            </Row>
          ))}
        </section>
      )}

      <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
        <section className="card" style={{ flex: "1 1 420px", minWidth: 0 }}>
          <h3 style={{ marginTop: 0 }}>Home readings</h3>
          <small className="muted">From the family&rsquo;s diaries and logs. Filed with the readings history, so they chart with readings sent on WhatsApp.</small>
          {homeTypes.length === 0 && <div className="muted" style={{ marginTop: 8 }}>None found.</div>}
          {homeTypes.map((t) => {
            const list = homesBy(t);
            const v = (h: { v1: number; v2?: number }) => (t === "bp" ? `${h.v1}/${h.v2}` : `${h.v1}`);
            return (
              <details key={t} style={{ padding: "8px 0", borderTop: "1px solid var(--line-2)" }}>
                <summary><b>{VITAL_META[t as VitalType]?.label ?? t}</b> <span className="muted">· {list.length} reading{list.length === 1 ? "" : "s"}, {day(list[0].date)} to {day(list[list.length - 1].date)}</span></summary>
                {list.map((h) => (
                  <div key={h.id} className="row num" style={{ gap: 8, padding: "3px 0" }}>
                    <span style={{ width: 120 }}>{day(h.date)}{h.time ? ` ${h.time}` : ""}</span><span style={{ width: 80 }}>{v(h)}</span>
                    {!locked && <button className="btn sm ghost" aria-label="Remove reading" onClick={() => edit((x) => { x.homes = x.homes.filter((y) => y.id !== h.id); })}>✕</button>}
                  </div>
                ))}
              </details>
            );
          })}
        </section>
        <section className="card" style={{ flex: "1 1 420px", minWidth: 0 }}>
          <h3 style={{ marginTop: 0 }}>Other results, as printed</h3>
          {draft.texts.length === 0 && <div className="muted">None found.</div>}
          {textDates.map((dt) => (
            <details key={dt} style={{ padding: "8px 0", borderTop: "1px solid var(--line-2)" }}>
              <summary><b>{dt ? day(dt) : "No date"}</b> <span className="muted">· {draft.texts.filter((x) => (x.date ?? "") === dt).length} results</span></summary>
              {draft.texts.filter((x) => (x.date ?? "") === dt).map((x) => (
                <div key={x.id} className="row" style={{ gap: 8, padding: "3px 0" }}>
                  <span style={{ flex: "1 1 180px" }}>{x.group ? <small className="muted">{x.group} · </small> : null}{x.test}</span>
                  <div style={{ width: 160 }}><In label={`${x.test} result`} value={x.result} disabled={locked} onChange={(v) => edit((y) => { const it = y.texts.find((z) => z.id === x.id); if (it) it.result = v; })} /></div>
                  {!locked && <button className="btn sm ghost" aria-label={`Remove ${x.test}`} onClick={() => edit((y) => { y.texts = y.texts.filter((z) => z.id !== x.id); })}>✕</button>}
                </div>
              ))}
            </details>
          ))}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- step 5: the doctor confirms
function ConfirmPanel({ update, draft, edit, busy, dirty, note, setNote, sent, onConfirm, onReturn }: { update: boolean; draft: Draft; edit: Edit; busy: string | null; dirty: boolean; note: string; setNote: (s: string) => void; sent: boolean; onConfirm: () => void; onReturn: () => void }) {
  const left = draft.points.map((p, i) => ({ p, i })).filter(({ p }) => p.status !== "resolved" && !p.old);
  const docs = draft.doctors.filter((d) => d.add && d.role !== "treating").length;
  const labs = draft.labs.filter((l) => l.value !== null && l.date && (!update || l.fresh)).length;
  const texts = draft.texts.filter((x) => !update || x.fresh).length, homes = draft.homes.filter((x) => !update || x.fresh).length;
  return (
    <section className="card" style={{ marginTop: 16, borderColor: "var(--c-brand)" }}>
      <h3 style={{ marginTop: 0 }}>{update ? "Confirm the added records" : sent ? "Confirm this onboarding" : "Confirm when you're done checking"}</h3>
      {left.length > 0 && (
        <div className="stack" style={{ gap: 0, marginBottom: 12 }}>
          <b style={{ color: "var(--c-amber)" }}>Left for you ({left.length})</b>
          {left.map(({ p, i }) => (
            <Row key={p.id}>
              <span style={{ flex: "1 1 300px" }}><b>{p.title}</b><br /><small>{p.detail}</small></span>
              <div style={{ flex: "1 1 220px" }}><In label={`Your answer: ${p.title}`} value={p.answer ?? ""} onChange={(v) => edit((x) => { x.points[i].answer = v; })} /></div>
            </Row>
          ))}
        </div>
      )}
      <div className="callout" style={{ fontSize: 13 }}>
        <b>When you confirm:</b> {update ? <>the updated summary replaces the clinical history (Profile tab), still editable; new doctors join the care team and new visits are saved on their dates; {labs} new lab values, {texts} other results and {homes} home readings go into the history.</> : <>the summary becomes the patient&rsquo;s clinical history (Profile tab), still editable; {docs} doctor{docs === 1 ? "" : "s"} join{docs === 1 ? "s" : ""} the care team and visits to them are saved on their dates; {labs} lab values, {texts} other results and {homes} home readings go into the history, so trends start from the oldest record.</>} Nothing is sent on WhatsApp, and the care plan starts only when you record a visit and choose to start it.
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: "flex-end", gap: 8 }}>
        {sent && <input aria-label="Note for the assistant" placeholder="Note for the assistant, if sending back" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: "1 1 300px" }} />}
        {sent && <button className="btn" disabled={!!busy} onClick={onReturn}>{busy === "return" ? <span className="spin" /> : null} Send back</button>}
        <button className="btn primary" disabled={!!busy || dirty} onClick={() => window.confirm(update ? "Confirm the added records? The updated history, new doctors, visits, lab values and readings are filed in the patient's record." : "Confirm the onboarding? The history, doctors, visits, lab values and home readings are filed in the patient's record.") && onConfirm()}>{busy === "confirm" ? <span className="spin" /> : null} {update ? "Confirm update" : "Confirm onboarding"}</button>
      </div>
    </section>
  );
}
