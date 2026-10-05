# M1 test report and handover

Verified locally on 26 September 2026 with Docker Desktop, Python 3.12, PostgreSQL 16, Redis 7 and Node.js 22. All data used was synthetic.

## Patient dashboard amendment 26 September 2026

**Latest result: 80 automated tests passed, comprising 72 backend cases and 8 frontend cases.** The original 50 backend cases remain green. The 22 new backend cases cover own-record profile/history reads; unlinked and cross-tenant denial; all onboarding/diagnostic write denials; administrator-only binding; account role/tenant/status checks; third-party contact/history privacy; rebind/revoke/no-op/stale writes and audit; unique ownership and concurrent assignments; inactive identity/organization; connection restart; composite-FK enforcement; audit rollback; seed preservation of revocation; guarded downgrade; filtering private history before the event limit; and rejection of identity fields injected into profile writes. The frontend adds an explicit test that PATIENT/CAREGIVER/unknown roles never inherit staff controls.

Final Node 22 production build and TypeScript compilation, Prettier, Ruff lint/format, Python compilation and live `alembic check` passed. The same two non-failing dependency warnings described below remain. Hosted CI was not run.

Browser verification passed for:

- Demo Patient A and Demo Patient B each receive only their own My health dashboard, with profile, care-team names and My history.
- No patient registry, caregiver registry, profile edit, membership controls, caregiver contacts, account administration or caregiver permission events appear in the patient view.
- Demo Unlinked Patient sees No patient record linked.
- Demo Administrator linked Demo Unlinked Patient to the synthetic QA record; that account saw the QA profile/history, including the inactive historical profile. Removing the binding denied the next read, and the administrator timeline retained both events.
- Stack rebuild/bootstrap rerun preserved patient A/B ownership and QA revocation. Existing profiles, care-team membership and caregiver grants were preserved, including changes made after the original M1 handover.
- Refresh my details worked through an actual browser click. Patient layouts had no horizontal overflow at 390px and 768px; viewport override was reset.
- The Word PRD was updated and all 11 rendered pages visually checked.

Try it at <http://localhost:3000> by selecting **Demo Patient A · Patient** or **Demo Patient B · Patient**. To configure another synthetic record, use **Demo Administrator**, open its Patient 360, then use **Patient dashboard identity** and **Save patient access**. Production login/identity verification remains later work; messaging, monitoring replies, uploads and acknowledgements continue through WhatsApp.

Alembic `0003_patient_dashboard` adds the PATIENT role and optional unique, tenant-scoped identity binding. It was applied without deleting existing M1 data. A downgrade refuses to delete/change existing PATIENT accounts silently. QA's temporary patient account binding was removed after browser testing; demo A/B bindings remain. The original handover details below describe the earlier test state and are retained for traceability.

Evidence: [patient dashboard](test-evidence/m1-patient-dashboard.png). Responsive checks used browser DOM dimensions at 390px and 768px; the browser bridge's mobile screenshot capture did not preserve those dimensions reliably, so it is not included as visual evidence.

## Original M1 handover result

**57 automated tests passed: 50 backend PostgreSQL integration cases and 7 frontend request-adapter cases.** The final frontend production build, TypeScript check, Prettier check, backend Ruff lint/format and Python compilation passed. The live development database passed `alembic check` with no new upgrade operations detected.

The GitHub Actions workflow is configured for these checks. No hosted CI run was performed: this local workspace has no Git repository. Browser verification was performed through the Codex in-app browser using actual controls, mouse clicks and keyboard input; it is documented below separately from the automated suites.

## Automated cases

| Area | Cases covered | Result |
| --- | --- | --- |
| Authentication | Missing, malformed and unknown identity; disabled development auth; inactive user and organization; M0 role gate | Pass |
| Patient profiles | All onboarding fields; unknown birth date; invalid paired/future birth date, phone, timezone, status and treating doctor; PA onboarding | Pass |
| Registry | Tenant and assignment scoping, search, status filter, pagination | Pass |
| Team membership | Grant, revoke, repeated request, relink history, treating-doctor removal guard and reassignment | Pass |
| Caregiver access | Link alone denied; explicit grant; revoke; unlink; read-only restrictions; contact-only caregiver; inactive account/profile | Pass |
| Privacy | Cross-tenant reads/writes; direct database composite-FK rejection; other caregiver contacts/history hidden | Pass |
| Caregiver profiles | Duplicate phone/account; role and tenant validation; account rebind revokes grants; shared-contact edit requires every affected patient assignment | Pass |
| Audit | Actor and before/after data; no extra events on duplicate no-op; failed audit rolls back profile and membership | Pass |
| Concurrency and order | Simultaneous profile edits and caregiver grants; one winner; stale version conflicts; old grant cannot undo newer revocation | Pass |
| Persistence | New connection reads saved data; seed rerun preserves edits/revocations; real migration downgrade/upgrade round trip and schema comparison | Pass |
| M0 regression | Identity, role gate, audit; successful queue submission and queue unavailability | Pass |
| Frontend requests | Selected identity/JSON headers; 403; field/root validation messages; non-JSON response; network failure; write timeout; identity-switch cancellation | Pass |

State-machine resolution, reminders, escalation transitions and duplicate WhatsApp events are outside M1 and require tests with their later implementations.

## Browser cases

| Case | Observed result |
| --- | --- |
| Seeded doctor workspace | Demo Doctor initially saw Patient A and B with profile, care team and caregiver links. |
| Create patient | Created QA Onboarding Patient with birth month/year, phone, sex, timezone, address, physician, pharmacy and baseline notes; appeared in registry and timeline. |
| Required/invalid fields | Empty required field blocked submission. A birth month without year produced useful API validation and retained form values. |
| Duplicate patient | Existing phone rejected with readable conflict; form retained; no fourth patient created. |
| Edit patient | Saved baseline-note change and inactive status; profile and timeline updated. |
| Search/filter/selection | QA search and inactive filter found the patient; active filter excluded it and cleared the old detail. Reselecting the same patient loaded its detail. |
| Clinical team | Assigned QA patient to Demo PA Coordinator, who saw it; removed assignment and PA saw only Patient A. |
| Caregiver registry | Created QA Family Caregiver, bound the unused local caregiver account and edited relationship. |
| Link without access | Linked QA caregiver with permission off; its account saw no permitted patients. |
| Explicit access | Granted permission; caregiver saw only QA patient, its own caregiver contact/history and no profile/team/registry editing controls. |
| Revocation | Revoked dashboard permission; caregiver saw no permitted patients. |
| Membership history | Unlinked and relinked QA caregiver; both events remained on timeline, new link defaulted to permission off. |
| Unassigned doctor | Demo Second Doctor saw no assigned patients. |
| Independent caregiver | Demo Second Caregiver saw only Patient B, with no Patient A or edit controls. |
| Responsive layout | Checked 390px mobile form and caregiver view and 768px tablet caregiver view; no horizontal overflow. Temporary viewport override reset. |
| Keyboard | Tab navigation advanced from patient name to WhatsApp input. |
| Actual clicks | New/edit/save, team controls, caregiver link/access/unlink and identity switching worked through browser controls. |
| M0 diagnostics | Four readiness checks connected; displayed API port 8030; identity action worked; worker ping queued and processed in worker logs. |
| API outage | Stopped API; displayed configured address and unavailable state, with new-patient action disabled. |
| Startup outage recovery | Loaded page while API stopped; started API; Reload records retrieved identities and patients without a page reload. |
| Restart and seed safety | Rebuilt/restarted application containers and reran bootstrap; QA profile/notes/status and revoked caregiver/PA access remained; original demo access remained. |
| Final browser logs | No uncaught browser runtime errors observed in the final recovered view. Intentional validation/network failures were checked during negative cases. |

## Repairs found during verification

- Clearing registry filters now clears the previous patient selection.
- Selecting the same patient explicitly refreshes its details.
- Background diagnostic readiness polling preserves action results.
- API failure is distinguished from an empty registry; identity loading can be retried after an initial outage.
- Validation messages omit a blank root-field prefix.
- Shared caregiver edits cannot modify patients outside a clinician's assigned care team.

## Reproduce the checks

From the project root:

```sh
docker compose --profile test run --rm --build tests
docker compose --profile test run --rm tests ruff check app migrations tests tools
docker compose --profile test run --rm tests ruff format --check app migrations tests tools
docker compose --profile test run --rm tests python -m compileall -q app migrations tests tools
docker compose exec -T api alembic check
```

The runner creates and truncates only `remotecare_test`; both runner and fixtures reject database names without the `_test` suffix. Tests use real PostgreSQL and Alembic, not SQLite.

After `docker compose build frontend`, these isolated containers check the frontend without writing to the running development server's `.next` volume:

```sh
docker run --rm remotecare-m0-frontend npm test
docker run --rm remotecare-m0-frontend npm run typecheck
docker run --rm remotecare-m0-frontend npm run format:check
docker run --rm remotecare-m0-frontend npm run build
```

Two non-failing dependency warnings remain: Starlette warns about its httpx TestClient adapter; Node warns when it infers the module type for the TypeScript file used by the request tests. These did not cause failed or skipped tests.

## Your testing guide

Open <http://localhost:3000>. Host API is <http://localhost:8030/docs>; container port is 8000. API, frontend, database, Redis and worker were left running. Start them later with `docker compose up -d --build`.

1. As **Demo Doctor**, inspect Patient A, Patient B and QA Onboarding Patient. Try search and active/inactive filters.
2. Create a synthetic patient using a new international phone such as `+15550100903`; select the treating doctor. Edit the profile and check the onboarding timeline.
3. Add **Demo PA Coordinator**, switch identities and verify the patient appears. Remove the PA and verify it disappears on the next read.
4. Inspect **Caregiver registry**. QA Family Caregiver is bound to **Demo Unlinked Caregiver**, which currently has no dashboard permission.
5. Open **QA Onboarding Patient**, toggle dashboard access for QA Family Caregiver, then switch to **Demo Unlinked Caregiver**. Verify it can see QA and cannot edit. Switch back, revoke access and verify the patient disappears.
6. As **Demo Caregiver**, expect only Patient A; as **Demo Second Caregiver**, only Patient B; as **Demo Second Doctor**, no patients unless you assign one.
7. Refresh or restart the stack and verify saved profiles and current permissions remain. Inspect `/diagnostics` for service readiness.

QA Onboarding Patient is deliberately inactive, with its caregiver link active but dashboard permission disabled and PA assignment removed. It remains available as a historical record to its treating doctor. Three patients and three caregiver contacts remain in the development database; automated fixtures are in the separate test database.

## Scope and artifacts

M1 is local onboarding/access scaffolding using synthetic development identities, now including an optional read-only patient dashboard for own details/history. Production login, care plans, WhatsApp UI/integration, readings, reminders, escalations and AI are later milestones. Empty Patient 360 clinical panels reflect that scope.

Alembic `0002_m1_onboarding` was applied, preserving M0 records. Standard Compose configuration now consistently uses host API port 8030 and frontend port 3000. The stable `remotecare-m0` project name preserves existing volumes.

- [Clinician workspace](test-evidence/m1-workspace.png)
- [Permitted caregiver view during access testing](test-evidence/m1-caregiver.png)
- [Mobile onboarding form](test-evidence/m1-mobile.png)
- [M1 scope and authorization decisions](M1.md)
