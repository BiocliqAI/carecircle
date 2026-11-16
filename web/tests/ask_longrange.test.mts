import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CARECIRCLE_DB = path.join(os.tmpdir(), `carecircle-test-asklong-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { get, run } = await import("../lib/db");
const { seedDemo } = await import("../lib/seed");
const engine = await import("../lib/engine");
const ask = await import("../lib/askrecord");

const T = Date.parse("2026-11-23T19:00:00+05:30");
const at = (d: string) => Date.parse(`${d}T09:00:00+05:30`);
describe("asking the record about a long period", () => {
  it("gives the AI lab values from the whole record, says what each part covers, and charts years back", async () => {
    await seedDemo();
    const doctor = get<{ id: string }>("SELECT id FROM users WHERE role = 'DOCTOR' LIMIT 1")!;
    const pid = engine.onboardPatient({ name: "Long Range", age: 78, sex: "M", phone: "+91 90000 77711", conditions: "", address: "", doctorId: doctor.id, caregivers: [{ name: "A", relation: "Son", phone: "+91 90000 77719", level: 1, dashboard: true }] }, T, doctor.id);
    const lab = (m: string, v: number, d: string) => run("INSERT INTO labs(patient_id, marker, value, taken_at, source) VALUES(?,?,?,?,?)", pid, m, v, at(d), "ONBOARDING");
    lab("ntprobnp", 9100, "2024-02-13"); lab("ntprobnp", 7400, "2025-04-15"); lab("ntprobnp", 5840, "2025-11-25"); lab("ntprobnp", 76.4, "2026-11-13");
    for (let i = 0; i < 90; i++) lab("creatinine", 1.5 + i / 100, new Date(at("2023-10-29") + i * 7 * 86_400_000).toISOString().slice(0, 10));
    run("INSERT INTO outside_visits(patient_id, visit_at, doctor_name, specialty, status, source, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)", pid, at("2024-02-14"), "Dr Sunil Shroff", "Urology", "COMPLETE", "document", T, T);

    const c = ask.buildContext(pid, T) as unknown as { labs: Record<string, [string, number][]>; coverage: Record<string, string>; otherDoctorVisits: { doctor: string }[] };
    assert.deepEqual(c.labs.ntprobnp.map((x) => x[0]), ["2024-02-13", "2025-04-15", "2025-11-25", "2026-11-13"], "values older than a year are included");
    assert.equal(c.labs.creatinine.length, 60, "90 results thinned to 60 spread over the span");
    assert.equal(c.labs.creatinine.at(-1)![1], 2.39, "the last value is kept");
    assert.equal(c.labs.creatinine[0][0], "2023-10-29", "the first value is kept when thinning");
    assert.match(c.coverage.labs, /whole record, from 2023-10-29/);
    assert.match(c.coverage.readingsFluidsDiureticsAlertsSymptoms, /180 days/);
    assert.match(c.otherDoctorVisits[0].doctor, /Sunil Shroff/);

    assert.equal(ask.questionDays("NT-proBNP trend for last 2 years"), 730);
    assert.equal(ask.questionDays("creatinine over the last 5 years"), 1825);
    const chart = ask.buildChart(pid, ["ntprobnp"], 1825, T)!;
    assert.equal(chart.panels[0].points.length, 4, "the chart reaches back to 2024");
    assert.equal(ask.cleanSpec({ series: ["ntprobnp"], days: 5000 })!.days, ask.MAX_DAYS);
  });
});
