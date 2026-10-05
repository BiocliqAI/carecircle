"use client";
// Home page in live-clinic mode: first-run clinic setup, then the onboarding checklist and sign-in.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, avatarColor, homeFor, initials, ROLE_LABEL, useSession } from "./client";

interface Checklist {
  clinic: boolean;
  doctors: number;
  pas: number;
  patients: number;
  caregivers: number;
  baselines: number;
  withVisit: number;
  consentsGiven: number;
  consentsPending: number;
  inbound: number;
  escalations: number;
}

export function LiveHome() {
  const { clinic } = useSession();
  return clinic ? <ClinicHome /> : <Setup />;
}

function Setup() {
  const { refresh, notifyChange } = useSession();
  const router = useRouter();
  const [c, setC] = useState({ name: "", address: "", phone: "+91 " });
  const [dr, setDr] = useState({ name: "", title: "", phone: "+91 ", email: "", regNo: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/clinic", { body: { action: "setup", clinic: c, doctor: dr } });
      await refresh();
      notifyChange();
      router.push("/doctor");
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="page" style={{ maxWidth: 860 }}>
      <section className="hero">
        <small className="eyebrow">Live clinic · first-time setup</small>
        <h1 style={{ fontSize: 28, margin: "6px 0 8px" }}>Set up your clinic on CareCircle</h1>
        <p>Takes about a minute. Next you’ll add the care team, onboard a patient and their family care circle, capture the baseline and record Visit 1. From then on, the patient’s WhatsApp drives everything.</p>
      </section>
      <form className="stack gap16" onSubmit={submit}>
        <div className="card">
          <div className="card-head"><h3>1 · Clinic</h3></div>
          <div className="grid g3">
            <label className="f">Clinic name *<input required autoFocus value={c.name} placeholder="e.g. Sunrise Heart & Kidney Clinic" onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
            <label className="f">Area / address<input value={c.address} placeholder="Jayanagar, Bengaluru" onChange={(e) => setC({ ...c, address: e.target.value })} /></label>
            <label className="f">Front-desk phone<input value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} /></label>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>2 · First doctor</h3><small>You’ll be signed in as this doctor. You can add more doctors and PAs under Team.</small></div></div>
          <div className="grid g3">
            <label className="f">Full name *<input required value={dr.name} placeholder="Dr. Anita Menon" onChange={(e) => setDr({ ...dr, name: e.target.value })} /></label>
            <label className="f">Specialty / qualification<input value={dr.title} placeholder="MD (Nephrology)" onChange={(e) => setDr({ ...dr, title: e.target.value })} /></label>
            <label className="f">Mobile *<input required value={dr.phone} onChange={(e) => setDr({ ...dr, phone: e.target.value })} /></label>
            <label className="f">Email<input type="email" value={dr.email} onChange={(e) => setDr({ ...dr, email: e.target.value })} /></label>
            <label className="f">Medical registration no.<input value={dr.regNo} placeholder="e.g. KMC 123456" onChange={(e) => setDr({ ...dr, regNo: e.target.value })} /></label>
          </div>
        </div>
        {err && <div className="alert bad">{err}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy}>{busy ? <span className="spin" /> : null} Create clinic →</button>
          <small className="muted">Data stays on this Mac (data/clinic.db). The sample demo is separate: run <code>npm run dev</code>.</small>
        </div>
      </form>
    </main>
  );
}

function ClinicHome() {
  const { user, personas, switchTo, notifyChange, patientIds } = useSession();
  const router = useRouter();
  const [stale, setStale] = useState(false);
  const { refresh } = useSession();

  // Already signed in: go to the right home (clinicians → Today, families → their dashboard).
  useEffect(() => {
    if (user) router.replace(homeFor(user, patientIds));
  }, [user, patientIds, router]);

  async function go(id: string) {
    try {
      const r = await switchTo(id);
      const u = personas.find((p) => p.id === id) ?? null;
      notifyChange();
      router.push(homeFor(u, r?.patientIds ?? []));
    } catch {
      // The persona list is stale (e.g. the database was reset or replaced since this page loaded).
      await refresh().catch(() => undefined);
      notifyChange();
      setStale(true);
    }
  }
  if (user) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  const group = (roles: string[]) => personas.filter((p) => roles.includes(p.role));

  return (
    <main className="page signin">
      <div className="signin-head">
        <span className="brand-mark big">💚</span>
        <h1>Who’s using CareCircle?</h1>
        <p className="muted">Clinic staff use the dashboard. Patients and caregivers mostly use WhatsApp, and can also view their own record here.</p>
      </div>
      {stale && <div className="alert warn" style={{ marginBottom: 16 }}><div>That person no longer exists. The clinic data changed since this page loaded. Pick again.</div></div>}
      <div className="stack gap16">
        {(
          [
            ["Clinic staff", ["DOCTOR", "PA"], "No staff yet."],
            ["Patients", ["PATIENT"], "No patients yet."],
            ["Caregivers", ["CAREGIVER"], "No caregivers yet."],
          ] as [string, string[], string][]
        ).map(([title, roles, empty]) => (
          <section key={title} className="card">
            <div className="card-head"><h3>{title}</h3></div>
            {group(roles).length === 0 ? (
              <div className="muted">{empty}</div>
            ) : (
              <div className="grid g3">
                {group(roles).map((p) => (
                  <button key={p.id} className="persona" onClick={() => go(p.id)}>
                    <span className="avatar" style={{ background: avatarColor(p.name) }}>{initials(p.name)}</span>
                    <span>
                      <b>{p.name}</b>
                      <br />
                      <small>{p.role === "CAREGIVER" || p.role === "PATIENT" ? p.title : ROLE_LABEL[p.role]}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
