import { redirect } from "next/navigation";

// Clinic settings moved to the Admin page.
export default function SettingsPage() {
  redirect("/admin");
}
