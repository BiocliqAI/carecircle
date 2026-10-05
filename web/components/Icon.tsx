// Line icons for the clinician UI (stroke icons, inherit currentColor). Emoji stay inside WhatsApp only.
const PATHS: Record<string, React.ReactNode> = {
  today: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  patients: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><circle cx="17.5" cy="9" r="2.5" /><path d="M17 14.6c2.3.3 3.9 1.9 4.5 4.9" /></>,
  assistant: <><path d="M8 4h8v4a4 4 0 0 1-8 0z" /><path d="M4 20c1-4 4.4-6 8-6s7 2 8 6" /></>,
  tasks: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></>,
  draft: <><path d="M5 4h10l4 4v12H5z" /><path d="M9 13h6M9 17h4" /></>,
  clinic: <><path d="M4 20V8l8-4 8 4v12" /><path d="M10 20v-5h4v5M12 8v4M10 10h4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4.5l3 2" /></>,
  alert: <><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17.5v.5" /></>,
  chat: <path d="M4 5h16v11H8l-4 4z" />,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  clip: <path d="M21 12.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10.4 18.3a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />,
  pill: <><rect x="3" y="8" width="18" height="8" rx="4" /><path d="M12 8v8" /></>,
  userx: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><path d="M17 8l4 4M21 8l-4 4" /></>,
  swap: <path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" />,
  logout: <><path d="M9 4H5v16h4" /><path d="M15 8l4 4-4 4M19 12H9" /></>,
  phone: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  heart: <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />,
};

export function Icon({ name, size = 18, stroke = 1.9, className, title }: { name: keyof typeof PATHS | string; size?: number; stroke?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {PATHS[name] ?? null}
    </svg>
  );
}

/** The CareCircle mark (two overlapping circles). */
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <span className="cc-mark" style={{ width: size, height: size }}>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="#06221F" strokeWidth="2.2" aria-hidden="true"><circle cx="9" cy="12" r="5" /><circle cx="15" cy="12" r="5" /></svg>
    </span>
  );
}
