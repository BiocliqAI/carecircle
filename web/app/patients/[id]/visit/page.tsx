"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { api, useSession } from "@/components/client";
import { Highlights } from "@/components/interval";
import type { IntervalSummary, MedChangeRow } from "@/lib/summary";
import { DEFAULT_THRESHOLDS, DEFAULT_TIMERS, FREQ_TIMES, KIDNEY_TEMPLATE, SYMPTOMS, VITAL_META, type Baseline, type CarePlan, type ClinicVitals, type Medication, type Visit, type VitalType } from "@/lib/types";
import { DAY, TZ_OFFSET_MS, dayStart, fmtDate } from "@/lib/time";

const EMPTY_PLAN: CarePlan = {
  medications: [{ key: "", name: "", dose: "", times: ["08:00"] }],
  monitoring: [{ key: "bp", times: ["08:00"] }],
  physio: [],
  lifestyle: [],
  checkinTime: "21:00",
  watchSymptoms: ["breathlessness", "chest_pain", "dizziness"],
  thresholds: { ...DEFAULT_THRESHOLDS },
  escalation: { ...DEFAULT_TIMERS },
};

const toTimes = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).map((x) => (/^\d{1,2}$/.test(x) ? `${x.padStart(2, "0")}:00` : x.length === 4 ? `0${x}` : x));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Merge the kidney template into a plan (keeps anything the doctor already set). */
function applyKidney(p: CarePlan) {
  for (const m of KIDNEY_TEMPLATE.monitoring) if (!p.monitoring.some((x) => x.key === m.key)) p.monitoring.push({ ...m });
  p.fluid = p.fluid ?? { ...KIDNEY_TEMPLATE.fluid };
  p.labs = p.labs ?? { ...KIDNEY_TEMPLATE.labs };
  for (const [k, v] of Object.entries(KIDNEY_TEMPLATE.thresholds)) {
    const t = p.thresholds as unknown as Record<string, number | undefined>;
    if (t[k] == null || k === "sysLow") t[k] = v as number;
  }
  p.watchSymptoms = [...new Set([...p.watchSymptoms, ...KIDNEY_TEMPLATE.watchSymptoms])];
  for (const l of KIDNEY_TEMPLATE.lifestyle) if (!p.lifestyle.some((x) => x.key === l.key)) p.lifestyle.push({ ...l });
  p.template = "kidney";
}

/** Visit 1 starts from the medicines the patient was already taking at onboarding. */
function medsFromBaseline(b: Baseline): Medication[] {
  return b.currentMeds.map((m) => {
    const f = m.frequency.toUpperCase() === "WEEKLY" ? "weekly" : m.frequency.toUpperCase();
    const med: Medication = { key: "", name: m.name, dose: m.dose, times: FREQ_TIMES[f] ?? ["08:00"], prescriber: m.prescriber, purpose: m.purpose };
    if (f === "PRN") med.prn = true;
    if (f === "weekly") med.everyNDays = 7;
    if (!FREQ_TIMES[f] && m.frequency) med.instructions = m.frequency;
    return med;
  });
}

interface VisitData {
  now: number;
  baseline: Baseline | null;
  patient: { name: string; conditions: string };
  current: Visit | null;
  visits: Visit[];
  summary: IntervalSummary | null;
  careTeam: { id: number; name: string; role: string }[];
  medChanges: MedChangeRow[];
}

export default function RecordVisit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { loading, notifyChange } = useSession();
  const [d, setD] = useState<VisitData | null>(null);
  const [plan, setPlan] = useState<CarePlan>(EMPTY_PLAN);
  const [vitals, setVitals] = useState<Record<string, string>>({});
  const [diagnosis, setDiagnosis] = useState("");
  const [notes, setNotes] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<VisitData>(`/api/patients/${id}`);
  useEffect(() => {
    if (loading) return;
    load().then((x) => {
      setD(x);
      if (x.current) {
        setPlan(JSON.parse(JSON.stringify(x.current.plan)));
        setDiagnosis(x.current.diagnosis);
      } else {
        setDiagnosis(x.patient.conditions || "");
        const b = x.baseline;
        if (b) {
          if (b.currentMeds.length) setPlan((p) => ({ ...p, medications: medsFromBaseline(b) }));
          const v = b.vitals;
          setVitals({
            ...(v.sys ? { bp: `${v.sys}/${v.dia ?? ""}` } : {}),
            ...Object.fromEntries((["weight", "hr", "glucose", "spo2"] as const).filter((k) => v[k] != null).map((k) => [k, String(v[k])])),
          });
          const monitor = new Set<VitalType>(["bp"]);
          if (b.conditions.some((c) => /diabet/i.test(c))) monitor.add("glucose");
          if (b.conditions.some((c) => /heart failure|kidney|ckd/i.test(c))) monitor.add("weight");
          setPlan((p) => ({ ...p, monitoring: [...monitor].map((k) => ({ key: k, times: k === "weight" ? ["07:00"] : ["08:00"] })) }));
          if (b.allergies || b.notes) setNotes([b.allergies && `Allergies: ${b.allergies}`, b.notes && `Intake: ${b.notes}`].filter(Boolean).join("\n"));
        }
      }
      const nd = new Date(dayStart(x.now) + 28 * DAY + TZ_OFFSET_MS + 12 * 3600_000).toISOString().slice(0, 10);
      setNextDate(nd);
    }).catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loading]);

  if (!d) return <main className="page">{err ? <div className="alert bad">{err}</div> : <div className="empty"><span className="spin" /></div>}</main>;
  const visitNo = d.visits.length + 1;
  const up = (fn: (p: CarePlan) => void) => setPlan((p) => { const n = JSON.parse(JSON.stringify(p)) as CarePlan; fn(n); return n; });
  const primaryName = d.careTeam.find((t) => t.role === "PRIMARY")?.name ?? "";
  const reported = d.medChanges.filter((m) => m.status === "REPORTED");
  async function review(mid: number, status: string) {
    await api(`/api/patients/${id}/med-changes`, { method: "POST", body: { action: "review", id: mid, status } });
    const x = await load();
    setD(x);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const v: ClinicVitals = {};
      const bp = (vitals.bp || "").match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
      if (bp) { v.sys = Number(bp[1]); v.dia = Number(bp[2]); }
      for (const k of ["weight", "hr", "glucose", "spo2", "pain"] as const) if (vitals[k]) v[k] = Number(vitals[k]);
      const next = nextDate ? Date.parse(`${nextDate}T11:00:00+05:30`) : null;
      const r = await api<{ id: string }>(`/api/patients/${id}/visits`, { body: { vitals: v, diagnosis, notes, plan, next_visit_at: next } });
      notifyChange();
      router.push(d!.current ? `/patients/${id}/compare?b=${r.id}` : `/patients/${id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <Link href={`/patients/${id}`}>← {d.patient.name}</Link>
          <h1 style={{ marginTop: 4 }}>Visit {visitNo} · {fmtDate(d.now, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</h1>
          <div className="muted">{d.current ? "Pre-filled from the current care plan. Change what you need; the new plan reaches the patient’s WhatsApp as soon as you save." : d.baseline?.currentMeds.length ? "Medicines and intake vitals are pre-filled from the baseline. Confirm or change them; WhatsApp reminders start right after you save." : "Set up the care plan. WhatsApp reminders start right after you save."}</div>
        </div>
        <div className="row">
          {plan.template !== "kidney" && <button className="btn" onClick={() => up(applyKidney)} title="Adds weight/fluid/lab monitoring, dry-weight band, kidney lab limits and diet advice">🫘 Apply kidney template</button>}
          <Link className="btn" href={`/patients/${id}`}>Cancel</Link>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? <span className="spin" /> : "💾"} Save visit & activate plan</button>
        </div>
      </div>
      {err && <div className="alert bad" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="grid side">
        <div className="stack gap16">
          <div className="card">
            <div className="card-head"><h3>Clinic vitals today</h3><small>{d.current ? `Last visit: BP ${d.current.vitals.sys ?? "—"}/${d.current.vitals.dia ?? "—"}, Wt ${d.current.vitals.weight ?? "—"}` : ""}</small></div>
            <div className="grid g5">
              {[["bp", "BP (mmHg)", "138/86"], ["weight", "Weight (kg)", "77.4"], ["hr", "Pulse (bpm)", "72"], ["glucose", "Sugar fasting", "132"], ["spo2", "SpO₂ %", "97"]].map(([k, l, ph]) => (
                <label key={k} className="f">{l}<input value={vitals[k] || ""} placeholder={ph} onChange={(e) => setVitals({ ...vitals, [k]: e.target.value })} /></label>
              ))}
            </div>
            {plan.monitoring.some((m) => m.key === "pain") && (
              <div style={{ marginTop: 10, maxWidth: 160 }}><label className="f">Pain score /10<input value={vitals.pain || ""} onChange={(e) => setVitals({ ...vitals, pain: e.target.value })} /></label></div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><h3>Diagnosis & notes</h3></div>
            <div className="stack">
              <label className="f">Diagnosis<textarea value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} style={{ minHeight: 50 }} /></label>
              <label className="f">Consultation notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Findings, counselling, changes made…" /></label>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>💊 Medicines</h3><button className="btn sm" onClick={() => up((p) => p.medications.push({ key: "", name: "", dose: "", times: ["08:00"], prescriber: primaryName }))}>+ Add medicine</button></div>
            <table className="t">
              <thead><tr><th>Medicine</th><th>Dose(s)</th><th>Times (24h)</th><th>Schedule</th><th>Prescribed by</th><th>For / instructions</th><th /></tr></thead>
              <tbody>
                {plan.medications.map((m, i) => {
                  const sched = m.prn ? "prn" : m.courseDays ? "course" : m.everyNDays === 2 ? "alt" : m.everyNDays === 7 ? "weekly" : m.everyNDays && m.everyNDays > 1 ? "everyN" : "daily";
                  return (
                    <tr key={`${i}-${m.key}`}>
                      <td><input value={m.name} placeholder="e.g. Lasix" onChange={(e) => up((p) => { p.medications[i].name = e.target.value; if (!d.current?.plan.medications.some((x) => x.key === p.medications[i].key)) p.medications[i].key = ""; })} /></td>
                      <td style={{ width: 130 }}>
                        <input defaultValue={m.doses && m.doses.length > 1 ? m.doses.join(", ") : m.dose} placeholder="40 mg, 20 mg" title="One dose, or one per time separated by commas (split dose)"
                          onBlur={(e) => up((p) => {
                            const ds = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
                            p.medications[i].dose = ds[0] ?? "";
                            if (ds.length > 1) p.medications[i].doses = ds; else delete p.medications[i].doses;
                          })} />
                      </td>
                      <td style={{ width: 120 }}><input defaultValue={m.times.join(", ")} placeholder="08:00, 16:00" onBlur={(e) => up((p) => { p.medications[i].times = toTimes(e.target.value); })} /></td>
                      <td style={{ width: 150 }}>
                        <select value={sched} onChange={(e) => up((p) => {
                          const x = p.medications[i];
                          delete x.prn; delete x.everyNDays; delete x.courseDays;
                          const v = e.target.value;
                          if (v === "prn") x.prn = true;
                          if (v === "alt") x.everyNDays = 2;
                          if (v === "weekly") x.everyNDays = 7;
                          if (v === "everyN") x.everyNDays = 3;
                          if (v === "course") x.courseDays = 7;
                        })}>
                          <option value="daily">Daily</option><option value="alt">Alternate days</option><option value="weekly">Once a week</option><option value="everyN">Every N days</option><option value="course">Course (N days)</option><option value="prn">Only if required</option>
                        </select>
                        {sched === "everyN" && <input type="number" min={2} value={m.everyNDays} title="every N days" onChange={(e) => up((p) => { p.medications[i].everyNDays = Math.max(2, Number(e.target.value)); })} style={{ marginTop: 4 }} />}
                        {sched === "course" && <input type="number" min={1} value={m.courseDays} title="number of days" onChange={(e) => up((p) => { p.medications[i].courseDays = Math.max(1, Number(e.target.value)); })} style={{ marginTop: 4 }} />}
                      </td>
                      <td style={{ width: 150 }}>
                        <input list="cc-team-visit" value={m.prescriber ?? ""} placeholder={primaryName} onChange={(e) => up((p) => { p.medications[i].prescriber = e.target.value || undefined; })} />
                      </td>
                      <td>
                        <input value={m.purpose || ""} placeholder="for BP / fluid…" onChange={(e) => up((p) => { p.medications[i].purpose = e.target.value || undefined; })} />
                        <input value={m.instructions || ""} placeholder="after food" onChange={(e) => up((p) => { p.medications[i].instructions = e.target.value; })} style={{ marginTop: 4 }} />
                      </td>
                      <td style={{ width: 40 }}><button className="btn sm ghost" title="Stop medicine" onClick={() => up((p) => { p.medications.splice(i, 1); })}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <datalist id="cc-team-visit">{d.careTeam.map((t) => <option key={t.id} value={t.name} />)}</datalist>
            <small className="muted">Split dose: enter one dose per time, e.g. “40 mg, 20 mg” with times “08:00, 16:00”. PRN medicines get no reminders.</small>
          </div>

          {(plan.fluid || plan.template === "kidney") && (
            <div className="card">
              <div className="card-head"><h3>🫘 Kidney care</h3><small>Deviations alert the care circle, not the doctor</small></div>
              <div className="grid g4">
                <label className="f">Dry weight (kg)<input type="number" step="0.1" value={plan.thresholds.dryWeight ?? ""} onChange={(e) => up((p) => { p.thresholds.dryWeight = e.target.value ? Number(e.target.value) : undefined; })} /></label>
                <label className="f">Allowed band ± kg<input type="number" step="0.1" value={plan.thresholds.weightBand ?? ""} onChange={(e) => up((p) => { p.thresholds.weightBand = Number(e.target.value); })} /></label>
                <label className="f">Overnight gain alert (kg)<input type="number" step="0.1" value={plan.thresholds.weightDayGainKg ?? ""} onChange={(e) => up((p) => { p.thresholds.weightDayGainKg = Number(e.target.value); })} /></label>
                <label className="f">Fluid limit ml/day<input type="number" step="50" value={plan.fluid?.limitMl ?? ""} onChange={(e) => up((p) => { p.fluid = { ...(p.fluid ?? KIDNEY_TEMPLATE.fluid), limitMl: Number(e.target.value) }; })} /></label>
                <label className="f">Ask day totals at<input value={plan.fluid?.checkTime ?? ""} onChange={(e) => up((p) => { p.fluid = { ...(p.fluid ?? KIDNEY_TEMPLATE.fluid), checkTime: e.target.value }; })} /></label>
                <label className="f">Urine below ml/day<input type="number" step="50" value={plan.fluid?.lowOutputMl ?? ""} onChange={(e) => up((p) => { p.fluid = { ...(p.fluid ?? KIDNEY_TEMPLATE.fluid), lowOutputMl: Number(e.target.value) }; })} /></label>
                <label className="f">Lab panel<input value={plan.labs?.panel ?? ""} onChange={(e) => up((p) => { p.labs = { ...(p.labs ?? KIDNEY_TEMPLATE.labs), panel: e.target.value }; })} /></label>
                <label className="f">Labs every (days)<input type="number" value={plan.labs?.everyDays ?? ""} onChange={(e) => up((p) => { p.labs = { ...(p.labs ?? KIDNEY_TEMPLATE.labs), everyDays: Number(e.target.value) }; })} /></label>
              </div>
              <h4 style={{ margin: "14px 0 6px" }}>Lab limits</h4>
              <div className="grid g5">
                {([["kHigh", "K above"], ["kLow", "K below"], ["naLow", "Na below"], ["creatRiseAbs", "Creat rise mg/dL"], ["hbLow", "Hb below"]] as [keyof CarePlan["thresholds"], string][]).map(([k, l]) => (
                  <label key={k} className="f">{l}<input type="number" step="0.1" value={plan.thresholds[k] ?? ""} onChange={(e) => up((p) => { (p.thresholds as unknown as Record<string, number>)[k] = Number(e.target.value); })} /></label>
                ))}
              </div>
              <small className="muted">Potassium ≥ 6 is always urgent.</small>
            </div>
          )}

          <div className="card">
            <div className="card-head"><h3>📏 Home readings via WhatsApp</h3></div>
            <div className="stack">
              {(Object.keys(VITAL_META) as VitalType[]).map((k) => {
                const m = plan.monitoring.find((x) => x.key === k);
                return (
                  <div key={k} className="row">
                    <label className={`check ${m ? "on" : ""}`} style={{ minWidth: 170 }}>
                      <input type="checkbox" checked={!!m} onChange={(e) => up((p) => { if (e.target.checked) p.monitoring.push({ key: k, times: ["08:00"] }); else p.monitoring = p.monitoring.filter((x) => x.key !== k); })} />
                      {VITAL_META[k].label}
                    </label>
                    {m && (
                      <>
                        <input style={{ width: 130 }} defaultValue={m.times.join(", ")} onBlur={(e) => up((p) => { p.monitoring.find((x) => x.key === k)!.times = toTimes(e.target.value); })} />
                        <div className="row" style={{ gap: 3 }}>
                          {DOW.map((dn, di) => {
                            const on = !m.days || m.days.includes(di);
                            return (
                              <button key={dn} className={`chip-btn`} style={{ background: on ? "var(--brand-soft)" : "#fff", padding: "3px 7px" }} onClick={() => up((p) => {
                                const mm = p.monitoring.find((x) => x.key === k)!;
                                const cur = mm.days ?? [0, 1, 2, 3, 4, 5, 6];
                                mm.days = on ? cur.filter((x) => x !== di) : [...cur, di].sort();
                                if (mm.days.length === 7) mm.days = undefined;
                              })}>{dn[0]}</button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid g2">
            <div className="card">
              <div className="card-head"><h3>🏃 Physio / exercise</h3><button className="btn sm" onClick={() => up((p) => p.physio.push({ key: "", name: "", detail: "", times: ["17:00"] }))}>+ Add</button></div>
              <div className="stack">
                {plan.physio.map((x, i) => (
                  <div key={i} className="row" style={{ alignItems: "flex-start" }}>
                    <div className="stack" style={{ flex: 1 }}>
                      <input value={x.name} placeholder="e.g. Brisk walk" onChange={(e) => up((p) => { p.physio[i].name = e.target.value; })} />
                      <div className="row">
                        <input value={x.detail} placeholder="20 minutes" onChange={(e) => up((p) => { p.physio[i].detail = e.target.value; })} style={{ flex: 1 }} />
                        <input defaultValue={x.times.join(", ")} style={{ width: 110 }} onBlur={(e) => up((p) => { p.physio[i].times = toTimes(e.target.value); })} />
                      </div>
                    </div>
                    <button className="btn sm ghost" onClick={() => up((p) => { p.physio.splice(i, 1); })}>✕</button>
                  </div>
                ))}
                {!plan.physio.length && <small>None</small>}
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h3>🥗 Lifestyle advice</h3><button className="btn sm" onClick={() => up((p) => p.lifestyle.push({ key: "", text: "" }))}>+ Add</button></div>
              <div className="stack">
                {plan.lifestyle.map((x, i) => (
                  <div key={i} className="row">
                    <input value={x.text} placeholder="e.g. Salt under 5 g/day" onChange={(e) => up((p) => { p.lifestyle[i].text = e.target.value; })} style={{ flex: 1 }} />
                    <button className="btn sm ghost" onClick={() => up((p) => { p.lifestyle.splice(i, 1); })}>✕</button>
                  </div>
                ))}
                <label className="f" style={{ maxWidth: 200 }}>Daily symptom/lifestyle check-in<input value={plan.checkinTime} onChange={(e) => up((p) => { p.checkinTime = e.target.value; })} /></label>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>🚦 Deviation limits → alert the care circle</h3><small>The family is alerted. The doctor is not notified.</small></div>
            <div className="grid g5">
              {(
                [
                  ["sysHigh", "Systolic above"], ["diaHigh", "Diastolic above"], ["sysLow", "Systolic below"], ["weightGainKg", "Weight gain kg / 3d"], ["glucoseHigh", "Sugar above"],
                  ["glucoseLow", "Sugar below"], ["hrHigh", "Pulse above"], ["hrLow", "Pulse below"], ["spo2Low", "SpO₂ below"], ["painHigh", "Pain ≥"],
                ] as [keyof CarePlan["thresholds"], string][]
              ).map(([k, l]) => (
                <label key={k} className="f">{l}<input type="number" value={plan.thresholds[k]} onChange={(e) => up((p) => { p.thresholds[k] = Number(e.target.value); })} /></label>
              ))}
            </div>
            <h4 style={{ margin: "14px 0 6px" }}>Symptoms to watch (alert care circle)</h4>
            <div className="row" style={{ gap: 6 }}>
              {Object.entries(SYMPTOMS).map(([k, l]) => {
                const on = plan.watchSymptoms.includes(k);
                return (
                  <label key={k} className={`check ${on ? "on" : ""}`}>
                    <input type="checkbox" checked={on} onChange={() => up((p) => { p.watchSymptoms = on ? p.watchSymptoms.filter((x) => x !== k) : [...p.watchSymptoms, k]; })} />
                    {l}
                  </label>
                );
              })}
            </div>
            <small className="muted">Chest pain, fainting, severe breathlessness, BP ≥180/110, sugar &lt;54 and SpO₂ &lt;88 are always treated as urgent (fixed emergency rules).</small>
            <h4 style={{ margin: "14px 0 6px" }}>Escalation timers (minutes before moving to the next level)</h4>
            <div className="grid g3" style={{ maxWidth: 520 }}>
              {([["complianceMin", "Missed tasks"], ["deviationMin", "Deviations"], ["urgentMin", "Urgent"]] as [keyof CarePlan["escalation"], string][]).map(([k, l]) => (
                <label key={k} className="f">{l}<input type="number" value={plan.escalation[k]} onChange={(e) => up((p) => { p.escalation[k] = Number(e.target.value); })} /></label>
              ))}
            </div>
          </div>

          <div className="card row between">
            <label className="f" style={{ maxWidth: 220 }}>Next visit<input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></label>
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? <span className="spin" /> : "💾"} Save visit & activate plan</button>
          </div>
        </div>

        <div>
          <div className="stack gap16" style={{ position: "sticky", top: 70 }}>
            {reported.length > 0 && (
              <div className="card">
                <div className="card-head"><h3>💊 Reconcile reported changes</h3><span className="badge warn">{reported.length}</span></div>
                <small className="muted">Reported by the family / other doctors since the last visit. Update the medicine list on the left if you agree, then mark it.</small>
                {reported.map((m) => (
                  <div key={m.id} className="hl warn">
                    <span className="ic">!</span>
                    <div style={{ flex: 1 }}>
                      <b>{m.med_name}</b> {m.change.replace("_", " ")}{m.detail ? ` — ${m.detail}` : ""}
                      <div className="muted">{m.prescriber ? `by ${m.prescriber} · ` : ""}{fmtDate(m.at, { day: "numeric", month: "short" })}{m.reported_by_name ? ` · reported by ${m.reported_by_name}` : ""}</div>
                      <div className="row" style={{ marginTop: 6 }}>
                        <button className="btn sm" onClick={() => review(m.id, "CONFIRMED")}>✔ Confirmed</button>
                        <button className="btn sm ghost" onClick={() => review(m.id, "REVIEWED")}>Seen, no change</button>
                        <button className="btn sm ghost" onClick={() => review(m.id, "REJECTED")}>✖ Not to follow</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="card">
              <div className="card-head"><h3>Since last visit</h3>{d.current && <Link href={`/patients/${id}`} className="btn sm">Full brief</Link>}</div>
              {d.summary ? <Highlights items={d.summary.highlights} /> : <div className="muted">First visit — no home data yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
