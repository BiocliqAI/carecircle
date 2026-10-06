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

## Follow-up questions after a symptom
Reporting breathlessness, swelling, dizziness or palpitations starts two short questions with buttons (when, where, how much; for example "At rest / Walking or stairs / Lying flat"). Answers are saved as symptom details on the doctor's chart. Answers that match a rule that already exists raise that same alert: breathless at rest = the severe-breathlessness rule, lying flat = the orthopnoea rule, a fall or near-faint = the fainting red flag. A reading or any other message in the middle ends the questions and is handled normally. The same symptom is not asked about again for 12 hours.

## Recheck after an alert closes
When a caregiver closes an alert that came from a reading (BP, pulse, sugar, oxygen, weight, temperature) with any outcome except "hospital", CareCircle asks the patient for a recheck 2 hours later (weight: next morning), unless that reading is already due in the plan. A normal recheck tells the caregiver who closed it; one still outside the limit alerts the circle again without being held back; no recheck within 3 hours of the request tells the caregiver.

## Pattern watches
Slow drifts that stay under every limit are watched once each morning and after each reading: weight up on each of the last three days (at least 0.9 kg in total), average top BP number up 10 or more over the previous week while still under the limit, weight up 1 kg in two days together with swelling, breathlessness or a missed water tablet, and medicines confirmed on under 70% of doses after a good week. A watch is advisory: the patient and the first caregiver get a gentle "heads-up, not an alarm" message once, the doctor sees a "Pattern" line on Today and on the chart. The doctor can dismiss one (it will not reappear for 3 days) or turn a pattern off for a patient under Alerts & care circle.

## Documents read on arrival
A photo sent on WhatsApp (that is not a device display or part of a doctor-visit conversation) is read in the background (Gemini): what it is, its date, the prescriber, and any lab values. The assistant's "Document to file" task then shows what was read and offers **Confirm & file**, which files it with that title and category and enters the lab values (once; the same report twice does not duplicate them). Nothing enters the record before that confirmation. Entered lab values follow the usual rules, so a recent out-of-range result alerts the care circle. Without AI, the task is as before.

## Pre-visit brief
One to two days before a recorded visit date, the AI brief (or the rules-based summary when AI is off) is prepared in the background and stored. The chart's AI summary shows it with the time it was prepared (Refresh regenerates), the assistant's "Prepare visit" task says it is ready, and the Prepare visit page shows its overview and discussion points.

## Checks on another doctor's changes
Beside each pending change from another doctor, fixed rules show advisory warnings: the same type of medicine already in the plan, the same drug under another brand, an allergy that names the drug (or one of its type), potassium of 5.0 or more with an ACE inhibitor/ARB/ARNI or potassium-sparing diuretic, reduced kidney function with metformin, an anti-inflammatory painkiller or a potassium-sparing diuretic, an anti-inflammatory painkiller with a blood thinner or in heart failure/kidney disease, recent low BP before another BP-lowering medicine, a dose that more than doubles or halves, and stopping a blood thinner in atrial fibrillation (or an antiplatelet in heart disease). Nothing is blocked; the doctor or assistant decides.

## After a visit
In the plan builder's Send step the doctor sees an editable "In short" for the family, drafted from the reviewed plan only (AI, or a rules-based version in plain words), and a suggested next-visit date with its reason (later when stable with good adherence, sooner after several changes or alerts, otherwise the usual gap). The approved text goes to the patient with the plan and to the care circle with the update notice.

## Evening digest and weekly summary
The evening digest to the care circle now says what changed, in at most two plain lines from the record: weight up or down by half a kilo or more over the last days, the top BP number or the sugar well above or below this week's usual (with enough earlier readings to compare), or, when nothing needs a word, a streak of days with every medicine taken. On Sunday evening the care circle gets a short week in review (days fully on track, BP, weight and sugar averages against the week before, alerts and how many were closed, next visit) and the patient gets a friendlier version addressed to them.

## Language
Everything the assistant sends is translated into the recipient's own language just before delivery (Gemini), per person: a patient can read Tamil while a caregiver reads English. The language is learned from how they write: an Indian script switches it at once, romanised Hindi/Tamil/etc. read by the AI needs two messages in a row, and three longer English messages in a row switch back; "reply in Hindi" / "english please" sets it directly. Numbers, doses, units, names, medicine names, 108 and keyword words such as *ACK* and *YES* are kept exactly. Tapping a translated button is understood as the English word behind it, and Yes/No in Hindi, Tamil, Telugu, Kannada, Malayalam, Bengali, Gujarati and Punjabi is accepted for consent. If translation is unavailable or fails, the English message stands (the English is always kept alongside).

## Ask the record, and the timeline
On the Overview tab the doctor or assistant can ask a question about this patient in words ("when did creatinine start rising, and did it follow any diuretic change?"). The AI reads a compact summary of that patient's record only and returns a short answer, the facts it rests on, a note about gaps, and a plan for the chart; every plotted point is read from the database and medicine changes are drawn on it. It describes what the record shows and never advises treatment. Without AI, naming a reading gives its statistics and chart. The vitals and lab charts also carry medicine changes (including other doctors') as amber markers; several changes on one day are one marker with all of them in its tooltip.

## Visit to another doctor
A patient or caregiver says they saw another doctor ("We took Appa to the cardiologist, he reduced Lasix to .5 and added nifedipine 10 mg thrice a day"), taps "From another doctor's visit" under a document they sent, or answers the evening follow-up we send on a recorded next-visit date. The assistant opens a short conversation (Gemini, with a fixed-question fallback) and asks only for what is missing, at most two questions at a time: an ambiguous dose against the current plan first, then which doctor (offering care-team doctors of that specialty), then a photo of the prescription, then the next visit. A photo sent mid-conversation joins the visit and is read for the doctor, medicines, tests and review date. Readings, tablets and symptoms sent in the middle are still logged as usual; urgent messages skip the conversation. "Stop" saves what is known; an abandoned conversation is saved after 12 hours.
The visit (doctor added to the care team, documents, next appointment) is on the record for the doctor, PA, patient and caregivers at once, and the rest of the care circle gets a summary. Medicine changes stay REPORTED: reminders change only when the primary doctor or PA presses "Apply to plan", which amends the current plan, rebuilds future reminders and tells the patient and family. The evening before the next appointment the patient and the reporter are reminded; that evening the reporter is asked how it went ("no changes", changes, or postponed → new date).

## Caregiver compliance acknowledgement
Caregiver receives concise reason and can acknowledge responsibility. Acknowledgement starts configured resolution window; task completion resolves escalation.

## Emergency
Use only approved emergency templates and explicit configured trigger. Separate from compliance.

## Messaging engineering rules
Persist inbound webhook before processing; idempotent provider_message_id; template/version tracking; delivery status; retries with dedupe; never put PHI into infrastructure logs.
