"use client";
// Erase all records (live clinic) or restore the sample story (demo mode).
import { useState } from "react";
import { api, useSession } from "./client";

export function EraseClinic({ compact = false }: { compact?: boolean }) {
  const { mode, clinic, switchTo, notifyChange } = useSession();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (mode === "demo") {
    return (
      <button className="btn danger" disabled={busy} onClick={async () => {
        if (!window.confirm("Reset all demo data to the starting story? (Takes a few seconds)")) return;
        setBusy(true);
        try {
          await api("/api/demo", { body: { action: "reset" } });
          notifyChange();
        } finally {
          setBusy(false);
        }
      }}>{busy ? <span className="spin" /> : "↺"} Reset demo data</button>
    );
  }
  if (!clinic) return <small className="muted">Nothing to erase: the clinic isn’t set up.</small>;

  async function erase() {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/clinic", { body: { action: "reset", confirm } });
      await switchTo(null);
      window.location.href = "/";
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {!compact && <p className="muted" style={{ margin: 0 }}>Erases the clinic, staff, patients, caregivers, messages and alerts, and returns to the setup screen. Gemini settings are kept. This can’t be undone.</p>}
      {!open ? (
        <div><button className="btn danger" onClick={() => setOpen(true)}>Erase all records…</button></div>
      ) : (
        <>
          <label className="f">Type <b>{clinic.name}</b> to confirm<input autoFocus value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          {err && <div className="alert bad">{err}</div>}
          <div className="row">
            <button className="btn danger" disabled={confirm.trim() !== clinic.name || busy} onClick={erase}>{busy ? <span className="spin" /> : null} Erase everything</button>
            <button className="btn" onClick={() => { setOpen(false); setConfirm(""); setErr(null); }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
