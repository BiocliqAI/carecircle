"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, avatarColor, initials, ROLE_LABEL, useSession } from "@/components/client";

interface Staff { id: string; name: string; role: string; title: string | null; phone: string | null; email: string | null; reg_no: string | null; patients: number }

const blankStaff = { name: "", role: "DOCTOR" as "DOCTOR" | "PA", title: "", phone: "+91 ", email: "", regNo: "" };

export default function Team() {
  const { user, loading, bump, notifyChange } = useSession();
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [form, setForm] = useState(blankStaff);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ staff: Staff[] }>("/api/clinic").then((x) => setStaff(x.staff));
  useEffect(() => {
    if (!loading) load().catch((e) => setMsg({ kind: "bad", text: e.message }));
  }, [loading, bump]);

  const clinician = user && (user.role === "DOCTOR" || user.role === "PA");
  if (!loading && !clinician) return <main className="page"><div className="alert bad">Sign in as a doctor or PA to manage the team. <Link href="/">Sign in</Link></div></main>;
  if (!staff) return <main className="page"><div className="empty"><span className="spin" /></div></main>;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/clinic", { body: { action: "addStaff", staff: form } });
      setMsg({ kind: "good", text: `${form.role === "DOCTOR" ? "Doctor" : "PA"} added.` });
      setForm(blankStaff);
      setAdding(false);
      notifyChange();
      await load();
    } catch (x) {
      setMsg({ kind: "bad", text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <div className="muted">{plural(staff.filter((s) => s.role === "DOCTOR").length, "doctor")} · {plural(staff.filter((s) => s.role === "PA").length, "physician assistant")}. Doctors see only their own patients; PAs see everyone.</div>
        </div>
        {!adding && <button className="btn primary" onClick={() => { setAdding(true); setMsg(null); }}>+ Add doctor or PA</button>}
      </div>
      {msg && <div className={`alert ${msg.kind}`} style={{ marginBottom: 14 }}>{msg.text}</div>}

      {adding && (
        <form className="card" onSubmit={add} style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>Add to the care team</h3><small>Staff never receive automated WhatsApp alerts.</small></div>
          <div className="grid g3">
            <label className="f">Role
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "DOCTOR" | "PA" })}>
                <option value="DOCTOR">Doctor</option><option value="PA">Physician Assistant</option>
              </select>
            </label>
            <label className="f">Full name *<input required autoFocus value={form.name} placeholder={form.role === "DOCTOR" ? "Dr. Anita Menon" : "Rahul Verma"} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="f">{form.role === "DOCTOR" ? "Specialty / qualification" : "Designation"}<input value={form.title} placeholder={form.role === "DOCTOR" ? "MD (Cardiology)" : "Physician Assistant"} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="f">Mobile *<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label className="f">Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            {form.role === "DOCTOR" && <label className="f">Medical registration no.<input value={form.regNo} placeholder="e.g. KMC 123456" onChange={(e) => setForm({ ...form, regNo: e.target.value })} /></label>}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy}>{busy ? <span className="spin" /> : null} Add to team</button>
            <button type="button" className="btn" onClick={() => { setAdding(false); setForm(blankStaff); }}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="t team-table">
            <thead><tr><th>Name</th><th>Role</th><th>Contact</th><th>Reg. no.</th><th>Patients</th></tr></thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
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
    </main>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
