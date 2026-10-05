# AGENTS.md — Codex Rules
## Non-negotiable product rules
1. Patient messaging, monitoring submissions, documents and acknowledgements use WhatsApp. Patients may optionally use a read-only dashboard for their own details and history.
2. Doctor/PA uses the web application; caregiver dashboard access is limited to explicitly linked patients. Patient dashboard access is restricted to the identity-linked patient's own record, with no care-team or permission mutations.
3. Never send automated proactive alerts to Doctor/PA in V1.
4. Compliance and emergency escalation are separate workflows.
5. Compliance: patient reminders -> caregiver L1 -> L2 -> L3, using configured timers.
6. Emergency: separate policy, contacts, timers and state machine.
7. Never infer an emergency from an abnormal value unless an explicit emergency rule says so.
8. AI never directly mutates task, exception, escalation or treatment state.
9. Every clinical observation retains source provenance.
10. Every escalation transition, acknowledgement, correction and intervention is audited.
11. Do not implement autonomous diagnosis or treatment recommendations.
12. Longitudinal visibility and ease of use are first-class requirements.

### PRD V2 amendments (see PRD_V2.md / PRD_REVIEW.md)
13. Deviations from the doctor's limits (thresholds, weight trend, watch symptoms) escalate to the **care circle** (L1 → L2 → L3, deviation timer) with the doctor's advice and "contact the clinic if it persists". They are still **never** sent to the Doctor/PA.
14. Urgent red flags (explicit policy in code, not AI) use the same circle with a separate type, wording and shorter timer in the MVP. A separate emergency contact list is Phase 2.
15. `Visit` is first-class: clinic vitals, diagnosis, an immutable care-plan snapshot and next visit. The latest visit's plan is the active plan. Briefs and diffs are computed between visits.
16. Caregivers may log on the patient's behalf. Observations record who logged them.
17. The MVP lives in `web/` (Next.js + SQLite + WhatsApp simulator). The engineering rules below target the production build (Phase 2).

## Engineering rules
- Modular monolith first.
- FastAPI/Python/PostgreSQL backend; Next.js/TypeScript frontend.
- Alembic for every schema change.
- Thin controllers; services own business rules.
- External integrations behind adapters.
- Timezone-aware timestamps.
- No secrets in source and no real PHI/PII in prompts, fixtures, logs or tests.
- Webhooks/jobs/reminders/escalation sends must be idempotent.
- Authorization is server-side; UI hiding is not authorization.

## Protected state
Only TaskService changes Task.status; ObservationService changes verification/corrections; ExceptionService changes exception state; ComplianceEscalationService changes compliance state; EmergencyEscalationService changes emergency state; InterventionService creates interventions.

## Required workflow
Read relevant docs -> state scope/assumptions -> inspect code/tests -> smallest coherent change -> tests -> formatter/linter/typecheck -> report results/migrations/config changes. Never claim completion with failing tests.

## Stateful tests
Test happy path, timeout, duplicate event, out-of-order event, retry, concurrent execution, restart safety, authorization failure, invalid transition, and resolution while escalation is active.

## AI integration
AI output is untrusted. Validate strict schemas, normalize deterministically, preserve source + extraction run and record provider/model/schema version. Free-form model output must never determine emergency state.

## Review checklist
Cross-tenant access; authorization; missing audit; race conditions; duplicate sends; timezone bugs; invalid transitions; non-idempotent workers; PHI in logs; missing provenance; insufficient tests; accidental Doctor/PA proactive notifications.

## Good task
Read the relevant specification. Implement one bounded layer (e.g. models+migration only), add tests, run them, and report assumptions.
