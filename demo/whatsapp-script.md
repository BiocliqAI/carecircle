# WhatsApp script

Messages to send from the persona phones. Type them as shown, or paste. Each row says what the audience should notice.
Switch persona (top of the sidebar) to move between Venkat, Anjali and Karthik.

## Scene 4: the family says YES

| From | Message | Notice |
|---|---|---|
| Venkat | `YES` | "Consent recorded." |
| Anjali | `YES` | She is now in the care circle. |
| Karthik | `YES` | Backup person is in. |

If someone is slow to answer, the assistant's queue shows the pending consent, and the system reminds them by itself after a day.

## Scene 5: between visits (as Venkat)

| # | Message | Notice |
|---|---|---|
| 1 | `BP 132/84, weight 72.8, sugar 110, took all tablets` | One message, four things logged, tablets ticked off. |
| 2 | Voice note: `audio/patient-voice-note-1.m4a` (or say it) | Spoken words become readings. |
| 3 | `72.8` | It asks "Which one is it?" with buttons. Tap *Weight*. |
| 4 | `132 84` | It reads this as a blood pressure and asks to confirm. |
| 5 | `hello?` | A kind reply listing what is still due, with an example. No dead end. |
| 6 | Photo: `documents/glucometer-photo.png` | Optional and **not yet tested**: try it once before relying on it. |
| 7 | Voice note 3: forgot the water tablet | The missed dose is noted and the family is told. |

## Scene 6: something slips

1. Do not answer the 8 pm prompt.
2. Demo panel, **Advance clock** by 1 hour. A gentle reminder reaches Venkat.
3. Advance by 3 hours. The dose is marked missed and Anjali is alerted.
4. As Anjali tap **I'll handle it**. The doctor's screen shows "Anjali acknowledged".
5. Optional: as Anjali reply `1` (spoke with him, resolved at home).

## Scene 7: the emergency (as Venkat)

| Message | Notice |
|---|---|
| `BP 185/115, bad headache` | An urgent alert goes to Anjali with Venkat's phone number to call. |

Do not acknowledge. Advance the clock by 15 minutes. It moves to Karthik, then the patient is told. This is a fixed rule, never a free AI decision. The doctor's phone is not paged, and the clinic dashboard shows everything.

The 🆘 button in the patient's phone raises the same kind of alert (not re-tested for this kit).

## Scene 8: the evening digest

Advance to 8:30 pm. Anjali receives one message (`Venkat today…`). Show the "all good" version first, then one with a missed dose.

## Things that make the demo go wrong

- Typing readings in different words each run. Use the table above.
- Forgetting to advance the clock after step 2 of scene 6. Nothing happens until time moves.
- Gemini key missing. Scenes 2 and 3 fail with a clear message, and the rest still works.
