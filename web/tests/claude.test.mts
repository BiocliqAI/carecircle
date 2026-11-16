import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

// A stand-in for the Anthropic Messages API on localhost: records each request and streams back a scripted reply.
type Reply = { status?: number; text?: string; stop?: string };
const seen: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let next: Reply = {};
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
    if (next.status && next.status !== 200) {
      res.writeHead(next.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    }
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      ev("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: next.text ?? "" } }) +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", { delta: { stop_reason: next.stop ?? "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) +
      ev("message_stop", {}),
    );
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-0000000000000000000000";
delete process.env.CLAUDE_MODEL;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

const claude = await import("../lib/claude");
const ai = await import("../lib/gemini");
const { parseMessage } = await import("../lib/parser");

const JPG = { base64: "data:image/jpeg;base64,/9j/4AAQSkZJRg==", mime: "image/jpeg" };

describe("Claude for documents and reasoning, Gemini for speech", () => {
  before(() => { seen.length = 0; });
  beforeEach(() => { next = {}; });
  after(() => { server.close(); });

  it("knows which inputs Claude can read", () => {
    assert.equal(claude.claudeCanRead([{ type: "text", text: "x" }, { type: "document", data: "AA", mime_type: "application/pdf" }, { type: "image", data: "AA", mime_type: "image/jpg" }]), true);
    assert.equal(claude.claudeCanRead([{ type: "image", data: "AA", mime_type: "image/heic" }]), false);
    assert.equal(claude.claudeCanRead([{ type: "audio", data: "AA", mime_type: "audio/ogg" }]), false);
    assert.equal(claude.jsonFrom('Here it is:\n```json\n{"a": 1}\n```'), '{"a": 1}');
  });

  it("reports Claude as the reading model when its key is set", () => {
    assert.equal(ai.isAIConfigured(), true);
    assert.equal(ai.isGeminiConfigured(), false);
    assert.equal(ai.aiModel(), "claude-opus-5-5");
  });

  it("sends a photo to Claude, image first, with the refusal fallback, and reads the JSON back", async () => {
    next = { text: '```json\n{"isDevice": true, "device": "bp", "readings": {"sys": 138, "dia": 86}, "confidence": "high"}\n```' };
    const r = await ai.readDeviceAI(JPG.base64, JPG.mime);
    assert.deepEqual((r as { readings: unknown }).readings, { sys: 138, dia: 86 });
    const req = seen.at(-1)!;
    assert.equal(req.body.model, "claude-opus-5-5");
    assert.equal(req.body.stream, true);
    assert.equal(req.body.fallbacks, "default");
    assert.match(String(req.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.deepEqual(req.body.output_config, { effort: "low" });
    assert.match(String(req.body.system), /Reply with only the JSON object/);
    const content = (req.body.messages as { content: { type: string; source?: { media_type: string; data: string } }[] }[])[0].content;
    assert.deepEqual(content.map((c) => c.type), ["image", "text"]);
    assert.equal(content[0].source!.media_type, "image/jpeg");
    assert.equal(content[0].source!.data, "/9j/4AAQSkZJRg==", "the data: prefix is removed");
  });

  it("sends PDFs as documents", async () => {
    next = { text: '{"conditions": ["CKD stage 4"], "labs": []}' };
    const r = await ai.extractBaselineAI([{ base64: "JVBERi0xLjQ=", mime: "application/pdf" }, JPG], ["creatinine"]);
    assert.deepEqual((r as { conditions: string[] }).conditions, ["CKD stage 4"]);
    const content = (seen.at(-1)!.body.messages as { content: { type: string }[] }[])[0].content;
    assert.deepEqual(content.map((c) => c.type), ["document", "image", "text"]);
    assert.deepEqual(seen.at(-1)!.body.output_config, { effort: "high" });
  });

  it("reads a Word prescription on the visit screen as text", async () => {
    const { readFileSync } = await import("node:fs");
    next = { text: "Lasix 40 mg 1-1/2-0" };
    const doc = readFileSync(new URL("./fixtures/rx.doc", import.meta.url)).toString("base64");
    assert.equal(await ai.readPrescriptionAI(doc, "", "rx.doc"), "Lasix 40 mg 1-1/2-0");
    const content = (seen.at(-1)!.body.messages as { content: { type: string; text?: string }[] }[])[0].content;
    assert.ok(content.every((c) => c.type === "text"));
    assert.ok(content.some((c) => /Dr Dileep KS/.test(c.text ?? "")));
    await assert.rejects(ai.readPrescriptionAI("AAAA", "application/zip", "x.zip"), /can't be read/);
  });

  it("parses WhatsApp messages with Claude", async () => {
    next = { text: JSON.stringify({ vitals: [{ type: "bp", v1: 150, v2: 95 }], meds: { allTaken: true, allMissed: false, taken: [], missed: [] }, physio: null, lifestyle: null, symptoms: [], noSymptoms: true, help: false, fluids: [], labs: [], medChanges: [], outsideVisit: false, language: "en" }) };
    const { parsed, parser } = await parseMessage("BP 150/95, took all tablets", [{ key: "lasix", name: "Lasix" }]);
    assert.equal(parser, "claude-opus-5-5");
    assert.equal(parsed.vitals[0].v1, 150);
    assert.equal(parsed.meds.allTaken, true);
  });

  it("audio never goes to Claude: without a Gemini key it says Gemini is needed", async () => {
    const n = seen.length;
    assert.equal(await ai.transcribeConversationAI("UklGRg==", "audio/ogg"), null);
    assert.equal(await ai.transcribeAudio("UklGRg==", "audio/ogg"), null);
    assert.equal(ai.lastTranscribeError, "Gemini is not configured");
    assert.equal(seen.length, n, "no request reached Claude");
  });

  it("a HEIC photo Claude can't read is reported clearly", async () => {
    assert.equal(await ai.readPrescriptionAI("AAAA", "image/heic"), null);
    assert.match(String(ai.lastTranscribeError), /can't read this file type/);
  });

  it("a bad key and a refusal come back as readable reasons", async () => {
    next = { status: 401 };
    assert.equal(await ai.familySummaryAI({ x: 1 }), null);
    assert.equal(ai.lastTranscribeError, "Anthropic API key not valid");
    next = { text: "", stop: "refusal" };
    assert.equal(await ai.familySummaryAI({ x: 1 }), null);
    assert.match(String(ai.lastTranscribeError), /declined/);
  });
});
