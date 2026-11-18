# CareCircle end-to-end test report

**Run:** 17 Nov 2026 · **Code:** branch `claude/eager-faraday-9fdwdv` (same app code as `main` after PR #44) · **Plan:** [E2E_TEST_PLAN.md](E2E_TEST_PLAN.md)

## 1. Summary

All 274 tests in the plan were run. Each has exactly one recorded result.

| Result | Tests | P0 | P1 | P2 |
| --- | --- | --- | --- | --- |
| Passed | 233 | 94 | 127 | 12 |
| Failed: app bug | 22 | 9 | 11 | 2 |
| Failed: plan expectation doesn't match the app | 12 | 4 | 7 | 1 |
| Not run | 7 | 1 | 6 | 0 |
| **Total** | **274** | **108** | **151** | **15** |

The 22 bug failures come from **19 separate defects**: 3 tests hit the same consent defect, and 1 test fails only because 2 others do. Every failure was checked against the app code before being recorded.

**Fix first:**

1. **D1. Caregivers who said NO to consent still receive alerts.** Worse, the first alert still goes to them, while caregivers who agreed hear nothing until a timer runs out.
2. **D2. "I can't breathe" doesn't raise an urgent alert.**
3. **D3. The visit form drops the fluid limit and blood-test plan,** so kidney patients never get fluid reminders.
4. **D4 and D5. Two permission holes:** anyone can replace the clinic's Gemini key, and patients or caregivers can edit the care team.
5. **D6. One WhatsApp number can belong to two patients** if it's typed differently.
6. **D7. Restarting a paused care plan sends no reminders** for the rest of that day and the next.

## 2. How the tests were run

- **Where:** in this session's cloud container. One production build (`next build`) of the branch was made. Each suite starts its own copy of the app on a local port, with a throwaway database. Nothing touched the Railway deployment or clinic data.
- **Harness:** `web/tests/e2e/harness.mts`. It drives the app over HTTP (pages, API, WhatsApp simulator, demo clock), reads the database to check results, and records one result per plan ID in `web/tests/e2e/results/*.jsonl`. Page checks used Playwright with Chromium.
- **WhatsApp:** every WhatsApp test used the built-in simulator. All Twilio variables were removed and the gateway was switched off. The Twilio tests used a separate live-mode copy with fake credentials and an allowlist containing nobody, so nothing could reach a real phone.
- **AI:** no AI key was available. For the 12 tests marked to run both with and without AI, only the no-AI half ran. The 2 AI-only tests were not run.
- **Live mode:** there is no separate live-mode build. Live-mode tests (clinic setup, Twilio) ran live mode on the demo build through a test-only preload (`web/tests/e2e/live-mode-preload.cjs`, `live-preload.cjs`). The app code is the same; only the build folder differs.
- **Time:** time-based rules were tested by moving the demo clock forward.

| Suite | Plan sections | Tests | Passed | Failed | Not run |
| --- | --- | --- | --- | --- | --- |
| `access.e2e.mts` | §2 Access, §3 Clinic setup, §18 Workspace, §19 Family views, §22 Security | 55 | 47 | 8 | 0 |
| `records.e2e.mts` | §4 Onboarding, §5 Baseline, §6 Visits, §16 Other doctors | 58 | 50 | 8 | 0 |
| `whatsapp.e2e.mts` | §7 Consent, §8 Logging, §9 Reminders, §17 Digests and language, §20 Clock | 69 | 55 | 11 | 3 |
| `alerts.e2e.mts` | §10 Rules, §11 Escalation, §12 SOS, §13 Loops, §14 Watches, §15 Documents, §21 Twilio | 92 | 81 | 7 | 4 |

To re-run, build once, then run a suite (about 10 to 20 minutes each):

```bash
cd web && npx next build
```

```bash
cd web && npx tsx tests/e2e/alerts.e2e.mts
```

## 3. Defects

Severity: **Critical** means it can hide a medical emergency, or alert someone who refused consent. **High** means wrong clinical behaviour, or a security or data-integrity hole. **Medium** means a workflow is wrong but there's a workaround. **Low** means polish.

| # | Severity | Defect | Tests | Where |
| --- | --- | --- | --- | --- |
| D1 | Critical | **A caregiver who declined consent still gets alerts.** They're told "You won't receive care-circle alerts", but alerts always start at the lowest level and move up on timeout without checking consent. A declined L1 gets the urgent alert; a consented L2 hears nothing until the timer runs out. The digest and weekly summary do check consent. | WA-CON-05, WA-CON-11, ESC-16 | `web/lib/engine.ts:366-367` (createEscalation), `:392-394` (notifyLevel), `:422-427` (timeoutCaregiver) |
| D2 | Critical | **"I can't breathe" is not urgent.** It's read as moderate breathlessness, so it becomes a normal deviation followed by questions. "chest pain", "fainted", "help" and "emergency" do raise urgent alerts. | RULE-18 | `web/lib/parser.ts:17`, `:158` (severityNear); `web/lib/engine.ts:586` |
| D3 | High | **The visit form drops the fluid limit, lab plan and template.** The server's plan check doesn't copy `fluid`, `labs` or `template`, so kidney patients get no fluid limit, fluid reminders or blood-test lines. | VIS-02 | `web/app/api/patients/[id]/visits/route.ts:13-42` (validPlan) |
| D4 | High | **The Gemini key settings have no permission check.** A signed-out request replaced the clinic's key, and anyone can read the masked key. The Anthropic route correctly allows only the admin and doctors. | CLIN-11 | `web/app/api/settings/gemini/route.ts:6-27` |
| D5 | High | **Patients and caregivers can add, edit and delete consulting doctors.** The care-team API checks only that the user can see the patient. Every other clinical write was correctly refused. | AUTH-11 | `web/app/api/patients/[id]/team/route.ts:13` |
| D6 | High | **The same WhatsApp number can be used for two patients if it's written differently.** "+919886020001" created a second patient on Ramesh's number "+91 98860 20001". Onboarding compares the exact text; editing compares digits. Inbound messages from that number then have two possible patients. | ONB-03 | `web/lib/engine.ts:1302` vs `web/lib/records.ts:29` |
| D7 | High | **Restarting a paused care plan sends no reminders** for the rest of that day and the next. The cancelled tasks of the paused plan block the new ones (unique key plus INSERT OR IGNORE). | WA-REM-11 | `web/lib/engine.ts:231`, `:1252`, `:1279`; `web/lib/db.ts:34` |
| D8 | Medium | **Fluid day totals are added to earlier drinks.** "intake 1400 ml, urine 1100 ml today" is counted on top of drinks already logged, so the chart showed 1950 ml. This can trigger false over-limit kidney alerts. The seeded A Gopal data double-counts the same way. | WA-LOG-10 | `web/lib/parser.ts:44`; `web/lib/engine.ts:595-606` |
| D9 | Medium | **"took all except amlodipine" leaves the other doses open.** They're later marked missed and raise a compliance alert. | WA-LOG-06, WA-LOG-25 | `web/lib/parser.ts:303`; `web/lib/engine.ts:975` |
| D10 | Medium | **A weight without a unit is dropped silently** when AI is off. "72.8 and 146/92, sugar 140" logs BP and sugar, but loses the weight without asking. | WA-LOG-02, WA-LOG-25 | `web/lib/parser.ts:236-238` |
| D11 | Medium | **No reminders for two days after a fast-forward and restart.** This is in the date fix from PR #44: it marks the next two days as already scheduled while removing their tasks. It only happens after the demo clock was moved forward; a plain restart is fine. | TIME-07 | `web/lib/realtime.ts:58-60`, `:67` |
| D12 | Medium | **Failed WhatsApp deliveries are never shown to the clinic.** Delivery status and error codes are stored, but no page or API reads them. | TW-05 | `wa_status`/`wa_error` read only in `web/lib/whatsapp.ts`, `web/lib/engine.ts` |
| D13 | Medium | **Removing a staff member erases their name from history.** The user row is deleted, so their notes and audit entries show no author. | CLIN-05 | `web/lib/clinic.ts:125`; `web/lib/records.ts:138` |
| D14 | Low | **Assistant's Today page:** "Care circle not responding" can't be cleared by replacing the caregiver (it counts per level, not per person). "Done today" leaves out filed documents and reviewed medicine changes. Flagging a change for the visit writes no audit entry. | WS-04 | `web/lib/patasks.ts:111-119`, `:133`; `web/app/api/patients/[id]/prep/route.ts:27-33` |
| D15 | Low | **The "fluid today vs limit" badge never appears on the chart.** The data is returned, but the badge is only in a component no page uses. | WS-12 | `web/components/kidney.tsx:25`; `web/components/PatientView.tsx:142` |
| D16 | Low | **Broken requests crash 18 API routes with a blank error 500** instead of a clear message. Routes call `await req.json()` without a catch. | SEC-06 | e.g. `web/app/api/clinic/route.ts:21`, `web/app/api/escalations/[id]/route.ts:17` |
| D17 | Low | **Phone layout:** at 390 px the patient and caregiver pages are 420 px wide, and "Switch persona" is partly off-screen. 768 px is fine. | FAM-06 | `web/app/globals.css:45-49` |
| D18 | Low | **Demo reset erases the Anthropic key** but keeps the Gemini key. | TIME-06 | `web/lib/seed.ts:329-339` |
| D19 | Low | **No explanation when a correction is too old.** The old reading is correctly kept, but the reply is a generic "couldn't pick that up". | WA-LOG-20 | `web/lib/quality.ts:127-141`; `web/lib/engine.ts:1026-1029` |

### Other findings (not plan tests)

- **Possible gap in the WhatsApp allowlist (not exercised).** A delivery callback with error 63016 holds the message without checking the allowlist. Held messages might later be sent to non-allowlisted numbers. See `deliveryStatus` / `deliverWaiting` in `web/lib/whatsapp.ts`. Worth checking before go-live.
- **Weight creep misses an exact 0.9 kg rise.** 77.2 → 77.6 → 78.1 kg doesn't open a watch, because 78.1 − 77.2 = 0.8999… in floating point (`web/lib/watch.ts:29`).
- **Demo data is inconsistent with the app's rules.** Ramesh and Abdul have 3 caregivers, but the app allows 2. Ramesh also has an old ACKNOWLEDGED compliance alert that silently absorbs new missed medicines.
- **Smaller issues:**
  - When L1 passes an alert on, L1 is told "no response received from Level 1".
  - `POST /api/demo {action:"advance", minutes:0}` moves the clock 60 minutes.
  - With an invalid AI key, "Ask the record" says "The AI did not answer in time".
  - The care-circle audit entry doesn't say which dashboard-access setting changed.

## 4. Plan expectations that don't match the app

These 12 tests failed because the plan expected something the app does differently on purpose. Either the plan or the app should change. Each needs a product decision.

| Test | The plan expected | The app does |
| --- | --- | --- |
| ONB-01, ONB-10 | Up to 3 caregivers (L1–L3) | At most 2 (primary and backup), `web/lib/types.ts:6` |
| CLIN-01 | Getting Started checklist on first run | Admin sees a "Set up your clinic" form; the checklist is only on the assistant's Today page |
| BASE-10 | Sent-back history returns to "collecting" | Status becomes RETURNED |
| VIS-06 | Patient told what changed at Visit 2 | Patient gets the full new plan; changes are only in the plan builder's "In short" |
| WA-LOG-17 | "Was that a typo?" note for a 3 kg jump | Note only from 4 kg or 8% (`web/lib/quality.ts:91-95`); the weight-gain alert is still raised |
| ESC-03 | Reply "2" closes the alert | "2" asks what the clinic advised first, then closes |
| WATCH-01 | Pattern heads-up the next morning | Sent straight after the third reading (watches also run after each reading) |
| DOC-10 | Unsupported files rejected | Size limit (50 MB) enforced; any file type accepted, served as a download |
| OUT-02 | Unclear dose asked about first | Without AI, fixed questions: doctor, prescription, next visit. "Lasix" not matched to Furosemide |
| OUT-15 | "No changes" closes the conversation | Asks for the next appointment first, then closes |
| TW-09 | Unknown senders logged for the clinic | Polite reply, nothing stored but timestamps (privacy by design) |

The plan's §24 also said typing "help" alone raises no alert. That was wrong: it raises an urgent "Help requested" alert (SOS-06 passed). The plan has been corrected.

## 5. Not run

| Test | Reason |
| --- | --- |
| RULE-29 | Needs AI on. Without AI, ambiguous worrying text raised no urgent alert. |
| LANG-01, LANG-02 | Need AI (translation, recognising romanised Hindi or Tamil). |
| LANG-04 | Switching to Hindi needs AI (refused by design without it). The "english please" half worked. |
| TW-06, TW-07, TW-08 | Templates, buttons and message splitting only show on a real Twilio send. |

The AI-on halves of 12 more tests (BASE-03/04/08, VIS-08/09, WA-LOG-02, DOC-01/03/11, OUT-01, WS-09/10) were also not run. Adding `GEMINI_API_KEY` as an environment secret would let them run in a new session.

## 6. Caveats

- **Setup written straight into the database.** Some tests needed state the app can't create without AI or real devices. The tests wrote it into the database as setup; each test's code says so. Everything after that setup went through the app.
  - Plan-builder drafts: VIS-07, VIS-09, VIS-10.
  - What AI would have read from a photo or document: DOC-02, DOC-05, DOC-06, DOC-09.
  - Consent rows for the seeded circle.
  - Turning off one caregiver's dashboard access (AUTH-09).
  - The synthetic Twilio patient and fake Twilio message IDs (TW-05).
- **Page checks covered layout and key content.** They didn't test every control on every page.
- **Results describe this code with AI off.** AI output varies, so AI-on behaviour needs its own run.

## Appendix: every test result

Bug = app defect (see §3). Plan = the plan expected different behaviour (see §4). Full notes are in web/tests/e2e/results/*.jsonl.

### 2. Sign-in, roles and access control

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| AUTH-01 | P0 | Persona picker lists all users | Passed |  |
| AUTH-02 | P0 | Sign out | Passed |  |
| AUTH-03 | P0 | Unknown user id | Passed |  |
| AUTH-04 | P0 | Doctor sees only own patients | Passed |  |
| AUTH-05 | P0 | Doctor cannot open another doctor's patient | Passed |  |
| AUTH-06 | P0 | PA sees every clinic patient | Passed |  |
| AUTH-07 | P0 | Patient sees only their own record | Passed |  |
| AUTH-08 | P0 | Caregiver with dashboard access | Passed |  |
| AUTH-09 | P0 | Caregiver without dashboard access | Passed |  |
| AUTH-10 | P0 | Non-clinicians blocked from clinician APIs | Passed |  |
| AUTH-11 | P0 | Patient and caregiver cannot write clinical data | **Bug** | care-team route lets patient/caregiver add/edit/delete consulting doctors (app/api/patients/[id]/team/route.ts:13 checks only canView, not isClinician; the UI for it, components/kidney.tsx:391, is clinician-only). PLA… |
| AUTH-12 | P1 | Admin navigation | Passed |  |
| AUTH-13 | P1 | Role-specific navigation | Passed |  |
| AUTH-14 | P1 | Direct URL to a page not allowed for the role | Passed |  |

### 3. Clinic setup and staff (live mode)

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| CLIN-01 | P0 | First run on an empty database | Plan | no Getting Started checklist on first run. The admin sees the "Set up your clinic" form (app/admin/page.tsx:46) and the picker's "Start here" card; the GettingStarted checklist component is rendered only on the assist… |
| CLIN-02 | P0 | Set up the clinic | Passed |  |
| CLIN-03 | P1 | Add a PA and a second doctor | Passed |  |
| CLIN-04 | P1 | Edit staff | Passed |  |
| CLIN-05 | P1 | Remove staff | **Bug** | history loses the removed PA's name: the note is still there but author_name = null. removeStaff hard-deletes the user row (lib/clinic.ts:125) and notes/audit/review screens resolve names by joining users (lib/records… |
| CLIN-06 | P0 | Cannot remove a doctor who still has patients | Passed |  |
| CLIN-07 | P1 | Validation | Passed |  |
| CLIN-08 | P1 | Edit clinic details | Passed |  |
| CLIN-09 | P0 | Reset clinic | Passed |  |
| CLIN-10 | P1 | Reset blocked in demo API for live | Passed |  |
| CLIN-11 | P2 | AI settings [AI off at start] | **Bug** | /api/settings/gemini has no authorization — a signed-out request replaced the clinic's Gemini key (POST -> 200) and GET returns the masked key to anyone (200); compare anthropic/route.ts:8-11 which allows only admin/d… |

### 4. Patient onboarding and care circle

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| ONB-01 | P0 | Add a new patient | Plan | the plan asks for caregivers L1–L3, but a care circle holds at most 2 by design (lib/types.ts:6 MAX_CAREGIVERS = 2; app/api/patients/route.ts:21). Sending 3 gave HTTP 400 "A care circle has at most 2 caregivers (prima… |
| ONB-02 | P0 | Consent requests sent on WhatsApp | Passed |  |
| ONB-03 | P0 | Duplicate WhatsApp number | **Bug** | the same number written without spaces ("+919886020001") was accepted (HTTP 200, new patient p_dup_format_58724); patients with digits 919886020001 now: p_ramesh "+91 98860 20001", p_dup_format_58724 "+919886020001". … |
| ONB-04 | P1 | Required fields and validation | Passed |  |
| ONB-05 | P1 | Draft saved and resumed | Passed |  |
| ONB-06 | P1 | Draft deleted | Passed |  |
| ONB-07 | P1 | PA onboards for a doctor | Passed |  |
| ONB-08 | P1 | Edit patient profile | Passed |  |
| ONB-09 | P0 | Change care circle order | Passed |  |
| ONB-10 | P1 | Add a caregiver later | Plan | the plan adds "a new L3", but a care circle holds at most 2 caregivers by design (lib/types.ts:6; lib/records.ts:73 setCareCircle): adding a third gave HTTP 409 "A care circle has at most 2 caregivers (primary and bac… |
| ONB-11 | P1 | Remove a caregiver | Passed |  |
| ONB-12 | P1 | Resend consent | Passed |  |
| ONB-13 | P0 | Delete patient | Passed |  |
| ONB-14 | P1 | Clear selected records | Passed |  |

### 5. Baseline and past records

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| BASE-01 | P1 | Enter baseline by hand | Passed |  |
| BASE-02 | P1 | Baseline validation | Passed |  |
| BASE-03 | P1 | Baseline from a document [AI off] | Passed |  |
| BASE-04 | P1 | Onboarding from past records: upload [AI off] | Passed |  |
| BASE-05 | P1 | Move and remove a record | Passed |  |
| BASE-06 | P2 | Unreadable file | Passed |  |
| BASE-07 | P1 | Typed record | Passed |  |
| BASE-08 | P0 | Build history draft [AI off] | Passed |  |
| BASE-09 | P1 | Edit draft and send to doctor | Passed |  |
| BASE-10 | P1 | Doctor sends it back | Plan | the note reaches the assistant (Today task note "Please add the 2023 echo report"), but the status becomes RETURNED, not COLLECTING, by design (lib/onboarding.ts:719 sendBack sets status 'RETURNED'; adding a record th… |
| BASE-11 | P0 | Doctor confirms history | Passed |  |
| BASE-12 | P1 | Update a confirmed history | Passed |  |

### 6. Visits and care plans

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| VIS-01 | P0 | Record Visit 1 and start the plan | Passed |  |
| VIS-02 | P0 | Plan message content | **Bug** | the fluid limit (plan.fluid {limitMl:1500}) and the lab plan (plan.labs) sent by the visit form are dropped: the stored plan has fluid=undefined labs=undefined template=undefined, so the message has no "Fluid limit" /… |
| VIS-03 | P0 | Save visit without starting plan | Passed |  |
| VIS-04 | P1 | Start care plan later | Passed |  |
| VIS-05 | P1 | Past visit from records | Passed |  |
| VIS-06 | P1 | Visit 2 changes the plan | Plan | reminders follow the new plan (old future tasks replaced, no Atorvastatin tasks, Furosemide tasks at 40 mg), but the patient's WhatsApp only lists the new plan; it doesn't say that Atorvastatin was stopped or that Fur… |
| VIS-07 | P1 | Plan builder draft is kept | Passed |  |
| VIS-08 | P1 | Dictate a visit [AI off] | Passed |  |
| VIS-09 | P1 | "In short" for the family [AI off] | Passed |  |
| VIS-10 | P2 | Suggested next visit | Passed |  |
| VIS-11 | P1 | Compare visits | Passed |  |
| VIS-12 | P1 | Prepare visit | Passed |  |
| VIS-13 | P1 | Next visit date picker | Passed |  |

### 7. WhatsApp: consent

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| WA-CON-01 | P0 | Patient says YES | Passed |  |
| WA-CON-02 | P0 | Patient says NO | Passed |  |
| WA-CON-03 | P1 | Patient changes mind (NO then YES) | Passed |  |
| WA-CON-04 | P0 | Caregiver says YES, then receives alerts | Passed |  |
| WA-CON-05 | P0 | Caregiver (L2) says NO: no alerts to L2, 'Caregiver declined' task | **Bug** | declined L2 caregiver still received 1 alert message(s) after the L1 timeout (escalation 24 now level 2, NOTIFIED): "🚨 URGENT — Circle Consent Patient Cg Gamma Yes hasn't responded in 15 min, so this is now". timeout… |
| WA-CON-06 | P1 | Consent in Indian languages | Passed |  |
| WA-CON-07 | P0 | YES while an alert is waiting = ACK, not consent | Passed |  |
| WA-CON-08 | P1 | Caregiver in two circles answers the latest request | Passed |  |
| WA-CON-09 | P1 | Automatic consent reminders (day 1, then 3 days, max 2) | Passed |  |
| WA-CON-10 | P1 | Consent task on Today | Passed |  |
| WA-CON-11 | P0 | Declined caregiver gets no alerts; next consented level does | **Bug** | urgent alert (escalation 26, level 1) went to the DECLINED L1 caregiver (1 msg: "🚨 URGENT — Declined Level Patient Declined's BP is 190/115 ") and 0 to the consented L2. createEscalation starts at the lowest level (l… |
| WA-CON-12 | P1 | Digest only to consented caregivers | Passed |  |

### 8. WhatsApp: readings and daily logging

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| WA-LOG-01 | P0 | Single reading | Passed |  |
| WA-LOG-02 | P0 | Several readings in one message (AI off) | **Bug** | with AI off the rules parser logged only [bp:146/92, glucose:140, hr:78]; the bare "72.8" is dropped silently (no reading, no question) because the weight rule needs "weight"/"wt"/"kg" (lib/parser.ts:236) and the doub… |
| WA-LOG-03 | P1 | Natural language from a caregiver (A Gopal / Mom) | Passed |  |
| WA-LOG-04 | P0 | Medicines taken (tap after the prompt) | Passed |  |
| WA-LOG-05 | P0 | Medicines missed | Passed |  |
| WA-LOG-06 | P1 | One medicine missed: 'took all except amlodipine' (Abdul, 09:00 doses) | **Bug** | only amlodipine should be NOT_DONE and the rest taken, but tasks are {"med:amlodipine":"NOT_DONE","med:tiotropium":"PENDING","med:budesonide":"PENDING"} — the rules parser sets allTaken=false whenever "except" appears… |
| WA-LOG-07 | P1 | Physio done / skipped | Passed |  |
| WA-LOG-08 | P1 | Evening check-in | Passed |  |
| WA-LOG-09 | P1 | Fluid intake running total (A Gopal) | Passed |  |
| WA-LOG-10 | P1 | Fluid and urine day totals | **Bug** | the day total "intake 1400 ml … today" was added to the earlier drinks (400 + 150) instead of replacing them, so the chart shows 1950 ml. parseFluids() only treats a volume as a day total when words like "total"/"so f… |
| WA-LOG-11 | P1 | Lab values by text (A Gopal) | Passed |  |
| WA-LOG-12 | P1 | Ambiguous number asks which one; chosen one logged | Passed |  |
| WA-LOG-13 | P1 | Cancel the clarification | Passed |  |
| WA-LOG-14 | P0 | Impossible weight: not logged, suggests 59.2, Yes logs it | Passed |  |
| WA-LOG-15 | P0 | Impossible BP 1400/80 | Passed |  |
| WA-LOG-16 | P1 | Sugar in mmol/L | Passed |  |
| WA-LOG-17 | P1 | Large but plausible jump (weight +3 kg vs yesterday) | Plan | 80.3 kg (+3.0 kg vs yesterday's 77.3) is logged and raises the "Rapid weight gain" alert, but no "was that a typo?" note: the note needs a jump of at least max(4 kg, 8% of the last weight) (lib/quality.ts:95, weightJu… |
| WA-LOG-18 | P0 | Correction replaces the reading and closes its alert | Passed |  |
| WA-LOG-19 | P1 | 'Sorry' alone changes nothing | Passed |  |
| WA-LOG-20 | P1 | Correction outside the 36 h window | **Bug** | the old reading is correctly left alone, but the reply does not explain why — it is the generic "couldn't pick that up" message: "🤔 Sorry, I couldn't pick that up, but no problem. You can write it your own way, for e… |
| WA-LOG-21 | P1 | Reading before Visit 1 | Passed |  |
| WA-LOG-22 | P1 | Caregiver logs for the patient; patient told of the alert | Passed |  |
| WA-LOG-23 | P1 | Unknown sender | Passed |  |
| WA-LOG-24 | P2 | Message length limit | Passed |  |
| WA-LOG-25 | P1 | Rules parser with AI off (WA-LOG-01..08) | **Bug** | with AI off: WA-LOG-02 FAIL, WA-LOG-06 FAIL (see those results) 2 !== 0  |

### 9. WhatsApp: reminders and compliance alerts

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| WA-REM-01 | P0 | Prompt at due time (Ramesh 08:00) | Passed |  |
| WA-REM-02 | P0 | Reminder after 1 h lists the open items | Passed |  |
| WA-REM-03 | P0 | Tasks marked MISSED after 3 h | Passed |  |
| WA-REM-04 | P0 | Medicines missed → compliance alert to L1 | Passed |  |
| WA-REM-05 | P0 | No doctor or PA notified | Passed |  |
| WA-REM-06 | P1 | Reading missed 2 days running (weight) | Passed |  |
| WA-REM-07 | P1 | Physio missed 3 times in a row → one alert, not repeated within 3 days | Passed |  |
| WA-REM-08 | P0 | Late completion resolves the compliance alert | Passed |  |
| WA-REM-09 | P1 | One compliance alert at a time (items ADDED) | Passed |  |
| WA-REM-10 | P1 | Lab task: prompted on its day, missed only after 3 days (seeded history, A Gopal) | Passed |  |
| WA-REM-11 | P1 | Paused plan: no prompts until started | **Bug** | paused correctly, but after "Start care plan" (12:05) no prompt came at 18:00: the only tasks for the rest of the day are the old plan's rows, all CANCELLED (18:00 CANCELLED v_p_abdul_1794033000000; 21:00 CANCELLED v_… |
| WA-REM-12 | P2 | Old prompts not sent after a scheduler gap | Passed |  |

### 10. Alert rules (deviation and urgent)

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| RULE-01 | P0 | BP crisis | Passed |  |
| RULE-02 | P0 | BP above limit (well above) | Passed |  |
| RULE-03 | P0 | Borderline BP → recheck | Passed |  |
| RULE-04 | P0 | Recheck still high | Passed |  |
| RULE-05 | P0 | Recheck normal | Passed |  |
| RULE-06 | P0 | No recheck → alert anyway | Passed |  |
| RULE-07 | P1 | Low BP | Passed |  |
| RULE-08 | P0 | Rapid weight gain | Passed |  |
| RULE-09 | P1 | Weight above dry-weight band (Gopal 59.2 ± 1) | Passed |  |
| RULE-10 | P1 | Weight below band | Passed |  |
| RULE-11 | P0 | Very low sugar | Passed |  |
| RULE-12 | P1 | Low / high sugar | Passed |  |
| RULE-13 | P1 | Pulse outside limits (+ borderline recheck) | Passed |  |
| RULE-14 | P0 | Very low oxygen (Abdul) | Passed |  |
| RULE-15 | P1 | Oxygen below limit (Abdul, limit 92) | Passed |  |
| RULE-16 | P1 | Fever | Passed |  |
| RULE-17 | P1 | High pain score (Sunita, limit 7) | Passed |  |
| RULE-18 | P0 | Red-flag symptoms: chest pain, fainted, can't breathe | **Bug** | "I can't breathe" → no URGENT (got DEVIATION sx:breathlessness); reply: ✅ Logged: • Symptom noted: Breathlessness (moderate) A quick question so the doctor has the full picture: When do you feel breathless? ⚠️ Br. "ca… |
| RULE-19 | P0 | Severe breathlessness | Passed |  |
| RULE-20 | P1 | Watched symptom (swelling) | Passed |  |
| RULE-21 | P0 | Very high potassium (Gopal) | Passed |  |
| RULE-22 | P1 | Potassium high / low, sodium out of range (Gopal) | Passed |  |
| RULE-23 | P1 | Creatinine rising (Gopal) | Passed |  |
| RULE-24 | P1 | Low haemoglobin (Gopal, limit 8) | Passed |  |
| RULE-25 | P1 | Kidney fluid check (2 days over limit / low ratio → next morning after 06:00, once) | Passed |  |
| RULE-26 | P0 | Same rule while open → REPEAT | Passed |  |
| RULE-27 | P0 | Emergency rules before Visit 1 | Passed |  |
| RULE-28 | P0 | Abnormal ≠ emergency | Passed |  |
| RULE-29 | P0 | AI cannot raise an emergency | Not run | Needs AI on (no GEMINI/ANTHROPIC key in this environment). AI-off sanity check: ambiguous worrying text raised 0 URGENT alerts. |

### 11. Escalation chain (caregiver levels)

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| ESC-01 | P0 | L1 notified | Passed |  |
| ESC-02 | P0 | L1 acknowledges (ACK / ok / on it / I'll handle it / 👍) | Passed |  |
| ESC-03 | P0 | Outcome recorded (2) | Plan | "2" does not resolve the alert by itself — it asks for a note first ("Got it. Briefly, what did the doctor / clinic advise?"; lib/engine.ts:810-815) and resolves with outcome 2 once the note arrives; L1 thanked and pa… |
| ESC-04 | P1 | Outcome with a note (4) | Passed |  |
| ESC-05 | P0 | Timeout moves to L2 (deviation 60 min) | Passed |  |
| ESC-06 | P0 | Urgent timer 15 min | Passed |  |
| ESC-07 | P0 | Compliance timer 120 min | Passed |  |
| ESC-08 | P0 | L1 passes it on | Passed |  |
| ESC-09 | P0 | Exhausted | Passed |  |
| ESC-10 | P0 | Others told when one acknowledges | Passed |  |
| ESC-11 | P0 | Only circle members can ACK | Passed |  |
| ESC-12 | P0 | Ack after close | Passed |  |
| ESC-13 | P1 | Acknowledge from the dashboard, then close | Passed |  |
| ESC-14 | P1 | Acknowledged alert does not time out | Passed |  |
| ESC-15 | P1 | Plan overrides timers | Passed |  |
| ESC-16 | P0 | Declined caregiver is skipped | **Bug** | after Arjun declined consent (told "You won't receive care-circle alerts"), the timeout moved the alert to level 2 and sent Arjun 1 alert message(s) ("⚠️ Care Circle alert — Ramesh Kumar Lakshmi Kumar hasn't responded… |
| ESC-17 | P0 | Alert timeline | Passed |  |

### 12. SOS

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| SOS-01 | P0 | Patient presses SOS | Passed |  |
| SOS-02 | P0 | Caregiver presses SOS | Passed |  |
| SOS-03 | P0 | SOS escalates after 15 min | Passed |  |
| SOS-04 | P1 | Second SOS while open | Passed |  |
| SOS-05 | P1 | Unlinked number | Passed |  |
| SOS-06 | P0 | Typed "help" / "emergency" | Passed |  |

### 13. Follow-up loops after a reading

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| LOOP-01 | P1 | Symptom follow-up questions | Passed |  |
| LOOP-02 | P0 | Answer matches a rule (At rest → severe breathlessness) | Passed |  |
| LOOP-03 | P1 | Lying flat → orthopnoea; near-faint → fainting red flag | Passed |  |
| LOOP-04 | P1 | Reading interrupts the questions | Passed |  |
| LOOP-05 | P2 | Not asked again within 12 h | Passed |  |
| LOOP-06 | P1 | Recheck after an alert closes (2 h; weight next morning) | Passed |  |
| LOOP-07 | P1 | Recheck normal → closer told | Passed |  |
| LOOP-08 | P0 | Recheck still out of range → alert without the borderline hold | Passed |  |
| LOOP-09 | P1 | No recheck → caregiver told | Passed |  |
| LOOP-10 | P1 | No recheck after hospital (3) | Passed |  |
| LOOP-11 | P2 | Recheck already in the plan → no extra request | Passed |  |

### 14. Pattern watches

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| WATCH-01 | P1 | Weight creep | Plan | heads-up sent to patient and L1 once and the watch is on the chart, but not "next morning after 09:30": evaluateWatches also runs right after each reading (lib/engine.ts:1056), so it opened at 21:56 IST right after th… |
| WATCH-02 | P1 | BP drift | Passed |  |
| WATCH-03 | P1 | Fluid build-up | Passed |  |
| WATCH-04 | P1 | Adherence slip | Passed |  |
| WATCH-05 | P1 | Dismiss | Passed |  |
| WATCH-06 | P1 | Turn a pattern off | Passed |  |
| WATCH-07 | P2 | Not repeated next morning | Passed |  |

### 15. Documents and photos on WhatsApp

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| DOC-01 | P0 | Device photo [AI±] | Passed |  |
| DOC-02 | P1 | Device photo rejected | Passed |  |
| DOC-03 | P0 | Prescription / lab photo [AI±] | Passed |  |
| DOC-04 | P0 | Nothing filed before confirmation | Passed |  |
| DOC-05 | P0 | Confirm & file | Passed |  |
| DOC-06 | P1 | Same report twice | Passed |  |
| DOC-07 | P1 | PDF | Passed |  |
| DOC-08 | P1 | Clinic upload: edit, verify, download | Passed |  |
| DOC-09 | P0 | Delete document with its data | Passed |  |
| DOC-10 | P2 | Unsupported file (.exe / huge) | Plan | a 51 MB file is rejected ("Files are limited to 50 MB"), but an .exe (application/x-msdownload) is accepted and stored as document 1 with reply "📄 Received “setup.exe”. It's been added to the record for your care tea… |
| DOC-11 | P1 | Voice note [AI±] (typed transcript) | Passed |  |
| DOC-12 | P2 | Reader output never shown as real (AI off) | Passed |  |

### 16. Visits to other doctors

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| OUT-01 | P0 | Reported on WhatsApp [AI off] | Passed |  |
| OUT-02 | P1 | Ambiguous dose asked first | Plan | with AI off the first question is "Which doctor did you see (cardiology)? Their name, and the hospital if you like.", not a dose clarification. The rules fallback asks fixed questions in order doctor → prescription → … |
| OUT-03 | P1 | Doctor choice | Passed |  |
| OUT-04 | P1 | Photo during the conversation | Passed |  |
| OUT-05 | P0 | Readings during the conversation | Passed |  |
| OUT-06 | P0 | Urgent message skips it | Passed |  |
| OUT-07 | P1 | Stop | Passed |  |
| OUT-08 | P1 | Abandoned | Passed |  |
| OUT-09 | P0 | Visit on the record | Passed |  |
| OUT-10 | P0 | Changes not applied automatically | Passed |  |
| OUT-11 | P0 | Safety checks shown | Passed |  |
| OUT-12 | P0 | Apply to plan | Passed |  |
| OUT-13 | P1 | Reject / mark reviewed | Passed |  |
| OUT-14 | P1 | Next appointment reminders | Passed |  |
| OUT-15 | P1 | "How did it go" answers | Plan | "No changes" doesn't close at once: the reply is "👍 Noted: no medicine changes.\n\nWhen is the next visit with Dr Lak? (e.g. “20 Oct” or “after 2 weeks”, or *NO* if not planned)". The rules flow still wants the next-… |
| OUT-16 | P1 | Entered on the web | Passed |  |
| OUT-17 | P1 | Tap "From another doctor's visit" under a document | Passed |  |
| OUT-18 | P1 | Postponed date in the past year | Passed |  |
| OUT-19 | P2 | Delete an outside visit | Passed |  |

### 17. Digests, summaries and language

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| DIG-01 | P1 | Evening digest | Passed |  |
| DIG-02 | P1 | Digest sent once | Passed |  |
| DIG-03 | P2 | Medicine streak line (seeded digests) | Passed |  |
| DIG-04 | P1 | Weekly summary (Sunday 19:00) | Passed |  |
| DIG-05 | P1 | No digest before the plan starts | Passed |  |
| LANG-01 | P1 | Indian script switches language [AI on] | Not run | Needs AI translation (GEMINI/ANTHROPIC keys are stripped in this environment); script detection alone only stores the preference. |
| LANG-02 | P1 | Romanised language needs two messages [AI on] | Not run | Romanised language is only recognised by the AI parser (parsed.language); AI is off here. |
| LANG-03 | P1 | Switch back after three longer English messages | Passed |  |
| LANG-04 | P1 | Ask directly: 'reply in Hindi', then 'english please' | Not run | Switching to Hindi needs AI translation (AI off: "Sorry, I can't reply in Hindi right now, but I'll understand", by design — see LANG-07). The English half works: "Okay, I'll reply in English from now on.". |
| LANG-05 | P1 | Per-person language | Passed |  |
| LANG-06 | P1 | Translated quick-reply button understood as English | Passed |  |
| LANG-07 | P1 | No AI: 'reply in Tamil' | Passed |  |

### 18. Doctor and assistant workspace

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| WS-01 | P0 | Doctor Today | Passed |  |
| WS-02 | P1 | Mark reviewed | Passed |  |
| WS-03 | P0 | PA Today tasks | Passed |  |
| WS-04 | P1 | Task clears when done | **Bug** | tasks not cleared after completion: care circle not responding (still: "In 2 weeks, primary New missed 3 of 4 alerts. Check the number or add someone else.") (circle task counts TIMEOUT events per level, not per perso… |
| WS-05 | P0 | Patient chart | Passed |  |
| WS-06 | P1 | Patient table | Passed |  |
| WS-07 | P1 | Notes | Passed |  |
| WS-08 | P1 | Care team | Passed |  |
| WS-09 | P1 | AI summary / pre-visit brief [AI off] | Passed |  |
| WS-10 | P1 | Ask the record [AI off] | Passed |  |
| WS-11 | P1 | Med change review | Passed |  |
| WS-12 | P1 | Kidney view | **Bug** | no "fluid today vs limit" badge (expected like "💧 Today 1325 / 1000 ml"). The API returns fluidToday (app/api/patients/[id]/route.ts:109) and KidneyBadges renders it (components/kidney.tsx:25-30), but KidneyBadges is… |
| WS-13 | P2 | Assistants page | Passed |  |
| WS-14 | P1 | Dashboard API isolation | Passed |  |

### 19. Family and patient web views

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| FAM-01 | P1 | Family home | Passed |  |
| FAM-02 | P1 | Nothing scheduled | Passed |  |
| FAM-03 | P0 | Read-only for patient | Passed |  |
| FAM-04 | P1 | Caregiver closes an alert from the web | Passed |  |
| FAM-05 | P1 | Outside visit from the web | Passed |  |
| FAM-06 | P2 | Mobile layout | **Bug** | u_lakshmi@390: horizontal scroll (420 > 390); u_lakshmi@390: off-screen controls BUTTON:⇄ Switch persona; u_ramesh@390: horizontal scroll (420 > 390); u_ramesh@390: off-screen controls BUTTON:⇄ Switch persona. The fam… |

### 20. Clock, scheduler and data integrity

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| TIME-01 | P0 | Scheduler catches up in 15-min steps (one 6 h advance) | Passed |  |
| TIME-02 | P0 | No duplicates on re-run / reload | Passed |  |
| TIME-03 | P1 | Simulate 7 days | Passed |  |
| TIME-04 | P0 | Back to real date on restart | Passed |  |
| TIME-05 | P1 | Clock indicator after advancing | Passed |  |
| TIME-06 | P1 | Demo reset: fresh seeded data, AI keys kept | **Bug** | the Anthropic (Claude) key saved under Settings is erased by Reset; only gemini_api_key/gemini_model are preserved (lib/seed.ts:329-339) before resetDb() drops the settings table (lib/db.ts:230). + actual - expected +… |
| TIME-07 | P0 | Restart persistence: data kept, scheduler resumes without re-sending | **Bug** | after the restart that follows a fast-forward, the scheduler sends no morning prompt: Ramesh has 0 task(s) for the next day and 0 prompts by 08:05. syncToRealDate() moves/deletes every non-PENDING task dated after now… |
| TIME-08 | P1 | Timezone: plan times and messages in IST | Passed |  |

### 21. Real WhatsApp gateway (Twilio)

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| TW-01 | P0 | Webhook signature | Passed |  |
| TW-02 | P0 | Valid inbound message | Passed |  |
| TW-03 | P0 | Idempotent inbound | Passed |  |
| TW-04 | P1 | Inbound media (download + size limit) | Passed |  |
| TW-05 | P1 | Delivery status callbacks | **Bug** | message status is updated (delivered; failed with error 30008 kept in messages.wa_error), but no API or page shows delivery failures to the clinic — wa_status/wa_error are only read in lib/whatsapp.ts and lib/engine.t… |
| TW-06 | P1 | Templates outside 24 h | Not run | Needs a real Twilio account and approved templates delivered to an allowlisted test phone; with the fake credentials any allowlisted send would hit api.twilio.com. Template choice logic (lib/whatsapp.ts hold()) not ex… |
| TW-07 | P1 | Buttons | Not run | Needs a real Twilio account (Content API button resources are created on send, lib/twilio.ts buttonsContent). |
| TW-08 | P1 | Long message split | Not run | Needs a real Twilio send to observe the split parts (lib/whatsapp.ts splitText/sendSession). |
| TW-09 | P0 | Stranger | Plan | polite reply sent, nothing revealed, body not stored — but nothing is "logged for the clinic": only timestamps are kept (wa:lastin:+919000088888, wa:stranger:whatsapp:+919000088888) and no page lists unknown senders. … |
| TW-10 | P0 | No health data in logs | Passed | checked 632 bytes of server logs (demo + live) for message bodies/readings; none found |

### 22. Security and robustness

| ID | Pri | Test | Result | Note |
| --- | --- | --- | --- | --- |
| SEC-01 | P0 | Changing ids in URLs | Passed |  |
| SEC-02 | P0 | Document download access | Passed |  |
| SEC-03 | P0 | Escalation actions access | Passed |  |
| SEC-04 | P1 | Script injection | Passed |  |
| SEC-05 | P1 | SQL-like input | Passed |  |
| SEC-06 | P1 | Malformed JSON / missing fields | **Bug** | routes that call `await req.json()` without a catch return 500 with no message on malformed JSON: POST /api/clinic -> 500 (app/api/clinic/route.ts); POST /api/demo -> 500 (app/api/demo/route.ts); POST /api/drafts -> 5… |
| SEC-07 | P1 | Health check | Passed |  |
| SEC-08 | P2 | Large uploads | Passed |  |
| SEC-09 | P1 | AI failure (invalid keys) | Passed |  |
| SEC-10 | P0 | Audit trail | Passed |  |
