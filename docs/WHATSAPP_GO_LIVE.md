# Real WhatsApp via Twilio: go-live guide

CareCircle sends and receives real WhatsApp messages through Twilio once the live-clinic deployment has Twilio credentials. The demo (`npm run dev`) never sends anything real: its phone numbers are made up.

- Sender: **+91 90359 13536** (Biocliq Technologies), already approved by Meta and *Online* in Twilio.
- Code: `web/lib/twilio.ts` (talks to Twilio), `web/lib/whatsapp.ts` (what to send and when), `web/app/api/twilio/inbound` and `web/app/api/twilio/status` (Twilio's webhooks).

## How it behaves

| Situation | What happens |
|---|---|
| The person messaged us in the last 24 h | The message goes out as normal text, in their language. Up to 3 short choices become WhatsApp buttons. Up to 10 become a list. Longer choices are listed as "Reply with: …". |
| The person hasn't messaged us in 24 h (WhatsApp's rule) | The message is held. They get the **"new message"** template, at most once every 6 h. When they tap *Show message* or reply, the held messages are delivered, oldest first (at most the last 6 from the past day). |
| An alert (escalation) to a caregiver outside the 24 h window | They get the **escalation** template: the alert itself, with **I'll handle it** (and **Pass to backup** when there is one) on the notification. Tapping a button works exactly like typing it. The escalation ladder still moves on if nobody responds. |
| Any other alert outside the window (e.g. to the patient), or a caregiver who reads another language | They always get the **"care alert"** template, which carries the alert's title (or, in another language, its translated text). |
| A caregiver update that asks nothing of them (someone is handling it, care plan changed, weekly summary) outside the window | It waits quietly, with no template, and is delivered the next time they write or tap. Caregivers hear from us only when something needs them. |
| A message generated more than 2 h ago (e.g. the server was down and caught up) | Not sent; marked `expired`. |
| Someone not in any care circle writes in | One polite "contact your clinic" reply a day. Nothing is stored. |
| Photo, PDF or voice note | Saved to the patient's documents, the same as in the simulator: device photos are read, voice notes are transcribed (with Gemini), and the WhatsApp caption becomes the file name. |

Each outbound message records its delivery state in `messages.wa_status` (`pending`, `sent`, `delivered`, `read`, `waiting`, `failed`, `expired`, `skipped`), plus `wa_sid` and `wa_error`.

## 1. Create the two templates (Twilio → Messaging → Content Template Builder)

Create both as **Quick reply** type, category **Utility**, language **English**, then **Save and submit for WhatsApp approval**. Approval usually takes minutes to a day. A template can't start or end with a variable.

**`carecircle_update_v2`**

> Hello {{1}}, {{2}} has sent an update on the care plan. Tap *Show message* to read it.

- Button: **Show message**, button ID **`cc_show`**
- Sample values for the submission: `{{1}}` = `Ramesh`, `{{2}}` = `Rao Family Clinic`

**`carecircle_alert_v2`**

> Care alert for {{1}}: {{2}}'s care needs attention: {{3}}. This was raised by {{4}} under the care plan. Tap *Show alert* to see the advice and respond.

- Button: **Show alert**, button ID **`cc_show`**
- Sample values: `{{1}}` = `Lakshmi`, `{{2}}` = `Ramesh`, `{{3}}` = `BP above doctor's limit`, `{{4}}` = `Rao Family Clinic`
- `{{3}}` is the alert's title (for people set to another language, the translated alert text).

Meta may re-classify a template as **Marketing**, which costs more and can be capped or turned off by the recipient. Don't use a Marketing-classed alert template; reword it to be more specific, or appeal the category in WhatsApp Manager.

**`carecircle_escalate_v1`** (buttons **I'll handle it** `cc_ack`, **Pass to backup** `cc_pass`) and **`carecircle_escalate_solo_v1`** (button **I'll handle it** `cc_ack` only)

> Care alert for {{1}} from {{2}} about {{3}}: {{4}}. Advice: {{5}}. Please call them on {{6}}. Tap *I'll handle it* to take ownership.

- Sample values: `{{1}}` = `Lakshmi`, `{{2}}` = `Rao Family Clinic`, `{{3}}` = `Ramesh`, `{{4}}` = `BP above doctor's limit. BP 182/110 mmHg (limit 140/90)`, `{{5}}` = `Rest for 15 minutes and recheck. Confirm the BP tablets were taken`, `{{6}}` = `+91 98860 20001`
- Submit with category changes turned off, so Meta rejects rather than re-classifies it as Marketing.

Copy each approved template's **Content SID** (starts with `HX`).

Templates in other languages (optional): create the same template in, say, Hindi, keeping button ID `cc_show`. Then set `TWILIO_TEMPLATE_UPDATE_HI` / `TWILIO_TEMPLATE_ALERT_HI`. Anyone without a template in their language gets the English one.

## 2. Railway variables (in addition to those in `web/README.md`)

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account info (`AC…`) |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Account info |
| `TWILIO_WHATSAPP_FROM` | `+919035913536` |
| `PUBLIC_BASE_URL` | the Railway domain, e.g. `https://carecircle-production.up.railway.app` (no trailing slash needed). It **must** match what's in Twilio, or webhook signatures fail. |
| `TWILIO_TEMPLATE_UPDATE` | `HX…` of `carecircle_update_v2` |
| `TWILIO_TEMPLATE_ALERT` | `HX…` of `carecircle_alert_v2` |
| `TWILIO_TEMPLATE_ESCALATE` | `HX…` of `carecircle_escalate_v1` |
| `TWILIO_TEMPLATE_ESCALATE_SOLO` | `HX…` of `carecircle_escalate_solo_v1` |
| `WHATSAPP_ALLOWLIST` | while testing: comma-separated numbers allowed to receive messages, e.g. `+9198xxxxxxxx,+9199xxxxxxxx`. Remove it to go live for everyone. |
| `WHATSAPP_GATEWAY` | `off` stops all real sending (kill switch). The simulator keeps working. |

Sending only happens in live-clinic mode (`npm run clinic:*`, which `railway.json` already uses).

## 3. Twilio sender settings (Messaging → Senders → WhatsApp senders → +91 90359 13536)

| Field | Value |
|---|---|
| Webhook URL for incoming messages | `https://<railway-domain>/api/twilio/inbound`, HTTP POST |
| Fallback URL | leave empty (the incoming URL answers instantly; there's nothing to fall back to) |
| Status callback URL | leave empty: each message sets its own callback to `/api/twilio/status` |
| Messaging service | not needed |

These two webhook paths skip the `APP_PASSWORD` gate. Instead they check Twilio's signature, so nobody else can post to them.

## 4. Test before inviting patients

1. Set `WHATSAPP_ALLOWLIST` to your own number(s). In the live clinic, onboard a test patient with your number and a caregiver with a colleague's.
2. The welcome/consent message arrives as the **"new message"** template (you have never written to the number). Tap *Show message* to receive the welcome with YES / NO buttons.
3. Reply `YES`, then `BP 140/90`, then send a photo of a BP monitor and a voice note. Check that each one appears in the patient's record.
4. Trigger an alert (`BP 190/120`) and confirm the caregiver gets it, as text if they wrote in the last 24 h, or as the alert template if not.
5. Check `wa_status` in the database for anything `failed` and read its `wa_error`.
6. Top up the Twilio balance. Meta charges for each template message, and Twilio adds a per-message fee.

## Known limits

- The simulator's red **Call for help** button has no WhatsApp equivalent. On real WhatsApp, people raise an emergency by typing it (e.g. "chest pain"), which the engine already handles.
- Voice-note length isn't known for real WhatsApp audio, so the file title doesn't include it.
- Failed deliveries are recorded (`wa_status`), but not yet shown in the clinic UI.
- Only one server instance: the per-person send queue is held in memory (fine with `numReplicas: 1`).
