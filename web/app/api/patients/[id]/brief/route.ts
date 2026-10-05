import { generateClinicalSummary } from "@/lib/gemini";
import { getPatient } from "@/lib/engine";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

// Medically comprehensive pre-consultation clinical summary powered by Gemini 3.8 Flash
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await sessionUser();
  if (!isClinician(user) || !getPatient(id) || !canView(user!, id)) return err("Care team only", 403);

  try {
    const summary = await generateClinicalSummary(id);
    const bullets = [
      `• ${summary.executiveSummary}`,
      `• ${summary.clinicalTrajectory}`,
      `• ${summary.biometricAndFluidControl}`,
      `• ${summary.renalMetabolicPanel}`,
      `• ${summary.treatmentAdherence}`,
      `• ${summary.careCircleEscalations}`,
      summary.crossDoctorReconciliation ? `• ${summary.crossDoctorReconciliation}` : null,
      ...summary.consultationDiscussionPoints.map((p) => `• 💡 Discussion point: ${p}`),
    ].filter(Boolean).join("\n\n");

    return json({
      source: summary.source,
      model: summary.model,
      text: bullets,
      summary,
    });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return POST(_req, ctx);
}
