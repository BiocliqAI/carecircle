"use client";
// Onboardings from past records on Today. The doctor sees the ones the assistant has sent for confirmation; the
// assistant sees the ones still being read or checked, and the ones the doctor sent back. Hidden when there are none.
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useSession } from "../client";
import { fmtDateTime } from "@/lib/time";
import type { OnboardingTask } from "@/lib/onboarding";

const STATE: Record<string, string> = { COLLECTING: "Reading records", REVIEW: "To check", RETURNED: "Sent back", SENT: "With the doctor" };

export function OnboardingWorklist({ doctor }: { doctor?: boolean }) {
  const { bump } = useSession();
  const [tasks, setTasks] = useState<OnboardingTask[] | null>(null);
  useEffect(() => { api<{ tasks: OnboardingTask[] }>("/api/onboardings").then((r) => setTasks(r.tasks)).catch(() => setTasks([])); }, [bump]);
  if (!tasks?.length) return null;
  return (
    <section className="v2-card pad">
      <div className="row between" style={{ marginBottom: 6 }}>
        <h2>{doctor ? "Onboardings to confirm" : "Past records in progress"}</h2>
        <span className="v2-sub">{tasks.length}</span>
      </div>
      {tasks.map((t) => (
        <div key={t.onboardingId} className="row between" style={{ padding: "8px 0", borderTop: "1px solid var(--line-2)", gap: 8 }}>
          <div style={{ flex: "1 1 200px", minWidth: 0 }}>
            <b>{t.patientName}</b>
            <div className="v2-sub">
              {doctor
                ? `${t.records} record${t.records === 1 ? "" : "s"} · sent ${t.byName ? `by ${t.byName} ` : ""}${fmtDateTime(t.updatedAt)}${t.forDoctor ? ` · ${t.forDoctor} point${t.forDoctor === 1 ? "" : "s"} left for you` : ""}`
                : `${STATE[t.status] ?? t.status} · ${t.records} record${t.records === 1 ? "" : "s"}${t.status === "RETURNED" && t.note ? ` · “${t.note}”` : ""}`}
            </div>
          </div>
          <Link className="v2-btn" href={`/patients/${t.patientId}/onboarding`}>{doctor ? "Review" : t.status === "SENT" ? "View" : "Open"}</Link>
        </div>
      ))}
    </section>
  );
}
