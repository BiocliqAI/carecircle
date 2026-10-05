"use client";
// Baseline intake (registration) form and the read-only baseline card shown on Patient 360.
import Link from "next/link";
import { useState } from "react";
import { LAB_META, ageFromDob, bmi, type Baseline, type BaselineLab, type BaselineMed } from "@/lib/types";
import { fmtDate } from "@/lib/time";

const COMMON_CONDITIONS = ["Hypertension", "Type 2 diabetes", "Chronic kidney disease", "Heart failure", "Coronary artery disease", "COPD", "Asthma", "Hypothyroidism", "Osteoarthritis", "Dyslipidaemia"];
const FREQS: [string, string][] = [["OD", "Once daily"], ["BD", "Twice daily"], ["TDS", "Three times"], ["QID", "Four times"], ["HS", "At bedtime"], ["weekly", "Weekly"], ["PRN", "Only if needed"]];
const LAB_PANELS: [string, string[]][] = [
  ["Kidney panel", ["creatinine", "urea", "egfr", "potassium", "sodium"]],
  ["Diabetes", ["hba1c"]],
  ["Lipids", ["ldl"]],
  ["Blood count", ["hb", "wbc"]],
];
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function BaselineForm({ value, onChange }: { value: Baseline; onChange: (b: Baseline) => void }) {
  const b = value;
  const set = (patch: Partial<Baseline>) => onChange({ ...b, ...patch });
  const [bp, setBp] = useState(b.vitals.sys ? `${b.vitals.sys}/${b.vitals.dia ?? ""}` : "");
  const [condText, setCondText] = useState("");
  const setVital = (k: keyof Baseline["vitals"], v: string) => set({ vitals: { ...b.vitals, [k]: v === "" ? undefined : Number(v) } });
  const setMed = (i: number, patch: Partial<BaselineMed>) => set({ currentMeds: b.currentMeds.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const setLab = (i: number, patch: Partial<BaselineLab>) => set({ labs: b.labs.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const addCondition = (c: string) => {
    const v = c.trim();
    if (v && !b.conditions.some((x) => x.toLowerCase() === v.toLowerCase())) set({ conditions: [...b.conditions, v] });
  };
  const addPanel = (markers: string[]) => {
    const d = b.labs[b.labs.length - 1]?.date || today();
    set({ labs: [...b.labs, ...markers.filter((m) => !b.labs.some((l) => l.marker === m)).map((m) => ({ marker: m, value: NaN, date: d }))] });
  };
  const bmiV = bmi(b.heightCm, b.vitals.weight);

  return (
    <div className="stack gap16">
      <div className="card">
        <div className="card-head"><div><h3>Profile</h3><small>Used to personalise WhatsApp messages and to read results in context.</small></div></div>
        <div className="grid g4">
          <label className="f">Date of birth<input type="date" max={today()} value={b.dob ?? ""} onChange={(e) => set({ dob: e.target.value || undefined })} /></label>
          <label className="f">Preferred language
            <select value={b.language ?? ""} onChange={(e) => set({ language: e.target.value || undefined })}>
              <option value="">—</option>
              {["English", "Hindi", "Tamil", "Telugu", "Kannada", "Malayalam", "Marathi", "Bengali", "Gujarati", "Urdu"].map((l) => <option key={l}>{l}</option>)}
            </select>
          </label>
          <label className="f">Blood group
            <select value={b.bloodGroup ?? ""} onChange={(e) => set({ bloodGroup: e.target.value || undefined })}>
              <option value="">—</option>
              {["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((g) => <option key={g}>{g}</option>)}
            </select>
          </label>
          <label className="f">Height (cm)<input type="number" min={40} max={250} value={b.heightCm ?? ""} onChange={(e) => set({ heightCm: e.target.value ? Number(e.target.value) : undefined })} /></label>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div><h3>Intake vitals</h3><small>Measured at registration. These pre-fill the clinic vitals for Visit 1.</small></div>
          {bmiV && <span className={`badge ${bmiV >= 30 || bmiV < 18.5 ? "warn" : "good"}`}>BMI {bmiV}</span>}
        </div>
        <div className="grid g5">
          <label className="f">BP (mmHg)
            <input value={bp} placeholder="138/86" onChange={(e) => setBp(e.target.value)} onBlur={() => {
              const m = bp.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
              set({ vitals: { ...b.vitals, sys: m ? Number(m[1]) : undefined, dia: m ? Number(m[2]) : undefined } });
            }} />
          </label>
          <label className="f">Weight (kg)<input type="number" step="0.1" value={b.vitals.weight ?? ""} onChange={(e) => setVital("weight", e.target.value)} /></label>
          <label className="f">Pulse (bpm)<input type="number" value={b.vitals.hr ?? ""} onChange={(e) => setVital("hr", e.target.value)} /></label>
          <label className="f">Sugar (mg/dL)<input type="number" value={b.vitals.glucose ?? ""} onChange={(e) => setVital("glucose", e.target.value)} /></label>
          <label className="f">SpO₂ %<input type="number" min={50} max={100} value={b.vitals.spo2 ?? ""} onChange={(e) => setVital("spo2", e.target.value)} /></label>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Medical history</h3></div>
        <label className="f">Known conditions</label>
        <div className="row" style={{ margin: "6px 0 8px" }}>
          {b.conditions.map((c) => (
            <span key={c} className="badge brand">{c} <button type="button" className="x-btn" aria-label={`Remove ${c}`} onClick={() => set({ conditions: b.conditions.filter((x) => x !== c) })}>×</button></span>
          ))}
          <input style={{ width: 220 }} value={condText} placeholder="Type and press Enter…" onChange={(e) => setCondText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCondition(condText); setCondText(""); } }}
            onBlur={() => { if (condText.trim()) { addCondition(condText); setCondText(""); } }} />
        </div>
        <div className="row" style={{ gap: 4, marginBottom: 12 }}>
          {COMMON_CONDITIONS.filter((c) => !b.conditions.includes(c)).map((c) => (
            <button key={c} type="button" className="chip-btn" onClick={() => addCondition(c)}>+ {c}</button>
          ))}
        </div>
        <div className="grid g3">
          <label className="f">Allergies<textarea value={b.allergies} placeholder="Drug / food allergies, or “None known”" onChange={(e) => set({ allergies: e.target.value })} style={{ minHeight: 60 }} /></label>
          <label className="f">Surgeries & hospitalisations<textarea value={b.history} placeholder="e.g. CABG 2019; admitted for HF 2024" onChange={(e) => set({ history: e.target.value })} style={{ minHeight: 60 }} /></label>
          <label className="f">Family history<textarea value={b.familyHistory} placeholder="e.g. Father: diabetes, MI at 60" onChange={(e) => set({ familyHistory: e.target.value })} style={{ minHeight: 60 }} /></label>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Lifestyle</h3></div>
        <div className="grid g4">
          <label className="f">Smoking
            <select value={b.smoking} onChange={(e) => set({ smoking: e.target.value as Baseline["smoking"] })}>
              <option value="">—</option><option value="never">Never</option><option value="former">Former</option><option value="current">Current</option>
            </select>
          </label>
          <label className="f">Alcohol
            <select value={b.alcohol} onChange={(e) => set({ alcohol: e.target.value as Baseline["alcohol"] })}>
              <option value="">—</option><option value="never">Never</option><option value="occasional">Occasional</option><option value="regular">Regular</option>
            </select>
          </label>
          <label className="f">Physical activity
            <select value={b.activity} onChange={(e) => set({ activity: e.target.value as Baseline["activity"] })}>
              <option value="">—</option><option value="sedentary">Sedentary</option><option value="light">Light (walks)</option><option value="active">Active</option>
            </select>
          </label>
          <label className="f">Diet<input value={b.diet} placeholder="Vegetarian, low salt…" onChange={(e) => set({ diet: e.target.value })} /></label>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div><h3>💊 Current medicines</h3><small>What the patient takes today, from any doctor. The doctor confirms these into the care plan at Visit 1.</small></div>
          <button type="button" className="btn sm" onClick={() => set({ currentMeds: [...b.currentMeds, { name: "", dose: "", frequency: "OD" }] })}>+ Add medicine</button>
        </div>
        {b.currentMeds.length === 0 ? (
          <div className="muted">No medicines added.</div>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Medicine</th><th>Dose</th><th>Frequency</th><th>For</th><th>Prescribed by</th><th /></tr></thead>
              <tbody>
                {b.currentMeds.map((m, i) => (
                  <tr key={i}>
                    <td><input value={m.name} placeholder="e.g. Metformin" onChange={(e) => setMed(i, { name: e.target.value })} /></td>
                    <td style={{ width: 110 }}><input value={m.dose} placeholder="500 mg" onChange={(e) => setMed(i, { dose: e.target.value })} /></td>
                    <td style={{ width: 150 }}>
                      <select value={m.frequency} onChange={(e) => setMed(i, { frequency: e.target.value })}>
                        {FREQS.map(([k, l]) => <option key={k} value={k}>{k} · {l}</option>)}
                      </select>
                    </td>
                    <td><input value={m.purpose ?? ""} placeholder="sugar, BP…" onChange={(e) => setMed(i, { purpose: e.target.value })} /></td>
                    <td><input value={m.prescriber ?? ""} placeholder="Dr…" onChange={(e) => setMed(i, { prescriber: e.target.value })} /></td>
                    <td style={{ width: 40 }}><button type="button" className="btn sm ghost" aria-label="Remove medicine" onClick={() => set({ currentMeds: b.currentMeds.filter((_, j) => j !== i) })}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div><h3>🧪 Recent lab reports</h3><small>Becomes the starting point of the lab trend lines. Baseline labs never raise alerts.</small></div>
          <div className="row" style={{ gap: 4 }}>
            {LAB_PANELS.map(([l, ms]) => <button key={l} type="button" className="chip-btn" onClick={() => addPanel(ms)}>+ {l}</button>)}
            <button type="button" className="btn sm" onClick={() => set({ labs: [...b.labs, { marker: "creatinine", value: NaN, date: b.labs[b.labs.length - 1]?.date || today() }] })}>+ Add test</button>
          </div>
        </div>
        {b.labs.length === 0 ? (
          <div className="muted">No lab results added.</div>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Test</th><th>Value</th><th>Unit</th><th>Report date</th><th /></tr></thead>
              <tbody>
                {b.labs.map((l, i) => (
                  <tr key={i}>
                    <td style={{ width: 220 }}>
                      <select value={l.marker} onChange={(e) => setLab(i, { marker: e.target.value })}>
                        {Object.entries(LAB_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                      </select>
                    </td>
                    <td style={{ width: 120 }}><input type="number" step="any" value={Number.isFinite(l.value) ? l.value : ""} onChange={(e) => setLab(i, { value: e.target.value === "" ? NaN : Number(e.target.value) })} /></td>
                    <td className="muted">{LAB_META[l.marker]?.unit}</td>
                    <td style={{ width: 170 }}><input type="date" max={today()} value={l.date} onChange={(e) => setLab(i, { date: e.target.value })} /></td>
                    <td style={{ width: 40 }}><button type="button" className="btn sm ghost" aria-label="Remove test" onClick={() => set({ labs: b.labs.filter((_, j) => j !== i) })}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <label className="f">Intake notes<textarea value={b.notes} placeholder="Anything the doctor should know before Visit 1" onChange={(e) => set({ notes: e.target.value })} /></label>
      </div>
    </div>
  );
}

/** Strips empty rows (NaN lab values, blank medicines) before sending to the server. */
export function baselineForSubmit(b: Baseline): Baseline {
  return { ...b, currentMeds: b.currentMeds.filter((m) => m.name.trim()), labs: b.labs.filter((l) => Number.isFinite(l.value)) };
}

// ---------------------------------------------------------------- read-only card
export interface ConsentView {
  user_id: string;
  role: string;
  status: "PENDING" | "GIVEN" | "DECLINED";
  requested_at: number;
  responded_at: number | null;
}
type StoredBaseline = Baseline & { capturedAt: number; capturedBy: string | null; updatedAt: number };

const CONSENT_BADGE: Record<string, [string, string]> = { GIVEN: ["good", "✓ Consented"], PENDING: ["warn", "Awaiting YES"], DECLINED: ["bad", "Declined"] };

export function ConsentList({ consents, people }: { consents: ConsentView[]; people: { user_id: string | null; label: string }[] }) {
  if (!consents.length) return null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {people.map((p) => {
        const c = consents.find((x) => x.user_id === p.user_id);
        if (!c) return null;
        const [cls, txt] = CONSENT_BADGE[c.status];
        return (
          <div key={p.user_id} className="row between">
            <span>{p.label}</span>
            <span className={`badge ${cls}`} title={c.responded_at ? `Replied ${fmtDate(c.responded_at)}` : `Asked ${fmtDate(c.requested_at)}`}>{txt}</span>
          </div>
        );
      })}
    </div>
  );
}

export function BaselineCard({ b, pid, canEdit, now }: { b: StoredBaseline | null; pid: string; canEdit: boolean; now: number }) {
  if (!b) {
    return (
      <div className="card">
        <div className="card-head"><h3>Baseline</h3>{canEdit && <Link className="btn sm" href={`/patients/${pid}/baseline`}>+ Capture baseline</Link>}</div>
        <div className="muted">No baseline intake recorded.</div>
      </div>
    );
  }
  const age = ageFromDob(b.dob, now);
  const bmiV = bmi(b.heightCm, b.vitals.weight);
  const v = b.vitals;
  const vitals = [v.sys ? `BP ${v.sys}/${v.dia}` : null, v.weight ? `Wt ${v.weight} kg` : null, v.hr ? `Pulse ${v.hr}` : null, v.glucose ? `Sugar ${v.glucose}` : null, v.spo2 ? `SpO₂ ${v.spo2}%` : null].filter(Boolean);
  const life = [b.smoking && `Smoking: ${b.smoking}`, b.alcohol && `Alcohol: ${b.alcohol}`, b.activity && `Activity: ${b.activity}`, b.diet && `Diet: ${b.diet}`].filter(Boolean);
  return (
    <div className="card">
      <div className="card-head">
        <div><h3>Baseline</h3><small>Captured {fmtDate(b.capturedAt)}{b.capturedBy ? ` by ${b.capturedBy}` : ""}{b.updatedAt !== b.capturedAt ? ` · updated ${fmtDate(b.updatedAt)}` : ""}</small></div>
        {canEdit && <Link className="btn sm" href={`/patients/${pid}/baseline`}>Edit</Link>}
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 6 }}>
          {age != null && <span className="badge">{age} yrs</span>}
          {b.bloodGroup && <span className="badge">{b.bloodGroup}</span>}
          {b.heightCm && <span className="badge">{b.heightCm} cm</span>}
          {bmiV && <span className="badge">BMI {bmiV}</span>}
          {b.language && <span className="badge">{b.language}</span>}
        </div>
        {b.allergies && !/^(none|nil|nkda|no)/i.test(b.allergies) ? <div className="alert bad" style={{ padding: "8px 12px" }}>⚠️ <b>Allergies:</b> {b.allergies}</div> : b.allergies ? <small>Allergies: {b.allergies}</small> : null}
        {vitals.length > 0 && <div><small className="muted">Intake vitals</small><div>{vitals.join(" · ")}</div></div>}
        {b.conditions.length > 0 && <div className="row" style={{ gap: 4 }}>{b.conditions.map((c) => <span key={c} className="badge brand">{c}</span>)}</div>}
        {b.currentMeds.length > 0 && (
          <div>
            <small className="muted">Medicines at onboarding</small>
            {b.currentMeds.map((m, i) => <div key={i}><b>{m.name}</b> {m.dose} · {m.frequency}{m.purpose ? <span className="muted"> · {m.purpose}</span> : null}</div>)}
          </div>
        )}
        {b.labs.length > 0 && (
          <div>
            <small className="muted">Baseline labs</small>
            <div>{b.labs.map((l) => `${LAB_META[l.marker]?.label ?? l.marker} ${l.value}`).join(" · ")}</div>
          </div>
        )}
        {b.history && <div><small className="muted">History</small><div>{b.history}</div></div>}
        {b.familyHistory && <div><small className="muted">Family history</small><div>{b.familyHistory}</div></div>}
        {life.length > 0 && <small>{life.join(" · ")}</small>}
        {b.notes && <div className="callout">{b.notes}</div>}
      </div>
    </div>
  );
}
