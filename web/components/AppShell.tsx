"use client";
// App chrome. Clinicians get a sidebar that follows the clinic's day (Today → Patients → Team → Settings);
// patients and caregivers get a simple top bar; presenter tools live in one Demo panel.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { avatarColor, homeFor, initials, ROLE_LABEL, useSession } from "./client";
import { DemoPanel } from "./DemoPanel";
import { Icon, Mark } from "./Icon";
import { fmtDateTime } from "@/lib/time";

const DemoCtx = createContext<{ open: () => void }>({ open: () => undefined });
export const useDemoPanel = () => useContext(DemoCtx);

type NavItem = [href: string, label: string, icon: string, active: (p: string) => boolean];
const NAV: Record<string, NavItem[]> = {
  ADMIN: [["/admin", "Clinic & staff", "clinic", (p) => p === "/admin"]],
  DOCTOR: [
    ["/doctor", "Today", "today", (p) => p === "/doctor"],
    ["/patients", "Patients", "patients", (p) => p.startsWith("/patients")],
    ["/team", "Assistants", "assistant", (p) => p === "/team"],
  ],
  PA: [
    ["/doctor", "Today", "tasks", (p) => p === "/doctor"],
    ["/patients", "Patients", "patients", (p) => p.startsWith("/patients")],
  ],
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const path = usePathname() ?? "/";
  const router = useRouter();

  // Signed-out visitors to a dashboard page go to the sign-in (or setup) screen.
  useEffect(() => {
    if (!loading && !user && path !== "/" && path !== "/whatsapp") router.replace("/");
  }, [loading, user, path, router]);
  const [panel, setPanel] = useState(false);
  const [hidden, setHidden] = useState(true); // decided on mount (avoids a flash of the button)

  useEffect(() => {
    try {
      const pref = localStorage.getItem("cc_demo_hidden");
      // Live clinic: hidden unless the presenter brought it back (Shift+D). Sample demo: shown.
      setHidden(pref === "1" || (pref === null && document.documentElement.dataset.mode === "live"));
    } catch { /* storage unavailable */ }
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "d") {
        setHidden(false);
        try { localStorage.setItem("cc_demo_hidden", "0"); } catch { /* storage unavailable */ }
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

  const { mode } = useSession();
  const clinician = !!user && (user.role === "DOCTOR" || user.role === "PA");
  const bare = path === "/" && mode === "live"; // the persona picker is full-bleed
  const withSidebar = !!user && !!NAV[user.role] && path !== "/" && path !== "/whatsapp";

  return (
    <DemoCtx.Provider value={{ open: () => setPanel(true) }}>
      {withSidebar ? (
        <div className="shell">
          <Sidebar path={path} />
          <div className="shell-main">{children}</div>
        </div>
      ) : bare ? (
        children
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
      <Mark />
      <span className="brand-text">
        CareCircle
        {mode === "live" && clinic ? <small>{clinic.name}</small> : mode === "demo" ? <small>Sample clinic</small> : null}
      </span>
    </Link>
  );
}

function useSwitchPersona() {
  const { switchTo, notifyChange } = useSession();
  const router = useRouter();
  return async () => {
    await switchTo(null).catch(() => null);
    notifyChange();
    router.push("/");
  };
}

function Sidebar({ path }: { path: string }) {
  const { user, clock } = useSession();
  const switchPersona = useSwitchPersona();
  const items = user ? NAV[user.role] ?? [] : [];
  return (
    <aside className="sidebar">
      <Brand />
      {user && (user.role === "DOCTOR" || user.role === "PA") && <Link href="/patients/new" className="side-cta"><Icon name="plus" size={16} stroke={2.2} />Onboard patient</Link>}
      <nav>
        {items.map(([href, label, icon, active]) => (
          <Link key={href} href={href} className={active(path) ? "active" : ""}>
            <Icon name={icon} />{label}
          </Link>
        ))}
      </nav>
      <div className="side-foot">
        {clock?.offsetMs ? <div className="side-clock" title="The demo clock has been moved forward">⏩ {fmtDateTime(clock.now)}</div> : null}
        {user && (
          <div className="side-user">
            <span className="avatar" style={{ background: avatarColor(user.name) }}>{initials(user.name)}</span>
            <span style={{ flex: 1, minWidth: 0 }}><b>{user.name}</b><small>{ROLE_LABEL[user.role]}</small></span>
          </div>
        )}
        <button className="side-switch" onClick={switchPersona}><Icon name="swap" size={15} /> Switch persona</button>
      </div>
    </aside>
  );
}

function SimpleBar({ path, clinician }: { path: string; clinician: boolean }) {
  const { user } = useSession();
  const switchPersona = useSwitchPersona();
  const back = user && path === "/whatsapp" ? homeFor(user) : null;
  return (
    <header className="topbar">
      <Brand />
      <nav>
        {back && <Link href={back}>← Back</Link>}
        {!clinician && user && path !== "/me" && <Link href="/me">My page</Link>}
      </nav>
      <div className="spacer" />
      {user ? (
        <div className="row" style={{ gap: 8 }}>
          <div className="who-chip">
            <span className="avatar" style={{ background: avatarColor(user.name), width: 28, height: 28, fontSize: 11 }}>{initials(user.name)}</span>
            <span>{user.name}<small>{user.role === "CAREGIVER" || user.role === "PATIENT" ? user.title : ROLE_LABEL[user.role]}</small></span>
          </div>
          <button className="btn sm topbar-switch" onClick={switchPersona}>⇄ Switch persona</button>
        </div>
      ) : null}
    </header>
  );
}
