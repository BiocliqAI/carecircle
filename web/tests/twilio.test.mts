import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-twilio-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.CARECIRCLE_MODE = "live";
process.env.CARECIRCLE_SCHEDULER = "off";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "secret";
process.env.TWILIO_WHATSAPP_FROM = "+91 90359 13536";
process.env.PUBLIC_BASE_URL = "https://care.example.com/";
process.env.TWILIO_TEMPLATE_UPDATE = "HXupdate";
process.env.TWILIO_TEMPLATE_ALERT = "HXalert";
delete process.env.GEMINI_API_KEY;
delete process.env.WHATSAPP_ALLOWLIST;

const { get, run, setSetting } = await import("../lib/db");
const tw = await import("../lib/twilio");
const wa = await import("../lib/whatsapp");
const { now } = await import("../lib/clock");

type Call = { url: string; form?: URLSearchParams; json?: Record<string, unknown> };
let calls: Call[] = [];
let sidN = 0;
let failNext: { code: number; message: string } | null = null;
tw.setTwilioFetch((async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const call: Call = { url };
  if (init?.body instanceof URLSearchParams) call.form = init.body;
  else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
  calls.push(call);
  if (failNext) { const f = failNext; failNext = null; return new Response(JSON.stringify(f), { status: 400 }); }
  return new Response(JSON.stringify({ sid: url.includes("content.twilio.com") ? "HXbuttons" : `SM${++sidN}` }), { status: 201 });
}) as typeof fetch);

run("INSERT INTO users(id, name, role, phone, title) VALUES('u_pat','Ramesh Kumar','PATIENT','+91 98860 20001','Patient')");
run("INSERT INTO users(id, name, role, phone, title) VALUES('u_cg','Lakshmi Kumar','CAREGIVER','098860 20002','Wife')");
run("INSERT INTO users(id, name, role, phone, title) VALUES('u_dr','Dr. Rao','DOCTOR','+91 98450 10001','MD')");
run("INSERT INTO patients(id, user_id, name, phone, doctor_id, created_at) VALUES('p1','u_pat','Ramesh Kumar','+91 98860 20001','u_dr',0)");

const sends = () => calls.filter((c) => c.url.includes("/Messages.json"));
const status = (id: number) => get<{ wa_status: string; wa_error: string | null }>("SELECT wa_status, wa_error FROM messages WHERE id = ?", id)!;
const send = (userId: string, body: string, extra: { quick?: string[]; kind?: string; at?: number } = {}) =>
  wa.sendWhatsApp({ userId, patientId: "p1", body, quick: extra.quick, kind: extra.kind ?? "reply", at: extra.at ?? now() });
const openWindow = (u: string) => setSetting(`wa:lastin:${u}`, String(Date.now()));
const closeWindow = (u: string) => { run("DELETE FROM settings WHERE key IN (?, ?)", `wa:lastin:${u}`, `wa:nudge:${u}`); };

beforeEach(() => { calls = []; failNext = null; });

describe("twilio: numbers and signatures", () => {
  it("normalises Indian numbers in the forms people type them", () => {
    assert.equal(tw.e164("+91 98860 20001"), "+919886020001");
    assert.equal(tw.e164("098860 20002"), "+919886020002");
    assert.equal(tw.e164("9886020003"), "+919886020003");
    assert.equal(tw.e164("whatsapp:+14155238886"), "+14155238886");
    assert.equal(tw.e164("12"), null);
  });
  it("finds patients and caregivers by WhatsApp number, never clinic staff", () => {
    assert.equal(wa.userByPhone("whatsapp:+919886020001")?.id, "u_pat");
    assert.equal(wa.userByPhone("whatsapp:+919886020002")?.id, "u_cg");
    assert.equal(wa.userByPhone("whatsapp:+919845010001"), undefined);
  });
  it("accepts Twilio's signature over the public URL and rejects a tampered request", () => {
    const cfg = tw.twilioConfig()!;
    const params = { Body: "BP 140/90", From: "whatsapp:+919886020001", MessageSid: "SM1" };
    const url = "https://care.example.com/api/twilio/inbound";
    const sig = tw.twilioSignature("secret", url, params);
    assert.ok(tw.validSignature(cfg, sig, url, params));
    assert.ok(!tw.validSignature(cfg, sig, url, { ...params, Body: "BP 120/80" }));
    assert.ok(!tw.validSignature(cfg, null, url, params));
    assert.equal(tw.signedUrl(cfg, new Request("http://10.0.0.5:8080/api/twilio/inbound")), url);
  });
});

describe("twilio: delivery", () => {
  it("sends a plain reply inside the 24-hour window, with a status callback", async () => {
    openWindow("u_pat");
    const id = send("u_pat", "✅ Logged BP 140/90.");
    await wa.deliveriesSettled();
    const [c] = sends();
    assert.equal(c.form!.get("To"), "whatsapp:+919886020001");
    assert.equal(c.form!.get("From"), "whatsapp:+919035913536");
    assert.equal(c.form!.get("Body"), "✅ Logged BP 140/90.");
    assert.equal(c.form!.get("StatusCallback"), "https://care.example.com/api/twilio/status");
    assert.equal(status(id).wa_status, "sent");
  });

  it("turns up to 3 short choices into WhatsApp buttons, creating the button set only once", async () => {
    openWindow("u_pat");
    send("u_pat", "Did you take Metformin?", { quick: ["Taken", "Skipped"] });
    send("u_pat", "Did you take Amlodipine?", { quick: ["Taken", "Skipped"] });
    await wa.deliveriesSettled();
    const creates = calls.filter((c) => c.url.includes("content.twilio.com"));
    assert.equal(creates.length, 1);
    assert.ok((creates[0].json!.types as Record<string, unknown>)["twilio/quick-reply"]);
    assert.deepEqual(sends().map((c) => c.form!.get("ContentSid")), ["HXbuttons", "HXbuttons"]);
    assert.equal(JSON.parse(sends()[1].form!.get("ContentVariables")!)["1"], "Did you take Amlodipine?");
  });

  it("lists choices as text when they don't fit WhatsApp's button limits", async () => {
    openWindow("u_pat");
    send("u_pat", "Which one?", { quick: ["A very long option label that is too long for a button", "B"] });
    await wa.deliveriesSettled();
    assert.match(sends()[0].form!.get("Body")!, /Reply with: \*A very long.*\* \/ \*B\*/);
  });

  it("outside the window: holds the message, sends one 'new message' template, and delivers on their reply", async () => {
    closeWindow("u_cg");
    const a = send("u_cg", "🌙 Evening digest for Ramesh", { kind: "info" });
    const b = send("u_cg", "Reminder: walk 20 min", { kind: "reminder" });
    await wa.deliveriesSettled();
    assert.equal(status(a).wa_status, "waiting");
    assert.equal(status(b).wa_status, "waiting");
    assert.equal(sends().length, 1, "one template, not one per message");
    assert.equal(sends()[0].form!.get("ContentSid"), "HXupdate");
    assert.equal(JSON.parse(sends()[0].form!.get("ContentVariables")!)["1"], "Lakshmi");

    calls = [];
    wa.inboundReceived("u_cg");
    await wa.deliveriesSettled();
    assert.deepEqual(sends().map((c) => c.form!.get("Body")), ["🌙 Evening digest for Ramesh", "Reminder: walk 20 min"]);
    assert.equal(status(a).wa_status, "sent");
  });

  it("a message sent before they were onboarded opens the window for their welcome", async () => {
    closeWindow("u_cg");
    wa.strangerWrote("whatsapp:+919886020002");
    const id = send("u_cg", "👋 Welcome to CareCircle", { kind: "info", quick: ["YES", "NO"] });
    await wa.deliveriesSettled();
    assert.equal(status(id).wa_status, "sent");
    run("DELETE FROM settings WHERE key = 'wa:lastin:+919886020002'");
  });

  it("outside the window: an alert always goes out as the alert template, with its first line", async () => {
    closeWindow("u_cg");
    const id = send("u_cg", "⚠️ *Ramesh*: BP 182/110\nPlease check on him now.", { kind: "escalation", quick: ["I'll handle it"] });
    await wa.deliveriesSettled();
    const vars = JSON.parse(sends()[0].form!.get("ContentVariables")!);
    assert.equal(sends()[0].form!.get("ContentSid"), "HXalert");
    assert.equal(vars["2"], "Ramesh");
    assert.equal(vars["3"], "⚠️ Ramesh: BP 182/110 · Please check on him now.");
    assert.equal(status(id).wa_status, "waiting");
  });

  it("falls back to holding the message when Twilio says the window is closed (63016)", async () => {
    openWindow("u_pat");
    run("DELETE FROM settings WHERE key = 'wa:nudge:u_pat'");
    failNext = { code: 63016, message: "Outside window" };
    const id = send("u_pat", "Time for your evening medicines");
    await wa.deliveriesSettled();
    assert.equal(status(id).wa_status, "waiting");
    assert.equal(sends().at(-1)!.form!.get("ContentSid"), "HXupdate");
  });

  it("does not send messages generated long ago (a server restart catching up)", async () => {
    openWindow("u_pat");
    const id = send("u_pat", "Old reminder", { at: now() - 3 * 3600_000 });
    await wa.deliveriesSettled();
    assert.equal(sends().length, 0);
    assert.equal(status(id).wa_status, "expired");
  });

  it("follows delivery receipts forward only", async () => {
    openWindow("u_pat");
    const id = send("u_pat", "Hello");
    await wa.deliveriesSettled();
    const sid = get<{ wa_sid: string }>("SELECT wa_sid FROM messages WHERE id = ?", id)!.wa_sid;
    wa.deliveryStatus(sid, "delivered", null);
    wa.deliveryStatus(sid, "sent", null);
    assert.equal(status(id).wa_status, "delivered");
    wa.deliveryStatus(sid, "read", null);
    wa.deliveryStatus(sid, "failed", "30008");
    assert.equal(status(id).wa_status, "read");
  });

  it("splits long messages on line breaks within Twilio's limit", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Line ${i}: ${"x".repeat(30)}`).join("\n");
    const parts = wa.splitText(long, 1500);
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1500));
    assert.equal(parts.join("\n"), long);
  });
});
