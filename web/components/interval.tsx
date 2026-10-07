"use client";
import { useState } from "react";
import type { IntervalSummary, EscalationView } from "@/lib/summary";
import type { CarePlan, ClinicVitals } from "@/lib/types";
import { dayKey, fmtDate, fmtDateTime } from "@/lib/time";
import { ChartCard, LineChart, Ring } from "./charts";
import { api } from "./client";

const ICON = { good: "✓", warn: "!", bad: "▲", info: "i" } as const;

export function Highlights({ items }: { items: IntervalSummary["highlights"] }) {
  return (
    <div>
      {items.map((h, i) => (
        <div key={i} className={`hl ${h.tone}`}>
          <span className="ic">{ICON[h.tone]}</span>
          <span>{h.text}</span>
        </div>
      ))}
    </div>
  );
}

export function KpiRow({ s }: { s: IntervalSummary }) {
  const alerts = s.escalations.length;
  const urgent = s.escalations.filter((e) => e.type === "URGENT").length;
  return (
    <div className="grid g5">
      {(
        [
          ["Medicines", s.overall.meds],
          ["Monitoring logged", s.overall.monitoring],
          ["Physio / exercise", s.overall.physio],
          ["Daily check-ins", s.overall.checkin],
        ] as [string, number | null][]
      ).map(([l, v]) => (
        <div key={l} className="card tight row" style={{ gap: 12 }}>
          <Ring pct={v} size={58} />
          <div className="stat">
            <span className="l">{l}</span>
            <span style={{ fontWeight: 600, fontSize: 12, color: "var(--ink-2)" }}>adherence</span>
          </div>
        </div>
      ))}
      <div className="card tight">
        <div className="stat">
          <span className="l">Care-circle alerts</span>
          <span className={`v ${urgent ? "bad" : alerts ? "warn" : "good"}`}>{alerts}</span>
          <span className="l">
            {s.symptomFreeDays}/{s.days.length} days symptom-free
          </span>
        </div>
      </div>
    </div>
  );
}

export function AdherenceHeatmap({ s, visitDays = [] }: { s: IntervalSummary; visitDays?: string[] }) {
  const cols = s.days;
  const cell = cols.length > 45 ? 10 : cols.length > 30 ? 14 : 18;
  const groups: [string, string][] = [
    ["med", "💊 Medicines"],
    ["vital", "📏 Readings"],
    ["fluid", "💧 Fluids"],
    ["physio", "🏃 Physio / exercise"],
    ["checkin", "📝 Check-in"],
    ["lab", "🧪 Labs"],
  ];
  return (
    <div style={{ overflowX: "auto" }}>
      <div className="legend" style={{ marginBottom: 10 }}>
        <span><i style={{ background: "#34d399" }} />all done</span>
        <span><i style={{ background: "#fbbf24" }} />partly</span>
        <span><i style={{ background: "#f87171" }} />missed / not done</span>
        <span><i style={{ background: "#eef2f6" }} />not scheduled</span>
        <span className="muted">· {fmtDate(s.from, { day: "numeric", month: "short" })} → {fmtDate(s.to, { day: "numeric", month: "short" })}</span>
      </div>
      {groups.map(([k, title]) => {
        const rows = s.adherence.filter((a) => a.kind === k);
        if (!rows.length) return null;
        return (
          <div key={k} style={{ marginBottom: 12 }}>
            <h4 style={{ marginBottom: 6 }}>{title}</h4>
            <div className="heat" style={{ gridTemplateColumns: `200px repeat(${cols.length}, ${cell}px) 52px` }}>
              {rows.map((r) => (
                <Row key={r.key} label={r.label} cols={cols} byDay={r.byDay} pct={r.pct} visitDays={visitDays} title={`${r.done}/${r.due} done · ${r.missed} not logged · ${r.notDone} reported not done${r.late ? ` · ${r.late} logged late` : ""}`} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Row({ label, cols, byDay, pct, title, visitDays }: { label: string; cols: string[]; byDay: Record<string, string>; pct: number | null; title: string; visitDays: string[] }) {
  return (
    <>
      <div className="lbl" title={title}>{label}</div>
      {cols.map((d) => (
        <div key={d} className={`c ${byDay[d] || ""} ${visitDays.includes(d) ? "visit" : ""}`} title={`${d}: ${byDay[d] || "not scheduled"}`} />
      ))}
      <div className="pct" style={{ color: pct == null ? "#94a3b8" : pct >= 90 ? "var(--good)" : pct >= 75 ? "var(--warn)" : "var(--bad)" }}>{pct == null ? "—" : `${pct}%`}</div>
    </>
  );
}

export function VitalCharts({ s, plan, base, markers = [] }: { s: IntervalSummary; plan?: CarePlan; base?: ClinicVitals; markers?: { t: number; label: string; color?: string }[] }) {
  const th = plan?.thresholds;
  if (!s.vitals.length) return <div className="empty">No readings logged yet.</div>;
  const alertMarkers = s.escalations.filter((e) => e.type !== "COMPLIANCE").map((e) => ({ t: e.started_at, label: "⚠", color: "#f59e0b" }));
  return (
    <div className="grid g2">
      {s.vitals.map((v) => {
        const lines: { y: number; label: string; color?: string }[] = [];
        if (v.type === "bp" && th) lines.push({ y: th.sysHigh, label: `sys limit ${th.sysHigh}` }, { y: th.diaHigh, label: `dia limit ${th.diaHigh}`, color: "#a855f7" });
        if (v.type === "glucose" && th) lines.push({ y: th.glucoseHigh, label: `limit ${th.glucoseHigh}` }, { y: th.glucoseLow, label: `low ${th.glucoseLow}` });
        if (v.type === "spo2" && th) lines.push({ y: th.spo2Low, label: `limit ${th.spo2Low}%` });
        if (v.type === "hr" && th) lines.push({ y: th.hrHigh, label: `upper ${th.hrHigh}` });
        if (v.type === "pain" && th) lines.push({ y: th.painHigh, label: `alert ${th.painHigh}` });
        if (v.type === "weight" && base?.weight) lines.push({ y: base.weight, label: `clinic ${base.weight} kg`, color: "#0f766e" });
        const delta = v.first != null && v.last != null ? Math.round((v.last - v.first) * 10) / 10 : null;
        return (
          <ChartCard key={v.type} label={v.label}>
            <div className="card-head">
              <div>
                <h3>{v.label}</h3>
                <small>
                  {v.count} readings · avg {v.avg}
                  {v.avgV2 != null && v.type === "bp" ? `/${v.avgV2}` : ""} {v.unit} · range {v.min}–{v.max}
                </small>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontWeight: 700, fontSize: 18 }}>
                  {v.last}
                  {v.type === "bp" ? `/${v.lastV2}` : ""} <small>{v.unit}</small>
                </div>
                {delta != null && v.type !== "bp" && <small>{delta >= 0 ? "+" : ""}{delta} since start</small>}
                {v.outOfRange > 0 && <div><span className="badge bad">{v.outOfRange} out of range</span></div>}
              </div>
            </div>
            <LineChart series={v.series} from={s.from} to={s.to} lines={lines} markers={[...markers, ...alertMarkers]} dual={v.type === "bp"} unit={v.unit} height={190} />
          </ChartCard>
        );
      })}
    </div>
  );
}

export function SymptomTable({ s }: { s: IntervalSummary }) {
  if (!s.symptoms.length) return <div className="muted">No symptoms reported. {s.symptomFreeDays} symptom-free days.</div>;
  return (
    <div className="table-wrap">
      <table className="t compact">
        <thead>
          <tr>
            <th>Symptom</th>
            <th style={{ textAlign: "center", width: 44 }}>Days</th>
            <th>Worst</th>
            <th style={{ textAlign: "right" }}>Last reported</th>
          </tr>
        </thead>
        <tbody>
          {s.symptoms.map((x) => (
            <tr key={x.key}>
              <td><b>{x.label}</b></td>
              <td style={{ textAlign: "center" }}>{x.days}</td>
              <td>
                <span className={`badge ${x.maxSeverity === "severe" ? "bad" : x.maxSeverity === "moderate" ? "warn" : ""}`}>
                  {x.maxSeverity}
                </span>
              </td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <div>{fmtDate(x.last, { day: "numeric", month: "short" })}</div>
                {x.first !== x.last && (
                  <small className="muted" style={{ display: "block", fontSize: 11 }}>
                    1st: {fmtDate(x.first, { day: "numeric", month: "short" })}
                  </small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const OUTCOME: Record<string, string> = {
  "1": "Spoke with patient — resolved at home",
  "2": "Contacted doctor / clinic",
  "3": "Taken to hospital / emergency",
  "4": "Other action",
  AUTO: "Patient completed the task",
  EXHAUSTED: "No one acknowledged",
};
const TYPE_LABEL: Record<string, string> = { URGENT: "Urgent", DEVIATION: "Deviation", COMPLIANCE: "Compliance" };

export function EscalationCard({ e, caregivers, canAct, onDone, compact }: { e: EscalationView; caregivers: { name: string; level: number; relation: string | null }[]; canAct?: boolean; onDone?: () => void; compact?: boolean }) {
  const [code, setCode] = useState("1");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notified = new Set(e.events.filter((x) => x.event === "NOTIFIED").map((x) => x.level));
  const timedOut = new Set(e.events.filter((x) => x.event === "TIMEOUT").map((x) => x.level));
  const ackLevel = e.events.find((x) => x.event === "ACKNOWLEDGED")?.level;
  const stateBadge = e.state === "RESOLVED" ? "good" : e.state === "EXHAUSTED" ? "bad" : e.state === "ACKNOWLEDGED" ? "info" : "warn";
  async function act(action: "ack" | "resolve" | "miss") {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/escalations/${e.id}`, { body: { action, code, note } });
      onDone?.();
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`esc ${e.type}`}>
      <div className="row between">
        <div className="row">
          <span className={`badge ${e.type === "URGENT" ? "bad" : e.type === "DEVIATION" ? "warn" : "info"}`}>{TYPE_LABEL[e.type]}</span>
          <b>{e.title}</b>
        </div>
        <div className="row">
          <span className={`badge ${stateBadge}`}>
            {e.state === "NOTIFIED" ? `Waiting on Level ${e.level}` : e.state === "ACKNOWLEDGED" ? `Owned by ${e.ack_by_name}` : e.state === "RESOLVED" ? "Resolved" : "Unacknowledged"}
          </span>
          <small>{fmtDateTime(e.started_at)}</small>
        </div>
      </div>
      <div style={{ marginTop: 6, color: "var(--ink-2)" }}>{e.detail}</div>
      {!compact && (
        <div className="ladder">
          {caregivers.map((c) => {
            const cls = ackLevel === c.level ? "acked" : timedOut.has(c.level) ? "timeout" : notified.has(c.level) ? "notified" : "";
            return (
              <div key={c.level} className={`rung ${cls}`}>
                <b>L{c.level} · {c.name}</b>
                {ackLevel === c.level ? "✅ took ownership" : timedOut.has(c.level) ? "no response" : notified.has(c.level) ? "notified on WhatsApp" : "standby"}
              </div>
            );
          })}
        </div>
      )}
      {(e.state === "RESOLVED" || e.state === "EXHAUSTED") && (
        <div className={`alert ${e.state === "RESOLVED" ? "good" : "bad"}`} style={{ marginTop: 8, padding: "8px 12px" }}>
          <div>
            <b>{OUTCOME[e.outcome_code || ""] || e.outcome_code}</b>
            {e.outcome_note && <div>“{e.outcome_note}”</div>}
            <small>
              {e.resolved_by_name ? `${e.resolved_by_name} · ` : ""}
              {e.resolved_at ? fmtDateTime(e.resolved_at) : ""}
              {e.ack_at ? ` · acknowledged in ${Math.max(1, Math.round((e.ack_at - e.started_at) / 60000))} min` : ""}
            </small>
          </div>
        </div>
      )}
      {!compact && (
        <ul className="events">
          {e.events.filter((x) => x.event !== "CREATED").map((x, i) => (
            <li key={i}>
              <span>{fmtDateTime(x.at)}</span>
              <span>
                <b>{x.event.toLowerCase()}</b> {x.level ? `L${x.level}` : ""} {x.actor && x.actor !== "system" ? `· ${x.actor}` : ""} {x.note ? `— ${x.note}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canAct && (e.state === "NOTIFIED" || e.state === "ACKNOWLEDGED") && (
        <div className="card flat tight" style={{ marginTop: 10, background: "#fafcfd" }}>
          {e.state === "NOTIFIED" && (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn primary sm" disabled={busy} onClick={() => act("ack")}>
                ✋ I'll handle this (acknowledge)
              </button>
              <button className="btn sm" disabled={busy} onClick={() => act("miss")} title="Simulate caregiver missing / timeout">
                ⏱️ Miss (Timeout)
              </button>
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <select value={code} onChange={(x) => setCode(x.target.value)} style={{ maxWidth: 280 }}>
              {["1", "2", "3", "4"].map((k) => (
                <option key={k} value={k}>{OUTCOME[k]}</option>
              ))}
            </select>
            <input placeholder="What was done / advised?" value={note} onChange={(x) => setNote(x.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <button className="btn sm" disabled={busy} onClick={() => act("resolve")}>Record outcome & close</button>
          </div>
          {error && <small style={{ color: "var(--bad)" }}>{error}</small>}
        </div>
      )}
    </div>
  );
}

export function visitDayKeys(visits: { visit_at: number }[]): string[] {
  return visits.map((v) => dayKey(v.visit_at));
}
