# CareCircle — MVP

Between-visit care for patients and families over **WhatsApp**, with a dashboard for doctors, PAs, caregivers and patients. Implements [`docs/PRD_V2.md`](../docs/PRD_V2.md).

## Run

```bash
cd web
npm install
npm run dev          # http://localhost:3000
```

- Requires Node ≥ 22.5 (uses the built-in `node:sqlite`).
- The database (`data/carecircle.db`) is created and seeded on the first request.
- Optional AI: `GEMINI_API_KEY=... npm run dev`. This enables the Gemini parser (`gemini-3.8-flash`, override with `GEMINI_MODEL`) and the AI pre-visit brief. Without a key, the deterministic parser is used.
- `npm test` runs the engine smoke test (seed, escalation ladder, timeouts, ACK/outcome, visit diff, and checks that the doctor received no messages).

## Live clinic mode (customer demos from scratch)

A second way to run the app: it starts **empty**, and the clinic, staff, patients, care circles and baselines are onboarded for real through the UI. It uses its own database (`data/clinic.db`), port and build folder, so it runs alongside the sample demo without touching it.

```bash
cd web
npm run clinic                        # http://localhost:3100 (dev server)
# or, for a smoother demo:
npm run clinic:build && npm run clinic:start
```

Flow:

1. **Setup** (`/`): clinic name and address, plus the first doctor. You're signed in as that doctor.
2. **Team** (`/team`): add more doctors and PAs (specialty, mobile, email, registration no.). Doctors see only their own patients; PAs see everyone. A **Getting started** checklist on **Today** shows the next step.
3. **+ New patient**: a 4-step wizard.
   - **Patient:** details, plus the treating doctor when a PA onboards.
   - **Care circle:** L1–L3 caregivers, with dashboard access per caregiver.
   - **Baseline:** DOB, language, blood group, height, intake vitals, conditions, allergies, history, lifestyle, current medicines, recent lab reports.
   - **Review.**
4. **WhatsApp consent**: the patient and each caregiver get a welcome message and reply **YES** or **NO** in the simulator. Status shows on Patient 360 and on the home checklist.
5. **Visit 1**: pre-filled from the baseline (current medicines with reminder times from OD/BD/TDS, intake vitals, allergy note). Saving it activates the care plan, and from then on it's the same engine as the demo.
6. **Reset between customers**: **Clinic settings → Start afresh**, or the Demo panel (type the clinic name to confirm). Gemini settings are kept.

Rules for baseline data:

- Baseline lab reports go into the lab history (source `BASELINE`) so trend lines start from them.
- They never raise care-circle alerts.

**Access from other devices:** the clinic server listens on all interfaces. A phone or laptop on the same Wi-Fi can open `http://<your-mac's-LAN-IP>:3100`; find the IP with `ipconfig getifaddr en0`. For a remote customer, share your screen.

**Backups:** `npm run clinic:backup` writes a consistent snapshot to `backups/clinic-<timestamp>.db`. It's safe while the app is running. To restore, stop the app and copy the snapshot over `data/clinic.db`.

**Password gate:** set `APP_PASSWORD` (and optionally `APP_USER`) to require HTTP Basic auth on every page and API route (`proxy.ts`). It's off when unset.

**Still demo-grade:** sign-in is the persona switcher, WhatsApp is the simulator, and everything is single-clinic SQLite on this Mac. See `docs/ROADMAP.md` for the production path (real auth, WhatsApp Business API, Postgres).

## Deploy to Railway (public test instance)

The repo root contains `docs/` and `web/`; the app lives in `web/`. `web/railway.json` sets the build and start commands, a single replica (SQLite) and a health check.

1. Railway → **New project → Deploy from GitHub repo**, and pick this repo.
2. Service **Settings → Source → Root directory**: `web`.
3. **Add a volume** to the service (right-click the service → *Attach volume*). Mount path: `/data`.
4. **Variables**:

   | Variable | Value |
   |---|---|
   | `CARECIRCLE_DB` | `/data/clinic.db` |
   | `APP_PASSWORD` | the shared password for testers (**required**: without it the site is open to anyone) |
   | `APP_USER` | optional, defaults to `carecircle` |
   | `GEMINI_API_KEY` | optional, enables AI parsing |
   | `NODE_VERSION` | `22` |

5. **Settings → Networking → Generate domain.** Open it, sign in with `APP_USER` / `APP_PASSWORD`, and set up the clinic.

Notes:

- **Replicas:** keep exactly 1. The database is a single SQLite file on the volume.
- **Scheduler:** a background timer (`instrumentation.ts`) runs it every minute, so reminders and escalations fire without traffic.
- **Backups:** run `npm run clinic:backup` from a Railway shell, or download `/data/clinic.db`.
- **Data:** synthetic data only. There are no per-user accounts, and everyone who has the password sees everything.

## Demo script (≈10 min)

1. **Login** (`/`): pick **Dr. Meera Rao**. **Today** lists the patients who need attention (all patients are under **Patients**). Ramesh's Visit 2 is today, and Abdul has a live SpO₂ alert waiting on Level 2 (shown for visibility; the clinic is not notified).
2. **Pre-visit brief**: open **Ramesh**. *Since last visit* shows adherence rings, highlights (BP trend, weight peak, knee pain → skipped walks), clinic baseline vs. home readings, and alerts with their outcomes. Then look at the *Adherence* heatmap, *Trends* and *Timeline* (every reading links to its WhatsApp message).
3. **WhatsApp** (`/whatsapp`): Ramesh and Lakshmi (L1) are shown side by side.
   - As Ramesh, send `BP 165/100, ankles swollen`. A deviation alert goes to Lakshmi.
   - Click **+1 h**. Lakshmi didn't respond, so the alert moves to Arjun (L2). Shift-click Arjun to open his phone.
   - As Arjun: `ACK` → `2` → `Called Dr Rao's clinic, advised extra furosemide`. Outcome recorded.
   - Try `Chest pain` for the urgent path (15-min ladder).
4. **Visit 2**: back on Ramesh, click **Start Visit 2**. The form is pre-filled with the current plan. Change a dose or add a medicine, then save. The **Visit comparison** opens: medicine diff, clinic vitals delta, and everything between the visits. Sunita already has two visits (knee replacement), so you can compare them directly.
5. **Family view**: switch persona to **Lakshmi** or **Ramesh** (top-right). They see the same longitudinal record, read-only. Caregivers can acknowledge or close alerts here too.
6. **Kidney Failure Care (A Gopal & Durai)**:
   - **Doctor isolation**: Sign in as **Dr. Dileep** (Nephrology). He sees *only* A Gopal. Dr. Meera Rao sees only her patients; PAs see all.
   - **Patient 360**: Open Gopal. The pre-visit brief features the **🫘 Kidney panel**: weight within the 59.2 ± 1.0 kg dry-weight band, daily fluid intake vs. 1000 ml limit, urine output, and latest labs with deltas vs. pre-visit baseline.
   - **🫘 Kidney & labs tab**: Long-range charts for weight vs. diuretic mg (with shaded dry band), fluid intake vs. urine output (with daily limit line), multi-panel lab series (creatinine, potassium, eGFR, urea, Hb, sodium), lab report history, lab entry form, and doctor care-team management.
   - **Medicine changes by other doctors**: Tracked with prescriber and status. Changes reported on WhatsApp or entered by clinicians are **logged, never auto-applied**. They await doctor review and reconciliation at the next visit.
   - **WhatsApp simulator**: Select **Durai** or **A Gopal**. Pre-made kidney chips demonstrate fluid logs (`Water 950 ml total, urine 850 ml`), lab reports (`creat 2.1 urea 68 K 4.9`), and med changes (`Dr Manoj Shah reduced Prizide to 30 mg`).
   - **Visit form**: "Apply kidney template" button, rich medicine rows (split doses like Lasix 40/20, courses, alternate-day, PRN), and the "Reconcile reported changes" panel.
7. **Onboarding**: as the doctor, use **+ New patient** → care circle → Visit 1 plan. The welcome and plan messages appear in the simulator.

**Layout:** clinicians get a sidebar with Today, Patients, Team, Clinic settings and **+ Onboard patient**. Patients and caregivers get a simple top bar with their own record.

**Demo tools:** the **🎬 Demo** button (bottom right, or **Shift+D**) opens one panel with:
- persona switching ("View as")
- the WhatsApp simulator
- **+15 min / +1 h / +6 h** clock fast-forward (fires reminders and escalation timeouts)
- **Simulate 7 days** (realistic replies for all patients)
- the Gemini key
- reset/erase

You can hide the Demo button so the clinic screens look like the product.

## Data provenance

Patient **A Gopal**'s data is grounded in the family's real record (`Appa blood sugar log and medicines.xlsx`). Real visits, lab reports, observations and 18 historical medicine changes up to 10 Sep 2026 are imported directly. Subsequent between-visit days are simulated with realistic WhatsApp logs and care-circle escalations. All patient data remains strictly local in SQLite (`data/carecircle.db`).

## Structure

| Path | What |
|---|---|
| `lib/engine.ts` | Tasks and reminders, compliance/deviation/urgent rules, escalation state machine, WhatsApp ingestion, visits, onboarding, kidney rules (dry weight, fluids, labs) |
| `lib/parser.ts` | Free-text parser: Gemini (JSON schema) with deterministic fallback (vitals, symptoms, fluids, labs, med changes) |
| `lib/meds.ts` | Medicine scheduling, split doses, course lengths, PRN and human-readable descriptions |
| `lib/summary.ts` | Interval summary (adherence, vitals, symptoms, alerts, highlights), kidney summary, long-range trends, and visit-to-visit diff |
| `lib/whatsapp.ts` | Gateway adapter (simulator now; Twilio / Meta Cloud API later) |
| `lib/clinic.ts` & `lib/mode.ts` | Live-clinic mode: clinic setup, staff, baseline intake (validation + storage), go-live checklist, reset |
| `lib/seed.ts` & `lib/seed_gopal.ts` | Demo clinics (Dr. Rao & Dr. Dileep), 4 patients with scripted between-visit history |
| `components/kidney.tsx` | Header badges, pre-visit kidney panel, long-range "Kidney & labs" tab, lab entry, med-change reconciliation, care team |
| `app/` | Pages (Today, Patients, Team, Clinic settings, Patient 360, record visit, compare, onboarding, WhatsApp simulator) and API routes |

Safety invariants: doctors and PAs never receive automated messages; AI never changes alert or escalation state; every observation keeps its source message and the person who logged it; medicine changes from other doctors are logged and reconciled, never auto-applied.
