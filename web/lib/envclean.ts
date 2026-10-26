// Settings pasted into a hosting dashboard often keep the quotes from a .env file ("ACxx..." instead of ACxx...).
// The quotes then become part of the value: Twilio logins and webhook signatures fail, and a quoted CARECIRCLE_DB puts
// the database outside the persistent volume. This strips one pair of matching surrounding quotes from the app's own
// settings, once at startup, and names the settings it fixed (never their values).
const OURS = /^(APP_|CARECIRCLE_|TWILIO_|WHATSAPP_|GEMINI_|GOOGLE_API_KEY$|PUBLIC_BASE_URL$)/;

export function unquote(v: string): string {
  const m = /^\s*(["'])([\s\S]*)\1\s*$/.exec(v);
  return m ? m[2] : v;
}

/** Returns the names of the settings whose surrounding quotes were removed. */
export function unquoteEnv(env: Record<string, string | undefined> = process.env): string[] {
  const fixed: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!OURS.test(k) || typeof v !== "string") continue;
    const u = unquote(v);
    if (u !== v) { env[k] = u; fixed.push(k); }
  }
  return fixed;
}
