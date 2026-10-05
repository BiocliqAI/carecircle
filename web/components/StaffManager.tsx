"use client";
// Add / edit / remove clinic staff. Admin manages doctors and assistants; doctors manage assistants.
import { useEffect, useState } from "react";
import { api, avatarColor, initials, useSession } from "./client";

interface Staff { id: string; name: string; role: string; title: string | null; phone: string | null; email: string | null; reg_no: string | null; patients: number }
type StaffRole = "DOCTOR" | "PA";
const LABEL: Record<StaffRole, [string, string]> = { DOCTOR: ["Doctor", "Doctors"], PA: ["Assistant", "Assistants"] };
const blank = (role: StaffRole) => ({ name: "", role, title: "", phone: "+91 ", email: "", regNo: "" });

export function StaffManager({ roles }: { roles: StaffRole[] }) {
  const { user, bump, notifyChange } = useSession();
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ staff: Staff[] }>("/api/clinic").then((x) => setStaff(x.staff));
  useEffect(() => { load().catch(() => setStaff([])); }, [bump]);

  async function act(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/clinic", { body });
      setMsg({ kind: "good", text: ok });
      setForm(null);
      setEditId(null);
      notifyChange();
      await load();
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const label = LABEL[form.role][0];
    if (editId) act({ action: "updateStaff", id: editId, staff: form }, `${label} updated.`);
    else act({ action: "addStaff", staff: form }, `${label} added. They can now sign in from the persona picker.`);
  }
  if (!staff) return <div className="empty"><span className="spin" /></div>;

  return (
    <div className="stack gap16">
      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
      {roles.map((role) => {
        const list = staff.filter((s) => s.role === role);
        const [one, many] = LABEL[role];
        const formHere = form && form.role === role;
        return (
          <section key={role} className="card" style={{ padding: 0 }}>
            <div className="card-head" style={{ padding: "16px 18px 0" }}>
              <div><h3>{many}</h3><small>{role === "DOCTOR" ? "Each doctor sees only their own patients." : "Assistants onboard patients and see every patient in the clinic."}</small></div>
              {!formHere && <button className="btn sm primary" onClick={() => { setForm(blank(role)); setEditId(null); setMsg(null); }}>+ Add {one.toLowerCase()}</button>}
            </div>
            {formHere && (
              <form className="staff-form" onSubmit={submit}>
                <b>{editId ? `Edit ${one.toLowerCase()}` : `New ${one.toLowerCase()}`}</b>
                <div className="grid g3">
                  <label className="f">Full name *<input required autoFocus value={form.name} placeholder={role === "DOCTOR" ? "Dr. Anita Menon" : "Rahul Verma"} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                  <label className="f">{role === "DOCTOR" ? "Specialty / qualification" : "Designation"}<input value={form.title} placeholder={role === "DOCTOR" ? "MD (Cardiology)" : "Physician Assistant"} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
                  <label className="f">Mobile *<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
                  <label className="f">Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
                  {role === "DOCTOR" && <label className="f">Medical registration no.<input value={form.regNo} placeholder="e.g. KMC 123456" onChange={(e) => setForm({ ...form, regNo: e.target.value })} /></label>}
                </div>
                <div className="row">
                  <button className="btn primary" disabled={busy}>{busy ? <span className="spin" /> : null} {editId ? "Save changes" : `Add ${one.toLowerCase()}`}</button>
                  <button type="button" className="btn" onClick={() => { setForm(null); setEditId(null); }}>Cancel</button>
                </div>
              </form>
            )}
            {list.length === 0 ? (
              <div className="muted" style={{ padding: "4px 18px 18px" }}>No {many.toLowerCase()} yet.</div>
            ) : (
              <div className="table-wrap">
                <table className="t team-table">
                  <thead><tr><th>Name</th><th>Contact</th>{role === "DOCTOR" && <th>Reg. no.</th>}{role === "DOCTOR" && <th>Patients</th>}<th /></tr></thead>
                  <tbody>
                    {list.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                            <span className="avatar" style={{ background: avatarColor(s.name) }}>{initials(s.name)}</span>
                            <span><b>{s.name}</b>{s.id === user?.id ? <span className="badge brand" style={{ marginLeft: 6 }}>you</span> : null}<br /><small className="muted">{s.title}</small></span>
                          </div>
                        </td>
                        <td><small>{s.phone}{s.email ? <><br />{s.email}</> : null}</small></td>
                        {role === "DOCTOR" && <td><small>{s.reg_no ?? "—"}</small></td>}
                        {role === "DOCTOR" && <td>{s.patients}</td>}
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button className="btn sm ghost" onClick={() => { setForm({ name: s.name, role, title: s.title ?? "", phone: s.phone ?? "", email: s.email ?? "", regNo: s.reg_no ?? "" }); setEditId(s.id); setMsg(null); }}>Edit</button>
                          {s.id !== user?.id && <button className="btn sm ghost" onClick={() => window.confirm(`Remove ${s.name} from the clinic?`) && act({ action: "removeStaff", id: s.id }, `${s.name} removed.`)}>Remove</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
