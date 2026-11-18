"use client";
// Clinic admin: download a backup of the clinic, or upload one to restore it at the next restart.
import { useEffect, useRef, useState } from "react";
import { api } from "./client";
import { fmtDateTime } from "@/lib/time";

interface Summary { clinic: string | null; takenAt: number | null; patients: number; staff: number; caregivers: number; messages: number; lastActivity: number | null; sizeBytes: number }
interface Pending { stagedAt: number; stagedBy: string; fileName: string; summary: Summary }
interface Last { restoredAt: number; fileName: string; backupTakenAt: number | null; previous: string }

const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;

function describe(s: Summary) {
  return `${s.clinic ?? "Clinic not set up"}${s.takenAt ? ` · backed up ${fmtDateTime(s.takenAt)}` : ""} · ${n(s.patients, "patient")}, ${n(s.staff, "staff member")}, ${n(s.caregivers, "caregiver")}, ${n(s.messages, "message")} · ${size(s.sizeBytes)}`;
}

export function BackupRestore() {
  const [state, setState] = useState<{ pending: Pending | null; last: Last | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = () => api<{ pending: Pending | null; last: Last | null }>("/api/clinic/backup").then(setState).catch((e) => setMsg({ kind: "bad", text: (e as Error).message }));
  useEffect(() => { void load(); }, []);

  async function download() {
    setBusy("download");
    setMsg(null);
    try {
      const r = await fetch("/api/clinic/backup?download=1", { cache: "no-store" });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `Backup failed (${r.status})`);
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "carecircle-backup.db";
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMsg({ kind: "good", text: `Downloaded ${name}. Keep it somewhere safe, with a second copy.` });
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function upload() {
    if (!file) return;
    setBusy("upload");
    setMsg(null);
    try {
      const r = await fetch("/api/clinic/backup", { method: "POST", body: file, headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) } });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error || `Upload failed (${r.status})`);
      setFile(null);
      if (input.current) input.current.value = "";
      await load();
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    try {
      await api("/api/clinic/backup", { method: "DELETE" });
      setMsg({ kind: "good", text: "Restore cancelled. Nothing was changed." });
      await load();
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const pending = state?.pending;
  return (
    <section className="card">
      <div className="card-head"><h3>Backup and restore</h3><small>Everything: clinic, staff, patients, messages, documents and settings</small></div>
      <div className="stack" style={{ gap: 14 }}>
        {state?.last && (
          <div className="alert info"><div>Restored on {fmtDateTime(state.last.restoredAt)} from <b>{state.last.fileName}</b>{state.last.backupTakenAt ? ` (backed up ${fmtDateTime(state.last.backupTakenAt)})` : ""}. {state.last.previous ? <>The database before the restore is kept on the server as <code>{state.last.previous}</code>.</> : null}</div></div>
        )}

        <div className="stack">
          <b>Download a backup</b>
          <p className="muted" style={{ margin: 0 }}>A complete copy of the clinic, taken without stopping the app.</p>
          <div><button className="btn primary" disabled={!!busy} onClick={download}>{busy === "download" ? <span className="spin" /> : "⬇"} Download backup</button></div>
        </div>

        <div className="stack">
          <b>Restore from a backup</b>
          {pending ? (
            <div className="alert warn">
              <div className="stack">
                <div><b>Restore ready: {pending.fileName}</b></div>
                <div>{describe(pending.summary)}</div>
                <div>To finish, <b>restart the service in Railway</b> (open the service, then Restart). The backup replaces everything in the clinic as the app starts; the current data is kept on the server so the restore can be undone. Until then, the clinic keeps running as it is.</div>
                <div><button className="btn sm" disabled={!!busy} onClick={cancel}>{busy === "cancel" ? <span className="spin" /> : null} Cancel restore</button></div>
              </div>
            </div>
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>Replaces everything in the clinic with the backup. You'll see what's in the file before anything happens, and the change only takes effect when the service restarts.</p>
              <div className="row">
                <input ref={input} type="file" accept=".db,application/vnd.sqlite3,application/octet-stream" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={!!busy} />
                <button className="btn" disabled={!file || !!busy} onClick={upload}>{busy === "upload" ? <span className="spin" /> : null} Check and prepare restore</button>
              </div>
            </>
          )}
        </div>
        {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
      </div>
    </section>
  );
}
