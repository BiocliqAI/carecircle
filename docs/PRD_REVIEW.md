# PRD Review — V1 Final vs. stated requirements

Reviewed: `docs/Care_Platform_PRD_V1_Final.docx` (kept unchanged).
Updated PRD: [`PRD_V2.md`](PRD_V2.md) (also exported as `Care_Platform_PRD_V2.docx`).

## Verdict

The V1 PRD has the right foundation: WhatsApp-first, doctors are never alerted proactively, a three-level caregiver chain, deterministic rules with AI only assisting, provenance back to each WhatsApp message, and a pull-based Command Centre. **It does not cover the core of your request: the visit-to-visit loop.** It also has two policy conflicts with your requirements, and its scope is too large for a quick demoable MVP.

## What already matches (kept)

| Requirement | V1 PRD |
|---|---|
| Patients and caregivers transact over WhatsApp; no new app | §1, §2, §8 |
| Escalation stays within the patient–caregiver chain (L1→L2→L3) | §10, §11 |
| No automated alerts to the doctor or PA | §2, §10, §20 |
| Caregivers record actions and outcomes (e.g. "contacted the doctor") | §6, §13, §16 |
| Dashboard for doctor, PA, caregiver and patient | §3, §4, §13 |
| AI extracts and summarises; rules decide | §2, §17 |
| Every reading is traceable to the source message | §2, §8, §15 |
| "Not reported" is distinguished from "reported not done" | §9 |

## Gaps and conflicts (changed in V2)

| # | Gap | Why it matters for your requirement | V2 change |
|---|---|---|---|
| 1 | **No Visit / Encounter entity.** The care plan is a living object with no snapshots at each consultation. | You want the doctor to see the *diff between the previous and current visit*. Without visits, there is nothing to diff against. | `Visit` is first-class (§5): clinic vitals, diagnosis, notes, a **plan snapshot**, and the next visit date. Recording a visit activates the new plan. |
| 2 | **No visit comparison or pre-visit brief.** "What changed?" (§15) is undefined: changed since when? | This is the main time sink for doctors and PAs today ("lots of paperwork, inaccuracy"). | New **Pre-visit brief** (since the last visit) and **Visit Comparison** screens (§9.3, §9.4). They show medicines added, stopped or changed; clinic vitals delta; plan changes; and adherence, trends, symptoms and alerts *between* the two visits. |
| 3 | **Clinical deviations only go to the web app** (§12: "do not automatically generate notifications"). Caregivers are only notified for *non-compliance*. | You want deviations from baseline to escalate **to the patient and caregiver group**, who then take it to the doctor. | New **Deviation** escalation (§7.2) through the same caregiver ladder. The message includes the doctor's advice and "contact the clinic if it persists". The doctor is still never notified. |
| 4 | **Caregivers cannot log on the patient's behalf** (they only "support" monitoring). | Often the caregiver *is* the one taking the readings. | Any care-circle member can log over WhatsApp. Provenance records *who* logged (§6.3). |
| 5 | **Physio / exercise and lifestyle compliance are not modelled.** §7 lists only vitals, labs and medicines. | Explicitly requested ("log physiotherapy compliance, lifestyle modifications"). | The care plan includes physio items (scheduled, tracked, with escalation after repeated misses), lifestyle advice, and a daily symptom/lifestyle check-in (§5.2). |
| 6 | **Symptom logging is thin.** Only "edema" is listed, plus a generic "configured symptom exception". | Watching for and logging symptoms is a core caregiver job. | Symptom catalogue with severity, negation ("no breathlessness"), a doctor-chosen *watch list* (→ deviation), and red flags (→ urgent) (§6.2, §7.3). |
| 7 | **The patient dashboard is "optional read-only, profile only in M1"**; trends come in "later milestones". | You want the dashboard available to patients and caregivers too. | Patients and caregivers see the same longitudinal views (summary, trends, adherence, alerts, timeline), read-only, scoped to their own patient (§9.6). |
| 8 | **The emergency chain needs separate people**, designed before anything works. | Adds configuration burden. No clinic asked for it in the MVP. | The MVP uses the **same care circle** with a separate *Urgent* type, separate wording and a shorter timer (15 min). It never merges with compliance. A separate emergency contact list moves to Phase 2 (§7.4). |
| 9 | **Scope is too large for a demo**: OCR of labs and prescriptions, voice, documents, multi-org identity binding, natural-language search, intervention module, and the M0–M10 FastAPI/Postgres roadmap. | You asked for a demoable MVP *now*. | MVP scope is cut to the full patient lifecycle (§11). Everything else is Phase 2/3, without losing the V1 safety principles. |
| 10 | **Repo docs (`M1.md`, `M1_TEST_REPORT.md`) describe M0/M1 code that is not in this folder.** | Misleading for anyone picking this up. | Noted in `ROADMAP.md`. The working MVP lives in `web/`. |

## Smaller corrections

- **Escalation outcomes**: V2 defines fixed outcome codes, which make up the doctor's audit trail: *resolved at home / contacted doctor / taken to hospital / other*, plus a free-text note.
- **Auto-resolve**: when the patient logs a missed task late, the open compliance alert closes automatically and caregivers are told "no action needed". This avoids alert fatigue.
- **AI dependency**: V1 says Gemini "drives all modes". V2 keeps Gemini as the preferred parser (`gemini-3.8-flash`) but requires a **deterministic fallback parser**, so the product (and the demo) works without AI and AI never sits on the safety path.
