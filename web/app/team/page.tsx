"use client";
// Doctor: manage the clinic's assistants (PAs). Doctors themselves are managed by the clinic admin.
import { useSession } from "@/components/client";
import { StaffManager } from "@/components/StaffManager";

export default function Assistants() {
  const { user, loading } = useSession();
  if (loading) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  if (user?.role !== "DOCTOR") return <main className="page"><div className="alert bad">Doctors manage assistants here. Doctors themselves are managed by the clinic admin.</div></main>;
  return (
    <main className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div>
          <h1>Assistants</h1>
          <div className="muted">Physician assistants onboard patients, keep records up to date and look after care circles.</div>
        </div>
      </div>
      <StaffManager roles={["PA"]} />
    </main>
  );
}
