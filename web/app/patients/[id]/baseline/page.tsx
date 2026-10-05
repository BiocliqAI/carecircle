"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { api, useSession } from "@/components/client";
import { BaselineForm, baselineForSubmit } from "@/components/baseline";
import { EMPTY_BASELINE, type Baseline } from "@/lib/types";

export default function EditBaseline({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { loading, user, notifyChange } = useSession();
  const [name, setName] = useState("");
  const [b, setB] = useState<Baseline | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loading) return;
    api<{ patient: { name: string }; baseline: Baseline | null }>(`/api/patients/${id}/baseline`)
      .then((r) => { setName(r.patient.name); setB(r.baseline ? { ...EMPTY_BASELINE, ...r.baseline } : { ...EMPTY_BASELINE, vitals: {} }); })
      .catch((e) => setErr(e.message));
  }, [id, loading]);

  if (user && user.role !== "DOCTOR" && user.role !== "PA") return <main className="page"><div className="alert bad">Only the care team can edit the baseline.</div></main>;
  if (!b) return <main className="page">{err ? <div className="alert bad">{err}</div> : <div className="empty"><span className="spin" /></div>}</main>;

  async function save() {
    if (b!.labs.some((l) => !Number.isFinite(l.value))) return setErr("Enter a value for every lab test, or remove the empty rows");
    setBusy(true);
    setErr(null);
    try {
      const { capturedAt: _a, capturedBy: _b, updatedAt: _c, ...data } = b as Baseline & { capturedAt?: number; capturedBy?: string; updatedAt?: number };
      await api(`/api/patients/${id}/baseline`, { body: baselineForSubmit(data) });
      notifyChange();
      router.push(`/patients/${id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <small><Link href={`/patients/${id}`}>← {name}</Link></small>
          <h1>Baseline intake</h1>
          <div className="muted">The reference point before the first care plan. Edits are audited.</div>
        </div>
        <div className="row">
          <Link className="btn" href={`/patients/${id}`}>Cancel</Link>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? <span className="spin" /> : "💾"} Save baseline</button>
        </div>
      </div>
      {err && <div className="alert bad" style={{ marginBottom: 12 }}>{err}</div>}
      <BaselineForm value={b} onChange={setB} />
    </main>
  );
}
