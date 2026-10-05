"use client";
// Home page in live-clinic mode: first-run clinic setup, then the onboarding checklist and sign-in.
import Link from "next/link";
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
      router.push("/clinic");
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
          <div className="card-head"><div><h3>2 · First doctor</h3><small>You’ll be signed in as this doctor. Add more doctors and PAs on the next screen.</small></div></div>
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
  const { clinic, personas, switchTo, notifyChange, bump, user } = useSession();
  const router = useRouter();
  const [cl, setCl] = useState<Checklist | null>(null);

  useEffect(() => {
    api<{ checklist: Checklist }>("/api/clinic").then((r) => setCl(r.checklist)).catch(() => undefined);
  }, [bump]);

  async function go(id: string, to?: string) {
    const r = await switchTo(id);
    const u = personas.find((p) => p.id === id) ?? null;
    notifyChange();
    router.push(to ?? homeFor(u, r?.patientIds ?? []));
  }
  const staff = personas.filter((p) => p.role === "DOCTOR" || p.role === "PA");
  const clinicianId = user && (user.role === "DOCTOR" || user.role === "PA") ? user.id : staff[0]?.id;
  const asClinician = (to: string) => (clinicianId ? go(clinicianId, to) : router.push(to));
  const group = (roles: string[]) => personas.filter((p) => roles.includes(p.role));

  const steps: { done: boolean; title: string; detail: string; action?: [string, () => void] }[] = cl
    ? [
        { done: cl.clinic, title: "Clinic created", detail: clinic!.name },
        { done: cl.doctors + cl.pas > 1, title: "Add the care team", detail: `${cl.doctors} doctor${cl.doctors === 1 ? "" : "s"} · ${cl.pas} PA${cl.pas === 1 ? "" : "s"}`, action: ["Manage staff", () => asClinician("/clinic")] },
        { done: cl.patients > 0, title: "Onboard a patient and care circle", detail: cl.patients ? `${cl.patients} patient${cl.patients === 1 ? "" : "s"} · ${cl.caregivers} caregiver${cl.caregivers === 1 ? "" : "s"}` : "Patient details, L1–L3 caregivers, baseline", action: ["+ New patient", () => asClinician("/patients/new")] },
        { done: cl.patients > 0 && cl.baselines >= cl.patients, title: "Capture the baseline", detail: `${cl.baselines} of ${cl.patients} patients: history, current medicines, labs, intake vitals` },
        { done: cl.consentsGiven > 0 && cl.consentsPending === 0, title: "Consent on WhatsApp", detail: cl.consentsGiven + cl.consentsPending ? `${cl.consentsGiven} replied YES · ${cl.consentsPending} waiting` : "Each person replies YES to the welcome message", action: ["Open WhatsApp", () => router.push("/whatsapp")] },
        { done: cl.withVisit > 0, title: "Record Visit 1 and the care plan", detail: `${cl.withVisit} of ${cl.patients} patients have an active plan`, action: cl.patients ? ["Command Centre", () => asClinician("/doctor")] : undefined },
        { done: cl.inbound > cl.consentsGiven, title: "First WhatsApp log", detail: "e.g. “BP 142/90, took tablets”, sent from the patient’s phone", action: ["Open WhatsApp", () => router.push("/whatsapp")] },
        { done: cl.escalations > 0, title: "First care-circle escalation", detail: cl.escalations ? `${cl.escalations} so far` : "Send an out-of-range reading, then use +1h to watch L1 → L2" },
      ]
    : [];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <main className="page">
      <section className="hero">
        <small className="eyebrow">Live clinic</small>
        <h1 style={{ fontSize: 30, margin: "6px 0 8px" }}>{clinic!.name}</h1>
        <p>{clinic!.address ? `${clinic!.address} · ` : ""}Everything here was onboarded for real: no sample data. Patients and families use the WhatsApp simulator, and the care team uses this dashboard.</p>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={() => asClinician("/patients/new")}>+ Onboard a patient</button>
          <button className="btn" onClick={() => asClinician("/doctor")}>Command Centre</button>
          <button className="btn" onClick={() => router.push("/whatsapp")}>WhatsApp simulator</button>
        </div>
      </section>

      <div className="grid side">
        <div className="stack gap16">
          {(
            [
              ["Care team (web dashboard)", ["DOCTOR", "PA"], "No staff yet."],
              ["Patients (WhatsApp + read-only dashboard)", ["PATIENT"], "No patients yet. Onboard one to see them here."],
              ["Caregivers / care circle (WhatsApp + dashboard)", ["CAREGIVER"], "Caregivers appear once a patient is onboarded."],
            ] as [string, string[], string][]
          ).map(([title, roles, empty]) => (
            <div key={title} className="card">
              <div className="card-head"><h3>{title}</h3>{roles[0] === "DOCTOR" && <button className="btn sm" onClick={() => asClinician("/clinic")}>+ Add staff</button>}</div>
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
            </div>
          ))}
        </div>

        <div className="stack gap16">
          <div className="card">
            <div className="card-head">
              <h3>Go-live checklist</h3>
              {cl && <span className="badge brand">{doneCount}/{steps.length}</span>}
            </div>
            {cl && <div className="progress" style={{ marginBottom: 10 }}><span style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>}
            <ol className="checklist">
              {steps.map((s) => (
                <li key={s.title} className={s.done ? "done" : ""}>
                  <span className="tick">{s.done ? "✓" : ""}</span>
                  <div style={{ flex: 1 }}>
                    <b>{s.title}</b>
                    <div className="muted">{s.detail}</div>
                  </div>
                  {s.action && !s.done && <button className="btn sm" onClick={s.action[1]}>{s.action[0]}</button>}
                </li>
              ))}
            </ol>
          </div>
          <div className="card">
            <div className="card-head"><h3>Running a customer demo</h3></div>
            <ol className="steps">
              <li>Ask the customer for <b>their</b> clinic and doctor names, and set them up.</li>
              <li>As the PA, onboard a patient. Use a family member in the room as Level 1.</li>
              <li>Open WhatsApp: reply <b>YES</b> as the patient and as each caregiver.</li>
              <li>As the doctor, record Visit 1. The plan arrives on the patient’s WhatsApp.</li>
              <li>Send a high BP reading. Level 1 is alerted, then <b>+1h</b> moves it to Level 2.</li>
              <li>Use <b>Simulate 7 days</b>, then open the pre-visit brief and record Visit 2.</li>
            </ol>
            <small className="muted">Between customers: <Link href="/clinic">Clinic</Link> → Reset clinic.</small>
          </div>
        </div>
      </div>
    </main>
  );
}
