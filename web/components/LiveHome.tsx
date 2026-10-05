"use client";
// Live clinic landing: the persona picker. Everyone enters here and lands on their own page.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { avatarColor, homeFor, initials, useSession, type SessionUser } from "./client";

type PersonaKey = "ADMIN" | "DOCTOR" | "PA" | "PATIENT" | "CAREGIVER";

const PERSONAS: { key: PersonaKey; n: string; title: string; tag: string; can: string[]; empty: string }[] = [
  { key: "ADMIN", n: "01", title: "Clinic admin", tag: "Sets up the clinic and its people", can: ["Create the clinic", "Add doctors", "Add assistants", "Edit them any time"], empty: "" },
  { key: "DOCTOR", n: "02", title: "Doctor", tag: "Sees the whole story between visits", can: ["All patients at a glance", "Deep-dive patient dashboard", "Clinical notes & visits", "Onboard & edit patients", "Manage assistants"], empty: "The admin adds doctors" },
  { key: "PA", n: "03", title: "Assistant", tag: "Physician assistant (PA) who runs onboarding and records", can: ["Onboard patients", "Edit details & care circles", "Documents & notes", "Every patient's dashboard"], empty: "The admin adds assistants" },
  { key: "PATIENT", n: "04", title: "Patient", tag: "Just uses WhatsApp", can: ["Text readings in any words", "Tap reply buttons", "Send reports & voice notes", "🆘 Call for help", "See my dashboard"], empty: "Onboard a patient first" },
  { key: "CAREGIVER", n: "05", title: "Caregiver", tag: "Family who act on alerts", can: ["Get alerts on WhatsApp", "ACK and record the outcome", "Log readings for them", "See their dashboard"], empty: "Added when a patient is onboarded" },
];

export function LiveHome() {
  // The app's link always opens the persona picker; a signed-in user gets a "Continue as" shortcut.
  return <PersonaPicker />;
}

function PersonaPicker() {
  const { user, personas, clinic, switchTo, notifyChange, refresh } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState<PersonaKey | null>(null);
  const [stale, setStale] = useState(false);

  async function enter(p: SessionUser) {
    try {
      const r = await switchTo(p.id);
      notifyChange();
      router.push(homeFor(p, r?.patientIds ?? []));
    } catch {
      // The persona list is out of date (the clinic was reset or changed since this page loaded).
      await refresh().catch(() => undefined);
      setStale(true);
      setOpen(null);
    }
  }
  function pick(key: PersonaKey, people: SessionUser[]) {
    if (people.length === 1) return enter(people[0]);
    if (people.length > 1) setOpen(open === key ? null : key);
  }

  return (
    <main className="pp">
      <div className="pp-glow" aria-hidden />
      <header className="pp-head">
        <div className="pp-brand"><span className="brand-mark">💚</span> CareCircle</div>
        <p className="pp-kicker">{clinic ? clinic.name : "A new clinic"}</p>
        <h1>Who’s stepping in<br /><em>today?</em></h1>
        <p className="pp-sub">Between-visit care that runs on WhatsApp. Pick a role to see the product through their eyes. Each one lands on its own page.</p>
      </header>

      {user && (
        <div className="pp-continue">
          <span className="avatar" style={{ background: avatarColor(user.name) }}>{initials(user.name)}</span>
          <span>Signed in as <b>{user.name}</b></span>
          <button onClick={() => router.push(homeFor(user))}>Continue →</button>
        </div>
      )}
      {stale && <div className="pp-note">That person no longer exists. The clinic changed since this page loaded, so the list has been refreshed.</div>}

      <section className="pp-grid">
        {PERSONAS.map((p, i) => {
          const people = personas.filter((x) => x.role === p.key);
          const locked = p.key !== "ADMIN" && !clinic;
          const disabled = locked || people.length === 0;
          const start = p.key === "ADMIN" && !clinic;
          return (
            <article key={p.key} className={`pp-card p-${p.key.toLowerCase()} ${disabled ? "off" : ""} ${start ? "start" : ""} ${open === p.key ? "open" : ""}`} style={{ animationDelay: `${120 + i * 90}ms` }}>
              <button className="pp-hit" disabled={disabled} onClick={() => pick(p.key, people)} aria-expanded={people.length > 1 ? open === p.key : undefined}>
                <span className="pp-n">{p.n}</span>
                <span className="pp-title">{p.title}</span>
                <span className="pp-tag">{p.tag}</span>
                <ul>{p.can.map((c) => <li key={c}>{c}</li>)}</ul>
                <span className="pp-foot">
                  {start ? (
                    <b>Start here →</b>
                  ) : locked ? (
                    <small>After the admin sets up the clinic</small>
                  ) : people.length === 0 ? (
                    <small>{p.empty}</small>
                  ) : (
                    <>
                      <span className="pp-faces">
                        {people.slice(0, 4).map((x) => <span key={x.id} className="avatar" style={{ background: avatarColor(x.name) }}>{initials(x.name)}</span>)}
                        {people.length > 4 && <span className="avatar more">+{people.length - 4}</span>}
                      </span>
                      <b>{people.length === 1 ? `Enter as ${people[0].name}` : `Choose from ${people.length} →`}</b>
                    </>
                  )}
                </span>
              </button>
              {open === p.key && (
                <div className="pp-people">
                  {people.map((x) => (
                    <button key={x.id} onClick={() => enter(x)}>
                      <span className="avatar" style={{ background: avatarColor(x.name) }}>{initials(x.name)}</span>
                      <span><b>{x.name}</b><small>{x.title || ""}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </section>

      <footer className="pp-foot-note">
        <span>Doctors are never paged: the family care circle owns every alert.</span>
        <span>Demo tools · <kbd>Shift</kbd> + <kbd>D</kbd></span>
      </footer>
    </main>
  );
}
