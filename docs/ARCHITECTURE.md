# ARCHITECTURE.md — Care Platform V1
## Constraints
WhatsApp patient messaging and monitoring submissions; optional read-only patient dashboard for own details/history; Doctor/PA web app; linked-caregiver dashboard; no proactive Doctor/PA alerts; separate compliance/emergency workflows; three-level compliance caregiver chain; deterministic state transitions; longitudinal provenance/audit. The PRD specifies Google Gemini 3.8 Flash; keep AI behind a provider adapter.

## V1 stack
Modular monolith: Next.js/TypeScript frontend; FastAPI/Python backend; PostgreSQL + SQLAlchemy/Alembic; Redis + background worker; S3-compatible storage; Docker.

## Modules
Identity & Access; Patient Registry; Caregiver Access; Care Plan; Task/Scheduler; WhatsApp Gateway; Message Intelligence; Document Intelligence; Longitudinal Clinical Store; Monitoring/Exception; Compliance Escalation; Emergency Escalation; Intervention; AI Copilot; Audit/Provenance.

## Monitoring flow
CarePlan -> Scheduler -> Task -> WhatsApp -> webhook -> Message -> AI extraction candidate -> schema validation/normalisation -> Observation -> deterministic rules -> Exception -> timeline/dashboard.

## Compliance flow
Task overdue -> patient reminder(s) -> L1 -> acknowledgement/resolution window -> L2 -> L3 -> resolved/exhausted. No proactive Doctor/PA notification.

## Emergency flow
Explicit emergency event/rule -> independent EmergencyEscalationPolicy -> L1 -> acknowledgement/action -> L2/L3 on timeout. Never convert an abnormal value to emergency without an explicit configured rule.

## Reliability
Provider message IDs and task dedupe keys are unique. Webhooks and workers are idempotent. State transitions are transactional with row/version locking. Re-running jobs must not duplicate messages, observations, exceptions or escalations.

## AI boundary
AI may parse text/voice, extract labs/prescriptions, summarize and retrieve. It may not directly change task/escalation state, independently declare emergencies, prescribe treatment or write unvalidated observations.

## Security
Organization-scoped RBAC: ADMIN, DOCTOR, PA_COORDINATOR, CAREGIVER, PATIENT. Every query is tenant/patient scoped. Caregivers only access explicitly linked patients. Patients only read the record bound to their account. Only tenant administrators bind/revoke patient identities; every binding change is audited. Production authentication and identity verification are required before live use.

## Audit/provenance
Append-only audit for patient/caregiver/care-plan changes, observation correction, task/escalation transitions, acknowledgements, emergency events, interventions and permissions. Every observation links to source message/document and extraction model/version.

## Environments
Local/CI synthetic data only; staging test WhatsApp + demo patients; production isolated secrets/DB/storage. Never use production patient data in coding prompts.

## Repository
care-platform/{AGENTS.md,docs/,backend/,frontend/,infra/,scripts/}. Backend folders: api, domain, services, adapters, workers, models, schemas, audit, migrations, tests.

## Deployment
One frontend + one backend + PostgreSQL + Redis/worker + object storage. Split services only after evidence demands it.
