"use client";
// Patient's and caregiver's own page content (beside their WhatsApp phone). Plain language, larger type.
import { useEffect, useState } from "react";
import { api, avatarColor, initials, useSession } from "../client";
import { Icon } from "../Icon";
import { Spark } from "../Spark";
import { fmtDate, fmtTime, relDays } from "@/lib/time";
import type { familyToday } from "@/lib/family";

type Today = ReturnType<typeof familyToday>;

export function useToday(pid: string | null) {
  const { bump } = useSession();
  const [d, setD] = useState<Today | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => (pid ? api<Today>(`/api/patients/${pid}/today`).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message)) : Promise.resolve());
  useEffect(() => {
    load();
    const i = setInterval(load, 8000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, bump]);
  return { d, err, reload: load };
}

const STATUS: Record<string, { text: string; color: string; icon: "check" | "alert" | null; bg: string }> = {
  done: { text: "Done", color: "var(--c-green)", icon: "check", bg: "var(--c-brand-soft)" },
  high: { text: "Outside target", color: "var(--c-red)", icon: "alert", bg: "var(--c-red-soft)" },
  missed: { text: "Missed", color: "var(--c-amber)", icon: "alert", bg: "var(--c-amber-soft)" },
  due: { text: "Due now", color: "var(--c-amber)", icon: null, bg: "transparent" },
  later: { text: "Later", color: "var(--c-mute)", icon: null, bg: "transparent" },
};

function PlanCard({ d, title }: { d: Today; title: string }) {
  const done = d.plan.filter((i) => i.status === "done" || i.status === "high").length;
  return (
    <section className="fh-card num">
      <div className="row between" style={{ marginBottom: 4 }}><h2>{title}</h2><span className="fh-sub">{d.plan.length ? `${done} of ${d.plan.length} done` : ""}</span></div>
      {!d.hasPlan && <p className="fh-sub" style={{ margin: "6px 0 0" }}>The plan starts after the first visit with {d.doctor ?? "the doctor"}.</p>}
      {d.hasPlan && !d.plan.length && <p className="fh-sub" style={{ margin: "6px 0 0" }}>Nothing scheduled today.</p>}
      {d.plan.map((i, k) => {
        const st = STATUS[i.status];
        return (
          <div key={k} className="fh-plan">
            <span className="fh-tick" style={{ background: st.bg, color: st.color, border: st.icon ? 0 : "2px solid #CFD8D5" }}>{st.icon && <Icon name={st.icon} size={15} stroke={2.6} title={st.text} />}</span>
            <span className="fh-time">{i.time}</span>
            <span style={{ flex: 1 }}>{i.label}</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: st.color }}>{i.value ?? st.text}</span>
          </div>
        );
      })}
    </section>
  );
}

function ReadingCard({ d, you }: { d: Today; you: boolean }) {
  const r = d.reading;
  if (!r) return <section className="fh-card"><div className="fh-sub" style={{ fontWeight: 600 }}>Readings</div><p className="fh-sub">No readings in the last 2 weeks yet.</p></section>;
  return (
    <section className="fh-card num">
      <div className="fh-sub" style={{ fontWeight: 600 }}>{r.label}</div>
      <div className="row" style={{ gap: 6, alignItems: "baseline", marginTop: 4, flexWrap: "nowrap" }}><span style={{ fontSize: 32, fontWeight: 700 }}>{r.latest}</span><span className="fh-sub">{r.unit} · {relDays(r.at, d.now) === 0 ? fmtTime(r.at) : fmtDate(r.at, { day: "numeric", month: "short" })}</span></div>
      <p style={{ margin: "6px 0 0", fontSize: 15, fontWeight: 500, color: r.status === "ok" ? "var(--c-green)" : "var(--c-amber)" }}>{r.message}</p>
      <div style={{ marginTop: 10 }}><Spark points={r.points} lo={r.lo} hi={r.hi} tone={r.status === "ok" ? "brand" : "amber"} width={320} height={52} label={`${r.label} over the last 2 weeks`} /></div>
      <div className="fh-sub" style={{ fontSize: 13 }}>Last 2 weeks · shaded area is {you ? "your" : "the"} target</div>
    </section>
  );
}

function WeekCard({ d }: { d: Today }) {
  return (
    <section className="fh-card num">
      <div className="fh-sub" style={{ fontWeight: 600 }}>Medicines this week</div>
      <div className="row" style={{ gap: 6, alignItems: "baseline", marginTop: 4 }}><span style={{ fontSize: 32, fontWeight: 700 }}>{d.weekOk} of {d.weekDue || 7}</span><span className="fh-sub">days on track</span></div>
      <div className="fh-week">
        {d.week.map((w) => <div key={w.day}><div style={{ background: w.status === "ok" ? "#0F5C55" : w.status === "missed" ? "#F59E0B" : "#E3E8E6" }} title={w.status} />{w.label}</div>)}
      </div>
      <div className="fh-sub" style={{ fontSize: 13, marginTop: 8 }}>{d.missedDays.length ? `Missed doses on ${d.missedDays.join(", ")}` : "No missed doses this week"}</div>
    </section>
  );
}

function NextVisitCard({ d, you }: { d: Today; you: boolean }) {
  return (
    <section className="fh-card">
      <h2 style={{ marginBottom: 10 }}>Next visit</h2>
      {d.nextVisit ? <div className="num" style={{ fontSize: 20, fontWeight: 700 }}>{fmtDate(d.nextVisit, { weekday: "long", day: "numeric", month: "long" })}, {fmtTime(d.nextVisit)}</div> : <div className="fh-sub">Not booked yet</div>}
      {d.doctor && <div className="fh-sub" style={{ marginTop: 2 }}>{d.doctor}</div>}
      <div className="fh-sub" style={{ marginTop: 10 }}>{you ? "Bring your medicine strips and any new reports." : d.monthAlerts.n ? `${d.monthAlerts.n} alert${d.monthAlerts.n > 1 ? "s" : ""} this month, ${d.monthAlerts.closed} closed by the family.` : "No alerts this month."}</div>
    </section>
  );
}

// ---------------------------------------------------------------- patient
export function PatientHome({ pid }: { pid: string }) {
  const { d, err } = useToday(pid);
  if (err) return <div className="alert bad">{err}</div>;
  if (!d) return <div className="empty"><span className="spin" /></div>;
  return (
    <div className="stack gap16">
      <div>
        <h1 className="fh-h1">Hello, {d.patient.first}</h1>
        <p className="fh-sub" style={{ margin: "4px 0 0", fontSize: 16 }}>Here’s how your care plan is going. {d.doctor ?? "Your doctor"} and your family see the same.</p>
      </div>
      <PlanCard d={d} title="Today’s plan" />
      <div className="fh-two"><ReadingCard d={d} you /><WeekCard d={d} /></div>
      <div className="fh-two">
        <NextVisitCard d={d} you />
        <section className="fh-card">
          <h2 style={{ marginBottom: 6 }}>Your care circle</h2>
          {d.caregivers.map((c) => (
            <div key={c.name} className="row" style={{ gap: 12, padding: "8px 0", borderTop: c.level > 1 ? "1px solid var(--c-line2)" : 0, flexWrap: "nowrap" }}>
              <span className="avatar" style={{ background: avatarColor(c.name) }}>{initials(c.name)}</span>
              <div><div style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</div><div className="fh-sub" style={{ fontSize: 13 }}>{c.relation} · {c.level === 1 ? "contacted first" : "backup"}</div></div>
            </div>
          ))}
        </section>
      </div>
      <section className="fh-card fh-sos">
        <span className="fh-sos-badge">SOS</span>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>In an emergency</div>
          <div className="fh-sub">Chest pain, trouble breathing or fainting: call <b style={{ color: "var(--c-ink)" }}>108</b> now. Pressing SOS on WhatsApp alerts {d.caregivers.map((c) => c.name.split(" ")[0]).join(" and ") || "your care circle"} straight away.</div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- caregiver
const OUTCOMES: [string, string][] = [["1", "Resolved at home"], ["2", "Spoke to the clinic"], ["3", "Went to hospital"], ["4", "Something else"]];

export function CaregiverHome({ pid }: { pid: string }) {
  const { user, notifyChange } = useSession();
  const { d, err, reload } = useToday(pid);
  const [code, setCode] = useState("1");
  const [note, setNote] = useState("");
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (err) return <div className="alert bad">{err}</div>;
  if (!d) return <div className="empty"><span className="spin" /></div>;

  async function act(id: number, body: Record<string, unknown>, done: string) {
    setBusy(String(body.action));
    setMsg(null);
    try {
      await api(`/api/escalations/${id}`, { body });
      setMsg(done);
      setNote("");
      notifyChange();
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function sendLog() {
    if (!log.trim() || !user) return;
    setBusy("log");
    try {
      await api("/api/whatsapp", { body: { userId: user.id, body: log.trim() } });
      setLog("");
      setMsg(`Logged for ${d!.patient.first}.`);
      notifyChange();
      await reload();
    } finally {
      setBusy(null);
    }
  }
  const me = d.me;
  const other = d.caregivers.find((c) => c.level !== me?.level);

  return (
    <div className="stack gap16">
      <div>
        <h1 className="fh-h1">{d.patient.first} today</h1>
        <p className="fh-sub" style={{ margin: "4px 0 0", fontSize: 16 }}>You’re {me?.level === 1 ? "the primary caregiver" : "the backup caregiver"}{other ? `. ${other.name.split(" ")[0]} (${(other.relation || "family").toLowerCase()}) is the ${other.level === 1 ? "primary" : "backup"}.` : "."}</p>
      </div>
      {msg && <div className="alert good"><div>{msg}</div></div>}

      {d.alerts.map((a) => (
        <section key={a.id} className={`fh-card fh-alert ${a.type === "URGENT" ? "red" : "amber"}`}>
          <div className="row" style={{ gap: 10, marginBottom: 6 }}>
            <span className="fh-alert-k">{a.type === "URGENT" ? "Urgent" : a.type === "DEVIATION" ? "Needs attention" : "Missed task"}</span>
            {a.state === "ACKNOWLEDGED"
              ? <span className="v2-pill green">{a.ackBy === user?.id ? "You’re handling this" : `${a.ackByName ?? "Someone"} is handling this`}{a.ackAt ? ` · since ${fmtTime(a.ackAt)}` : ""}</span>
              : <span className="v2-pill amber">{a.mine ? "Waiting for you" : `With ${a.atLevelName ?? "the care circle"}`}</span>}
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 700 }}>{a.title}</h2>
          <p className="fh-sub" style={{ margin: "4px 0 0" }}>{a.detail}</p>
          {a.advice && <p style={{ margin: "8px 0 0", fontSize: 15 }}>{a.advice}</p>}

          {a.state === "NOTIFIED" && a.mine && (
            <div className="row" style={{ gap: 10, marginTop: 14 }}>
              <button className="fh-btn primary" disabled={!!busy} onClick={() => act(a.id, { action: "ack" }, "Thank you. You own this alert now.")}>I’ll handle it</button>
              {a.nextName && <button className="fh-btn" disabled={!!busy} onClick={() => act(a.id, { action: "timeout" }, `Passed to ${a.nextName}.`)}>Pass to {a.nextName}</button>}
            </div>
          )}
          {(a.state === "ACKNOWLEDGED" && a.ackBy === user?.id) && (
            <div style={{ marginTop: 14 }}>
              <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
                <legend style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>What happened?</legend>
                <div className="fh-opts">
                  {OUTCOMES.map(([k, l]) => <label key={k} className={`fh-opt ${code === k ? "on" : ""}`}><input type="radio" name={`o${a.id}`} checked={code === k} onChange={() => setCode(k)} /> {l}</label>)}
                </div>
              </fieldset>
              <label className="stack" style={{ gap: 6, marginTop: 12, fontWeight: 600, fontSize: 15 }}>What was advised or done?
                <textarea className="fh-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Clinic said continue medicines and recheck in the evening" />
              </label>
              <div className="row" style={{ gap: 10, marginTop: 12 }}>
                <button className="fh-btn primary" disabled={!!busy} onClick={() => act(a.id, { action: "resolve", code, note }, "Alert closed. It’s on the record for the doctor.")}>Close alert</button>
                {a.nextName && <button className="fh-btn" disabled={!!busy} onClick={() => act(a.id, { action: "timeout" }, `Passed to ${a.nextName}.`)}>Pass to {a.nextName}</button>}
              </div>
            </div>
          )}
        </section>
      ))}

      <PlanCard d={d} title={`${d.patient.first}’s plan today`} />
      <div className="fh-two">
        <section className="fh-card">
          <h2 style={{ marginBottom: 4 }}>Log something for {d.patient.first}</h2>
          <p className="fh-sub" style={{ margin: "0 0 12px" }}>Write it the way you’d text it. It’s recorded as logged by you.</p>
          <label><span className="sr-only">Message for {d.patient.first}’s record</span>
            <textarea className="fh-input" value={log} onChange={(e) => setLog(e.target.value)} placeholder="e.g. Evening tablet taken at 8:15, BP 146/90" />
          </label>
          <div className="row" style={{ gap: 8, marginTop: 10 }}><button className="fh-btn primary" disabled={!log.trim() || busy === "log"} onClick={sendLog}>Log it</button></div>
        </section>
        <ReadingCard d={d} you={false} />
      </div>
      <NextVisitCard d={d} you={false} />
    </div>
  );
}
