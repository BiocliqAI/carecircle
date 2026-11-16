import { now } from "@/lib/clock";
import { getPatient, getUser } from "@/lib/engine";
import { loadLearnedMarkers } from "@/lib/labmarkers";
import { markCounts } from "@/lib/historyspec";
import { addRecord, confirmedOnboarding, getOnboarding, historyVersions, removedFrom, confirmOnboarding, startUpdate, currentOnboarding, draftOf, moveRecord, openItems, progress, rebuildDraft, removeRecord, resumeReading, retryRecord, saveDraftEdits, sendBack, sendToDoctor, startOnboarding, type Draft, type Pile } from "@/lib/onboarding";
import { canView, err, isClinician, json, ready, sessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

async function guard(id: string) {
  const user = await sessionUser();
  if (!isClinician(user) || !getPatient(id) || !canView(user!, id)) return null;
  return user!;
}

// Onboarding from past records: progress, the draft for review, and every step (upload, sort, edit, send, confirm).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await guard(id);
  if (!user) return err("Care team only", 403);
  // One confirmed version of the history (from the version list).
  const version = Number(new URL(req.url).searchParams.get("version"));
  if (version) {
    const v = getOnboarding(version);
    if (!v || v.patient_id !== id || v.status !== "CONFIRMED") return err("Version not found", 404);
    return json({ summary: draftOf(v)?.summary ?? null, confirmedAt: v.confirmed_at, confirmedBy: getUser(v.confirmed_by ?? "")?.name ?? null });
  }
  const p = getPatient(id)!;
  const o = currentOnboarding(id);
  if (o && o.status === "COLLECTING") resumeReading(o.id);
  const fresh = o ? currentOnboarding(id)! : null;
  const draft = draftOf(fresh ?? undefined);
  // The history as last confirmed (shown on the chart while an update to it is being checked).
  const conf = confirmedOnboarding(id);
  const confDraft = conf && conf.id !== fresh?.id ? draftOf(conf) : null;
  return json({
    now: now(),
    patient: { id: p.id, name: p.name, doctorId: p.doctor_id, doctorName: getUser(p.doctor_id)?.name ?? null },
    viewer: { id: user.id, role: user.role, name: user.name },
    onboarding: fresh && {
      id: fresh.id, status: fresh.status, builtAt: fresh.built_at, buildError: fresh.build_error,
      sentAt: fresh.sent_at, sentBy: getUser(fresh.sent_by ?? "")?.name ?? null,
      returnedAt: fresh.returned_at, returnedBy: getUser(fresh.returned_by ?? "")?.name ?? null, returnNote: fresh.return_note,
      confirmedAt: fresh.confirmed_at, confirmedBy: getUser(fresh.confirmed_by ?? "")?.name ?? null,
    },
    isUpdate: !!fresh?.base_id && fresh.status !== "CONFIRMED",
    removed: fresh?.base_id && fresh.status !== "CONFIRMED" && draft ? removedFrom(draftOf(getOnboarding(fresh.base_id))?.summary ?? {}, draft.summary) : [],
    versions: historyVersions(id),
    marks: draft ? markCounts(draft.summary) : null,
    confirmed: conf ? { confirmedAt: conf.confirmed_at, confirmedBy: getUser(conf.confirmed_by ?? "")?.name ?? null, summary: (confDraft ?? draft)?.summary ?? null, points: (confDraft ?? draft)?.points ?? [] } : null,
    progress: fresh ? progress(fresh) : null,
    draft,
    open: draft ? openItems(draft) : null,
    labMarkers: loadLearnedMarkers(),
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await ctx.params;
  const user = await guard(id);
  if (!user) return err("Care team only", 403);
  const b = (await req.json().catch(() => ({}))) as { action?: string; base64?: string; mime?: string; name?: string; docId?: number; pile?: string; edits?: Partial<Draft>; note?: string };
  const t = now();
  try {
    switch (b.action) {
      case "start": return json({ ok: true, onboardingId: startOnboarding(id, user.id, t) });
      case "update": return json({ ok: true, onboardingId: startUpdate(id, user.id, t) });
      case "upload": {
        if (!b.base64) return err("Choose a file");
        startOnboarding(id, user.id, t);
        return json({ ok: true, docId: addRecord(id, user.id, { base64: b.base64, mime: b.mime ?? "", name: b.name ?? "Record" }, t) });
      }
      case "remove": removeRecord(id, Number(b.docId), user.id, t); break;
      case "move": moveRecord(id, Number(b.docId), b.pile === "lab" ? "lab" : ("clinical" as Pile)); break;
      case "retry": retryRecord(id, Number(b.docId)); break;
      case "rebuild": rebuildDraft(id, user.id, t); break;
      case "save": saveDraftEdits(id, b.edits ?? {}, user, t); break;
      case "send": sendToDoctor(id, user, t); break;
      case "return": sendBack(id, user, b.note ?? "", t); break;
      case "confirm": return json({ ok: true, filed: confirmOnboarding(id, user, t) });
      default: return err("Unknown action");
    }
    return json({ ok: true });
  } catch (e) {
    return err((e as Error).message, 400);
  }
}
