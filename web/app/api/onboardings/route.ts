import { onboardingTasks } from "@/lib/onboarding";
import { err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Onboardings on this person's Today list: the doctor's to confirm, the assistant's in progress or sent back.
export async function GET() {
  await ready();
  const user = await sessionUser();
  if (!isClinician(user)) return err("Care team only", 403);
  return json({ tasks: onboardingTasks(user!) });
}
