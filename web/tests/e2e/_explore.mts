import { startApp } from "./harness.mts";
import { killPort } from "./_killport.mts";
killPort(3292);
const app = await startApp({ port: 3292, suite: "_explore" });
await app.api("u_dr_rao","GET","/api/dashboard");
const MIN=60000, DAY=86400000, IST=330*MIN;
const dayKey = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const t0 = await app.clock.now();
const v1 = app.q1<any>("SELECT * FROM visits WHERE patient_id = 'p_ramesh' ORDER BY visit_at DESC LIMIT 1");
const plan = JSON.parse(v1.plan);
plan.medications = plan.medications.filter((x: any) => x.key !== "atorvastatin");
plan.medications.find((x: any) => x.key === "furosemide").dose = "40 mg";
plan.fluid = { limitMl: 1500, checkTime: "20:00", lowOutputMl: 500, ratioLow: 0.5 };
const v = await app.api("u_dr_rao", "POST", "/api/patients/p_ramesh/visits", { vitals: {}, diagnosis: "x", notes: "", plan, next_visit_at: null });
console.log(v.data, JSON.parse(app.q1<any>("SELECT plan FROM visits WHERE id=?", v.data.id).plan).fluid);
console.log(app.q("SELECT item_key,label,due_at,visit_id FROM tasks WHERE patient_id='p_ramesh' AND status='PENDING' ORDER BY due_at LIMIT 12").map((x:any)=>[x.item_key,x.label,new Date(x.due_at+IST).toISOString(),x.visit_id]));
await app.clock.reset();
const t = await app.clock.now();
const m = app.mark();
for (const [u, doc] of [["u_lakshmi", "Dr Lak"], ["u_kavya", "Dr Kav"]]) {
  const r = await app.api(u, "POST", "/api/patients/p_ramesh/outside-visits", { action: "save", visit: { visitDate: dayKey(t), doctorName: doc, nextVisitDate: dayKey(t+DAY) } });
  console.log(r.data);
}
await app.api(null,"GET","/api/demo");
console.log(app.q("SELECT user_id,kind,body FROM messages WHERE id>? AND direction='OUT'", m).map((x:any)=>[x.user_id,x.kind,x.body.slice(0,90)]));
await app.clock.advance(Math.ceil((Math.floor((t+IST)/DAY)*DAY-IST+DAY+19.25*3600000-t)/MIN));
const m2=app.mark();
await app.api(null,"GET","/api/demo");
console.log(app.q("SELECT key,value FROM settings WHERE key LIKE 'ov%'"));
for (const [u,b] of [["u_lakshmi","No changes"],["u_kavya","Visit postponed"],["u_kavya","postponed to 28 Oct"]]) {
  const mm=app.mark(); await app.wa.send(u,b);
  console.log(u,b, app.q("SELECT body FROM messages WHERE id>? AND user_id=? AND direction='OUT'", mm, u).map((x:any)=>x.body.slice(0,150)));
  console.log(app.q("SELECT key,value FROM settings WHERE key = ?", "ov:"+u));
}
console.log(app.q("SELECT id,next_visit_at,reported_by,followup_of,advice,status FROM outside_visits WHERE patient_id='p_ramesh'").map((x:any)=>({...x,n:x.next_visit_at&&dayKey(x.next_visit_at)})));
await app.stop(); killPort(3292);
