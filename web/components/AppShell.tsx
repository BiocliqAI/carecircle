"use client";
// App chrome. Clinicians get a sidebar that follows the clinic's day (Today → Patients → Team → Settings);
// patients and caregivers get a simple top bar; presenter tools live in one Demo panel.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { avatarColor, initials, ROLE_LABEL, useSession } from "./client";
import { DemoPanel } from "./DemoPanel";
import { fmtDateTime } from "@/lib/time";

const DemoCtx = createContext<{ open: () => void }>({ open: () => undefined });
export const useDemoPanel = () => useContext(DemoCtx);

const NAV: [string, string, string, (p: string) => boolean][] = [
  ["/doctor", "Today", "☀️", (p) => p === "/doctor"],
  ["/patients", "Patients", "👥", (p) => p.startsWith("/patients")],
  ["/team", "Team", "🩺", (p) => p === "/team"],
  ["/settings", "Clinic settings", "⚙️", (p) => p === "/settings"],
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const path = usePathname() ?? "/";
  const router = useRouter();

  // Signed-out visitors to a dashboard page go to the sign-in (or setup) screen.
  useEffect(() => {
    if (!loading && !user && path !== "/" && path !== "/whatsapp") router.replace("/");
  }, [loading, user, path, router]);
  const [panel, setPanel] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try { setHidden(localStorage.getItem("cc_demo_hidden") === "1"); } catch { /* storage unavailable */ }
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "d") {
        setHidden(false);
        try { localStorage.removeItem("cc_demo_hidden"); } catch { /* storage unavailable */ }
        setPanel((x) => !x);
      }
      if (e.key === "Escape") setPanel(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hide = () => {
    setHidden(true);
    setPanel(false);
    try { localStorage.setItem("cc_demo_hidden", "1"); } catch { /* storage unavailable */ }
  };

  const clinician = !!user && (user.role === "DOCTOR" || user.role === "PA");
  const withSidebar = clinician && path !== "/" && path !== "/whatsapp";

  return (
    <DemoCtx.Provider value={{ open: () => setPanel(true) }}>
      {withSidebar ? (
        <div className="shell">
          <Sidebar path={path} />
          <div className="shell-main">{children}</div>
        </div>
      ) : (
        <>
          <SimpleBar path={path} clinician={clinician} />
          {children}
        </>
      )}
      {!hidden && !panel && (
        <button className="demo-launch" onClick={() => setPanel(true)} title="Demo tools (Shift+D)">🎬 Demo</button>
      )}
      <DemoPanel open={panel} onClose={() => setPanel(false)} onHide={hide} />
    </DemoCtx.Provider>
  );
}

function Brand() {
  const { mode, clinic } = useSession();
  return (
    <Link href="/" className="brand">
      <span className="brand-mark">💚</span>
      <span className="brand-text">
        CareCircle
        {mode === "live" && clinic ? <small>{clinic.name}</small> : mode === "demo" ? <small>Sample clinic</small> : null}
      </span>
    </Link>
  );
}

function Sidebar({ path }: { path: string }) {
  const { user, clock } = useSession();
  const { open } = useDemoPanel();
  return (
    <aside className="sidebar">
      <Brand />
      <Link href="/patients/new" className="btn primary side-cta">+ Onboard patient</Link>
      <nav>
        {NAV.map(([href, label, icon, active]) => (
          <Link key={href} href={href} className={active(path) ? "active" : ""}>
            <span className="ic" aria-hidden>{icon}</span>{label}
          </Link>
        ))}
      </nav>
      <div className="side-foot">
        {clock?.offsetMs ? <div className="side-clock" title="The demo clock has been moved forward">⏩ {fmtDateTime(clock.now)}</div> : null}
        {user && (
          <button className="side-user" onClick={open} title="Switch user (Demo tools)">
            <span className="avatar" style={{ background: avatarColor(user.name) }}>{initials(user.name)}</span>
            <span><b>{user.name}</b><small>{ROLE_LABEL[user.role]}</small></span>
          </button>
        )}
      </div>
    </aside>
  );
}

function SimpleBar({ path, clinician }: { path: string; clinician: boolean }) {
  const { user } = useSession();
  const { open } = useDemoPanel();
  const family = !!user && !clinician;
  return (
    <header className="topbar">
      <Brand />
      <nav>
        {clinician && <Link href="/doctor">← Back to clinic</Link>}
        {family && <Link href="/home" className={path === "/home" || path.startsWith("/patients") ? "active" : ""}>My dashboard</Link>}
      </nav>
      <div className="spacer" />
      {user ? (
        <button className="who-chip" onClick={open} title="Switch user (Demo tools)">
          <span className="avatar" style={{ background: avatarColor(user.name), width: 28, height: 28, fontSize: 11 }}>{initials(user.name)}</span>
          <span>{user.name}<small>{user.role === "CAREGIVER" || user.role === "PATIENT" ? user.title : ROLE_LABEL[user.role]}</small></span>
        </button>
      ) : null}
    </header>
  );
}
