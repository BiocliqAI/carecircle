import { startApp } from "./harness.mts";
const app = await startApp({ port: 3292, suite: "_explore" });
const now = await app.clock.now();
console.log("now", new Date(now).toISOString());
const v = app.q("SELECT id, patient_id, visit_at, next_visit_at, plan FROM visits WHERE patient_id='p_ramesh' ORDER BY visit_at");
for (const x of v) { const p = JSON.parse(x.plan); console.log(x.id, new Date(x.visit_at).toISOString(), x.next_visit_at && new Date(x.next_visit_at).toISOString(), p.medications.map((m:any)=>`${m.key}:${m.name} ${m.dose} ${m.times}`).join(" | ")); console.log(JSON.stringify({mon:p.monitoring, fluid:p.fluid, labs:p.labs, physio:p.physio, life:p.lifestyle})); }
console.log(app.q("SELECT * FROM care_team WHERE patient_id='p_ramesh'"));
console.log(app.q("SELECT patient_id, user_id, status FROM consents"));
console.log(app.q("SELECT id,name,doctor_id FROM patients"));
console.log(app.q("SELECT data FROM patient_baseline WHERE patient_id='p_ramesh'"));
console.log(app.q("SELECT key,value FROM settings WHERE key LIKE 'paused:%' OR key LIKE 'ov:%'"));
const t = await app.api("u_pa_priya","GET","/api/pa-today"); console.log(JSON.stringify(t.data.tasks.map((x:any)=>[x.kind,x.label,x.patient])));
await app.stop();
