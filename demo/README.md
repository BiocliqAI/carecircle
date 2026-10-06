# CareCircle demo kit

One story, told in about 14 minutes: **a doctor sees a patient once a month, but the family lives with the illness every day.**
Everything here is fictional. The patient is *Venkat Raman*, 71, with heart failure, type 2 diabetes and CKD stage 3.

## What is in this folder

| File | What it is for |
|---|---|
| `documents/discharge-summary-aug-2026.pdf` / `.png` | Old hospital summary. Feed it to **Fill from documents** (scene 2). |
| `documents/lab-report-aug-2026.pdf` / `.png` | Old lab report. Same scene. |
| `documents/prescription-visit1-photo.png` | Today's printed prescription, photographed at a slight angle (scene 3). Has a 14-day taper. |
| `documents/glucometer-photo.png` | A glucose meter showing 126 (scene 5, optional, not yet tested). |
| `audio/consultation.m4a` | The doctor, patient and daughter talking (scene 3). Contains one deliberate disagreement with the prescription and two family questions. |
| `audio/dictation-clinical-note.m4a` | The doctor dictating a note (scene 3). |
| `audio/patient-voice-note-1..3.m4a` | Venkat's voice notes: normal readings, swelling and breathlessness, a forgotten tablet (scene 5). |
| `whatsapp-script.md` | The messages to type or paste, in order. |
| `make-audio.sh` | Regenerates the audio (Mac only). |
| `src/*.html` | Sources of the documents, if you want to change a number. |

## One-time setup (5 minutes)

```bash
cd web
npx tsx scripts/demo_story.mts ready    # clinic, doctor, assistant, patient and family. No baseline yet.
npx tsx scripts/demo_story.mts story    # the same, plus Visit 1 and 12 days of history. Opens on a full Today screen.
```

Run one of them at a time:

```bash
CARECIRCLE_DB=data/demo-ready.db npm run clinic     # for the live walk-through (scenes 1 to 9)
CARECIRCLE_DB=data/demo-story.db npm run clinic     # for the opening, or as the fallback if a live scene breaks
```

Open `http://localhost:3100`. People you can switch to: Clinic Admin, Dr. Meera Iyer, Divya Menon (assistant), Venkat Raman, Anjali (daughter, first contact), Karthik (son, backup).

**Before you present:** add the Gemini key (Admin, then Settings) and test it 10 minutes earlier. The AI scenes (2 and 3) need it. Scene 4 onwards works without it.
**Two screens:** the laptop for the dashboards, a real phone or the WhatsApp simulator for messages.
**Demo panel:** press Shift+D. It has *Advance clock* and *Simulate days*, so you never wait in real time.

## The storyboard

| # | Scene | Who | What you do | What to say |
|---|---|---|---|---|
| 0 | **Open on the answer** (`story` database) | Doctor | Show **Today**: swelling reported, BP creeping up, daughter already acknowledged. | "It's Tuesday morning. Dr. Iyer sees in ten seconds who needs her, and that the family is already on it. Let me show you how it got here." |
| 1 | **Start in 2 minutes** | Admin | Show clinic, doctor and assistant already added. | "Set up once. No IT team, no app to install." |
| 2 | **Onboard from old papers** (`ready` database) | Assistant | Onboard patient. At the baseline step click **Fill from documents**, add both PDFs. Review what filled in. | "Divya doesn't type 12 medicines. She adds the old papers and checks. Notice aspirin and metformin aren't in the current list: the system saw they were stopped and wrote that in the history." |
| 3 | **Visit 1: the doctor's day** | Doctor | Open the plan builder. Add the prescription photo, the consultation audio and the dictation. Build the draft. Resolve the telmisartan conflict. Send. | "The AI drafts, the doctor decides. Every line shows where it came from. Here the prescription says telmisartan twice a day, but she said morning only. The system doesn't guess: it asks her." |
| 4 | **The family says YES** | Patient and daughter | On the phone, reply YES to consent. | "Nothing is shared without consent. Venkat never installs anything." |
| 5 | **Between visits** | Patient | Send the messages in `whatsapp-script.md` (a plain reading, a messy bundle, a voice note, a lone number). | "He just talks. Weight, BP and sugar land in his chart. And when he sends just '72.8', it asks which reading that is. It doesn't guess." |
| 6 | **Something slips** | Demo panel, daughter | Do not reply to the 8 pm prompt. Advance the clock 1 hour (a gentle reminder goes out), then 3 hours (marked missed, alert to Anjali). Anjali taps *I'll handle it*. | "Nobody is left alone with it. One tap and the alert is owned." |
| 7 | **The emergency** | Patient, both caregivers | Send "BP 185/115, bad headache". Do not acknowledge, and advance 15 minutes. | "This is a fixed rule, not an AI opinion. The daughter is called first. If she doesn't answer, it goes to the son." |
| 8 | **The evening digest** | Daughter | Advance to 8:30 pm. Show the digest message. | "On a good day she gets one calm message: 'all good, nothing needs you'. Silence is safe." |
| 9 | **The next visit** | Doctor | Open **Compare** for Venkat. | "Weight and BP trends, the doses, and the family's questions, all in one page before he walks in." |

**If time is short, cut:** scene 1 (20 seconds), scene 8, and the dictation in scene 3.
**If the AI is down:** run scenes 4 to 9 from the `story` database and say "this is where the AI reads the papers" over the screenshots in `docs/test-evidence`.

## What the AI scenes should do (checked on 6 Oct 2026)

- **Fill from documents** with both PDFs: 7 current medicines, aspirin and metformin placed in the history, 7 lab results with dates, allergy, family history, no warnings.
- **Plan builder** with the prescription photo and the consultation: furosemide split into 40 mg for 14 days then 20 mg from day 15; one conflict (telmisartan, prescription vs conversation); aspirin stopped; both family questions answered; labs in 14 days; next visit 22 Oct.
- If you add the baseline first, the draft marks medicines as *same*, *changed* or *stopped* against it. Without a baseline everything shows as *new*.

## Honest limits to know before you present

- WhatsApp is the built-in simulator, not real WhatsApp. Say so if asked.
- The voices are text-to-speech, so recognition is easier than with a real clinic room.
- Messages are in English. Tamil and Hindi replies are not tested.
- The test patient's phone numbers (`+91 90000…`) are not real. Do not point the app at a real WhatsApp number without consent.

## Reset between audiences

Stop the server and run the same `demo_story.mts` command again. It rebuilds the database from scratch in a few seconds.
