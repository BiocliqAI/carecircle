"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, avatarColor, initials, ROLE_LABEL, useSession } from "@/components/client";
import { fmtDate } from "@/lib/time";

interface Staff { id: string; name: string; role: string; title: string | null; phone: string | null; email: string | null; reg_no: string | null; created_at: number | null; patients: number }
interface ClinicData {
  mode: "demo" | "live";
  clinic: { name: string; address: string; phone: string; setupAt: number } | null;
  staff: Staff[];
}

const blankStaff = { name: "", role: "DOCTOR" as "DOCTOR" | "PA", title: "", phone: "+91 ", email: "", regNo: "" };

export default function ClinicPage() {
  const { user, loading, bump, notifyChange, switchTo } = useSession();
  const [d, setD] = useState<ClinicData | null>(null);
  const [form, setForm] = useState(blankStaff);
  const [details, setDetails] = useState<{ name: string; address: string; phone: string } | null>(null);
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api<ClinicData>("/api/clinic").then((x) => { setD(x); if (x.clinic) setDetails({ name: x.clinic.name, address: x.clinic.address, phone: x.clinic.phone }); });
  useEffect(() => {
    if (!loading) load().catch((e) => setMsg({ kind: "bad", text: e.message }));
  }, [loading, bump]);

  const clinician = user && (user.role === "DOCTOR" || user.role === "PA");
  if (!loading && !clinician) return <main className="page"><div className="alert bad">Sign in as a doctor or PA to manage the clinic. <Link href="/">Choose a persona</Link></div></main>;
  if (!d) return <main className="page"><div className="empty"><span className="spin" /></div></main>;

  async function act(key: string, body: unknown, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await api("/api/clinic", { body });
      setMsg({ kind: "good", text: ok });
      notifyChange();
      await load();
      return true;
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addStaff(e: React.FormEvent) {
    e.preventDefault();
    if (await act("staff", { action: "addStaff", staff: form }, `${form.role === "DOCTOR" ? "Doctor" : "PA"} added. They can now sign in from the persona menu.`)) setForm(blankStaff);
  }

  async function reset() {
    if (await act("reset", { action: "reset", confirm }, "Clinic erased.")) {
      await switchTo(null);
      window.location.href = "/";
    }
  }

  return (
    <main className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div>
          <h1>{d.clinic?.name ?? "Clinic"}</h1>
          <div className="muted">{d.clinic ? `Set up ${fmtDate(d.clinic.setupAt)} · ` : ""}{d.staff.length} staff · {d.mode === "live" ? "Live clinic" : "Sample demo data"}</div>
        </div>
        <Link className="btn" href="/doctor">Command Centre →</Link>
      </div>
      {msg && <div className={`alert ${msg.kind}`} style={{ marginBottom: 14 }}>{msg.text}</div>}

      <div className="grid side">
        <div className="stack gap16">
          <div className="card">
            <div className="card-head"><h3>Care team</h3><small>Doctors see only their own patients. PAs see every patient in the clinic.</small></div>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Name</th><th>Role</th><th>Contact</th><th>Reg. no.</th><th>Patients</th></tr></thead>
                <tbody>
                  {d.staff.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                          <span className="avatar" style={{ background: avatarColor(s.name) }}>{initials(s.name)}</span>
                          <span><b>{s.name}</b>{s.id === user?.id ? <span className="badge brand" style={{ marginLeft: 6 }}>you</span> : null}<br /><small className="muted">{s.title}</small></span>
                        </div>
                      </td>
                      <td>{ROLE_LABEL[s.role]}</td>
                      <td><small>{s.phone}{s.email ? <><br />{s.email}</> : null}</small></td>
                      <td><small>{s.reg_no ?? "—"}</small></td>
                      <td>{s.role === "DOCTOR" ? s.patients : <span className="muted">all</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <form className="card" onSubmit={addStaff}>
            <div className="card-head"><h3>Add a doctor or PA</h3></div>
            <div className="grid g3">
              <label className="f">Role
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "DOCTOR" | "PA" })}>
                  <option value="DOCTOR">Doctor</option><option value="PA">Physician Assistant</option>
                </select>
              </label>
              <label className="f">Full name *<input required value={form.name} placeholder={form.role === "DOCTOR" ? "Dr. Anita Menon" : "Rahul Verma"} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label className="f">{form.role === "DOCTOR" ? "Specialty / qualification" : "Designation"}<input value={form.title} placeholder={form.role === "DOCTOR" ? "MD (Cardiology)" : "Physician Assistant"} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
              <label className="f">Mobile *<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
              <label className="f">Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
              {form.role === "DOCTOR" && <label className="f">Medical registration no.<input value={form.regNo} placeholder="e.g. KMC 123456" onChange={(e) => setForm({ ...form, regNo: e.target.value })} /></label>}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn primary" disabled={busy === "staff"}>{busy === "staff" ? <span className="spin" /> : "+"} Add to care team</button>
              <small className="muted">Staff never receive automated WhatsApp alerts.</small>
            </div>
          </form>
        </div>

        <div className="stack gap16">
          {details && (
            <div className="card">
              <div className="card-head"><h3>Clinic details</h3></div>
              <div className="stack">
                <label className="f">Clinic name<input value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} /></label>
                <label className="f">Address<textarea value={details.address} onChange={(e) => setDetails({ ...details, address: e.target.value })} style={{ minHeight: 50 }} /></label>
                <label className="f">Front-desk phone<input value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} /></label>
                <div><button className="btn" disabled={busy === "update"} onClick={() => act("update", { action: "update", clinic: details }, "Clinic details saved.")}>Save details</button></div>
              </div>
            </div>
          )}
          {d.mode === "live" && d.clinic && (
            <div className="card danger-zone">
              <div className="card-head"><h3>Reset clinic</h3></div>
              <p className="muted" style={{ marginTop: 0 }}>Erases the clinic, staff, patients, messages and audit trail so the next customer demo starts from an empty setup screen. This can’t be undone.</p>
              <label className="f">Type <b>{d.clinic.name}</b> to confirm<input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
              <button className="btn danger" style={{ marginTop: 10 }} disabled={confirm.trim() !== d.clinic.name || busy === "reset"} onClick={reset}>
                {busy === "reset" ? <span className="spin" /> : null} Erase everything
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
