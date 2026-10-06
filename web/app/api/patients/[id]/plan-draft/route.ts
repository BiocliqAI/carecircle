import { now } from "@/lib/clock";
import { createVisit, getPatient, latestVisit } from "@/lib/engine";
import { addSource, blockers, buildDraft, clearPlanDraft, confirmItem, draftToPlan, editMed, getPlanDraft, removeItem, removeSource, resolveConflict, savePlanDraft, type SourceKind } from "@/lib/plandraft";
import { clearPrep, getPrep } from "@/lib/prep";
import { draftFamilySummary, suggestNextVisit } from "@/lib/aftervisit";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";
import type { ClinicVitals } from "@/lib/types";

export const dynamic = "force-dynamic";

async function guard(id: string, doctorOnly = false) {
  const user = await sessionUser();
  if (!isClinician(user) || !canView(user!, id)) return null;
  if (doctorOnly && user!.role !== "DOCTOR") return null;
  return user!;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  if (!(await guard(id))) return err("Care team only", 403);
  const d = getPlanDraft(id);
  const t = now();
  const base = latestVisit(id, t)?.plan ?? null;
  const asPlan = new URL(req.url).searchParams.get("asPlan") === "1";
  return json({ draft: d, blockers: d.built ? blockers(d.built) : null, plan: asPlan && d.built ? draftToPlan(d.built, base) : undefined, prep: getPrep(id), hasVisit: !!base });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const body = (await req.json()) as {
    action: "source" | "removeSource" | "build" | "resolve" | "confirm" | "remove" | "editMed" | "clear" | "send" | "familySummary";
    kind?: SourceKind; base64?: string; mime?: string; seconds?: number; id?: string; option?: number;
    patch?: Record<string, unknown>; nextVisit?: string | null; familySummary?: string;
  };
  const user = await guard(id, body.action === "send");
  if (!user) return err(body.action === "send" ? "Only the doctor can send the care plan" : "Care team only", 403);
  const t = now();
  try {
    if (body.action === "source") {
      if (!body.base64 || !body.kind) return err("Nothing to add");
      if (body.base64.length > 20_000_000) return err("That file or recording is too large");
      await addSource(id, body.kind, body.base64, body.mime || "application/octet-stream", body.seconds, t, user.id);
    } else if (body.action === "removeSource") {
      removeSource(id, body.id ?? "", t);
    } else if (body.action === "build") {
      await buildDraft(id, t, user.id);
    } else if (body.action === "familySummary") {
      const d = getPlanDraft(id);
      if (!d.built) return err("Build the draft first");
      const changes = d.built.medications.filter((m) => m.change !== "same").length;
      return json({ ...(await draftFamilySummary(d.built, body.nextVisit ?? d.built.nextVisit?.date ?? null)), suggest: suggestNextVisit(id, t, changes) });
    } else if (body.action === "clear") {
      clearPlanDraft(id);
    } else if (body.action === "send") {
      const d = getPlanDraft(id);
      if (!d.built) return err("Build the draft first");
      const bl = blockers(d.built);
      if (bl.conflicts || bl.toConfirm) return err(`Resolve ${bl.conflicts} conflict(s) and confirm ${bl.toConfirm} item(s) first`);
      const p = getPatient(id)!;
      const base = latestVisit(id, t)?.plan ?? null;
      const plan = draftToPlan(d.built, base);
      const pv = getPrep(id).vitals;
      const vitals: ClinicVitals = {};
      const bp = (pv.bp || "").match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
      if (bp) { vitals.sys = Number(bp[1]); vitals.dia = Number(bp[2]); }
      for (const k of ["weight", "hr", "glucose", "spo2"] as const) if (pv[k] && Number.isFinite(Number(pv[k]))) vitals[k] = Number(pv[k]);
      const nextDate = body.nextVisit ?? d.built.nextVisit?.date ?? null;
      const next = nextDate ? Date.parse(`${nextDate}T11:00:00+05:30`) : null;
      const notes = [d.built.note, ...d.built.answers.map((a) => `Q (${a.askedBy ?? "family"}): ${a.question}\nA: ${a.answer}`)].filter(Boolean).join("\n\n");
      const vid = createVisit(id, user.id, { vitals, diagnosis: d.built.diagnosis || p.conditions || "", notes, plan, next_visit_at: next, answers: d.built.answers.map((a) => ({ question: a.question, answer: a.answer })), familySummary: (body.familySummary ?? "").trim().slice(0, 1200) || undefined }, t);
      clearPlanDraft(id);
      clearPrep(id);
      return json({ ok: true, visitId: vid });
    } else {
      const d = getPlanDraft(id);
      if (!d.built) return err("Build the draft first");
      if (body.action === "resolve") resolveConflict(d.built, body.id ?? "", Number(body.option));
      else if (body.action === "confirm") confirmItem(d.built, body.id ?? "");
      else if (body.action === "remove") removeItem(d.built, body.id ?? "");
      else if (body.action === "editMed") editMed(d.built, body.id ?? "", body.patch ?? {});
      else return err("Unknown action");
      savePlanDraft(id, d, t);
    }
    const d = getPlanDraft(id);
    return json({ draft: d, blockers: d.built ? blockers(d.built) : null });
  } catch (e) {
    return err((e as Error).message, 400);
  }
}
