import { redirect } from "next/navigation";

// Patients and caregivers now have a single page with their WhatsApp and their record.
export default function HomePage() {
  redirect("/me");
}
