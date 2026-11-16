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

  it("asks for every lab test the record tracks when reading a report, not a fixed few", async () => {
    const { LAB_META } = await import("../lib/types");
    next = { text: JSON.stringify({ documentType: "lab_report", documentTypeName: "Lab report", transcription: "", documentDate: "2024-02-13", extracted: { vitals: [], medications: [], symptoms: [],
      labs: [{ marker: "hba1c", label: "HBA1C", value: 7.0, unit: "%" }, { marker: "wbc", label: "Total WBC Count", value: 7900, unit: "/µL" }, { marker: "tsh", label: "TSH", value: 0.514, unit: "mIU/L" }, { marker: "creatinine", label: "Creatinine", value: 2.91, unit: "mg/dL" }] } }) };
    const r = await ai.analyzeDocumentOCR({ imageBase64: "JVBERi0xLjQ=", mimeType: "application/pdf" });
    assert.deepEqual(r.extracted.labs.map((l) => l.marker), ["hba1c", "wbc", "tsh", "creatinine"]);
    const system = String(seen.at(-1)!.body.system);
    for (const k of Object.keys(LAB_META)) assert.ok(system.includes(`${k} = ${LAB_META[k].label}`), `prompt lists ${k}`);
    assert.match(system, /EVERY numeric result/);
  });

  it("learns a lab test it hasn't seen before and keeps every numeric result of a report", async () => {
    const { LAB_META } = await import("../lib/types");
    const { resolveMarker, loadLearnedMarkers } = await import("../lib/labmarkers");
    const { getSetting } = await import("../lib/db");
    // Known tests by key or by name; nothing new is learned for them.
    assert.equal(resolveMarker("hba1c", "HbA1c", "%"), "hba1c");
    assert.equal(resolveMarker("glycated_hb", "HbA1c", "%"), "hba1c");
    assert.equal(resolveMarker("", "", "U/L"), null);
    // A new test: learned once, stored, and from then on known.
    assert.equal(LAB_META.ldh, undefined);
    assert.equal(resolveMarker("LDH", "Lactate dehydrogenase", "U/L"), "ldh");
    assert.deepEqual({ label: LAB_META.ldh.label, unit: LAB_META.ldh.unit }, { label: "Lactate dehydrogenase", unit: "U/L" });
    assert.ok(JSON.parse(getSetting("lab_markers")!).ldh);
    assert.ok(loadLearnedMarkers().ldh);

    // Through the Documents tab reader: a new test in a report is kept, not dropped.
    const { run } = await import("../lib/db");
    const { extractDocument } = await import("../lib/docauto");
    run("INSERT OR IGNORE INTO users(id, name, role, phone, title) VALUES('u_t_doc','Dr T','DOCTOR','+919800000077','Doctor')");
    run("INSERT OR IGNORE INTO patients(id, user_id, name, age, sex, phone, conditions, address, doctor_id, created_at) VALUES('p_t', NULL, 'T Patient', 70, 'M', '+919800000078', '', '', 'u_t_doc', 0)");
    const docId = run("INSERT INTO patient_documents(patient_id, title, category, mime, size, data, source, uploaded_by, uploaded_at) VALUES('p_t','report','lab','application/pdf',4,?, 'clinic','u_t_doc',0)", new Uint8Array([37, 80, 68, 70])).lastInsertRowid;
    next = { text: JSON.stringify({ documentType: "lab_report", documentTypeName: "Lab report", transcription: "", documentDate: "2024-02-13", extracted: { vitals: [], medications: [], symptoms: [],
      labs: [{ marker: "hba1c", label: "HBA1C", value: 7.0, unit: "%" }, { marker: "procalcitonin", label: "Procalcitonin", value: 0.12, unit: "ng/mL" }, { marker: "bad", label: "", value: "n/a", unit: "" }],
      texts: [{ test: "Urine Albumin", group: "Urine routine", result: "Absent", reference: "ABSENT" }, { test: "Pus cells", group: "Urine deposits", result: "20-30", reference: "0 - 5" }, { test: "", result: "x" }] } }) };
    const x = await extractDocument(Number(docId));
    assert.deepEqual(x!.labs.map((l) => l.marker), ["hba1c", "procalcitonin"]);
    // Results that aren't numbers are kept, as printed, and filed with the report's date when the checker confirms.
    assert.deepEqual(x!.texts!.map((r) => `${r.group}|${r.test}|${r.result}`), ["Urine routine|Urine Albumin|Absent", "Urine deposits|Pus cells|20-30"]);
    const { autoFile } = await import("../lib/docauto");
    const { all } = await import("../lib/db");
    const filed = autoFile(Number(docId), "u_t_doc", Date.parse("2026-11-16T10:00:00+05:30"), { texts: [...x!.texts!, { test: "Colour", group: "Urine routine", result: "Yellow" }] });
    assert.equal(filed.texts, 3);
    const rows = all<{ test: string; result: string; taken_at: number; document_id: number }>("SELECT test, result, taken_at, document_id FROM lab_texts WHERE patient_id = 'p_t' ORDER BY id");
    assert.deepEqual(rows.map((r) => `${r.test}=${r.result}`), ["Urine Albumin=Absent", "Pus cells=20-30", "Colour=Yellow"]);
    assert.ok(rows.every((r) => r.taken_at === Date.parse("2024-02-13T09:00:00+05:30") && r.document_id === Number(docId)));
    assert.equal(all("SELECT 1 FROM labs WHERE patient_id = 'p_t'").length, 2, "the numbers go to the lab history as before");
    const { enterTexts } = await import("../lib/docauto");
    assert.equal(enterTexts("p_t", [{ test: "Colour", group: "Urine routine", result: "Yellow" }], rows[0].taken_at, "u_t_doc", Number(docId)), 0, "filing the same report twice adds nothing");
    assert.equal(LAB_META.procalcitonin.label, "Procalcitonin");
    assert.match(String(seen.at(-1)!.body.system), /ldh = Lactate dehydrogenase \(U\/L\)/, "learned tests are offered on the next read");
  });

  it("a document added on the visit screen is also kept under Documents and read for lab values", async () => {
    const { addSource } = await import("../lib/plandraft");
    const { all } = await import("../lib/db");
    const { deliveriesSettled } = await import("../lib/whatsapp");
    next = { text: "Creatinine 2.91 mg/dL" };
    const before = seen.length;
    const src = await addSource("p_t", "rx", "JVBERi0xLjQ=", "application/pdf", undefined, Date.parse("2026-11-16T10:00:00+05:30"), "u_t_doc", "RFT Feb 2024.pdf");
    assert.equal(src.text, "Creatinine 2.91 mg/dL");
    const doc = all<{ id: number; title: string; notes: string }>("SELECT id, title, notes FROM patient_documents WHERE id = ?", src.docId!)[0];
    assert.deepEqual({ title: doc.title, notes: doc.notes }, { title: "RFT Feb 2024", notes: "Added on the visit screen" });
    await deliveriesSettled();
    for (let i = 0; i < 50 && seen.length < before + 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.length, before + 2, "read once for the draft and once for its lab values");
  });

  it("splits a note holding several visits into dated visits, and on a later copy records only the new one", async () => {
    const { run, all } = await import("../lib/db");
    const { extractDocument, autoFile } = await import("../lib/docauto");
    const t0 = Date.parse("2026-11-16T10:00:00+05:30");
    const shroff = { doctorName: "Dr Sunil Shroff", specialty: "Urology", hospital: "Madras Medical Mission" };
    const v14 = { ...shroff, date: "2024-02-14", reason: "Recurrent UTI", findings: "Creat 2.91, PSA 0.99, urine 20-30 pus cells", tests: "USG KUB, urine culture" };
    const v21 = { ...shroff, date: "2024-02-21", findings: "USG KUB normal, culture Klebsiella", advice: "Course of antibiotics for 2 weeks", medChanges: [{ medName: "Nitrofurantoin", change: "started", newDose: "100 mg", frequency: "BD", detail: "for 2 weeks" }] };
    const reply = (visits: object[]) => JSON.stringify({ documentType: "handwritten_prescription", documentTypeName: "Dr Sunil Shroff review", transcription: "", documentDate: "2024-02-14",
      extracted: { vitals: [], medications: [], symptoms: [], texts: [], labs: [{ marker: "creatinine", label: "Creat", value: 2.91, unit: "mg/dL", date: "2024-02-13" }, { marker: "tsh", label: "TSH", value: 0.514, unit: "mIU/L", date: "2024-02-13" }] }, visits });
    const addDoc = () => Number(run("INSERT INTO patient_documents(patient_id, title, category, mime, size, data, source, uploaded_by, uploaded_at) VALUES('p_t','Dr Shroff review','other','application/pdf',4,?, 'clinic','u_t_doc',0)", new Uint8Array([37, 80, 68, 70])).lastInsertRowid);
    const msgs = () => all("SELECT 1 FROM messages WHERE patient_id = 'p_t' AND direction = 'OUT'").length;

    next = { text: reply([v21, v14]) };
    const doc1 = addDoc();
    const x = await extractDocument(doc1);
    assert.deepEqual(x!.visits!.map((v) => `${v.date} ${v.kind}`), ["2024-02-14 outside", "2024-02-21 outside"], "two visits, oldest first, both to another doctor");
    assert.deepEqual(x!.labs.map((l) => `${l.marker} ${l.date}`), ["creatinine 2024-02-13", "tsh 2024-02-13"], "values from the note keep the day they were taken");
    assert.match(String(seen.at(-1)!.body.system), /several dated entries/i);

    const sent = msgs();
    const r = autoFile(doc1, "u_t_doc", t0);
    assert.equal(r.visits, 2);
    const ov = all<{ id: number; visit_at: number; doctor_name: string; status: string; source: string }>("SELECT id, visit_at, doctor_name, status, source FROM outside_visits WHERE patient_id = 'p_t' ORDER BY visit_at");
    assert.deepEqual(ov.map((o) => `${o.doctor_name}|${new Date(o.visit_at + 5.5 * 3600e3).toISOString().slice(0, 10)}|${o.status}|${o.source}`), ["Dr Sunil Shroff|2024-02-14|COMPLETE|document", "Dr Sunil Shroff|2024-02-21|COMPLETE|document"]);
    assert.equal(all("SELECT 1 FROM med_changes WHERE outside_visit_id = ? AND med_name = 'Nitrofurantoin'", ov[1].id).length, 1);
    assert.equal(msgs(), sent, "nothing is sent to the family for visits read from records");
    assert.equal(all("SELECT 1 FROM labs WHERE patient_id = 'p_t' AND marker = 'tsh'").length, 1, "TSH filed under 13 Feb");
    assert.equal(all("SELECT 1 FROM care_team WHERE patient_id = 'p_t' AND name = 'Dr Sunil Shroff'").length, 1, "the doctor joins the care team");

    // The same sheet, later, with a third entry (28 Feb) and an entry whose date may be misread (23 Feb, two days after 21 Feb).
    next = { text: reply([v14, v21, { ...shroff, date: "2024-02-23", advice: "?" }, { ...shroff, date: "2024-03-28", findings: "Culture sterile", advice: "Stop antibiotics" }]) };
    const doc2 = addDoc();
    const y = await extractDocument(doc2);
    assert.deepEqual(y!.visits!.map((v) => `${v.date} ${v.kind}${v.recorded ? " recorded" : ""}${v.nearby ? " nearby" : ""}`),
      ["2024-02-14 skip recorded", "2024-02-21 skip recorded", "2024-02-23 skip nearby", "2024-03-28 outside"]);
    const r2 = autoFile(doc2, "u_t_doc", t0 + 1000);
    assert.equal(r2.visits, 1, "only the new visit is recorded");
    assert.equal(r2.labs, 0, "values already on record for that day aren't entered again");
    assert.equal(all("SELECT 1 FROM outside_visits WHERE patient_id = 'p_t'").length, 3);
  });

  it("medicine changes from a visit older than the treating doctor's latest visit are history, not to-do", async () => {
    const { run, all } = await import("../lib/db");
    const { saveDocumentVisit } = await import("../lib/outside");
    const { DEFAULT_THRESHOLDS, DEFAULT_TIMERS } = await import("../lib/types");
    const plan = { medications: [], monitoring: [], physio: [], lifestyle: [], checkinTime: "", watchSymptoms: [], thresholds: DEFAULT_THRESHOLDS, escalation: DEFAULT_TIMERS };
    run("INSERT INTO visits(id, patient_id, doctor_id, visit_at, vitals, diagnosis, notes, plan, next_visit_at, created_at) VALUES('v_t_2025','p_t','u_t_doc',?, '{}', '', '', ?, NULL, ?)", Date.parse("2025-06-01T11:00:00+05:30"), JSON.stringify(plan), Date.now());
    const t0 = Date.parse("2026-11-16T10:00:00+05:30");
    const old = saveDocumentVisit("p_t", "u_t_doc", null, { date: "2024-05-10", doctorName: "Dr Old", medChanges: [{ medName: "Amlodipine", change: "started", newDose: "5 mg" }] }, t0);
    const recent = saveDocumentVisit("p_t", "u_t_doc", null, { date: "2026-01-10", doctorName: "Dr New", medChanges: [{ medName: "Febuxostat", change: "started", newDose: "40 mg" }] }, t0);
    assert.equal(all<{ status: string }>("SELECT status FROM med_changes WHERE outside_visit_id = ?", old)[0].status, "REVIEWED");
    assert.equal(all<{ status: string }>("SELECT status FROM med_changes WHERE outside_visit_id = ?", recent)[0].status, "REPORTED");
    assert.throws(() => saveDocumentVisit("p_t", "u_t_doc", null, { date: "2030-01-01", doctorName: "Dr Future" }, t0), /future/);
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
