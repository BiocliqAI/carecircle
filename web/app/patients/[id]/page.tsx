"use client";
import { useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { useSession } from "@/components/client";
import { PatientChart } from "@/components/PatientChart";

// The patient chart is for the care team; patients and caregivers have their own page (/me).
export default function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useSession();
  const router = useRouter();
  const family = user && (user.role === "PATIENT" || user.role === "CAREGIVER");
  useEffect(() => {
    if (family) router.replace("/me");
  }, [family, router]);
  if (loading || family) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  return <PatientChart id={id} />;
}
