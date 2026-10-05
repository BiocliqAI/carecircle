"use client";
import { use } from "react";
import { useSession } from "@/components/client";
import { PlanBuilder } from "@/components/PlanBuilder";

export default function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useSession();
  if (loading) return <main className="page"><div className="empty"><span className="spin" /></div></main>;
  if (!user || (user.role !== "DOCTOR" && user.role !== "PA")) return <main className="page"><div className="alert bad">The plan builder is for the care team.</div></main>;
  return <PlanBuilder id={id} />;
}
