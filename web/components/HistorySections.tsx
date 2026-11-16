"use client";
// The patient history summary, section by section (lib/historyspec.ts): an editor for the onboarding review and a
// read-only view for the chart. Empty parts read "Not documented", as the clinic's template asks.
import { Fragment, useState } from "react";
import { LazyText } from "./LazyText";
import { HISTORY, cell, fieldsOf, listOf, type ColSpec, type HistRow, type History, type ListSpec, type Marks } from "@/lib/historyspec";
import { fmtDate } from "@/lib/time";

const ND = "Not documented";
const day = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? fmtDate(Date.parse(`${d}T12:00:00+05:30`), { day: "numeric", month: "short", year: "numeric" }) : d);

export const Sources = ({ ids }: { ids: number[] }) => (ids?.length ? (
  <small className="row" style={{ gap: 6 }}>
    {ids.slice(0, 3).map((id, i) => <a key={id} href={`/api/documents/${id}`} target="_blank" rel="noreferrer">source{ids.length > 1 ? ` ${i + 1}` : ""}</a>)}
    {ids.length > 3 && <span className="muted">+{ids.length - 3}</span>}
  </small>
) : null);

function Input({ c, value, onChange, disabled }: { c: ColSpec; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const common = { "aria-label": c.label, value, disabled, placeholder: ND, title: c.hint };
  if (c.type === "date") return <input type="date" {...common} onChange={(e) => onChange(e.target.value)} style={{ width: "100%" }} />;
  if (c.type === "long") return <LazyText multiline {...common} rows={2} onCommit={onChange} style={{ width: "100%", minHeight: 0 }} />;
  return <LazyText {...common} onCommit={onChange} style={{ width: "100%" }} list={c.options ? `opts-${c.key}` : undefined} />;
}

const grow = (c: ColSpec) => (c.type === "long" ? "3 1 260px" : c.options ? "2 1 240px" : c.type === "date" ? "0 0 150px" : "1 1 150px");
const PAGE = 8;

/** "New" or "Changed: why (was …)" on an entry that records added later brought in. */
export function Mark({ m }: { m: Marks }) {
  if (m._new) return <span className="badge info" title="Added from the records just brought in">New</span>;
  if (!m._changed) return null;
  return <span className="badge warn" style={{ whiteSpace: "normal", display: "inline-block", maxWidth: "100%", height: "auto", lineHeight: 1.4 }} title={m._was ? `Before: ${m._was}` : undefined}>Changed: {m._changed}{m._was ? <span style={{ fontWeight: 400 }}> · was “{m._was.length > 120 ? `${m._was.slice(0, 120)}…` : m._was}”</span> : null}</span>;
}
const marked = (m: Marks) => !!(m._new || m._changed);

/** Editable history. `change` receives a function that edits a copy of the history. With `onlyMarked`, only the
 *  sections and entries that are new or changed are shown. */
export function HistoryEditor({ history, change, locked, onlyMarked }: { history: History; change: (fn: (h: History) => void) => void; locked?: boolean; onlyMarked?: boolean }) {
  const sections = onlyMarked ? HISTORY.filter((s) => (s.kind === "list" ? listOf(history, s.key) : Object.values(fieldsOf(history, s.key))).some(marked)) : HISTORY;
  return (
    <div className="stack gap16">
      {onlyMarked && sections.length === 0 && <div className="card muted">Nothing in the history is new or changed yet.</div>}
      {sections.map((s) => s.kind === "fields" ? (
        <section key={s.key} className="card">
          <div className="card-head"><h3 style={{ margin: 0 }}>{s.n}. {s.title}</h3>{s.hint && <small className="muted">{s.hint}</small>}</div>
          <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
            {s.fields.filter((f) => !onlyMarked || marked(fieldsOf(history, s.key)[f.key] ?? {})).map((f) => {
              const v = fieldsOf(history, s.key)[f.key] ?? { text: "", sources: [] };
              return (
                <label key={f.key} className="stack" style={{ gap: 4, flex: f.type === "long" ? "1 1 100%" : "1 1 220px", minWidth: 0, ...(marked(v) ? { background: v._new ? "#EEF5FD" : "#FFF8EE", padding: 6, borderRadius: 8 } : {}) }}>
                  <small className="muted">{f.label}{f.hint ? ` (${f.hint})` : ""}</small>
                  <Input c={f} value={v.text} disabled={locked} onChange={(t) => change((h) => { const o = fieldsOf(h, s.key); o[f.key] = { ...(o[f.key] ?? { sources: [] }), text: t }; h[s.key] = o; })} />
                  <span className="row" style={{ gap: 6 }}><Mark m={v} /><Sources ids={v.sources} /></span>
                </label>
              );
            })}
          </div>
        </section>
      ) : <ListEditor key={s.key} s={s} rows={listOf(history, s.key)} change={change} locked={locked} onlyMarked={onlyMarked} />)}
    </div>
  );
}

function ListEditor({ s, rows, change, locked, onlyMarked }: { s: ListSpec; rows: HistRow[]; change: (fn: (h: History) => void) => void; locked?: boolean; onlyMarked?: boolean }) {
  const [all, setAll] = useState(false);
  // New and changed entries are always shown, wherever they are in a long list.
  const shown = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => (onlyMarked ? marked(r) : all || i < PAGE || marked(r)));
  const set = (i: number, k: string, v: string) => change((h) => { const l = listOf(h, s.key); l[i] = { ...l[i], [k]: v }; h[s.key] = l; });
  return (
    <section className="card">
      <div className="card-head">
        <h3 style={{ margin: 0 }}>{s.n}. {s.title} {rows.length > 0 && <span className="v2-count">{rows.length}</span>}</h3>
        {!locked && <button className="btn sm" onClick={() => { setAll(true); change((h) => { const blank: HistRow = { sources: [] }; for (const c of s.cols) blank[c.key] = ""; h[s.key] = [blank, ...listOf(h, s.key)]; }); }}>+ Add</button>}
      </div>
      {s.hint && <small className="muted">{s.hint}</small>}
      {s.cols.filter((c) => c.options).map((c) => <datalist key={c.key} id={`opts-${c.key}`}>{c.options!.map((o) => <option key={o} value={o} />)}</datalist>)}
      {rows.length === 0 && <div className="muted" style={{ marginTop: 6 }}>{ND}</div>}
      {shown.map(({ r, i }) => (
        <div key={i} className="row" style={{ gap: 8, padding: "8px 0", borderTop: "1px solid var(--line-2)", alignItems: "flex-end", ...(marked(r) ? { background: r._new ? "#EEF5FD" : "#FFF8EE", paddingInline: 6, borderRadius: 8 } : {}) }}>
          {marked(r) && <div style={{ flex: "1 1 100%" }}><Mark m={r} /></div>}
          {s.cols.map((c) => (
            <label key={c.key} className="stack" style={{ gap: 2, flex: grow(c), minWidth: 0 }}>
              <small className="muted">{c.label}</small>
              <Input c={c} value={cell(r, c.key)} disabled={locked} onChange={(v) => set(i, c.key, v)} />
            </label>
          ))}
          <Sources ids={r.sources} />
          {!locked && <button className="btn sm ghost" aria-label={`Remove this ${s.title.toLowerCase()} entry`} onClick={() => change((h) => { const l = listOf(h, s.key); l.splice(i, 1); h[s.key] = l; })}>✕</button>}
        </div>
      ))}
      {!onlyMarked && rows.length > PAGE && <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
    </section>
  );
}

/** Read-only history, compact: tables for lists, label/value pairs for the rest. */
export function HistoryView({ history, only }: { history: History; only?: string[] }) {
  return (
    <div className="stack gap16">
      {HISTORY.filter((s) => !only || only.includes(s.key)).map((s) => {
        if (s.kind === "fields") {
          const f = fieldsOf(history, s.key);
          return (
            <div key={s.key}>
              <h4 style={{ margin: "0 0 6px" }}>{s.n}. {s.title}</h4>
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(120px, 200px) minmax(0, 1fr)", gap: "4px 12px" }}>
                {s.fields.map((x) => (
                  <Fragment key={x.key}>
                    <dt className="muted">{x.label}</dt>
                    <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>{f[x.key]?.text || <span className="muted">{ND}</span>} <Sources ids={f[x.key]?.sources ?? []} /></dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          );
        }
        const rows = listOf(history, s.key);
        return (
          <div key={s.key}>
            <h4 style={{ margin: "0 0 6px" }}>{s.n}. {s.title} {rows.length > 0 && <span className="v2-count">{rows.length}</span>}</h4>
            {rows.length === 0 ? <div className="muted">{ND}</div> : (
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ width: "100%" }}>
                  <thead><tr>{s.cols.map((c) => <th key={c.key} style={{ textAlign: "left" }}>{c.label}</th>)}<th /></tr></thead>
                  <tbody>{rows.map((r, i) => <tr key={i}>{s.cols.map((c) => <td key={c.key} style={{ verticalAlign: "top" }}>{c.type === "date" ? day(cell(r, c.key)) : cell(r, c.key)}</td>)}<td><Sources ids={r.sources} /></td></tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
