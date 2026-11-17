# CareCircle end-to-end test plan

End-to-end tests for the CareCircle web app (`web/`). They exercise the real UI and API together, with WhatsApp driven through the **WhatsApp simulator** (`/whatsapp`) instead of Twilio.

Each test has an ID, a priority, the steps and what must be true afterwards.

- **P0**: patient safety, privacy or data integrity. Must pass before any release.
- **P1**: core workflows that doctors, assistants and families use every day.
- **P2**: secondary features, edge cases, polish.

---

## 1. Test environment

### 1.1 Modes

| Mode | Start | Data | Use for |
| --- | --- | --- | --- |
| Demo | `npm run dev` (port 3000) | `data/carecircle.db`, seeded clinic (Dr. Meera Rao, PA Priya Nair, Ramesh, Sunita, Abdul, plus A Gopal under Dr. Dileep) | Most workflow tests: patients already have plans, history, alerts |
| Live | `npm run clinic` (port 3100) | `data/clinic.db`, starts empty except the admin | Clinic setup, staff, onboarding, a first visit, from nothing |

Run each suite against a **fresh database** (set `CARECIRCLE_DB` to a temp file, or use *Reset* in the demo panel / *Clinic settings → Reset clinic* in live mode).

### 1.2 AI on and AI off

Many features have an AI path (Gemini / Claude) and a rules fallback. Run the suites marked **[AI±]** twice:

- **AI off:** no `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`. The simulator header shows "AI parser: off (rules)".
- **AI on:** a key set under *Settings*. Use a test key and synthetic data only.

AI output varies, so AI-on assertions should check structure (a reading was logged, a question was asked, a draft exists) rather than exact wording.

### 1.3 The WhatsApp simulator

- `/whatsapp` shows the patient, the Level 1 caregiver and (with **📱📱📱 3 Screens**) the Level 2 caregiver side by side.
- Each phone can send text, tap quick-reply buttons, attach a photo/PDF (`/api/whatsapp/media`), record or type a voice note, and press SOS (`/api/whatsapp/sos`).
- API equivalents for automation: `GET /api/whatsapp` (contacts), `GET /api/whatsapp?userId=…` (thread), `POST /api/whatsapp {userId, body}` (send text).

### 1.4 Moving time

Many rules depend on time (reminders, escalation timers, digests). Use the simulator's clock buttons, or `POST /api/demo`:

- `{"action":"advance","minutes":N}` moves the clock forward N minutes and runs the scheduler (buttons: +15 min, +1 h, +6 h).
- `{"action":"simulate","days":N}` generates N days of realistic replies for every patient, then moves the clock.
- `{"action":"reset"}` reseeds the demo (not allowed in live mode).

After a fast-forward, restarting the server returns the clock to the real date and pulls future-dated entries back to now (see §20).

Timers used by the tests below (from `web/lib/engine.ts` and related files; the care plan can override escalation timers):

| Rule | Value |
| --- | --- |
| Escalation timer per level | Urgent 15 min · Deviation 60 min · Compliance 120 min |
| Patient reminder for an unanswered task | 1 h after due |
| Task marked missed | 3 h after due (physio 6 h, lab 3 days) |
| Compliance alert | Medicines missed; a reading missed 2 days running; physio missed 3 times in a row |
| Consent reminders | After 1 day, then 3 days later; at most 2 |
| Borderline BP/pulse recheck | Asked to rest 10 min; alert anyway if no recheck within 30 min |
| Recheck after an alert is closed | 2 h later (weight: next morning); caregiver told if none within 3 h |
| Symptom follow-up questions | Not asked again for the same symptom within 12 h |
| Reading correction window | Latest matching reading from the last 36 h |
| Evening digest / weekly summary | 20:30 daily / Sunday from 19:00 |
| Pattern watches / kidney fluid check | Each morning from 09:30 / from 06:00 |
| Outside-visit conversation abandoned | Saved after 12 h |
| Pre-visit brief | Prepared 1 to 2 days before the next visit |

### 1.5 Conventions

- "Patient phone", "L1 phone", "L2 phone" mean the simulator phones.
- "Today" means the doctor's or assistant's Today page (`/doctor`).
- Unless stated, demo-mode tests use **Ramesh Kumar** (`p_ramesh`, heart failure, hypertension, diabetes; L1 Lakshmi, L2 Arjun, L3 Kavya) under **Dr. Meera Rao**.
- Every test that changes data should also check the audit trail and the patient timeline where relevant.

---

## 2. Sign-in, roles and access control

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| AUTH-01 | P0 | Persona picker lists all users | Open `/` signed out | Personas grouped Admin, Doctor, PA, Patient, Caregiver; picking one sets the `cc_user` cookie and lands on that role's home |
| AUTH-02 | P0 | Sign out | Sign in, then sign out | Cookie cleared; protected pages redirect to `/`; API calls return 401/403 |
| AUTH-03 | P0 | Unknown user id | `POST /api/session {userId:"nope"}` | 404, no cookie set |
| AUTH-04 | P0 | Doctor sees only own patients | Sign in as Dr. Rao, open `/patients`; then as Dr. Dileep | Rao: Ramesh, Sunita, Abdul (no Gopal). Dileep: only A Gopal |
| AUTH-05 | P0 | Doctor cannot open another doctor's patient | As Dr. Rao, open `/patients/p_gopal` and call `GET /api/patients/p_gopal` | Page shows no access; API 403 |
| AUTH-06 | P0 | PA sees every clinic patient | Sign in as Priya Nair | All patients listed; can open each chart |
| AUTH-07 | P0 | Patient sees only their own record | Sign in as Ramesh; try `/patients/p_sunita` and `GET /api/patients/p_sunita` | Own home only; other patient 403 |
| AUTH-08 | P0 | Caregiver with dashboard access | Sign in as Lakshmi | Sees Ramesh's family home only |
| AUTH-09 | P0 | Caregiver without dashboard access | Turn off Lakshmi's dashboard access in the care circle; sign in as Lakshmi | No patient visible; API reads for `p_ramesh` return 403 |
| AUTH-10 | P0 | Non-clinicians blocked from clinician APIs | As a patient and a caregiver, call `GET /api/dashboard`, `GET /api/pa-today`, `POST /api/patients/p_ramesh/visits` | 403 for each |
| AUTH-11 | P0 | Patient and caregiver cannot write clinical data | As Ramesh/Lakshmi, call care-plan, labs, notes, med-change, documents and clear endpoints with POST/PUT/DELETE | 403; nothing changes in the database |
| AUTH-12 | P1 | Admin navigation | Sign in as admin (live mode) | Only "Clinic & staff"; no patient data visible |
| AUTH-13 | P1 | Role-specific navigation | Sign in as each role | Doctor: Today, Patients, Assistants. PA: Today, Patients. Patient/caregiver: family home only |
| AUTH-14 | P1 | Direct URL to a page not allowed for the role | As a caregiver, open `/doctor`, `/admin`, `/settings`, `/team` | Redirected or "no access", never data |

## 3. Clinic setup and staff (live mode)

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| CLIN-01 | P0 | First run on an empty database | Start live mode on a fresh DB | Only the admin persona exists; Getting Started checklist shown |
| CLIN-02 | P0 | Set up the clinic | As admin, enter clinic name, address, phone and the first doctor | Clinic saved; doctor appears as a persona; checklist step done; audit entry |
| CLIN-03 | P1 | Add a PA and a second doctor | Clinic & staff → add staff | Both appear in the staff list and persona picker |
| CLIN-04 | P1 | Edit staff | Change a doctor's title, phone, registration number | Saved and shown everywhere the name appears |
| CLIN-05 | P1 | Remove staff | Remove the PA | PA can no longer sign in; history keeps their name |
| CLIN-06 | P0 | Cannot remove a doctor who still has patients | Try removing the treating doctor | Blocked with a clear message |
| CLIN-07 | P1 | Validation | Save staff with no name, a bad phone, a duplicate phone | Each rejected with a readable message; form keeps values |
| CLIN-08 | P1 | Edit clinic details | Change the clinic name | New name shown in the header and in outgoing WhatsApp messages |
| CLIN-09 | P0 | Reset clinic | Clinic settings → Reset clinic, confirm | All data erased except kept settings (AI keys); back to first-run state |
| CLIN-10 | P1 | Reset blocked in demo API for live | `POST /api/demo {action:"reset"}` in live mode | 400 "Use Clinic settings → Reset clinic" |
| CLIN-11 | P2 | AI settings | Settings → save, change, clear Gemini and Anthropic keys | Status updates; simulator shows the model; key never echoed back in full |

## 4. Patient onboarding and care circle

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| ONB-01 | P0 | Add a new patient | As doctor or PA, `/patients/new`: name, age, sex, WhatsApp number, conditions, address, treating doctor, caregivers L1–L3 | Patient created; caregivers saved with levels; appears in Patients |
| ONB-02 | P0 | Consent requests sent on WhatsApp | After ONB-01, open the simulator | Patient and each caregiver receive a consent message with YES / NO buttons |
| ONB-03 | P0 | Duplicate WhatsApp number | Add a patient with an existing number | Rejected; no second patient |
| ONB-04 | P1 | Required fields and validation | Missing name, bad phone, no doctor, future date of birth | Each blocked with a message; values kept |
| ONB-05 | P1 | Draft saved and resumed | Start onboarding, leave at step 2; reopen from Today | Draft listed as "Finish onboarding"; resumes at the same step with data |
| ONB-06 | P1 | Draft deleted | Delete the draft | Gone from Today and drafts |
| ONB-07 | P1 | PA onboards for a doctor | As PA, choose Dr. Rao as treating doctor | Patient is Dr. Rao's; visible to Rao, not to other doctors |
| ONB-08 | P1 | Edit patient profile | Change address, conditions, phone | Saved; audit entry; new phone used for WhatsApp |
| ONB-09 | P0 | Change care circle order | Swap L1 and L2 | Next alert goes to the new L1 |
| ONB-10 | P1 | Add a caregiver later | Add a new L3 | New caregiver gets a consent request |
| ONB-11 | P1 | Remove a caregiver | Remove L3 | No further alerts to them; open alerts move on correctly |
| ONB-12 | P1 | Resend consent | Patient page → resend consent to one person, then to all pending | Only the chosen people receive it again |
| ONB-13 | P0 | Delete patient | Delete a test patient, confirm | Patient, messages, readings and documents removed; other patients untouched; audit entry |
| ONB-14 | P1 | Clear selected records | Clear only readings and WhatsApp for one patient | Only those kinds cleared; profile, circle, consents, care team kept; other patients untouched |

## 5. Baseline and past records

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| BASE-01 | P1 | Enter baseline by hand | `/patients/{id}/baseline`: date of birth, allergies, current medicines, past labs | Saved; "Baseline missing" task disappears from Today |
| BASE-02 | P1 | Baseline validation | Future date of birth, lab with no value, future lab date | Blocked with messages |
| BASE-03 | P1 [AI±] | Baseline from a document | Upload a discharge summary | AI on: fields pre-filled with warnings to check. AI off: clear message to type them |
| BASE-04 | P1 [AI±] | Onboarding from past records: upload | Start "Onboarding from records", upload prescriptions and lab reports | Each file read; sorted into Clinical / Lab piles; progress shown |
| BASE-05 | P1 | Move and remove a record | Move a file to the other pile; remove one | Pile updated; a person's choice survives an AI re-read |
| BASE-06 | P2 | Unreadable file | Upload a corrupt or blank image | Read error shown; Retry available |
| BASE-07 | P1 | Typed record | Add a typed lab record with date and values | Appears in the draft like an uploaded one |
| BASE-08 | P0 [AI±] | Build history draft | Build the draft | Draft history created (conditions, medicines, labs); open items listed |
| BASE-09 | P1 | Edit draft and send to doctor | Edit a section; send to doctor | Doctor sees it on Today; status SENT |
| BASE-10 | P1 | Doctor sends it back | Doctor sends back with a note | Assistant sees the note; status back to collecting |
| BASE-11 | P0 | Doctor confirms history | Doctor confirms | Labs entered once (no duplicates); history versions shown; status CONFIRMED |
| BASE-12 | P1 | Update a confirmed history | Start an update, add a record, confirm | New version; removed items shown as removed; earlier version kept |

## 6. Visits and care plans

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| VIS-01 | P0 | Record Visit 1 and start the plan | Doctor: record visit (vitals, diagnosis, notes, medicines, monitoring, thresholds, physio, lifestyle, fluid limit, labs, next visit) → Save and send plan | Visit saved; plan active; patient receives the plan on WhatsApp; care circle receives an update; reminders begin |
| VIS-02 | P0 | Plan message content | Read the patient's WhatsApp | Lists each medicine with dose and times, readings to send, fluid limit, physio, lifestyle, next visit, "In short" text |
| VIS-03 | P0 | Save visit without starting plan | Untick "start plan" | Visit saved; no reminders; old schedule stops until the clinic starts it |
| VIS-04 | P1 | Start care plan later | Press "Start care plan" | Reminders begin from now; days since the visit stay empty |
| VIS-05 | P1 | Past visit from records | Pick an earlier visit date | Saved as a past visit at that date; no WhatsApp sent; future dates rejected |
| VIS-06 | P1 | Visit 2 changes the plan | Record a visit that stops one medicine and changes a dose | New reminders follow the new plan; old future reminders replaced; patient told what changed |
| VIS-07 | P1 | Plan builder draft is kept | Fill the plan builder, leave, return | Draft restored |
| VIS-08 | P1 [AI±] | Dictate a visit | Use dictation / upload audio | AI on: fields drafted for review. AI off: message that dictation needs AI |
| VIS-09 | P1 [AI±] | "In short" for the family | Send step | Editable summary drafted from the reviewed plan only; edited text is what goes out |
| VIS-10 | P2 | Suggested next visit | Send step for a stable patient vs one with many alerts | Later date when stable with good adherence; sooner after changes or alerts; reason shown |
| VIS-11 | P1 | Compare visits | `/patients/{id}/compare` between Visit 1 and today | Shows changes in medicines, vitals and what was logged on WhatsApp in between |
| VIS-12 | P1 | Prepare visit | Open "Prepare visit" from Today | Shows pre-visit brief, readings since last visit, open items |
| VIS-13 | P1 | Next visit date picker | Change next visit date | Saved; shown on chart and in the family's view |

## 7. WhatsApp: consent

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| WA-CON-01 | P0 | Patient says YES | Patient phone: tap YES | "Consent recorded"; consent GIVEN; audit CONSENT_GIVEN |
| WA-CON-02 | P0 | Patient says NO | Patient phone: NO | "Nothing will be shared"; consent DECLINED |
| WA-CON-03 | P1 | Patient changes mind | After NO, send YES | Consent GIVEN |
| WA-CON-04 | P0 | Caregiver says YES | L1 phone: YES | "You're now in the care circle"; caregiver receives alerts from now |
| WA-CON-05 | P0 | Caregiver says NO | L2 phone: NO | No alerts to L2; "Caregiver declined" task on Today |
| WA-CON-06 | P1 | Consent in Indian languages | Reply "ஆம்", "हाँ", "ಹೌದು", "haan" | Each accepted as YES; "இல்லை", "नहीं", "nahi" as NO |
| WA-CON-07 | P0 | YES while an alert is waiting | Caregiver with pending consent and a live alert sent to them sends YES | Treated as ACK of the alert, not consent |
| WA-CON-08 | P1 | Caregiver in two circles | Same caregiver pending for two patients; reply YES | Answers the circle most recently asked about |
| WA-CON-09 | P1 | Automatic consent reminders | Leave consent pending; advance 1 day, then 3 more days, then 5 more | One reminder after 1 day, a second 3 days later, no third |
| WA-CON-10 | P1 | Consent task on Today | Leave consent pending | "Consent pending · N days" task for the assistant |
| WA-CON-11 | P0 | Declined caregiver gets no alerts | Trigger an alert for the patient | Declined caregiver gets nothing; next consented level gets it |
| WA-CON-12 | P1 | Digest only to consented caregivers | Advance to 20:30 | Only caregivers with consent GIVEN get the digest |

## 8. WhatsApp: readings and daily logging

| ID | Pri | Test | Steps (patient phone unless stated) | Expected |
| --- | --- | --- | --- | --- |
| WA-LOG-01 | P0 | Single reading | "BP 132/84" | Observation logged; friendly reply; chart shows it |
| WA-LOG-02 | P0 | Several readings in one message [AI±] | "72.8 and 146/92, sugar 140, pulse 78" | Weight, BP, sugar and pulse each logged and linked to the message |
| WA-LOG-03 | P1 | Natural language | "Appa weight 60.5 kg, drank 1200 ml fluid today" from a caregiver | Logged for the patient, attributed to the caregiver |
| WA-LOG-04 | P0 | Medicines taken | Tap "Took all tablets ✅" after a prompt | Due medicine tasks DONE |
| WA-LOG-05 | P0 | Medicines missed | "Missed my tablets ❌" | Tasks NOT_DONE; counts toward compliance |
| WA-LOG-06 | P1 | One medicine missed | "took all except metformin" | Only that medicine NOT_DONE |
| WA-LOG-07 | P1 | Physio | "exercises done" / "skipped exercises today" | Physio task DONE / NOT_DONE |
| WA-LOG-08 | P1 | Evening check-in | "no symptoms, followed salt diet" | Check-in task DONE; lifestyle noted |
| WA-LOG-09 | P1 | Fluid intake running total | "2 glasses water", then "tea 150 ml" | Running total vs daily limit returned each time |
| WA-LOG-10 | P1 | Fluid and urine day totals | "intake 1400 ml, urine 1100 ml today" | Fluid task DONE; kidney chart updated |
| WA-LOG-11 | P1 | Lab value by text | "creatinine 1.8, potassium 4.9" | Labs entered with source WhatsApp; rules run (see §10) |
| WA-LOG-12 | P1 | Ambiguous number | "72" | "Which one is it?" with buttons (weight / pulse / …); the chosen one is logged |
| WA-LOG-13 | P1 | Cancel the clarification | Reply "none" to the buttons | "No problem, send it again…" ; nothing logged |
| WA-LOG-14 | P0 | Impossible value | "weight 592" | Not logged; "Did you mean 59.2 kg?"; Yes logs 59.2 |
| WA-LOG-15 | P0 | Impossible BP | "BP 1400/80" | Not logged; explanation and likely fix |
| WA-LOG-16 | P1 | Sugar in mmol/L | "sugar 6.5" | Not logged as 6.5 mg/dL; asks to confirm |
| WA-LOG-17 | P1 | Large but plausible jump | Weight 3 kg above yesterday | Logged, with a gentle "was that a typo?" |
| WA-LOG-18 | P0 | Correction | "BP 182/90", then "sorry that was 128 not 182" | Latest BP replaced with 128/90; old value in audit; any alert it caused closed as CORRECTED; circle told |
| WA-LOG-19 | P1 | "Sorry" alone | "sorry" | No reading changed |
| WA-LOG-20 | P1 | Correction outside window | Correct a reading older than 36 h | Not changed; reply explains |
| WA-LOG-21 | P1 | Reading before Visit 1 | New patient with no plan sends "BP 150/95" | Recorded; no doctor limits yet; emergency rules still apply |
| WA-LOG-22 | P1 | Caregiver logs for the patient | L1 phone: "Ramesh: BP 140/88" | Logged for Ramesh with logged_by = caregiver; patient is told of any alert |
| WA-LOG-23 | P1 | Unknown sender | Message from a number not in the clinic | "This number isn't linked to a patient yet"; nothing stored against a patient |
| WA-LOG-24 | P2 | Message length limit | Send 2,000 characters | Stored up to 1,000 characters; no error |
| WA-LOG-25 | P1 | Rules parser with AI off | Repeat WA-LOG-01 to 08 with AI off | Same results via rules |

## 9. WhatsApp: reminders and compliance alerts

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| WA-REM-01 | P0 | Prompt at due time | Advance to a plan time (e.g. 08:00) | Patient gets one message listing everything due then, with quick buttons |
| WA-REM-02 | P0 | Reminder after 1 h | Do not reply; advance 1 h | "Gentle reminder" listing the open items |
| WA-REM-03 | P0 | Marked missed after 3 h | Advance 3 h more | Tasks MISSED; audit TASK_MISSED |
| WA-REM-04 | P0 | Medicines missed → compliance alert | Continue from WA-REM-03 | Compliance alert to L1: "Medicines not logged" with times; ACK buttons |
| WA-REM-05 | P0 | No doctor or PA notified | During WA-REM-04 | No message to doctor/PA (compliance never notifies them) |
| WA-REM-06 | P1 | Reading missed 2 days running | Skip weight two mornings | Compliance alert "Weight not logged 2 days running"; not after one day |
| WA-REM-07 | P1 | Physio missed 3 times | Skip physio three times in a row | One compliance alert; not repeated within 3 days |
| WA-REM-08 | P0 | Late completion resolves the alert | With a compliance alert open, patient sends "took all tablets" | Alert RESOLVED with outcome "Patient completed the task" |
| WA-REM-09 | P1 | One compliance alert at a time | Miss more items while one is open | Items added to the open alert (ADDED event), no second alert |
| WA-REM-10 | P1 | Lab task | Plan with labs every N days | Lab reminder on the right day; missed only after 3 days |
| WA-REM-11 | P1 | Paused plan | Save a new visit without starting the plan | No prompts or reminders until started |
| WA-REM-12 | P2 | Old prompts not sent | Advance the clock 6 h in one step | No prompts for tasks more than 2 h old; they are marked as usual |

## 10. Alert rules (deviation and urgent)

For each rule: send the reading on the patient phone, confirm the alert type, its title, who is notified and the advice text. Then send a normal value and confirm no alert.

| ID | Pri | Rule | Trigger | Expected |
| --- | --- | --- | --- | --- |
| RULE-01 | P0 | BP crisis | "BP 185/112" | URGENT "Very high blood pressure" to L1 immediately; patient told to rest and recheck, emergency if symptoms |
| RULE-02 | P0 | BP above limit (well above) | Systolic 25 above the plan limit | DEVIATION "BP above doctor's limit" immediately |
| RULE-03 | P0 | Borderline BP → recheck | Systolic within 20 of the limit, above it | No alert yet; sender asked to rest 10 min and measure again |
| RULE-04 | P0 | Recheck still high | After RULE-03, send another high BP | Circle alerted, mentioning both readings |
| RULE-05 | P0 | Recheck normal | After RULE-03, send a normal BP | No alert |
| RULE-06 | P0 | No recheck | After RULE-03, advance 30 min | Circle alerted anyway |
| RULE-07 | P1 | Low BP | Below the plan's low limit | DEVIATION "Low blood pressure" |
| RULE-08 | P0 | Rapid weight gain | Weight up past the plan's gain limit since yesterday / over 3 days | DEVIATION "Rapid weight gain" with reasons |
| RULE-09 | P1 | Weight above dry-weight band | Plan with dry weight ± band; weight above | "Weight above target — possible fluid build-up" |
| RULE-10 | P1 | Weight below band | Weight below the band | "Weight below target — possible dehydration" |
| RULE-11 | P0 | Very low sugar | "sugar 50" | URGENT "Very low blood sugar"; patient told to take 15 g sugar |
| RULE-12 | P1 | Low / high sugar | Below / above plan limits | DEVIATION low / high |
| RULE-13 | P1 | Pulse outside limits | Pulse above or below the range | DEVIATION "Pulse outside limits"; borderline pulse (within 10) gets a recheck first |
| RULE-14 | P0 | Very low oxygen | "SpO2 86" | URGENT "Very low oxygen" |
| RULE-15 | P1 | Oxygen below limit | SpO₂ between 88 and the plan's limit | DEVIATION |
| RULE-16 | P1 | Fever | "temp 101" | DEVIATION "Fever" |
| RULE-17 | P1 | High pain score | "pain 8/10" with limit 7 | DEVIATION "High pain score" |
| RULE-18 | P0 | Red-flag symptoms | "chest pain", "fainted", "can't breathe" | URGENT symptom alert; "call 108" advice; patient reply includes emergency advice |
| RULE-19 | P0 | Severe breathlessness | "very breathless even sitting" | URGENT "Severe breathlessness" |
| RULE-20 | P1 | Watched symptom | A symptom the doctor listed (e.g. swelling) | DEVIATION "<symptom> reported" |
| RULE-21 | P0 | Very high potassium | "potassium 6.2" | URGENT "Very high potassium" |
| RULE-22 | P1 | Potassium high / low, sodium out of range | Values outside plan limits | DEVIATION each |
| RULE-23 | P1 | Creatinine rising | Creatinine up versus the last value / baseline | DEVIATION "Creatinine rising" with reasons |
| RULE-24 | P1 | Low haemoglobin | Below plan limit | DEVIATION "Haemoglobin low" |
| RULE-25 | P1 | Kidney fluid check | Intake over limit 2 days running; low output/intake ratio 2 days running | Alert the next morning after 06:00, once per day |
| RULE-26 | P0 | Same rule while open | Send a second crisis BP while the first alert is open | No second alert; REPEAT event on the open one |
| RULE-27 | P0 | Emergency rules before Visit 1 | Patient with no plan sends "BP 190/115" and "chest pain" | URGENT alerts still raised |
| RULE-28 | P0 | Abnormal ≠ emergency | A value above the doctor's limit but below the emergency rule | DEVIATION, never URGENT |
| RULE-29 | P0 | AI cannot raise an emergency | AI on; send ambiguous worrying text without a red-flag keyword | No URGENT alert unless a defined rule matches |

## 11. Escalation chain (caregiver levels)

Use 3 Screens in the simulator. Start each test by triggering a DEVIATION (e.g. RULE-02).

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| ESC-01 | P0 | L1 notified | Trigger the alert | L1 gets the alert with patient phone, advice, "I'll handle it" and "Pass to <L2>" buttons; event NOTIFIED |
| ESC-02 | P0 | L1 acknowledges | L1: "ACK" (also "ok", "on it", "I'll handle it", 👍) | State ACKNOWLEDGED; L1 asked for the outcome (1–4); patient told L1 is following up |
| ESC-03 | P0 | Outcome recorded | L1: "2" | Alert RESOLVED "Contacted doctor / clinic"; L1 thanked; patient told it's closed |
| ESC-04 | P1 | Outcome with a note | L1: "4", then a note | Note saved on the alert |
| ESC-05 | P0 | Timeout moves to L2 | Don't reply; advance 60 min (deviation) | L2 notified with "L1 hasn't responded in 60 min"; event TIMEOUT; audit LEVEL_UP |
| ESC-06 | P0 | Urgent timer | URGENT alert; advance 15 min | Moves to L2 after 15 min, not 60 |
| ESC-07 | P0 | Compliance timer | Compliance alert; advance 120 min | Moves to L2 after 120 min |
| ESC-08 | P0 | L1 passes it on | L1 taps "Pass to Arjun" | L2 notified immediately with "L1 couldn't take this"; L1 told it moved |
| ESC-09 | P0 | Exhausted | Nobody replies through L3 | State EXHAUSTED; every caregiver and the patient told nobody acknowledged |
| ESC-10 | P0 | Others told when one acknowledges | Alert reached L2; L2 acks | L1 told "Arjun has taken ownership" |
| ESC-11 | P0 | Only circle members can ACK | Another patient's caregiver sends ACK | Not accepted; alert unchanged |
| ESC-12 | P0 | Ack after close | ACK on a resolved alert | "Already acknowledged or closed" |
| ESC-13 | P1 | Acknowledge from the dashboard | Caregiver web home → acknowledge, then close with an outcome | Same states and messages as on WhatsApp, event says "via dashboard" |
| ESC-14 | P1 | Acknowledged alert does not time out | Ack, then advance past the timer | Stays ACKNOWLEDGED; no L2 message |
| ESC-15 | P1 | Plan overrides timers | Visit with custom escalation minutes | Timeouts follow the plan values |
| ESC-16 | P0 | Caregiver without WhatsApp user / declined | L2 declined consent | Escalation skips to the next eligible level |
| ESC-17 | P0 | Alert timeline | Open the alert in the chart | CREATED, NOTIFIED, TIMEOUT, ACKNOWLEDGED, RESOLVED events with times and people |

## 12. SOS

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| SOS-01 | P0 | Patient presses SOS | Patient phone → SOS | URGENT "Emergency: help requested" to L1; patient told "Help is on the way" and to call 108 |
| SOS-02 | P0 | Caregiver presses SOS | L2 phone → SOS | Alert for that caregiver's patient, naming who pressed it |
| SOS-03 | P0 | SOS escalates | No ack; advance 15 min | Moves to L2 |
| SOS-04 | P1 | Second SOS while open | Press again | REPEAT event, no duplicate alert |
| SOS-05 | P1 | Unlinked number | SOS from an unlinked user via API | 400 "isn't linked to a patient" |
| SOS-06 | P0 | Typed "help" / "emergency" | Patient types "help" or "emergency" with no other words | Should be treated as urgent. Today only the SOS button and red-flag symptoms ("chest pain", "fainted", "can't breathe") raise an alert; the words only stop an outside-visit conversation from starting. See §24 |

## 13. Follow-up loops after a reading

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| LOOP-01 | P1 | Symptom follow-up questions | "feeling breathless" | Two short questions with buttons (when / how much); answers saved as symptom details |
| LOOP-02 | P0 | Answer matches a rule | Answer "At rest" | Severe-breathlessness URGENT alert |
| LOOP-03 | P1 | Lying flat / fainting answers | Answer "Lying flat" / a fall or near-faint | Orthopnoea alert / fainting red flag |
| LOOP-04 | P1 | Reading interrupts the questions | During the questions send "BP 130/80" | Questions end; BP handled normally |
| LOOP-05 | P2 | Not asked again within 12 h | Report the same symptom again within 12 h | No questions |
| LOOP-06 | P1 | Recheck after an alert closes | L1 closes a BP alert with "1" | Patient asked to recheck 2 h later (weight: next morning) |
| LOOP-07 | P1 | Recheck normal | Patient sends normal BP | Caregiver who closed it told it's back within limits |
| LOOP-08 | P0 | Recheck still out of range | Patient sends high BP | Circle alerted again without the borderline hold |
| LOOP-09 | P1 | No recheck | Advance 3 h past the request | Caregiver told no recheck came in |
| LOOP-10 | P1 | No recheck after hospital | Close with "3" (hospital) | No recheck requested |
| LOOP-11 | P2 | Recheck already in the plan | Reading due within the window | No extra request |

## 14. Pattern watches

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| WATCH-01 | P1 | Weight creep | Weight up each of 3 days, ≥0.9 kg total, under every limit | Next morning after 09:30: "heads-up, not an alarm" to patient and L1, once; "Pattern" line on Today and chart |
| WATCH-02 | P1 | BP drift | Weekly average systolic up ≥10 and under the limit | Pattern raised |
| WATCH-03 | P1 | Fluid build-up | Weight up 1 kg in 2 days plus swelling / breathlessness / missed water tablet | Pattern raised |
| WATCH-04 | P1 | Adherence slip | Medicines confirmed on <70% of doses after a good week | Pattern raised |
| WATCH-05 | P1 | Dismiss | Doctor dismisses a watch | Gone; does not reappear for 3 days |
| WATCH-06 | P1 | Turn a pattern off | Alerts & care circle → turn off weight creep | No new weight-creep watches; open one closed |
| WATCH-07 | P2 | Not repeated | Same pattern next morning | No second message |

## 15. Documents and photos on WhatsApp

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| DOC-01 | P0 [AI±] | Device photo | Patient attaches a BP monitor photo | AI on: "I read this as BP 138/86, pulse 72. Is that right?"; Yes logs it like typed text (rules apply). AI off: asked to type numbers |
| DOC-02 | P1 | Device photo rejected | Answer No to DOC-01 | Nothing logged; asked to type |
| DOC-03 | P0 [AI±] | Prescription / lab photo | Send a lab report photo | Stored; read in background; "Document read, confirm to file" task on Today |
| DOC-04 | P0 | Nothing filed before confirmation | Before confirming DOC-03 | No lab values in the record |
| DOC-05 | P0 | Confirm & file | Assistant presses Confirm & file | Filed with title/category; lab values entered once; out-of-range recent result alerts the circle |
| DOC-06 | P1 | Same report twice | Send the same report again and confirm | No duplicate lab values |
| DOC-07 | P1 | PDF | Send a PDF | Accepted and handled like a photo |
| DOC-08 | P1 | Clinic upload | Chart → Documents → upload, edit title/category, verify, download | Each action saved; audit entries |
| DOC-09 | P0 | Delete document with its data | Delete a filed report "with its values" | Report and the lab values read from it removed; other labs kept |
| DOC-10 | P2 | Unsupported file | Send a .exe or huge file | Rejected with a message |
| DOC-11 | P1 [AI±] | Voice note | Record (or type, without a mic) a voice note "BP 135/85, took tablets" | AI on: transcribed and handled as text. AI off: typed text handled |
| DOC-12 | P2 | Simulated reader output never shown as real | AI call fails | Document stays "to file" without fake values |

## 16. Visits to other doctors

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| OUT-01 | P0 [AI±] | Reported on WhatsApp | Patient: "We took Appa to the cardiologist, he reduced Lasix to half and added nifedipine 10 mg thrice a day" | Conversation starts; asks only what's missing, at most two questions at a time |
| OUT-02 | P1 | Ambiguous dose asked first | Change that doesn't match the plan clearly | First question clarifies the dose |
| OUT-03 | P1 | Doctor choice | Specialty matches a care-team doctor | That doctor offered as a button |
| OUT-04 | P1 | Photo during the conversation | Send the prescription photo | Joins the visit; read for doctor, medicines, tests, review date |
| OUT-05 | P0 | Readings during the conversation | Send "BP 140/90" mid-conversation | Logged as usual; conversation continues |
| OUT-06 | P0 | Urgent message skips it | Send "chest pain" mid-conversation | Urgent alert raised immediately |
| OUT-07 | P1 | Stop | Patient: "stop" | Saved with what is known |
| OUT-08 | P1 | Abandoned | Leave mid-conversation; advance 12 h | Saved automatically |
| OUT-09 | P0 | Visit on the record | After OUT-01 | Visible to doctor, PA, patient and caregivers; doctor added to the care team; rest of circle gets a summary |
| OUT-10 | P0 | Changes not applied automatically | After OUT-01 | Reminders unchanged; changes REPORTED; "Other doctor's changes to review" task |
| OUT-11 | P0 | Safety checks shown | Pending change with a known clash (e.g. allergy, duplicate class, potassium ≥5 with an ACE inhibitor, NSAID in kidney disease, dose more than doubled, stopping a blood thinner in AF) | Advisory warning beside each; nothing blocked |
| OUT-12 | P0 | Apply to plan | Doctor/PA presses Apply to plan | Plan amended; future reminders rebuilt; patient and family told |
| OUT-13 | P1 | Reject / mark reviewed | Reject one change; mark the visit reviewed | Change REJECTED; task cleared |
| OUT-14 | P1 | Next appointment reminders | Visit with a next appointment date | Evening before: patient and reporter reminded; that evening reporter asked how it went |
| OUT-15 | P1 | "How did it go" answers | Reply "no changes" / "postponed to 25 Dec" / changes | No changes: closed. Postponed: date moved, no visit recorded. Changes: new conversation |
| OUT-16 | P1 | Entered on the web | Patient/caregiver web → add outside visit (or describe it in words for a draft) | Same outcome as WhatsApp |
| OUT-17 | P1 | Tap "From another doctor's visit" under a document | Send a document, tap the button | Conversation starts with that document attached |
| OUT-18 | P1 | Postponed date in the past year | Postpone with a date that has already passed this year (e.g. "25 Oct" in November) | Read as next year; the test must use a relative future date |
| OUT-19 | P2 | Delete an outside visit | Delete it | Removed with its documents' links; audit entry |

## 17. Digests, summaries and language

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| DIG-01 | P1 | Evening digest | Advance to 20:30 | Each consented caregiver gets one digest: medicines taken / due, missed items, readings, open alerts, next visit, at most two "what changed" lines |
| DIG-02 | P1 | Digest sent once | Advance further the same evening | No second digest |
| DIG-03 | P2 | Medicine streak line | Every medicine taken several days running, nothing else to say | Streak line shown |
| DIG-04 | P1 | Weekly summary | Advance to Sunday 19:00 | Circle gets week in review; patient gets a friendlier version |
| DIG-05 | P1 | No digest before the plan starts | Patient without a plan | No digest |
| LANG-01 | P1 [AI on] | Indian script switches language | Patient writes in Tamil script | Next replies in Tamil; numbers, medicine names, 108, ACK/YES unchanged |
| LANG-02 | P1 [AI on] | Romanised language needs two messages | Two Hinglish messages in a row | Switches to Hindi after the second |
| LANG-03 | P1 | Switch back | Three longer English messages | Back to English |
| LANG-04 | P1 | Ask directly | "reply in Hindi", then "english please" | Switches each time with a confirmation |
| LANG-05 | P1 | Per-person language | Patient in Tamil, caregiver in English | Each receives their own language |
| LANG-06 | P1 | Translated button | Tap a translated quick reply | Understood as the English word |
| LANG-07 | P1 [AI off] | No AI | "reply in Tamil" | "Sorry, I can't reply in Tamil right now…"; English kept |

## 18. Doctor and assistant workspace

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| WS-01 | P0 | Doctor Today | Sign in as Dr. Rao | Patients needing review first; open alerts with families; closed today count; patterns; reviewed today |
| WS-02 | P1 | Mark reviewed | Mark a patient reviewed | Moves to "Reviewed today"; review recorded |
| WS-03 | P0 | PA Today tasks | Sign in as Priya | To do / Onboarding / Visits / Done today tabs; tasks for consent, declined caregiver, baseline missing, prepare visit, documents to file, medicine changes, care circle not responding |
| WS-04 | P1 | Task clears when done | Complete each task kind | Task leaves "To do" and appears in "Done today" |
| WS-05 | P0 | Patient chart | Open a chart | Summary, vitals and lab charts with limits, medicine-change markers, alerts with timelines, WhatsApp log, documents, notes, visits |
| WS-06 | P1 | Patient table | `/patients` | Search, sort, status badges correct |
| WS-07 | P1 | Notes | Add, edit, delete a clinical note | Saved with author and time |
| WS-08 | P1 | Care team | Add/edit consulting doctors | Saved; primary doctor cannot be removed |
| WS-09 | P1 [AI±] | AI summary / pre-visit brief | Open AI summary; Refresh | Shows when it was prepared; refresh regenerates; AI off gives rules summary |
| WS-10 | P1 [AI±] | Ask the record | "when did creatinine start rising?" | Short answer, facts, gaps note, chart from database values; never advises treatment. AI off: naming a reading shows its stats and chart |
| WS-11 | P1 | Med change review | Confirm / reject a reported change | Status updated; reviewer recorded |
| WS-12 | P1 | Kidney view | Patient with a fluid plan | Fluid today vs limit badge; intake/output chart |
| WS-13 | P2 | Assistants page | Doctor opens `/team` | Lists assistants |
| WS-14 | P1 | Dashboard API isolation | `GET /api/dashboard` as each doctor and PA | Same patient sets as AUTH-04/06 |

## 19. Family and patient web views

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| FAM-01 | P1 | Family home | Sign in as Lakshmi | "<Patient> today": plan for today with done/missed, latest readings, open alerts, next visit |
| FAM-02 | P1 | Nothing scheduled | Patient with no plan today | "Nothing scheduled today." |
| FAM-03 | P0 | Read-only for patient | Sign in as Ramesh | Own history and plan only; no clinical edit controls |
| FAM-04 | P1 | Caregiver closes an alert from the web | See ESC-13 | Same result as WhatsApp |
| FAM-05 | P1 | Outside visit from the web | See OUT-16 | Saved and visible to the clinic |
| FAM-06 | P2 | Mobile layout | 390 px and 768 px widths | No horizontal scroll; buttons reachable |

## 20. Clock, scheduler and data integrity

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| TIME-01 | P0 | Scheduler catches up | Advance 6 h | Scheduler runs in 15-min steps; prompts, reminders and timeouts at their correct times |
| TIME-02 | P0 | No duplicates on re-run | Call advance 0 / reload pages repeatedly | No duplicate tasks, messages, alerts or digests |
| TIME-03 | P1 | Simulate 7 days | Simulator → Simulate 7 days | Realistic replies for every patient; charts fill; alerts raised and escalated plausibly |
| TIME-04 | P0 | Back to real date on restart | Advance 3 days, restart the server | Clock shows real time; no logged entry after now; next visits unchanged |
| TIME-05 | P1 | Clock indicator | After advancing | "⏩ Demo clock" shown in the side bar and demo panel |
| TIME-06 | P1 | Demo reset | Reset | Fresh seeded data; AI keys kept |
| TIME-07 | P0 | Restart persistence | Restart the server | All data kept; scheduler resumes without re-sending |
| TIME-08 | P1 | Timezone | Check times shown and reminder times | All in clinic time (IST) |

## 21. Real WhatsApp gateway (Twilio)

Run against a Twilio test account with synthetic numbers only.

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| TW-01 | P0 | Webhook signature | POST to `/api/twilio/inbound` with a bad signature | Rejected (403); nothing stored |
| TW-02 | P0 | Valid inbound message | Signed inbound from a patient number | Stored before processing; handled like the simulator |
| TW-03 | P0 | Idempotent inbound | Same MessageSid twice | Processed once |
| TW-04 | P1 | Inbound media | Signed inbound with a photo | Downloaded (size limit), handled like DOC-01/03 |
| TW-05 | P1 | Delivery status | Status callbacks queued → delivered → failed | Message status updated; failure shown to the clinic |
| TW-06 | P1 | Templates outside 24 h | Alert to someone who hasn't written in 24 h | Sent with the approved template and variables |
| TW-07 | P1 | Buttons | Message with quick replies | Sent as WhatsApp buttons |
| TW-08 | P1 | Long message split | Plan message over the WhatsApp limit | Split into ordered parts |
| TW-09 | P0 | Stranger | Unknown number writes | Polite reply; logged for the clinic; no patient data revealed |
| TW-10 | P0 | No health data in logs | Check server logs after the tests | No message bodies or readings logged |

## 22. Security and robustness

| ID | Pri | Test | Steps | Expected |
| --- | --- | --- | --- | --- |
| SEC-01 | P0 | Changing ids in URLs | For every `/api/patients/[id]/*` route, call with another doctor's patient id | 403 everywhere |
| SEC-02 | P0 | Document download access | `GET /api/documents/{id}` for a document of another patient | 403 |
| SEC-03 | P0 | Escalation actions access | `POST /api/escalations/{id}` by a user outside the circle | 403 / rejected |
| SEC-04 | P1 | Script injection | Patient name, note and WhatsApp text containing `<script>` | Shown as text everywhere |
| SEC-05 | P1 | SQL-like input | Search and messages containing `' OR 1=1 --` | Treated as text |
| SEC-06 | P1 | Malformed JSON / missing fields | Send bad bodies to each POST route | 400 with a message, no crash |
| SEC-07 | P1 | Health check | `GET /api/health` | 200 |
| SEC-08 | P2 | Large uploads | Upload above the size limit | Rejected with a message |
| SEC-09 | P1 | AI failure | AI key invalid or AI times out | Rules fallback used; no fake values; user sees a sensible message |
| SEC-10 | P0 | Audit trail | Review audit after the suites | Every consent, alert transition, plan change, correction, document filing and permission change has an entry with actor and time |

## 23. Suggested automation

- **Tooling:** Playwright for UI tests (pre-installed in cloud sessions), plain `fetch` for API tests, with `node:test` like the existing `web/tests/*.test.mts`.
- **Isolation:** start the app per suite with `CARECIRCLE_DB` pointing to a temp file, wait for `/api/health`, then reset.
- **Fixed dates:** never hard-code calendar dates in assertions. Compute them from the app clock (`GET /api/demo` returns `now`). This is why the existing `outside.test.mts` "postponed follow-up" test fails after 25 Oct.
- **HTTP tests:** the existing `api.test.mts` HTTP cases need a running server; start one in the test setup instead of assuming `localhost:3000`.
- **Order to build:** P0 WhatsApp and escalation suites (§7–§12) first, then access control (§2, §22), then onboarding and visits (§4–§6), then the rest.

## 24. Gaps found while writing this plan

These tests are expected to fail against the current code (checked 17 Nov 2026):

- **WA-CON-11 / ESC-16: a caregiver who declined consent still receives alerts.** When a caregiver replies NO, they are told "You won't receive care-circle alerts", but the escalation chain (`notifyLevel` in `web/lib/engine.ts`) does not check consent. Confirmed by script: with Lakshmi's consent set to DECLINED, "BP 190/115" from Ramesh sent her the urgent alert. The digest and weekly summary do check consent.
- **SOS-06: typing "help" or "emergency" does not raise an alert.** Only the SOS button and red-flag symptom words do.
