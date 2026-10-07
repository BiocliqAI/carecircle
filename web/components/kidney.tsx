"use client";
// Kidney-care UI: header badges, pre-visit kidney panel, long-range "Kidney & labs" tab,
// lab entry, medicine-change reconciliation and care-team (other doctors) management.
import { useState } from "react";
import { api } from "@/components/client";
import { ChartCard, ComboChart, LineChart, medMarkers } from "@/components/charts";
import type { KidneySummary, LongRange, MedChangeRow } from "@/lib/summary";
import { LAB_META, type CarePlan } from "@/lib/types";
import { DAY, dayKey, fmtDate, fmtTime } from "@/lib/time";

export interface CareTeamRow { id: number; name: string; specialty: string | null; hospital: string | null; phone: string | null; role: string; notes: string | null }
export interface LabDue { due_at: number; status: string; label: string; overdue: boolean }
export interface FluidToday { in: number; out: number; inLogged: boolean; outLogged: boolean; limit: number }

const dayMs = (d: string) => Date.parse(`${d}T12:00:00+05:30`);
const fmtLab = (marker: string, v: number) => {
  const dg = LAB_META[marker]?.digits ?? 1;
  return v.toFixed(dg);
};
const CHANGE_LABEL: Record<string, string> = { started: "started", stopped: "stopped", dose_changed: "dose changed", other: "changed" };
const STATUS_BADGE: Record<string, string> = { REPORTED: "warn", CONFIRMED: "good", REVIEWED: "info", REJECTED: "bad" };

/* ------------------------------------------------------------------ header */

export function KidneyBadges({ labDue, fluidToday, pending, now }: { labDue: LabDue | null; fluidToday: FluidToday | null; pending: number; now: number }) {
  return (
    <>
      {fluidToday && (
        <span className={`badge ${fluidToday.inLogged && fluidToday.in > fluidToday.limit ? "bad" : "info"}`} title="Fluid intake logged today vs the doctor's daily limit">
          💧 Today {fluidToday.inLogged ? `${fluidToday.in}` : "—"} / {fluidToday.limit} ml{fluidToday.outLogged ? ` · 🚻 ${fluidToday.out} ml` : ""}
        </span>
      )}
      {labDue && (
        <span className={`badge ${labDue.overdue ? "bad" : "brand"}`} title={labDue.label}>
          🧪 Labs {labDue.overdue ? `overdue since ${fmtDate(labDue.due_at, { day: "numeric", month: "short" })}` : `due ${fmtDate(labDue.due_at, { day: "numeric", month: "short" })}`}
          {labDue.overdue ? ` (${Math.floor((now - labDue.due_at) / DAY)} d)` : ""}
        </span>
      )}
      {pending > 0 && <span className="badge warn" title="Medicine changes reported by family / other doctors, waiting for the clinic to reconcile">💊 {pending} med change{pending > 1 ? "s" : ""} to reconcile</span>}
    </>
  );
}

export function CareTeamChips({ team }: { team: CareTeamRow[] }) {
  if (!team.length) return null;
  const seen = new Set<string>();
  const uniqueTeam = team.filter((c) => {
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: "wrap" }}>
      <small>Doctors:</small>
      {uniqueTeam.map((c) => (
        <span key={c.id} className={`badge ${c.role === "PRIMARY" ? "good" : ""}`} title={[c.hospital, c.phone, c.notes].filter(Boolean).join(" · ")}>
          {c.role === "PRIMARY" ? "★ " : ""}{c.name}{c.specialty ? ` · ${c.specialty}` : ""}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ brief panel */

export function KidneyBrief({ k, plan }: { k: KidneySummary; plan: CarePlan }) {
  const labs = k.labs.filter((l) => LAB_META[l.marker]?.kidney && l.latest);
  const pending = k.medChanges.filter((m) => m.status === "REPORTED");
  return (
    <div className="card">
      <div className="card-head"><h3>🫘 Kidney panel</h3><small>since last visit</small></div>
      <div className="grid g4" style={{ marginBottom: 12 }}>
        <Mini label="Weight in dry-weight band" value={k.weightBand?.pct != null ? `${k.weightBand.pct}%` : "—"} sub={k.weightBand ? `${k.weightBand.dry} ± ${k.weightBand.band} kg · ${k.weightBand.above} above / ${k.weightBand.below} below` : "no dry weight set"} tone={k.weightBand?.pct != null && k.weightBand.pct < 70 ? "bad" : "good"} />
        <Mini label="Avg fluid intake" value={k.avgIn != null ? `${Math.round(k.avgIn)} ml` : "—"} sub={k.limit ? `limit ${k.limit} ml · ${k.daysOver} day${k.daysOver === 1 ? "" : "s"} over` : ""} tone={k.daysOver > 2 ? "bad" : k.daysOver ? "warn" : "good"} />
        <Mini label="Avg urine output" value={k.avgOut != null ? `${Math.round(k.avgOut)} ml` : "—"} sub={`${k.daysLogged} days logged`} />
        <Mini label="Med changes to reconcile" value={`${pending.length}`} sub={`${k.medChanges.length} change(s) this period`} tone={pending.length ? "warn" : "good"} />
      </div>
      {labs.length > 0 ? (
        <div className="table-wrap">
          <table className="t compact">
            <thead><tr><th>Lab</th><th>Before visit</th><th>Latest</th><th>Change</th></tr></thead>
            <tbody>
              {labs.map((l) => {
                const diff = l.pre && l.latest ? l.latest.v - l.pre.v : null;
                const lb = LAB_META[l.marker]?.lowerBetter;
                const worse = diff != null && Math.abs(diff) > 0.001 && (lb ? diff > 0 : l.marker === "egfr" || l.marker === "hb" ? diff < 0 : false);
                return (
                  <tr key={l.marker}>
                    <td>{l.label} <small>{l.unit}</small></td>
                    <td>{l.pre ? <>{fmtLab(l.marker, l.pre.v)} <small>{fmtDate(l.pre.t, { day: "numeric", month: "short" })}</small></> : "—"}</td>
                    <td className={l.latest?.flag ? "delta bad" : ""}>{fmtLab(l.marker, l.latest!.v)} <small>{fmtDate(l.latest!.t, { day: "numeric", month: "short" })}</small></td>
                    <td className={worse ? "delta bad" : diff ? "delta good" : ""}>{diff != null ? `${diff > 0 ? "+" : ""}${fmtLab(l.marker, diff)}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted">No labs since the last visit{plan.labs ? ` (plan: ${plan.labs.panel} every ${plan.labs.everyDays} days)` : ""}.</div>
      )}
      {pending.length > 0 && (
        <div className="alert warn" style={{ marginTop: 10 }}>
          <div>
            <b>Reported medicine changes (not yet in the plan):</b>
            {pending.map((m) => <div key={m.id}>• {m.med_name} {CHANGE_LABEL[m.change] ?? m.change}{m.detail ? ` — ${m.detail}` : ""}{m.prescriber ? ` (by ${m.prescriber})` : ""} · {fmtDate(m.at, { day: "numeric", month: "short" })}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

function Mini({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "bad" }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px" }}>
      <small className="muted">{label}</small>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : undefined }}>{value}</div>
      {sub && <small className="muted">{sub}</small>}
    </div>
  );
}

/* ------------------------------------------------------------------ long-range tab */

const RANGES: [string, string][] = [["visit", "Since last visit"], ["90", "90 days"], ["365", "1 year"], ["all", "All history"]];

export function KidneyTab({ lr, plan, sinceVisit, now, clinician, pid, medChanges, team, onChange }: {
  lr: LongRange; plan: CarePlan; sinceVisit: number; now: number; clinician: boolean; pid: string; medChanges: MedChangeRow[]; team: CareTeamRow[]; onChange: () => void;
}) {
  const [range, setRange] = useState("all");
  const earliest = Math.min(now - 30 * DAY, ...lr.labs.flatMap((l) => l.series.map((p) => p.t)), ...lr.weight.map((w) => w.t), ...lr.visits.map((v) => v.t));
  const from = range === "visit" ? sinceVisit - DAY / 2 : range === "all" ? earliest - 3 * DAY : now - Number(range) * DAY;
  const to = now + DAY / 2;
  const inR = (t: number) => t >= from && t <= to;
  const markers = [...lr.visits.filter((v) => inR(v.t)).map((v) => ({ t: v.t, label: `V${lr.visits.indexOf(v) + 1}` })), ...medMarkers(medChanges, from, to)];
  const th = plan.thresholds;

  const labCharts: { marker: string; lines: { y: number; label: string; color?: string }[] }[] = [
    { marker: "creatinine", lines: [] },
    { marker: "potassium", lines: [...(th.kHigh ? [{ y: th.kHigh, label: `K high ${th.kHigh}` }] : []), ...(th.kLow ? [{ y: th.kLow, label: `K low ${th.kLow}`, color: "#2563eb" }] : [])] },
    { marker: "egfr", lines: [] },
    { marker: "urea", lines: [] },
    { marker: "hb", lines: th.hbLow ? [{ y: th.hbLow, label: `Hb low ${th.hbLow}` }] : [] },
    { marker: "sodium", lines: [...(th.naLow ? [{ y: th.naLow, label: `Na low ${th.naLow}`, color: "#2563eb" }] : [])] },
  ];

  const weight = lr.weight.filter((w) => inR(w.t));
  const diur = lr.diuretic.filter((d) => inR(dayMs(d.d)));
  const fluid = lr.fluid.filter((f) => inR(dayMs(f.d)));
  const band: [number, number] | undefined = lr.dryWeight && lr.band ? [lr.dryWeight - lr.band, lr.dryWeight + lr.band] : undefined;

  // lab table: newest dates first
  const allLabs = lr.labs.flatMap((l) => l.series.filter((p) => inR(p.t)).map((p) => ({ ...p, marker: l.marker })));
  const dates = [...new Set(allLabs.map((p) => dayKey(p.t)))].sort().reverse();
  const markersShown = lr.labs.filter((l) => allLabs.some((p) => p.marker === l.marker)).map((l) => l.marker);

  return (
    <div className="stack gap16">
      <div className="row between">
        <div className="row">
          {RANGES.map(([k, l]) => (
            <button key={k} className={`check ${range === k ? "on" : ""}`} onClick={() => setRange(k)}>{l}</button>
          ))}
        </div>
        <small className="muted">History before 10 Sep 2026 imported from the family’s log sheet · later readings from WhatsApp / clinic entry</small>
      </div>

      <div className="grid g2">
        <ChartCard label="Weight vs diuretic dose">
          <div className="card-head"><h3>Weight vs diuretic dose</h3><small>{band ? `dry weight ${lr.dryWeight} ± ${lr.band} kg (shaded)` : "no dry weight set"}</small></div>
          <ComboChart from={from} to={to} markers={markers}
            line={{ pts: weight, unit: "kg", color: "#0f766e", band, label: "Weight (kg)" }}
            bars={[{ pts: diur.map((d) => ({ t: dayMs(d.d), v: d.mg })), unit: "mg", color: "#f59e0b", label: "Diuretic mg/day" }]} />
        </ChartCard>
        <ChartCard label="Fluid intake vs urine output">
          <div className="card-head"><h3>Fluid intake vs urine output</h3><small>{lr.limit ? `limit ${lr.limit} ml/day` : ""}</small></div>
          <ComboChart from={from} to={to} markers={markers}
            bars={[
              { pts: fluid.filter((f) => f.in != null).map((f) => ({ t: dayMs(f.d), v: f.in! })), unit: "ml", color: "#3b82f6", label: "Intake ml" },
              { pts: fluid.filter((f) => f.out != null).map((f) => ({ t: dayMs(f.d), v: f.out! })), unit: "ml", color: "#a855f7", label: "Urine ml" },
            ]}
            barLines={lr.limit ? [{ y: lr.limit, label: `limit ${lr.limit}` }] : []} />
        </ChartCard>
      </div>

      <div className="grid g3">
        {labCharts.map(({ marker, lines }) => {
          const ls = lr.labs.find((l) => l.marker === marker);
          if (!ls) return null;
          const pts = ls.series.filter((p) => inR(p.t)).map((p) => ({ t: p.t, v1: p.v, flag: p.flag }));
          return (
            <ChartCard key={marker} label={ls.label}>
              <div className="card-head"><h3>{ls.label}</h3><small>{ls.unit}{ls.latest ? ` · latest ${fmtLab(marker, ls.latest.v)}` : ""}</small></div>
              <LineChart series={pts} from={from} to={to} lines={lines} markers={markers} height={170} unit={ls.unit} />
            </ChartCard>
          );
        })}
      </div>

      <div className="grid side">
        <div className="card">
          <div className="card-head"><h3>Lab results</h3><small>{dates.length} test dates in range</small></div>
          {dates.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead><tr><th>Date</th>{markersShown.map((m) => <th key={m}>{LAB_META[m]?.label ?? m}</th>)}</tr></thead>
                <tbody>
                  {dates.slice(0, 40).map((d) => (
                    <tr key={d}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDate(dayMs(d))}</td>
                      {markersShown.map((m) => {
                        const p = allLabs.filter((x) => x.marker === m && dayKey(x.t) === d).pop();
                        return <td key={m} className={p?.flag ? "delta bad" : ""} title={p ? `source: ${p.source}` : ""}>{p ? fmtLab(m, p.v) : ""}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="empty">No lab results in this range</div>}
        </div>
        <div className="stack gap16">
          {clinician && <LabEntry pid={pid} onDone={onChange} />}
          <div className="callout">
            Family can also send results on WhatsApp, e.g. <i>“creat 1.9 urea 62 K 4.8”</i>. Lab results outside the limits alert the <b>care circle</b> (not the doctor) and ask them to contact the clinic.
          </div>
        </div>
      </div>

      <MedChangesPanel rows={medChanges} clinician={clinician} pid={pid} team={team} onChange={onChange} />
    </div>
  );
}

/* ------------------------------------------------------------------ lab entry */

const ENTRY_MARKERS = ["creatinine", "urea", "egfr", "potassium", "sodium", "uric_acid", "hb", "bicarbonate", "calcium", "phosphorus", "albumin", "ntprobnp"];

export function LabEntry({ pid, onDone }: { pid: string; onDone: () => void }) {
  const [date, setDate] = useState(() => dayKey(Date.now()));
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    const values = Object.fromEntries(Object.entries(vals).filter(([, v]) => v.trim() !== "" && !isNaN(Number(v))).map(([k, v]) => [k, Number(v)]));
    if (!Object.keys(values).length) return setMsg("Enter at least one value");
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; results: { marker: string; flag: string | null }[] }>(`/api/patients/${pid}/labs`, { method: "POST", body: { date, values } });
      setVals({});
      const flagged = r.results.filter((x) => x.flag).map((x) => `${LAB_META[x.marker]?.label ?? x.marker} ${x.flag}`);
      setMsg(`Saved ${r.results.length} result(s).${flagged.length ? ` Flagged: ${flagged.join(", ")} — recent out-of-range results alert the care circle on WhatsApp.` : ""}`);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <div className="card-head"><h3>🧪 Enter lab report</h3></div>
      <label className="f" style={{ marginBottom: 8 }}>Report date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <div className="grid g3" style={{ gap: 8 }}>
        {ENTRY_MARKERS.map((m) => (
          <label key={m} className="f">
            {LAB_META[m].label.replace(/ \(.*\)/, "")}
            <input inputMode="decimal" placeholder={LAB_META[m].unit} value={vals[m] ?? ""} onChange={(e) => setVals({ ...vals, [m]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary sm" onClick={save} disabled={busy}>{busy ? <span className="spin" /> : null} Save results</button>
        {msg && <small>{msg}</small>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ medicine changes */

export function MedChangesPanel({ rows, clinician, pid, team, onChange }: { rows: MedChangeRow[]; clinician: boolean; pid: string; team: CareTeamRow[]; onChange: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState<{ medName: string; change: string; detail: string; prescriber: string; date: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sorted = [...rows].sort((a, b) => (a.status === "REPORTED" ? -1 : 0) - (b.status === "REPORTED" ? -1 : 0) || b.at - a.at);
  const shown = showAll ? sorted : sorted.slice(0, 8);

  async function review(id: number, status: string) {
    await api(`/api/patients/${pid}/med-changes`, { method: "POST", body: { action: "review", id, status } });
    onChange();
  }
  async function report() {
    if (!form?.medName.trim()) return setErr("Medicine name required");
    try {
      await api(`/api/patients/${pid}/med-changes`, { method: "POST", body: form });
      setForm(null);
      setErr(null);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>💊 Medicine changes by other doctors</h3>
        <button className="btn sm" onClick={() => setForm(form ? null : { medName: "", change: "dose_changed", detail: "", prescriber: team.find((t) => t.role !== "PRIMARY")?.name ?? "", date: dayKey(Date.now()) })}>
          {form ? "Cancel" : "+ Record a change"}
        </button>
      </div>
      <div className="callout" style={{ marginBottom: 10 }}>
        Changes reported on WhatsApp or here are <b>logged, never applied automatically</b>. Reminders continue on the current plan until the clinic confirms the change at the next visit.
      </div>
      {form && (
        <div className="grid g5" style={{ gap: 8, marginBottom: 12, alignItems: "end" }}>
          <label className="f">Medicine<input value={form.medName} onChange={(e) => setForm({ ...form, medName: e.target.value })} placeholder="e.g. Prizide" /></label>
          <label className="f">Change
            <select value={form.change} onChange={(e) => setForm({ ...form, change: e.target.value })}>
              <option value="started">Started</option><option value="stopped">Stopped</option><option value="dose_changed">Dose changed</option><option value="other">Other</option>
            </select>
          </label>
          <label className="f">Detail<input value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} placeholder="e.g. 60 → 30 mg" /></label>
          <label className="f">By doctor
            <input list="cc-team" value={form.prescriber} onChange={(e) => setForm({ ...form, prescriber: e.target.value })} />
            <datalist id="cc-team">{team.map((t) => <option key={t.id} value={t.name} />)}</datalist>
          </label>
          <div className="row">
            <label className="f" style={{ flex: 1 }}>Date<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
            <button className="btn primary sm" onClick={report}>Save</button>
          </div>
          {err && <small className="delta bad">{err}</small>}
        </div>
      )}
      {rows.length ? (
        <div className="table-wrap">
          <table className="t compact">
            <thead><tr><th>Date</th><th>Medicine</th><th>Change</th><th>By doctor</th><th>Reported by</th><th>Status</th>{clinician && <th />}</tr></thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDate(m.at, { day: "numeric", month: "short", year: "2-digit" })}</td>
                  <td><b>{m.med_name}</b></td>
                  <td>{CHANGE_LABEL[m.change] ?? m.change}{m.detail ? <div className="muted">{m.detail}</div> : null}</td>
                  <td>{m.prescriber ?? "—"}</td>
                  <td><small>{m.reported_by_name ?? (m.source === "import" ? "imported log" : m.source)}{m.source === "whatsapp" ? " · WhatsApp" : ""}</small></td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[m.status] ?? ""}`}>{m.status === "REPORTED" ? "awaiting clinic" : m.status.toLowerCase()}</span>
                    {m.reviewed_by_name && <div><small className="muted">{m.reviewed_by_name}{m.reviewed_at ? ` · ${fmtDate(m.reviewed_at, { day: "numeric", month: "short" })} ${fmtTime(m.reviewed_at)}` : ""}</small></div>}
                  </td>
                  {clinician && (
                    <td style={{ whiteSpace: "nowrap" }}>
                      {m.status === "REPORTED" && (
                        <>
                          <button className="btn sm" title="The change is correct — update the plan at the visit" onClick={() => review(m.id, "CONFIRMED")}>✔ Confirm</button>{" "}
                          <button className="btn sm ghost" title="Seen; no plan change" onClick={() => review(m.id, "REVIEWED")}>Seen</button>{" "}
                          <button className="btn sm ghost" title="Not correct / not to be followed" onClick={() => review(m.id, "REJECTED")}>✖</button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="muted">No medicine changes recorded.</div>}
      {sorted.length > 8 && <button className="btn sm ghost" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${sorted.length}`}</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ care team */

export function CareTeamPanel({ team, pid, canEdit, onChange }: { team: CareTeamRow[]; pid: string; canEdit: boolean; onChange: () => void }) {
  const blank = { id: 0, name: "", specialty: "", hospital: "", phone: "", notes: "" };
  const [edit, setEdit] = useState<typeof blank | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!edit) return;
    try {
      await api(`/api/patients/${pid}/team`, { method: "POST", body: { ...edit, action: edit.id ? "update" : "add" } });
      setEdit(null);
      setErr(null);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function remove(id: number) {
    if (!confirm("Remove this doctor from the care team?")) return;
    await api(`/api/patients/${pid}/team`, { method: "POST", body: { action: "delete", id } });
    onChange();
  }
  const seen = new Set<string>();
  const uniqueTeam = team.filter((c) => {
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div className="card">
      <div className="card-head">
        <h3>Doctors involved</h3>
        {canEdit && <button className="btn sm" onClick={() => setEdit(edit ? null : blank)}>{edit ? "Cancel" : "+ Add doctor"}</button>}
      </div>
      <small className="muted">Tracked for context only — other doctors don’t log in and never get messages.</small>
      {uniqueTeam.map((c) => (
        <div key={c.id} className="hl info">
          <span className="ic">{c.role === "PRIMARY" ? "★" : "+"}</span>
          <div style={{ flex: 1 }}>
            <b>{c.name}</b> {c.role === "PRIMARY" && <span className="badge good">primary</span>}
            <div className="muted">{[c.specialty, c.hospital].filter(Boolean).join(" · ") || "—"}</div>
            {(c.phone || c.notes) && <small>{[c.phone, c.notes].filter(Boolean).join(" · ")}</small>}
          </div>
          {canEdit && (
            <div className="row" style={{ alignSelf: "flex-start" }}>
              <button className="btn sm ghost" onClick={() => setEdit({ id: c.id, name: c.name, specialty: c.specialty ?? "", hospital: c.hospital ?? "", phone: c.phone ?? "", notes: c.notes ?? "" })}>Edit</button>
              {c.role !== "PRIMARY" && <button className="btn sm ghost" onClick={() => remove(c.id)}>✖</button>}
            </div>
          )}
        </div>
      ))}
      {edit && (
        <div className="stack" style={{ marginTop: 10 }}>
          <label className="f">Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Dr …" /></label>
          <div className="grid g2" style={{ gap: 8 }}>
            <label className="f">Specialty<input value={edit.specialty} onChange={(e) => setEdit({ ...edit, specialty: e.target.value })} /></label>
            <label className="f">Hospital<input value={edit.hospital} onChange={(e) => setEdit({ ...edit, hospital: e.target.value })} /></label>
            <label className="f">Phone<input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></label>
            <label className="f">Notes<input value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
          </div>
          <div className="row"><button className="btn primary sm" onClick={save}>Save</button>{err && <small className="delta bad">{err}</small>}</div>
        </div>
      )}
    </div>
  );
}
