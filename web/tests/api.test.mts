import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

const { canView, isClinician } = await import("../lib/server");
const engine = await import("../lib/engine");

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

describe("API & Authorization - Security & Workflows", () => {
  describe("Server-Side Authorization Rules (canView)", () => {
    it("enforces doctor isolation: Dr Dileep can view only p_gopal", () => {
      const dileep = { id: "u_dr_dileep", role: "DOCTOR", name: "Dr Dileep", phone: null, title: "Nephrologist" };
      assert.equal(canView(dileep, "p_gopal"), true, "Dr Dileep can view his patient p_gopal");
      assert.equal(canView(dileep, "p_ramesh"), false, "Dr Dileep cannot view Dr Rao's patient p_ramesh");
      assert.equal(canView(dileep, "p_abdul"), false, "Dr Dileep cannot view p_abdul");
      assert.equal(canView(dileep, "p_sunita"), false, "Dr Dileep cannot view p_sunita");
    });

    it("enforces doctor isolation: Dr Rao can view non-Gopal patients only", () => {
      const rao = { id: "u_dr_rao", role: "DOCTOR", name: "Dr Rao", phone: null, title: "Cardiologist" };
      assert.equal(canView(rao, "p_ramesh"), true);
      assert.equal(canView(rao, "p_abdul"), true);
      assert.equal(canView(rao, "p_sunita"), true);
      assert.equal(canView(rao, "p_gopal"), false, "Dr Rao cannot view Dr Dileep's patient p_gopal");
    });

    it("grants physician assistant access across clinic patients", () => {
      const pa = { id: "u_pa_priya", role: "PA", name: "Priya", phone: null, title: "PA" };
      assert.equal(canView(pa, "p_gopal"), true);
      assert.equal(canView(pa, "p_ramesh"), true);
      assert.equal(canView(pa, "p_abdul"), true);
      assert.equal(canView(pa, "p_sunita"), true);
    });

    it("restricts patient access to their own record only", () => {
      const ramesh = { id: "u_ramesh", role: "PATIENT", name: "Ramesh", phone: "+91 98860 20001", title: null };
      assert.equal(canView(ramesh, "p_ramesh"), true);
      assert.equal(canView(ramesh, "p_gopal"), false);
      assert.equal(canView(ramesh, "p_abdul"), false);
    });

    it("identifies clinician roles correctly", () => {
      assert.equal(isClinician({ id: "u_dr_dileep", role: "DOCTOR", name: "Dr Dileep", phone: null, title: null }), true);
      assert.equal(isClinician({ id: "u_pa_priya", role: "PA", name: "Priya", phone: null, title: null }), true);
      assert.equal(isClinician({ id: "u_ramesh", role: "PATIENT", name: "Ramesh", phone: null, title: null }), false);
      assert.equal(isClinician({ id: "u_durai", role: "CAREGIVER", name: "Durai", phone: null, title: null }), false);
      assert.equal(isClinician(null), false);
    });
  });

  describe("HTTP API Endpoints - Dashboard Isolation", () => {
    it("GET /api/dashboard returns ONLY p_gopal for Dr Dileep", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard`, {
        headers: { Cookie: "cc_user=u_dr_dileep" },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.patients));
      assert.equal(data.patients.length, 1);
      assert.equal(data.patients[0].id, "p_gopal");
      assert.equal(data.patients[0].name, "A Gopal");
      assert.ok(data.patients[0].kidney !== null, "Gopal should have kidney metadata in dashboard");
    });

    it("GET /api/dashboard returns Ramesh, Abdul, Sunita for Dr Rao (no Gopal)", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard`, {
        headers: { Cookie: "cc_user=u_dr_rao" },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.patients));
      const pids = data.patients.map((p: { id: string }) => p.id);
      assert.ok(pids.includes("p_ramesh"));
      assert.ok(pids.includes("p_abdul"));
      assert.ok(pids.includes("p_sunita"));
      assert.ok(!pids.includes("p_gopal"), "Dr Rao must not see Gopal");
    });

    it("GET /api/dashboard returns all patients for PA Priya", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard`, {
        headers: { Cookie: "cc_user=u_pa_priya" },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const pids = data.patients.map((p: { id: string }) => p.id);
      assert.ok(pids.includes("p_gopal") && pids.includes("p_ramesh"));
    });

    it("GET /api/dashboard returns 403 Forbidden for non-clinicians", async () => {
      const res = await fetch(`${BASE_URL}/api/dashboard`, {
        headers: { Cookie: "cc_user=u_lakshmi" },
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.error, "Doctor / PA only");
    });
  });

  describe("HTTP API Endpoints - WhatsApp Simulator", () => {
    it("GET /api/whatsapp returns contacts with bidirectional peer pairing", async () => {
      const res = await fetch(`${BASE_URL}/api/whatsapp`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.contacts));

      // A Gopal -> peer Mom (Level 1), peer2 Durai (Level 2)
      const gopal = data.contacts.find((c: { id: string }) => c.id === "u_gopal");
      assert.ok(gopal, "u_gopal contact should exist");
      assert.equal(gopal.peer_user_id, "u_mom");
      assert.equal(gopal.peer2_user_id, "u_durai");

      // Mom -> peer A Gopal, peer2 Durai, caregiver_level 1
      const mom = data.contacts.find((c: { id: string }) => c.id === "u_mom");
      assert.ok(mom, "u_mom contact should exist");
      assert.equal(mom.peer_user_id, "u_gopal");
      assert.equal(mom.peer2_user_id, "u_durai");
      assert.equal(mom.caregiver_level, 1);

      // Durai -> peer A Gopal, peer2 Mom, caregiver_level 2
      const durai = data.contacts.find((c: { id: string }) => c.id === "u_durai");
      assert.ok(durai, "u_durai contact should exist");
      assert.equal(durai.peer_user_id, "u_gopal");
      assert.equal(durai.peer2_user_id, "u_mom");
      assert.equal(durai.caregiver_level, 2);

      // Ramesh -> peer Lakshmi
      const ramesh = data.contacts.find((c: { id: string }) => c.id === "u_ramesh");
      assert.ok(ramesh);
      assert.equal(ramesh.peer_user_id, "u_lakshmi");

      // Lakshmi -> peer Ramesh
      const lakshmi = data.contacts.find((c: { id: string }) => c.id === "u_lakshmi");
      assert.ok(lakshmi);
      assert.equal(lakshmi.peer_user_id, "u_ramesh");
    });

    it("GET /api/whatsapp?userId=u_gopal returns message thread", async () => {
      const res = await fetch(`${BASE_URL}/api/whatsapp?userId=u_gopal`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.user.id, "u_gopal");
      assert.ok(Array.isArray(data.messages));
    });

    it("POST /api/whatsapp validates required parameters", async () => {
      const res = await fetch(`${BASE_URL}/api/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);

      const res404 = await fetch(`${BASE_URL}/api/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "unknown_user", body: "hello" }),
      });
      assert.equal(res404.status, 404);
    });
  });

  describe("HTTP API Endpoints - Care Team Management", () => {
    it("prevents removal of primary doctor from care team", async () => {
      const { get: getDb } = await import("../lib/db");
      const primaryRow = getDb<{ id: number }>(
        "SELECT id FROM care_team WHERE patient_id = 'p_gopal' AND role = 'PRIMARY'"
      );
      assert.ok(primaryRow, "Primary doctor should exist in care_team");

      const primaryDoc = await fetch(`${BASE_URL}/api/patients/p_gopal/team`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "cc_user=u_dr_dileep",
        },
        body: JSON.stringify({ action: "delete", id: primaryRow.id }),
      });
      assert.equal(primaryDoc.status, 400);
      const body = await primaryDoc.json();
      assert.match(body.error, /primary doctor/i);
    });

    it("adds and updates consulting doctors in care team", async () => {
      const addRes = await fetch(`${BASE_URL}/api/patients/p_gopal/team`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "cc_user=u_dr_dileep",
        },
        body: JSON.stringify({
          name: "Dr. Test Neurologist",
          specialty: "Neurology",
          hospital: "Kauvery Hospital",
          phone: "+91 98400 99999",
          notes: "Consulting for seizure management",
        }),
      });
      assert.equal(addRes.status, 200);
      const addData = await addRes.json();
      assert.equal(addData.ok, true);
      assert.ok(addData.id > 0);

      // Now update the doctor's notes
      const updateRes = await fetch(`${BASE_URL}/api/patients/p_gopal/team`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "cc_user=u_dr_dileep",
        },
        body: JSON.stringify({
          action: "update",
          id: addData.id,
          name: "Dr. Test Neurologist",
          specialty: "Neurology",
          hospital: "Kauvery Hospital",
          phone: "+91 98400 99999",
          notes: "Consulting for seizure management · Review in 6 months",
        }),
      });
      assert.equal(updateRes.status, 200);
      const updateData = await updateRes.json();
      assert.equal(updateData.ok, true);

      // Clean up: delete test doctor so tests do not pollute care team
      const delRes = await fetch(`${BASE_URL}/api/patients/p_gopal/team`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "cc_user=u_dr_dileep",
        },
        body: JSON.stringify({
          action: "delete",
          id: addData.id,
        }),
      });
      assert.equal(delRes.status, 200);
    });
  });
});
