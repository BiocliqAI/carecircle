"use client";
import { use } from "react";
import { useSession } from "@/components/client";
import { Onboarding } from "@/components/Onboarding";

export default function OnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useSession();
  if (loading) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  if (!user || (user.role !== "DOCTOR" && user.role !== "PA")) return <main className="page"><div className="alert bad">Onboarding is for the care team.</div></main>;
  return <Onboarding pid={id} />;
}
