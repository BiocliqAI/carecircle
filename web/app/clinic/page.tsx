import { redirect } from "next/navigation";

// The old Clinic page was split into Team and Clinic settings.
export default function ClinicPage() {
  redirect("/team");
}
