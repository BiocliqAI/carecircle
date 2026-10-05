# CareCircle — Product Requirements Document V2

**Between-visit care, run on WhatsApp, reviewed visit to visit.**

`Visit → Care plan → WhatsApp logging → Deviation / compliance rules → Care-circle escalation → Family contacts the doctor (if needed) → Next visit: brief + diff → Updated care plan`

V2 supersedes *Care_Platform_PRD_V1_Final.docx*. It keeps V1's safety principles and adds the **visit-to-visit loop**, **deviation escalation to the care circle**, **caregiver logging**, **physio and lifestyle compliance**, and a **demo-first MVP scope**. The gap analysis is in [`PRD_REVIEW.md`](PRD_REVIEW.md).

---

## 1. Problem

The doctor examines the patient, diagnoses, and prescribes medicines, readings to take at home, physiotherapy and lifestyle changes. Once the patient goes home, the patient or a family caregiver is expected to:

- follow the plan (medicines, exercises, diet),
- take and record readings (BP, weight, sugar, SpO₂, pain…),
- watch for symptoms, and
- **seek medical attention in time** if something goes wrong.

Today this happens on paper, in memory, or not at all. At the next visit the doctor or PA has to reconstruct the interval from scattered notes: what was taken, what was missed, how the vitals moved, what changed in the medicines. That is slow and inaccurate. Deterioration is often noticed late, because nobody in the family was clearly responsible for acting on it.

## 2. Goals and non-goals

**Goals**

1. Make logging effortless for patients and caregivers: **WhatsApp only**, in their own words, with no new app.
2. Detect **deviations from the doctor's baseline** and **non-compliance**, and escalate them **within the patient's care circle** (patient → L1 → L2 → L3) with clear advice to contact the doctor or seek care.
3. Give the doctor and PA a **lucid between-visit picture in under a minute**: a pre-visit brief and a visit-to-visit diff.
4. Give caregivers and patients the same longitudinal view, read-only.

**Non-goals (explicit)**

- The platform **does not alert doctors or PAs**. They are not expected to intervene proactively. Responsibility for escalating to clinical care stays with the patient and the care circle.
- No diagnosis or treatment recommendations by software or AI.
- No consumer mobile app.

## 3. Principles (carried from V1, with amendments)

1. **WhatsApp is the only patient/caregiver input channel.** The web dashboard is for viewing (plus caregiver acknowledgement as a convenience).
2. **The visit is the anchor.** Each consultation snapshots the care plan. Everything between two visits is summarised against that snapshot.
3. **Manage by exception, owned by the family.** Missed tasks and readings outside the doctor's limits go to the care circle, never to the clinic.
4. **Rules decide, AI assists.** AI (Gemini `gemini-3.8-flash`) parses free text and drafts summaries. Deterministic rules create alerts and move escalation state. A rule-based parser is always available as a fallback.
5. **Provenance.** Every reading, task completion and alert links back to the WhatsApp message (and the person) it came from.
6. **"Not logged" ≠ "reported not done".** Both are recorded distinctly.
7. **Compliance, deviation and urgent are separate escalation types.** They have separate timers and wording and are never merged.
8. **Ease of use beats completeness.** One message can carry everything ("BP 142/92, weight 72.8, took tablets, ankles swollen").

## 4. Users and roles

| Role | Channel | Can do |
|---|---|---|
| **Doctor** | Web | Onboard patients, record visits (clinic vitals, diagnosis, care plan, alert limits, next visit), view Command Centre, Patient 360, pre-visit brief and visit comparison. Receives no alerts. |
| **Physician Assistant** | Web | Same as the doctor, including preparing visits (entering clinic vitals and drafting the plan for the doctor). |
| **Patient** | WhatsApp + read-only web | Logs readings, medicines, exercises and symptoms; gets reminders; is told when the care circle is following up. Views own dashboard. |
| **Caregiver (L1–L3)** | WhatsApp + web | Logs *on behalf of* the patient; receives escalations in ladder order; acknowledges ("ACK"); records the outcome; views the patient's dashboard. |

A patient has 1–3 caregivers, ordered as the escalation ladder. Access is scoped: patients and caregivers see only their own patient. Clinicians see only their own patients.

## 5. Core objects

### 5.1 Visit (new, first-class)

Created by the doctor or PA at each consultation.

| Field | Notes |
|---|---|
| visit_at | Timestamp of the consultation |
| clinic vitals | BP, weight, pulse, fasting sugar, SpO₂, pain score as measured in clinic. These are the **baseline** for the interval. |
| diagnosis, notes | Free text |
| **care plan snapshot** | The full plan (§5.2) as prescribed at this visit. Immutable once saved. |
| next_visit_at | Shown to the family. It closes the interval for the next brief. |

Saving a visit **activates** its plan:
- future reminders are regenerated;
- the patient gets a WhatsApp summary of the new plan;
- caregivers are told the plan changed.

The latest visit's plan is the active plan.

### 5.2 Care plan (part of the visit)

| Section | Contents | Logged as |
|---|---|---|
| Medicines | name, dose, times, instructions | "took tablets" / "missed evening dose" |
| Home monitoring | BP, weight, sugar, pulse, SpO₂, temperature, pain. Times and days per week. | numbers in free text |
| Physio / exercise | name, detail (e.g. "30 min brisk walk"), times | "walked 30 min" / "skipped, knee pain" |
| Lifestyle | advice items (salt, fluids, diet, smoking…) | evening check-in ("diet ok") |
| Daily check-in | time for the symptoms and lifestyle question | "no symptoms" / "feeling dizzy" |
| Watch symptoms | symptoms that should trigger a deviation alert (e.g. breathlessness, edema) | free text |
| Alert limits | BP high/low, weight gain in 3 days, sugar high/low, pulse high/low, SpO₂ low, pain high. Defaults: 150/95, <100, +2 kg, 70–250, 50–110, <92 %, ≥7. | — |
| Escalation timers | minutes before moving to the next level, per type. Defaults: compliance 120, deviation 60, urgent 15. | — |

### 5.3 Other entities

Patient, User (doctor / PA / patient / caregiver), Caregiver (level, relation), Task (per scheduled item: PENDING, DONE, NOT_DONE, MISSED, plus a *late* flag), Message (IN/OUT, raw text, parser used), Observation (type, values, flag, severity, **source message**, **logged by**), Escalation (type, level, state, outcome), EscalationEvent, Audit log.

## 6. WhatsApp logging

### 6.1 Prompts and reminders

- At each due time the patient gets one combined prompt (e.g. 8:00 am: medicines + BP + weight), with quick-reply buttons.
- If there is no reply after **1 h**, the **patient** gets a gentle reminder.
- If there is still nothing after **3 h** (physio: 6 h), the task is marked **MISSED**, and the compliance rules (§7.1) decide whether the care circle is involved.
- The evening check-in asks about symptoms and lifestyle.

### 6.2 Free-text understanding

Patients and caregivers type naturally, in any order, in English or Indian-English shorthand. The parser extracts:
- vitals (with units and sanity ranges);
- medicine taken or missed (all, or a specific time slot);
- physio done or skipped (with reason);
- lifestyle adherence;
- symptoms, with **severity** (mild/moderate/severe), **negation** ("no breathlessness") and **improving** markers.

Every extraction is echoed back ("✅ Logged: BP 138/86 · Weight 72.4 kg · Morning tablets ✔") so the sender can correct mistakes. Gemini is used when configured; otherwise the deterministic parser is used. The parser used is stored per message.

### 6.3 Caregiver logging on behalf of the patient (new)

Any care-circle member can send readings for the patient from their own WhatsApp ("Appa's BP 150/96, took tablets"). The observation records **who logged it**. The dashboard shows the patient/caregiver logging split. If a caregiver-logged reading triggers an alert, the patient is also informed.

### 6.4 Conversational escalation handling

Caregivers reply **ACK** to take ownership, then choose an outcome with **1–4**:

1. Spoke with patient — resolved at home
2. Contacted doctor / clinic
3. Taken to hospital / emergency
4. Other

Codes 2–4 then prompt for a short note ("What did the doctor advise?"). The same actions are available on the dashboard.

## 7. Rules and escalation (care circle only)

All rules are deterministic and configured by the doctor in the visit's plan.

### 7.1 Compliance (task not done / not logged)

| Rule | Default |
|---|---|
| Any scheduled medicine dose missed | escalate |
| A monitoring reading not logged for 2 consecutive scheduled days | escalate |
| Physio missed or skipped 3 times in a row | escalate |

The patient is reminded first. Then L1 is alerted, then L2, then L3 according to `complianceMin`. **Auto-resolve**: if the patient logs the task late, the alert closes and notified caregivers get "no action needed".

### 7.2 Deviation from baseline (new: goes to the care circle)

| Rule | Example message to L1 |
|---|---|
| BP above limit, or systolic below the low limit | "Ramesh's BP 162/98 is above Dr. Rao's limit (150/95)…" |
| Weight gain ≥ X kg over 3 days | "+2.3 kg in 3 days: possible fluid retention…" |
| Sugar above or below limits; pulse, SpO₂, temperature, pain out of range | — |
| A *watch* symptom reported | "Ankle swelling reported, a symptom the doctor asked to watch for." |

Message format:
- the reading;
- the doctor's limit;
- the doctor's preset advice;
- **"If it persists or {patient} feels unwell, please contact {doctor}'s clinic or seek medical attention."**

Ladder: L1 → L2 → L3 according to `deviationMin`. The patient is told the family is following up. One open alert is kept per rule, so repeated readings do not duplicate it.

### 7.3 Urgent (red flags)

Red flags:
- chest pain;
- fainting;
- severe breathlessness;
- BP ≥ 180/110;
- sugar < 54;
- SpO₂ < 88 %;
- the patient typing "help" or "emergency".

Response:
- The patient gets immediate advice to call 108 / go to emergency.
- L1 gets a 🚨 message.
- The alert moves up every `urgentMin` (15 min).

Red flags are an explicit, documented policy, not AI inference.

### 7.4 Kidney failure & advanced monitoring (customisation)

For complex chronic conditions such as Chronic Kidney Disease (CKD / ESRD) or heart failure, CareCircle extends standard tracking with dry-weight bands, fluid/urine balance, scheduled labs and multi-doctor reconciliation:

1. **Dry-weight monitoring**:
   - Primary nephrologist sets target "dry weight" (e.g., 59.2 kg) and allowed ± band (e.g., 1.0 kg).
   - Deviations fire on: overnight day-on-day gain ≥ `weightDayGainKg` (1.0 kg), 3-day gain ≥ `weightGainKg` (2.0 kg), weight exceeding the dry band (fluid overload), or weight dropping below the dry band (hypovolemia/dehydration risk).
2. **Fluid restriction and urine output tracking**:
   - Daily fluid intake limit (e.g., 1000 ml/day covering all liquids: water, tea, soup, milk).
   - WhatsApp parser extracts fluid amounts (`drank 200 ml tea`, `water 950 ml total`) and urine output (`urine 850 ml`).
   - Automated evening prompt at `checkTime` (21:00) collects day totals if not yet reported.
   - Deviations fire if urine output is under `lowOutputMl` (500 ml/day) or if the urine/intake ratio drops below `ratioLow` (60%) across 2 consecutive days.
3. **Lab tracking and reminders**:
   - Scheduled recurring lab tasks (e.g. `RFT + electrolytes + uric acid` every 28 days) with overdue tracking.
   - Lab reports accepted via WhatsApp free text (e.g. `creat 2.1 urea 68 K 4.9`) or entered on the web dashboard by clinic PAs/doctors.
   - Deterministic safety evaluations: Potassium ≥ 6.0 mmol/L is treated as **URGENT**; Potassium high/low, Sodium high/low, Creatinine absolute rise (≥ 0.3 mg/dL) or percentage rise (≥ 25% vs pre-visit baseline), and severe anaemia (Hb < 8 g/dL) alert the care circle to seek medical attention.
4. **Richer medication schedules**:
   - Split doses (e.g., Lasix 40 mg morning, 20 mg evening with separate doses per time).
   - Alternate-day dosing, weekly courses (e.g., D-Rise 60k once a week for 4 weeks), finite courses (N days), and PRN ("only if required").
   - Explicit prescriber attribution and clinical purpose stored per medicine.
5. **Reconciliation of medicine changes from other doctors**:
   - CKD patients frequently see multiple specialists (cardiology, diabetology, nephrology).
   - Changes reported over WhatsApp or entered on the dashboard are **logged and attributed with provenance, never auto-applied**.
   - WhatsApp auto-reply confirms the note and advises continuing the prescribed plan until the primary clinic confirms.
   - The primary doctor reviews reported changes during the next visit with one-click reconciliation (Confirm, Seen, Reject).


### 7.5 Escalation state machine

`NOTIFIED(L1) → [timeout] NOTIFIED(L2) → [timeout] NOTIFIED(L3) → [timeout] EXHAUSTED`

At any level: `→ ACKNOWLEDGED → RESOLVED(outcome, note)`.

- Acknowledging informs the other notified caregivers (and, for deviation and urgent alerts, the patient).
- If the ladder is exhausted, the whole circle and the patient are told to contact the clinic or hospital directly.
- **The doctor is never messaged.**
- The MVP uses the same people for all types. A separate emergency contact list is Phase 2.

## 8. AI

| Use | Status |
|---|---|
| Free-text extraction (Gemini `gemini-3.8-flash`, JSON-schema output, 12 s timeout, rule fallback) | MVP |
| Pre-visit brief narrative (from the computed summary; never invents data) | MVP |
| Voice notes, prescription and lab OCR, multilingual replies | Phase 2 |
| Natural-language search over the record | Phase 3 |

AI output never changes task, alert or escalation state.

## 9. Dashboard (web)

### 9.1 Command Centre (doctor / PA)

A pull-based list of the doctor's patients:
- last visit and next visit (today's visits first);
- adherence (medicines, monitoring, physio);
- open care-circle alerts with their current level;
- deviations since the last visit;
- active symptoms;
- latest readings.

It is a visibility surface, **not** an alert channel.

### 9.2 Patient 360

Header: patient, conditions, care circle, last and next visit.

Tabs:
- **Since last visit** (brief)
- **Trends**: charts with the doctor's limits, visit markers and alert markers
- **Adherence**: day-by-day heatmap per medicine, reading, exercise and check-in; distinguishes not logged from not done
- **Care-circle alerts**: ladder, events, outcomes
- **Timeline**: every WhatsApp log with what was extracted from it
- **Visits & care plan**

### 9.3 Pre-visit brief (new)

For the interval from the last visit to now:
- KPI rings (medicines, monitoring, physio, check-ins, alerts, symptom-free days);
- auto-generated highlights (adherence and weakest item; BP early vs. recent vs. clinic; weight peaks; symptoms and days; alerts and how they ended; who logged);
- clinic baseline vs. latest home readings;
- symptom table;
- optional AI narrative.

### 9.4 Visit comparison (new)

Pick any Visit A → Visit B (or A → today):
- **Plan diff**: medicines added, stopped, or changed in dose/time; physio, monitoring and lifestyle changes; alert-limit changes; diagnosis.
- **Clinic vitals delta**, with better/worse colouring.
- **What happened between the visits**: adherence heatmap, vital trends, symptoms and care-circle alerts with outcomes.

After a visit is saved, the app opens this screen straight away.

### 9.5 Record visit

Pre-filled from the previous plan. The PA can enter clinic vitals before the doctor sees the patient. Saving validates the plan (times, thresholds), activates it and messages the family.

### 9.6 Caregiver and patient views

The same Patient 360 tabs, read-only, scoped to their patient, in friendlier language ("How you've been doing"). Caregivers can acknowledge and resolve alerts here as well as on WhatsApp.

## 10. Safety, privacy and audit

- No automated doctor/PA notifications, by design and by test.
- Consent is captured on WhatsApp ("Reply YES") before logging starts.
- Every alert shows the rule and the reading that caused it. Every reading links to its source message.
- Every escalation transition, acknowledgement, outcome, visit and plan change is timestamped in an audit log.
- Production (Phase 2): verified WhatsApp Business number, OTP login for the dashboard, encryption at rest, data residency, DPDP Act compliance review.

## 11. MVP scope (demoable now)

**In**
- Doctor/PA, patient and caregiver personas (demo login)
- Patient onboarding with a 1–3 level care circle
- Visit 1 with care plan
- WhatsApp prompts, reminders and free-text logging
- Caregiver logging
- Compliance, deviation and urgent rules
- Care-circle escalation L1→L2→L3 with ACK and outcomes, by WhatsApp or dashboard
- Command Centre, Patient 360, pre-visit brief
- Visit 2 and the visit comparison diff
- Optional Gemini parser and brief
- **Built-in WhatsApp simulator** behind a gateway adapter
- Demo clock (fast-forward, simulate days), seeded realistic histories

**Phase 2**
- Real WhatsApp Business API (Twilio / Meta Cloud)
- Separate emergency contacts
- Voice notes, prescription and lab OCR
- Multilingual (Hindi, Tamil, Kannada…)
- OTP auth, multi-clinic tenancy
- PA verification queue for AI-extracted data
- Labs as monitored parameters

**Phase 3**
- Natural-language search
- Population analytics
- Device and wearable integrations
- Teleconsult hand-off

## 12. Success metrics

| Metric | Why |
|---|---|
| Logging completion rate (per item type) | Is WhatsApp logging working? |
| Visit prep time (PA/doctor, before vs. after) | The core doctor pain point |
| Deviation-to-acknowledgement time; % acknowledged at L1 | Is the care circle acting in time? |
| % of deviation/urgent alerts with a recorded outcome | Completeness of the doctor's audit trail |
| % resolved as "contacted doctor" or "hospital" | Appropriate escalation to clinical care |
| Caregiver vs. patient logging share | Engagement of the family |
| Parser correction rate | Extraction quality |

## 13. End-to-end lifecycle (demo script)

1. **Visit 1**: the doctor onboards the patient and care circle, then records clinic vitals, diagnosis and the care plan. The family gets a WhatsApp plan summary.
2. **Days 1–28**: prompts arrive at due times. The patient (or a caregiver) replies in free text. Readings, doses and exercises are logged with provenance.
3. **A missed dose** triggers a reminder to the patient; if it stays missed, the care circle is alerted.
4. **A weight gain of 2.3 kg in 3 days** raises a deviation alert to L1 (Lakshmi). There is no acknowledgement in 60 min, so it goes to L2 (Arjun). Arjun replies ACK, then "2 – called Dr. Rao's clinic, furosemide increased". The outcome is recorded.
5. **Visit 2 morning**: the PA opens the pre-visit brief, which shows adherence 97 %, BP improving, a weight peak, knee pain causing skipped walks, and alerts with outcomes.
6. **Visit 2**: the doctor adjusts the plan and saves. The visit comparison shows the medicine diff, the clinic vitals delta and the full interval.
7. The cycle repeats from the new plan.
