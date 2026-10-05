# WHATSAPP_FLOWS.md
Patient/caregiver interaction is WhatsApp-first and conversational.

## Activation

Patients may also use an optional read-only dashboard to view their own details/history. Messaging, monitoring replies, uploads and acknowledgements remain on WhatsApp; the patient dashboard does not submit or edit data in M1.
Welcome + consent/acknowledgement flow according to approved policy; confirm monitoring channel.

## Scheduled monitoring
Ask only active care-plan items. Example: request weight + BP; allow natural reply such as "72.8 and 146/92". Store original message; AI creates extraction candidate; validate/normalize before Observation.

## Natural-language bundle
A single message may contain BP, weight, glucose, symptom change and medication adherence. Extract all with source links.

## Missing response
Patient reminder(s) according to policy. If still incomplete, start compliance L1/L2/L3. Do not endlessly message patient.

## Lab/prescription
Receive image/PDF -> store raw document -> extract candidate -> human verification -> longitudinal record.

## Caregiver compliance acknowledgement
Caregiver receives concise reason and can acknowledge responsibility. Acknowledgement starts configured resolution window; task completion resolves escalation.

## Emergency
Use only approved emergency templates and explicit configured trigger. Separate from compliance.

## Messaging engineering rules
Persist inbound webhook before processing; idempotent provider_message_id; template/version tracking; delivery status; retries with dedupe; never put PHI into infrastructure logs.
