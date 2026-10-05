# ROADMAP.md — V1

> **Status (Oct 2026):** The M0/M1 FastAPI/PostgreSQL code described in `M1.md` / `M1_TEST_REPORT.md` is **not present in this repository**. A demoable MVP covering the whole visit → WhatsApp → escalation → next-visit lifecycle is in [`../web`](../web/README.md). It is a single Next.js + SQLite app with a WhatsApp simulator and follows [`PRD_V2.md`](PRD_V2.md) (see [`PRD_REVIEW.md`](PRD_REVIEW.md) for what changed). The milestones below are the original production roadmap and still apply to Phase 2 hardening. MVP scope is defined in PRD_V2 §11.

Build vertical slices; each milestone is demoable end-to-end.

M0 Foundation: repo, Docker, FastAPI/Next.js shells, PostgreSQL/Alembic, worker, CI, RBAC skeleton, audit helper, synthetic data. Exit: one-command startup + green CI.

M1 Onboarding: patient, care team, caregivers, caregiver dashboard permission, Patient 360 shell, optional read-only patient dashboard for own details/history. Exit: strict linked-patient and patient-ownership authorization + audit.

M2 Care Plan: draft/version/activate BP + weight plan, schedules/reminders/rules. Exit: one active plan; history retained.

M3 WhatsApp spine: plan -> task -> WhatsApp -> reply -> webhook -> Message -> validated Observation -> Patient 360/timeline. Exit: duplicate webhook safe + provenance drill-down.

M4 Compliance: overdue -> reminder -> L1 -> acknowledgement/resolution -> L2 -> L3. Exit: deterministic/idempotent/audited; no Doctor/PA proactive alert.

M5 Caregiver dashboard: linked patient status/trends/compliance escalation + acknowledgement. Exit: authorization + audit.

M6 Emergency framework: independent policy/state machine with explicit synthetic/manual trigger. Exit: independent from compliance; L1/L2/L3 tested.

M7 Command Centre + Patient 360: pull-based clinical visibility, evidence/source drill-down. No Doctor/PA notification mechanism.

M8 Documents: WhatsApp lab/prescription -> storage -> extraction -> human verification -> longitudinal record.

M9 AI summaries/search: pre-review summary, What changed?, authorized natural-language retrieval. AI cannot mutate state.

M10 Pilot hardening: security, retry/load tests, backup/restore, observability, runbooks, audit completeness, WhatsApp failures, privacy/regulatory review, UAT.

## MVP-0
Doctor creates patient + L1/L2/L3 caregivers -> BP/weight plan -> WhatsApp request -> patient reply -> values extracted -> Patient 360 updates -> missed response triggers caregiver chain -> acknowledgement/resolution appears on timeline.

## Release gates
No P0/P1 security defects; state-machine, duplicate/retry, RBAC and audit/provenance tests green; synthetic E2E green.
