"use client";
// Go-live checklist for a new live clinic. Shown on Today until every step is done.
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useSession } from "./client";

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

export function GettingStarted() {
  const { mode, bump } = useSession();
  const [cl, setCl] = useState<Checklist | null>(null);
  useEffect(() => {
    if (mode === "live") api<{ checklist: Checklist }>("/api/clinic").then((r) => setCl(r.checklist)).catch(() => undefined);
  }, [mode, bump]);
  if (mode !== "live" || !cl) return null;

  const steps: { done: boolean; title: string; detail: string; href?: string; cta?: string }[] = [
    { done: cl.doctors + cl.pas > 1, title: "Add the care team", detail: `${cl.doctors} doctor${cl.doctors === 1 ? "" : "s"} · ${cl.pas} PA${cl.pas === 1 ? "" : "s"}`, href: "/team", cta: "Team" },
    { done: cl.patients > 0, title: "Onboard a patient and care circle", detail: cl.patients ? `${cl.patients} patient${cl.patients === 1 ? "" : "s"} · ${cl.caregivers} caregiver${cl.caregivers === 1 ? "" : "s"}` : "Details, L1–L3 caregivers, baseline", href: "/patients/new", cta: "Onboard" },
    { done: cl.patients > 0 && cl.baselines >= cl.patients, title: "Capture the baseline", detail: `${cl.baselines} of ${cl.patients} patients` },
    { done: cl.consentsGiven > 0 && cl.consentsPending === 0, title: "Consent on WhatsApp", detail: cl.consentsGiven + cl.consentsPending ? `${cl.consentsGiven} replied YES · ${cl.consentsPending} waiting` : "Each person replies YES to the welcome message" },
    { done: cl.withVisit > 0, title: "Record Visit 1 and the care plan", detail: `${cl.withVisit} of ${cl.patients} patients have an active plan` },
    { done: cl.inbound > cl.consentsGiven, title: "First WhatsApp log from home", detail: "e.g. “BP 142/90, took tablets”" },
    { done: cl.escalations > 0, title: "First care-circle escalation", detail: cl.escalations ? `${cl.escalations} so far` : "An out-of-range reading alerts Level 1" },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const next = steps.find((s) => !s.done)!;

  return (
    <div className="card getting-started">
      <div className="card-head">
        <div>
          <h3>Getting started</h3>
          <small>Next: <b>{next.title}</b></small>
        </div>
        <span className="badge brand">{done}/{steps.length}</span>
      </div>
      <div className="progress" style={{ marginBottom: 12 }}><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className="checklist gs-grid">
        {steps.map((s) => (
          <li key={s.title} className={s.done ? "done" : ""}>
            <span className="tick">{s.done ? "✓" : ""}</span>
            <div style={{ flex: 1 }}>
              <b>{s.title}</b>
              <div className="muted">{s.detail}</div>
            </div>
            {s.href && !s.done && <Link className="btn sm" href={s.href}>{s.cta}</Link>}
          </li>
        ))}
      </ol>
    </div>
  );
}
