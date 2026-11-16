"use client";
// A text box that stays smooth on big forms: what's typed is kept here and handed to the form shortly after typing
// pauses (and when the box loses focus), so the whole form isn't redrawn on every key. Changes from outside are taken
// in while the box isn't being edited.
import { useEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

type Common = { value: string; onCommit: (v: string) => void; delay?: number };
type Props = (Common & { multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">)
  | (Common & { multiline: true } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">);

export function LazyText(props: Props) {
  const { value, onCommit, delay = 350, multiline, ...rest } = props;
  const [v, setV] = useState(value);
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => { if (!editing.current) { setV(value); latest.current = value; } }, [value]);
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); if (latest.current !== value) commit.current(latest.current); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    commit.current(latest.current);
  };
  const change = (next: string) => {
    editing.current = true;
    latest.current = next;
    setV(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; commit.current(latest.current); }, delay);
  };
  const blur = () => { editing.current = false; if (timer.current) flush(); };

  if (multiline) {
    const r = rest as TextareaHTMLAttributes<HTMLTextAreaElement>;
    return <textarea {...r} value={v} onChange={(e) => change(e.target.value)} onBlur={(e) => { blur(); r.onBlur?.(e); }} />;
  }
  const r = rest as InputHTMLAttributes<HTMLInputElement>;
  return <input {...r} value={v} onChange={(e) => change(e.target.value)} onBlur={(e) => { blur(); r.onBlur?.(e); }} />;
}
