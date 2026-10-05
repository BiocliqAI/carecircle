"use client";
// Today: the clinician's landing page. Doctors get the triage queue; assistants get their work queue.
import { useSession } from "@/components/client";
import { DoctorToday } from "@/components/today/DoctorToday";
import { PaToday } from "@/components/today/PaToday";

export default function Today() {
  const { user, loading } = useSession();
  if (loading) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  return user?.role === "PA" ? <PaToday /> : <DoctorToday />;
}
