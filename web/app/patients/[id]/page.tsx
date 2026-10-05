"use client";
import { use } from "react";
import { PatientView } from "@/components/PatientView";

export default function Patient360({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PatientView id={id} />;
}
