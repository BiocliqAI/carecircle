"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, useSession } from "@/components/client";
import { BaselineForm, baselineForSubmit } from "@/components/baseline";
import { EMPTY_BASELINE, LAB_META, MAX_CAREGIVERS, ageFromDob, bmi, type Baseline } from "@/lib/types";
import { fmtDateTime } from "@/lib/time";

interface Cg { name: string; relation: string; phone: string; dashboard: boolean }
interface Doctor { id: string; name: string; role: string; title: string | null }

const STEPS = ["Patient", "Care circle", "Baseline", "Review"];
const PHONE_RE = /^\+?[\d\s-]{8,}$/;
const blankCg = (): Cg => ({ name: "", relation: "", phone: "+91 ", dashboard: true });

export default function NewPatient() {
  const router = useRouter();
  const { user, notifyChange } = useSession();
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ name: "", age: "", sex: "F", phone: "+91 ", address: "", doctorId: "" });
  const [cgs, setCgs] = useState<Cg[]>([blankCg()]);
  const [baseline, setBaseline] = useState<Baseline>({ ...EMPTY_BASELINE, vitals: {} });
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(false);

  // Resume a saved draft: /patients/new?draft=<id>
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("draft");
    if (!id) return;
    setLoadingDraft(true);
    api<{ draft: { id: string; step: number; updated_at: number; data: { f?: typeof f; cgs?: Cg[]; baseline?: Baseline } } }>(`/api/drafts?id=${encodeURIComponent(id)}`)
      .then(({ draft }) => {
        if (draft.data.f) setF((x) => ({ ...x, ...draft.data.f }));
        if (draft.data.cgs?.length) setCgs(draft.data.cgs.slice(0, MAX_CAREGIVERS));
        if (draft.data.baseline) setBaseline({ ...EMPTY_BASELINE, ...draft.data.baseline, labs: (draft.data.baseline.labs ?? []).map((l) => ({ ...l, value: l.value ?? NaN })) });
        setDraftId(draft.id);
        setSavedAt(draft.updated_at);
        setStep(draft.step);
      })
      .catch((e) => { setErr((e as Error).message); window.history.replaceState(null, "", "/patients/new"); })
      .finally(() => setLoadingDraft(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api<{ staff: Doctor[] }>("/api/clinic").then((r) => {
      const ds = r.staff.filter((s) => s.role === "DOCTOR");
      setDoctors(ds);
      setF((x) => ({ ...x, doctorId: x.doctorId || ds[0]?.id || "" }));
    }).catch(() => undefined);
  }, []);

  if (loadingDraft) return <main className="page"><div className="empty"><span className="spin" /> Loading draft…</div></main>;
  if (user && user.role !== "DOCTOR" && user.role !== "PA") return <main className="page"><div className="alert bad">Only the doctor or PA can onboard patients.</div></main>;

  const setCg = (i: number, patch: Partial<Cg>) => setCgs((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const digits = (s: string) => s.replace(/\D/g, "");

  function validate(s: number): string | null {
    if (s === 0) {
      if (!f.name.trim()) return "Enter the patient's full name";
      if (!PHONE_RE.test(f.phone) || digits(f.phone).length < 10) return "Enter the patient's WhatsApp number with country code";
      if (user?.role === "PA" && !f.doctorId) return "Choose the treating doctor";
    }
    if (s === 1) {
      const filled = cgs.filter((c) => c.name.trim() || digits(c.phone).length > 2);
      if (!filled.length || !cgs[0].name.trim()) return "Add at least the primary caregiver";
      for (const [i, c] of cgs.entries()) {
        if (!c.name.trim() && digits(c.phone).length <= 2) continue;
        const who = i === 0 ? "the primary caregiver" : "the backup caregiver";
        if (!c.name.trim()) return `Enter a name for ${who}`;
        if (!PHONE_RE.test(c.phone) || digits(c.phone).length < 10) return `Enter a WhatsApp number for ${who}`;
        if (digits(c.phone) === digits(f.phone)) return `${who[0].toUpperCase()}${who.slice(1)} can't use the patient's own number`;
      }
      const nums = cgs.filter((c) => c.name.trim()).map((c) => digits(c.phone));
      if (new Set(nums).size !== nums.length) return "Each caregiver needs a different WhatsApp number";
    }
    if (s === 2 && baseline.labs.some((l) => !Number.isFinite(l.value))) return "Enter a value for every lab test, or remove the empty rows";
    return null;
  }
  /** Saves the wizard as a draft (server-side) so anyone in the clinic can resume it. */
  async function saveDraft(atStep: number): Promise<boolean> {
    try {
      const r = await api<{ id: string; savedAt: number }>("/api/drafts", { body: { action: "save", id: draftId, step: atStep, data: { f, cgs, baseline } } });
      setDraftId(r.id);
      setSavedAt(r.savedAt);
      window.history.replaceState(null, "", `/patients/new?draft=${r.id}`);
      return true;
    } catch (x) {
      setErr(`Couldn't save the draft: ${(x as Error).message}`);
      return false;
    }
  }
  async function next() {
    const e = validate(step);
    setErr(e);
    if (e) return;
    setBusy("next");
    const ok = await saveDraft(step + 1);
    setBusy(null);
    if (ok) { setStep(step + 1); window.scrollTo({ top: 0 }); }
  }
  async function saveAndExit() {
    if (!f.name.trim()) return setErr("Enter at least the patient's name to save a draft");
    setBusy("exit");
    const ok = await saveDraft(step);
    setBusy(null);
    if (ok) { notifyChange(); router.push("/patients"); }
  }
  async function discard() {
    if (!draftId || !window.confirm("Discard this onboarding draft? Nothing has been sent to the patient yet.")) return;
    await api("/api/drafts", { body: { action: "discard", id: draftId } }).catch(() => undefined);
    notifyChange();
    router.push("/patients");
  }

  async function submit(then: "visit" | "patient") {
    for (const s of [0, 1, 2]) {
      const e = validate(s);
      if (e) { setErr(e); setStep(s); return; }
    }
    setBusy(then);
    setErr(null);
    try {
      const r = await api<{ id: string }>("/api/patients", {
        body: {
          ...f,
          age: f.age ? Number(f.age) : null,
          conditions: baseline.conditions.join(", "),
          caregivers: cgs.filter((c) => c.name.trim()),
          baseline: hasBaseline(baseline) ? baselineForSubmit(baseline) : undefined,
          draftId,
        },
      });
      notifyChange();
      router.push(then === "visit" ? `/patients/${r.id}/visit` : `/patients/${r.id}`);
    } catch (x) {
      setErr((x as Error).message);
      setBusy(null);
    }
  }

  const age = f.age ? Number(f.age) : ageFromDob(baseline.dob, Date.now());
  const doctorName = user?.role === "DOCTOR" ? user.name : doctors.find((d) => d.id === f.doctorId)?.name;

  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <small><Link href="/patients">← Patients</Link></small>
          <h1>Onboard a patient</h1>
          <div className="muted">About 5 minutes. The patient and each caregiver get a WhatsApp consent message. Nobody installs an app.</div>
        </div>
        {draftId && (
          <div className="draft-pill">
            <span>💾 Draft saved{savedAt ? ` · ${fmtDateTime(savedAt)}` : ""}</span>
            <button type="button" className="btn sm ghost" onClick={discard}>Discard</button>
          </div>
        )}
      </div>

      <ol className="stepper" aria-label="Onboarding steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? "on" : i < step ? "done" : ""}>
            <button type="button" disabled={i > step} onClick={() => { setErr(null); setStep(i); }}>
              <span className="n">{i < step ? "✓" : i + 1}</span>{s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="card">
          <div className="card-head"><h3>Patient</h3></div>
          <div className="grid g2">
            <Field label="Full name *"><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Kamala Iyer" /></Field>
            <Field label="WhatsApp number *"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="Sex">
              <select value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value })}>
                <option value="F">Female</option><option value="M">Male</option><option value="O">Other</option>
              </select>
            </Field>
            <Field label="Age (or enter date of birth in Baseline)"><input type="number" min={0} max={120} value={f.age} onChange={(e) => setF({ ...f, age: e.target.value })} /></Field>
            <Field label="Address / area"><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
            {user?.role === "PA" ? (
              <Field label="Treating doctor *">
                <select value={f.doctorId} onChange={(e) => setF({ ...f, doctorId: e.target.value })}>
                  {doctors.length === 0 && <option value="">No doctors yet. Add one in Clinic.</option>}
                  {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}{d.title ? ` · ${d.title}` : ""}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="Treating doctor"><input value={user?.name ?? ""} disabled /></Field>
            )}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <div className="card-head">
            <div>
              <h3>Care circle</h3>
              <small>If something is missed or a reading goes outside the doctor’s limits, the primary caregiver is alerted on WhatsApp first. If they don’t respond, the backup. The clinic is never auto-alerted.</small>
            </div>
          </div>
          {cgs.map((c, i) => (
            <div key={i} className="cg-row">
              <span className="lvl" title={i === 0 ? "Primary" : "Backup"}>{i === 0 ? "1st" : "2nd"}</span>
              <div className="grid g3" style={{ flex: 1, alignItems: "end" }}>
                <Field label={`Name${i === 0 ? " *" : ""}`}><input value={c.name} onChange={(e) => setCg(i, { name: e.target.value })} /></Field>
                <Field label="Relation"><input value={c.relation} onChange={(e) => setCg(i, { relation: e.target.value })} placeholder="Daughter, Son, Neighbour…" /></Field>
                <Field label={`WhatsApp number${i === 0 ? " *" : ""}`}><input value={c.phone} onChange={(e) => setCg(i, { phone: e.target.value })} /></Field>
              </div>
              <label className={`check ${c.dashboard ? "on" : ""}`} title="Lets this caregiver open the patient's read-only dashboard">
                <input type="checkbox" checked={c.dashboard} onChange={(e) => setCg(i, { dashboard: e.target.checked })} /> Dashboard access
              </label>
            </div>
          ))}
          <div className="row">
            {cgs.length < MAX_CAREGIVERS && <button type="button" className="btn sm" onClick={() => setCgs([...cgs, blankCg()])}>+ Add backup caregiver</button>}
            {cgs.length > 1 && <button type="button" className="btn sm" onClick={() => setCgs(cgs.slice(0, -1))}>Remove last</button>}
          </div>
        </div>
      )}

      {step === 2 && <BaselineForm value={baseline} onChange={setBaseline} />}

      {step === 3 && (
        <div className="grid g2">
          <div className="card">
            <div className="card-head"><h3>Patient</h3><button className="btn sm ghost" onClick={() => setStep(0)}>Edit</button></div>
            <div><b>{f.name}</b></div>
            <div className="muted">{[age != null ? `${age} yrs` : null, f.sex === "M" ? "Male" : f.sex === "F" ? "Female" : "Other", f.phone].filter(Boolean).join(" · ")}</div>
            {f.address && <div className="muted">{f.address}</div>}
            <div style={{ marginTop: 6 }}>Treating doctor: <b>{doctorName ?? "—"}</b></div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Care circle</h3><button className="btn sm ghost" onClick={() => setStep(1)}>Edit</button></div>
            {cgs.filter((c) => c.name.trim()).map((c, i) => (
              <div key={i} className="row between" style={{ padding: "4px 0" }}>
                <span><span className="badge brand">{i === 0 ? "Primary" : "Backup"}</span> {c.name} <span className="muted">({c.relation || "Family"}) · {c.phone}</span></span>
                <small>{c.dashboard ? "Dashboard ✓" : "WhatsApp only"}</small>
              </div>
            ))}
          </div>
          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="card-head"><h3>Baseline</h3><button className="btn sm ghost" onClick={() => setStep(2)}>Edit</button></div>
            <div className="grid g3">
              <Summary label="Conditions" value={baseline.conditions.join(", ")} />
              <Summary label="Allergies" value={baseline.allergies} />
              <Summary label="Intake vitals" value={[baseline.vitals.sys ? `BP ${baseline.vitals.sys}/${baseline.vitals.dia}` : "", baseline.vitals.weight ? `Wt ${baseline.vitals.weight} kg` : "", bmi(baseline.heightCm, baseline.vitals.weight) ? `BMI ${bmi(baseline.heightCm, baseline.vitals.weight)}` : ""].filter(Boolean).join(" · ")} />
              <Summary label={`Current medicines (${baselineForSubmit(baseline).currentMeds.length})`} value={baselineForSubmit(baseline).currentMeds.map((m) => `${m.name} ${m.dose} ${m.frequency}`).join(", ")} />
              <Summary label={`Lab results (${baselineForSubmit(baseline).labs.length})`} value={baselineForSubmit(baseline).labs.map((l) => `${LAB_META[l.marker]?.label} ${l.value}`).join(", ")} />
              <Summary label="Lifestyle" value={[baseline.smoking && `Smoking ${baseline.smoking}`, baseline.alcohol && `Alcohol ${baseline.alcohol}`, baseline.activity].filter(Boolean).join(" · ")} />
            </div>
          </div>
          <div className="callout" style={{ gridColumn: "1 / -1" }}>
            On create, {f.name.split(" ")[0] || "the patient"} and {cgs.filter((c) => c.name.trim()).length} caregiver(s) get a WhatsApp welcome asking them to reply <b>YES</b>. Reminders start only after Visit 1 sets the care plan.
          </div>
        </div>
      )}

      {err && <div className="alert bad" style={{ marginTop: 14 }}>{err}</div>}
      <div className="row between" style={{ marginTop: 16 }}>
        <button type="button" className="btn" disabled={step === 0} onClick={() => { setErr(null); setStep(step - 1); }}>← Back</button>
        {step < 3 ? (
          <div className="row">
            {step === 2 && <button type="button" className="btn ghost" onClick={() => { setBaseline(baselineForSubmit(baseline)); setErr(null); setStep(3); }} title="Capture it later from the patient page">Skip for now</button>}
            <button type="button" className="btn" disabled={!!busy} onClick={saveAndExit} title="Save a draft and resume later from Patients or Today">{busy === "exit" ? <span className="spin" /> : null} Save & finish later</button>
            <button type="button" className="btn primary" disabled={!!busy} onClick={next}>{busy === "next" ? <span className="spin" /> : null} Continue →</button>
          </div>
        ) : (
          <div className="row">
            <button type="button" className="btn" disabled={!!busy} onClick={() => submit("patient")}>{busy === "patient" ? <span className="spin" /> : null} Create, record visit later</button>
            <button type="button" className="btn primary" disabled={!!busy} onClick={() => submit("visit")}>{busy === "visit" ? <span className="spin" /> : null} Create & record Visit 1 →</button>
          </div>
        )}
      </div>
    </main>
  );
}

function hasBaseline(b: Baseline): boolean {
  const c = baselineForSubmit(b);
  return !!(c.dob || c.language || c.bloodGroup || c.heightCm || Object.values(c.vitals).some((v) => v != null) || c.conditions.length || c.allergies || c.history || c.familyHistory || c.smoking || c.alcohol || c.activity || c.diet || c.currentMeds.length || c.labs.length || c.notes);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <small style={{ fontWeight: 600 }}>{label}</small>
      {children}
    </label>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <small className="muted">{label}</small>
      <div>{value || <span className="muted">—</span>}</div>
    </div>
  );
}
