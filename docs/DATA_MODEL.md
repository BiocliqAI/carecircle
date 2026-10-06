# DATA_MODEL.md — Care Platform V1
Use UUIDs, PostgreSQL, UTC timezone-aware timestamps, versioned clinical configuration and preserved provenance.

## Entities
Organization(id,name,timezone,status)
User(id,organization_id,name,role,status)
Patient(id,organization_id,name,birth_month,birth_year,sex,whatsapp_number,address,treating_doctor_id,family_physician,preferred_pharmacy,status,timezone,dashboard_user_id)
PatientCareTeam(patient_id,user_id,relationship_role,active_from,active_to)
Caregiver(id,organization_id,name,relationship,whatsapp_number,status)
PatientCaregiver(patient_id,caregiver_id,can_view_dashboard,active_from,active_to)

ComplianceEscalationPolicy(id,patient_id,version,active,patient_reminder_rules_json,resolution_window_minutes,effective_from)
ComplianceEscalationLevel(policy_id,level,caregiver_id,notify_after_minutes,acknowledgement_timeout_minutes,resolution_timeout_minutes)
EmergencyEscalationPolicy(id,patient_id,version,active,policy_name,effective_from)
EmergencyEscalationLevel(policy_id,level,caregiver_id,acknowledgement_timeout_minutes,instructions)

CarePlan(id,patient_id,version,status,effective_from,effective_to,created_by,approved_by)
MonitoringParameter(id,care_plan_id,code,display_name,data_type,canonical_unit,collection_method,frequency_spec_json,reminder_spec_json,verification_required)
ClinicalRule(id,care_plan_id,monitoring_parameter_id,rule_type,rule_definition_json,severity,active,version)

Task(id,patient_id,care_plan_id,monitoring_parameter_id,task_type,scheduled_for,due_at,status,completion_observation_id,dedupe_key)
Task status: PENDING, COMPLETED, OVERDUE, ESCALATING, RESOLVED, CANCELLED.

Message(id,patient_id,caregiver_id,direction,channel,provider_message_id,sender,recipient,message_type,text,media_document_id,received_or_sent_at,delivery_status,raw_payload_ref)
Document(id,patient_id,source_message_id,document_type,object_uri,mime_type,checksum,extraction_status)
ExtractionRun(id,source_id,provider,model,model_version,schema_version,status,raw_structured_output_json,confidence_json,timestamps)

Observation(id,patient_id,monitoring_parameter_id,observation_code,value_numeric,value_text,unit,observed_at,received_at,source_type,source_message_id,source_document_id,extraction_run_id,verification_status,verified_by,verified_at)
Exception(id,patient_id,exception_type,rule_id,severity,status,title,explanation,created_at,closed_at)
ExceptionEvidence(exception_id,observation_id,task_id,message_id,document_id)

ComplianceEscalation(id,patient_id,task_id,policy_id,current_level,state,started_at,acknowledged_at,resolved_at,resolution_reason)
States: NOT_STARTED, PATIENT_REMINDER, OVERDUE, L1_NOTIFIED, L1_ACKNOWLEDGED, L2_NOTIFIED, L2_ACKNOWLEDGED, L3_NOTIFIED, L3_ACKNOWLEDGED, RESOLVED, EXHAUSTED.

EmergencyEvent(id,patient_id,triggering_rule_id,source_message_id,source_observation_id,reason,state,created_at,resolved_at)
EmergencyEscalation(id,emergency_event_id,policy_id,current_level,state,started_at,acknowledged_at,resolved_at)
EscalationEvent(id,escalation_type,escalation_id,event_type,level,actor_type,actor_id,occurred_at,metadata_json)
Acknowledgement(id,escalation_type,escalation_id,caregiver_id,level,acknowledged_at,response_code,note)
Intervention(id,patient_id,exception_id,actor_user_id,intervention_type,note,follow_up_at,created_at)
AuditEvent(id,organization_id,actor_type,actor_id,action,entity_type,entity_id,correlation_id,before_json,after_json,occurred_at)

## Constraints/indexes
Unique provider_message_id and Task.dedupe_key; one active care plan per patient in V1; unique (policy_id,level); provenance cannot be silently removed; escalation updates require optimistic version/row lock.
Index tasks by patient/status/due_at; observations by patient/code/time; exceptions by patient/status/time; messages by patient/time; escalation by state/level; audit by entity/time.

Do not hard-code retention periods before legal/regulatory review.

## M1 implementation details

- Patient additionally stores clinician-entered `diagnoses`/baseline notes, `version`, `created_at`, and `updated_at`. No AI or clinical observation is created from these notes.
- Optional `dashboard_user_id` uniquely binds one same-organization PATIENT account to one patient record, with a composite tenant foreign key. Only administrators can bind/rebind/revoke it, using the patient version and transactional audit. Patient profile payloads cannot change this identity binding. Inactive accounts/organizations cannot access it; inactive patient records remain readable as history.
- PATIENT accounts read only their own profile, care-team names and patient-facing onboarding history; caregiver contacts, caregiver permission history, account-binding events and raw audit JSON are omitted. Production authentication/identity verification is deferred; the M1 selector is synthetic development scaffolding.
- Caregiver additionally stores optional `user_id`, `version`, and `created_at`. `user_id` binds a contact to one active CAREGIVER account in the same organization. A contact can exist without a dashboard account; account binding alone grants no patient access.
- PatientCareTeam and PatientCaregiver have surrogate UUID `id` and `organization_id` fields. Composite foreign keys prevent cross-organization links; partial unique indexes permit only one active link per patient/member pair. Ending a link sets `active_to`; relinking creates a new history row.
- Patient WhatsApp numbers and caregiver WhatsApp numbers are unique within their respective organization-scoped registries.
- Patient profile, team, and caregiver-link writes serialize on the patient row and require `expected_version`. A stale or out-of-order write returns 409. Repeating an already-applied link state with the current version is a no-op.
- Dashboard access requires an active caregiver account, active caregiver profile, active patient link, and `can_view_dashboard=true`. Changing the bound account revokes existing dashboard grants and audits the change; a new grant must be explicit.
- Mutation audit records and entity changes commit together. The onboarding timeline exposes summaries, not raw before/after audit JSON; a caregiver sees only their own caregiver events and permitted patient profile events.
- The treating doctor is automatically linked to the care team. Reassigning the treating doctor links the new doctor; the old doctor remains a team member until explicitly removed. The current treating doctor cannot be unlinked.
- OutsideVisit(id, patient_id, visit_at, doctor_name, specialty, hospital, care_team_id, reason, advice, tests, next_visit_at, next_visit_note, status COLLECTING|COMPLETE, source whatsapp|web, reported_by, reviewed_by, reviewed_at, followup_of) records a visit to a doctor other than the treating doctor. Its medicine changes are `med_changes` rows with `outside_visit_id` and the proposed `med_key`, `new_dose` ("40 mg / 20 mg" = per scheduled time) and `new_times`; documents carry `outside_visit_id`. Applying a change sets `applied_at` and amends the latest visit's plan in place (audited as PLAN_AMENDED), so the visit count does not change. The treating doctor and PA remain the only ones who change the plan.
