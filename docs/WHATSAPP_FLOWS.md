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

## Visit to another doctor
A patient or caregiver says they saw another doctor ("We took Appa to the cardiologist, he reduced Lasix to .5 and added nifedipine 10 mg thrice a day"), taps "From another doctor's visit" under a document they sent, or answers the evening follow-up we send on a recorded next-visit date. The assistant opens a short conversation (Gemini, with a fixed-question fallback) and asks only for what is missing, at most two questions at a time: an ambiguous dose against the current plan first, then which doctor (offering care-team doctors of that specialty), then a photo of the prescription, then the next visit. A photo sent mid-conversation joins the visit and is read for the doctor, medicines, tests and review date. Readings, tablets and symptoms sent in the middle are still logged as usual; urgent messages skip the conversation. "Stop" saves what is known; an abandoned conversation is saved after 12 hours.
The visit (doctor added to the care team, documents, next appointment) is on the record for the doctor, PA, patient and caregivers at once, and the rest of the care circle gets a summary. Medicine changes stay REPORTED: reminders change only when the primary doctor or PA presses "Apply to plan", which amends the current plan, rebuilds future reminders and tells the patient and family. The evening before the next appointment the patient and the reporter are reminded; that evening the reporter is asked how it went ("no changes", changes, or postponed → new date).

## Caregiver compliance acknowledgement
Caregiver receives concise reason and can acknowledge responsibility. Acknowledgement starts configured resolution window; task completion resolves escalation.

## Emergency
Use only approved emergency templates and explicit configured trigger. Separate from compliance.

## Messaging engineering rules
Persist inbound webhook before processing; idempotent provider_message_id; template/version tracking; delivery status; retries with dedupe; never put PHI into infrastructure logs.
