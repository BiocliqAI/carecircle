"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, avatarColor, initials, useSession } from "@/components/client";
import type { IntervalSummary } from "@/lib/summary";
import { shortName } from "@/lib/types";

interface P { patient: { id: string; name: string; conditions: string }; summary: IntervalSummary | null; open: { id: number; title: string; type: string }[]; caregivers: { user_id: string | null; level: number }[] }

// Home for patients / caregivers: the patients whose care circle they belong to.
export default function Home() {
  const router = useRouter();
  const { user, patientIds, loading, bump } = useSession();
  const [list, setList] = useState<P[] | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) return router.replace("/");
    if (user.role === "DOCTOR" || user.role === "PA") return router.replace("/doctor");
    if (patientIds.length === 1) return router.replace(`/patients/${patientIds[0]}`);
    Promise.all(patientIds.map((id) => api<P>(`/api/patients/${id}`))).then(setList).catch(() => setList([]));
  }, [loading, user, patientIds, router, bump]);

  if (!list) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  return (
    <main className="page" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <h1>Hi {user ? shortName(user.name) : ""}</h1>
        <div className="muted">People in your care circle</div>
      </div>
      <div className="stack">
        {list.map((p) => {
          const me = p.caregivers.find((c) => c.user_id === user?.id);
          return (
            <Link key={p.patient.id} href={`/patients/${p.patient.id}`} className="card row between" style={{ textDecoration: "none", color: "inherit" }}>
              <div className="row" style={{ gap: 12 }}>
                <span className="avatar" style={{ background: avatarColor(p.patient.name) }}>{initials(p.patient.name)}</span>
                <div>
                  <b>{p.patient.name}</b>
                  <div className="muted">{p.patient.conditions}</div>
                  {me && <small>You are Level {me.level} in the care circle</small>}
                </div>
              </div>
              <div className="row">
                {p.open.length > 0 ? <span className="badge bad">{p.open.length} open alert{p.open.length > 1 ? "s" : ""}</span> : <span className="badge good">All good</span>}
                {p.summary?.overall.meds != null && <span className="badge">Medicines {p.summary.overall.meds}%</span>}
              </div>
            </Link>
          );
        })}
        {!list.length && <div className="empty">You are not in anyone’s care circle yet.</div>}
      </div>
    </main>
  );
}
