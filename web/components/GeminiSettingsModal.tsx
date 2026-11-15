"use client";
import { useEffect, useState } from "react";
import { api } from "./client";

export function GeminiSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [configured, setConfigured] = useState(false);
  const [model, setModel] = useState("gemini-3.8-flash");
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Anthropic (Claude): reading documents and reasoning. Gemini: speech.
  const [claude, setClaude] = useState<{ configured: boolean; fromEnv: boolean; model: string; maskedKey: string | null } | null>(null);
  const [claudeErr, setClaudeErr] = useState<string | null>(null);
  const [claudeKey, setClaudeKey] = useState("");

  useEffect(() => {
    if (open) {
      loadStatus();
      loadClaude();
    }
  }, [open]);

  async function loadClaude() {
    try {
      setClaude(await api("/api/settings/anthropic"));
      setClaudeErr(null);
    } catch (e) {
      setClaude(null);
      setClaudeErr((e as Error).message);
    }
  }

  async function saveClaude() {
    if (!claudeKey.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/settings/anthropic", { body: { apiKey: claudeKey.trim() } });
      setMsg({ type: "success", text: "Anthropic API key saved. Claude now reads documents and does the reasoning." });
      setClaudeKey("");
      await loadClaude();
    } catch (e) {
      setMsg({ type: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function loadStatus() {
    try {
      const res = await api<{ configured: boolean; model: string; maskedKey: string | null }>("/api/settings/gemini");
      setConfigured(res.configured);
      setModel(res.model || "gemini-3.8-flash");
      setMaskedKey(res.maskedKey);
    } catch {
      // ignore
    }
  }

  async function handleSave() {
    if (!apiKeyInput.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/settings/gemini", {
        body: { apiKey: apiKeyInput.trim() },
      });
      setMsg({ type: "success", text: "Gemini API key saved successfully!" });
      setApiKeyInput("");
      await loadStatus();
    } catch (e) {
      setMsg({ type: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 9999 }}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <div className="row" style={{ gap: 8 }}>
            <span style={{ fontSize: 22 }}>✨</span>
            <div>
              <h3 style={{ margin: 0 }}>AI configuration</h3>
              <small className="muted">Claude reads documents and does the reasoning. Gemini turns speech into text.</small>
            </div>
          </div>
          <button className="btn sm" style={{ background: "transparent", border: 0 }} onClick={onClose}>✕</button>
        </div>

        <h4 style={{ margin: "0 0 8px" }}>Anthropic (Claude): documents, OCR and reasoning</h4>
        <div className="card" style={{ marginBottom: 12, background: claude?.configured ? "rgba(37, 211, 102, 0.08)" : "var(--bg-subtle)" }}>
          {claude ? (
            <>
              <div className="row between">
                <div><b>Status: </b><span className={`badge ${claude.configured ? "good" : ""}`}>{claude.configured ? "🟢 Claude active" : "⚪ Not configured: Gemini does this instead"}</span></div>
                <span className="badge brand">{claude.model}</span>
              </div>
              {claude.maskedKey && <div style={{ marginTop: 8, fontSize: 13, color: "var(--ink-2)" }}>Active key: <code>{claude.maskedKey}</code>{claude.fromEnv ? " (from ANTHROPIC_API_KEY)" : ""}</div>}
            </>
          ) : <small className="muted">{claudeErr ?? "Loading…"}</small>}
        </div>
        {claude && !claude.fromEnv && (
          <div className="stack" style={{ gap: 8, marginBottom: 18 }}>
            <input type="password" placeholder="sk-ant-..." value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} disabled={busy} style={{ width: "100%", padding: "8px 12px" }} />
            <div className="row between" style={{ gap: 8 }}>
              <small className="muted">Create a key at <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)" }}>platform.claude.com</a>, or set <code>ANTHROPIC_API_KEY</code> on the server.</small>
              <button className="btn primary sm" onClick={saveClaude} disabled={busy || !claudeKey.trim()}>Save</button>
            </div>
          </div>
        )}

        <h4 style={{ margin: "0 0 8px" }}>Google Gemini: speech to text</h4>
        <div className="card" style={{ marginBottom: 16, background: configured ? "rgba(37, 211, 102, 0.08)" : "var(--bg-subtle)" }}>
          <div className="row between">
            <div>
              <b>Status: </b>
              <span className={`badge ${configured ? "good" : ""}`}>
                {configured ? "🟢 Gemini API Active" : "⚪ Not Configured"}
              </span>
            </div>
            <span className="badge brand">{model}</span>
          </div>
          {maskedKey && (
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--ink-2)" }}>
              Active key: <code>{maskedKey}</code>
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 10, marginBottom: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Enter Google Gemini API Key</label>
          <input
            type="password"
            placeholder="AIzaSy..."
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            disabled={busy}
            style={{ width: "100%", padding: "8px 12px" }}
          />
          <small className="muted">
            You can get an API key from Google AI Studio at{" "}
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)" }}>
              aistudio.google.com/app/apikey
            </a>.
            <br />
            Alternatively, you can set <code>GEMINI_API_KEY</code> in <code>web/.env.local</code>.
          </small>
        </div>

        {msg && (
          <div className={`alert ${msg.type === "success" ? "good" : "bad"}`} style={{ marginBottom: 16 }}>
            {msg.text}
          </div>
        )}

        <div className="row end" style={{ gap: 8 }}>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={handleSave} disabled={busy || !apiKeyInput.trim()}>
            {busy ? <span className="spin" /> : "Save Gemini key"}
          </button>
        </div>
      </div>
    </div>
  );
}
