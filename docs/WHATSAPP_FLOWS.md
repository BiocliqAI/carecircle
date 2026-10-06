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

## Trusting the reading
- **Impossible values** ("weight 592", "BP 1400/80", sugar "6.5" in mmol/L) are not logged. CareCircle says why and offers the likely fix ("Did you mean 59.2 kg?"); Yes logs it as if typed. A real-looking weight far from the last one is still logged, with a gentle "was that a typo?" note, because it may be real fluid gain.
- **Corrections.** "Sorry, that was 128, not 182" or "typo, BP should be 128/82" replaces the latest matching reading from the last 36 hours (the old value stays in the audit trail), re-runs the alert rules, closes an alert the typo caused and tells the care circle. A polite "sorry" alone never rewrites a reading.
- **Recheck before alerting.** A borderline high BP or pulse (within 20 / 10 of the limit) is not alerted at once: the sender is asked to rest 10 minutes and measure again. If the recheck is still high the care circle is alerted, noting both readings; if it is normal nothing is sent; if no recheck arrives within 30 minutes the care circle is alerted anyway. Emergency rules and readings further above the limit alert immediately.
- **Photos of devices.** A photo of a BP monitor, glucometer, scale, oximeter or thermometer is read (Gemini) and the sender is asked to confirm ("I read this as BP 138/86, pulse 72. Is that right?"). Yes logs it exactly as if typed, so every check above still applies. Such photos are filed automatically and do not reach the assistant's queue. Without AI, the reply asks the sender to type the numbers.

## Visit to another doctor
A patient or caregiver says they saw another doctor ("We took Appa to the cardiologist, he reduced Lasix to .5 and added nifedipine 10 mg thrice a day"), taps "From another doctor's visit" under a document they sent, or answers the evening follow-up we send on a recorded next-visit date. The assistant opens a short conversation (Gemini, with a fixed-question fallback) and asks only for what is missing, at most two questions at a time: an ambiguous dose against the current plan first, then which doctor (offering care-team doctors of that specialty), then a photo of the prescription, then the next visit. A photo sent mid-conversation joins the visit and is read for the doctor, medicines, tests and review date. Readings, tablets and symptoms sent in the middle are still logged as usual; urgent messages skip the conversation. "Stop" saves what is known; an abandoned conversation is saved after 12 hours.
The visit (doctor added to the care team, documents, next appointment) is on the record for the doctor, PA, patient and caregivers at once, and the rest of the care circle gets a summary. Medicine changes stay REPORTED: reminders change only when the primary doctor or PA presses "Apply to plan", which amends the current plan, rebuilds future reminders and tells the patient and family. The evening before the next appointment the patient and the reporter are reminded; that evening the reporter is asked how it went ("no changes", changes, or postponed → new date).

## Caregiver compliance acknowledgement
Caregiver receives concise reason and can acknowledge responsibility. Acknowledgement starts configured resolution window; task completion resolves escalation.

## Emergency
Use only approved emergency templates and explicit configured trigger. Separate from compliance.

## Messaging engineering rules
Persist inbound webhook before processing; idempotent provider_message_id; template/version tracking; delivery status; retries with dedupe; never put PHI into infrastructure logs.
