"use client";

import { useEffect, useState } from "react";
import type { SessionSystemPromptCustomization } from "@/lib/session-system-prompt";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  /** Current per-session override, if any. */
  custom?: SessionSystemPromptCustomization | null;
  /** Persist a new override (null clears). Undefined when no session is live. */
  onSave?: (custom: SessionSystemPromptCustomization | null) => Promise<void>;
  translate: Translate;
}

export function SystemPromptPanel({ loading, prompt, custom, onSave, translate }: Props) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"append" | "replace">(custom?.mode ?? "append");
  const [text, setText] = useState(custom?.text ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the editor when the active session (and thus its override) changes.
  useEffect(() => {
    setEditing(false);
    setError(null);
    setMode(custom?.mode ?? "append");
    setText(custom?.text ?? "");
  }, [custom]);

  const handleSave = async () => {
    if (!onSave) return;
    const trimmed = text.trim();
    if (!trimmed) {
      setError(translate("system.customEmpty"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ mode, text: trimmed });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!onSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(null);
      setEditing(false);
      setText("");
      setMode("append");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      {onSave && (
        <div className="system-prompt-custom">
          <div className="system-prompt-custom-header">
            <span className="system-prompt-custom-title">
              {translate("system.customTitle")}
              {custom && !editing && (
                <span className="system-prompt-custom-mode">
                  {translate(custom.mode === "replace" ? "system.customMode.replace" : "system.customMode.append")}
                </span>
              )}
            </span>
            {!editing ? (
              <button type="button" className="system-prompt-custom-button" onClick={() => setEditing(true)}>
                {custom ? translate("system.customEdit") : translate("system.customAdd")}
              </button>
            ) : (
              <div className="system-prompt-custom-actions">
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as "append" | "replace")}
                  className="system-prompt-custom-select"
                  aria-label={translate("system.customTitle")}
                >
                  <option value="append">{translate("system.customMode.append")}</option>
                  <option value="replace">{translate("system.customMode.replace")}</option>
                </select>
                <button
                  type="button"
                  className="system-prompt-custom-button primary"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {translate("system.customSave")}
                </button>
                {custom && (
                  <button
                    type="button"
                    className="system-prompt-custom-button danger"
                    onClick={handleClear}
                    disabled={saving}
                  >
                    {translate("system.customClear")}
                  </button>
                )}
                <button
                  type="button"
                  className="system-prompt-custom-button"
                  onClick={() => { setEditing(false); setError(null); setMode(custom?.mode ?? "append"); setText(custom?.text ?? ""); }}
                  disabled={saving}
                >
                  {translate("system.customCancel")}
                </button>
              </div>
            )}
          </div>
          {editing && (
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={translate("system.customPlaceholder")}
              rows={4}
              className="system-prompt-custom-textarea"
              autoFocus
            />
          )}
          {!editing && custom && (
            <div className="system-prompt-custom-preview">{custom.text}</div>
          )}
          {error && <div className="system-prompt-custom-error">{error}</div>}
        </div>
      )}
      <div className="system-prompt-scroll">
        {prompt ? (
          <div className="system-prompt-text">{prompt}</div>
        ) : (
          <div className="system-prompt-empty">
            {prompt === ""
              ? translate("system.empty")
              : loading
                ? translate("system.loading")
                : translate("system.load")}
          </div>
        )}
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          height: min(600px, 75dvh);
          min-height: 220px;
          flex-direction: column;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .system-prompt-custom {
          flex-shrink: 0;
          padding: 8px 16px;
          border-bottom: 1px solid var(--border);
          background: var(--bg);
        }
        .system-prompt-custom-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .system-prompt-custom-title {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 600;
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .system-prompt-custom-mode {
          font-weight: 400;
          color: var(--accent);
          background: color-mix(in srgb, var(--accent) 10%, transparent);
          border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
          border-radius: 3px;
          padding: 0 5px;
        }
        .system-prompt-custom-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .system-prompt-custom-select {
          font-size: 11px;
          font-family: var(--font-mono);
          background: var(--bg-panel);
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 2px 4px;
        }
        .system-prompt-custom-button {
          font-size: 11px;
          font-family: var(--font-mono);
          background: var(--bg-panel);
          color: var(--text-muted);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
        }
        .system-prompt-custom-button:hover:not(:disabled) {
          color: var(--text);
          background: var(--bg-hover);
        }
        .system-prompt-custom-button.primary {
          color: var(--accent);
          border-color: color-mix(in srgb, var(--accent) 40%, transparent);
        }
        .system-prompt-custom-button.danger:hover:not(:disabled) {
          color: #dc2626;
        }
        .system-prompt-custom-button:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .system-prompt-custom-textarea {
          width: 100%;
          box-sizing: border-box;
          margin-top: 6px;
          font-size: 11px;
          font-family: var(--font-mono);
          line-height: 1.5;
          background: var(--bg-panel);
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 6px 8px;
          resize: vertical;
        }
        .system-prompt-custom-textarea:focus {
          outline: none;
          border-color: var(--accent);
        }
        .system-prompt-custom-preview {
          margin-top: 6px;
          font-size: 11px;
          font-family: var(--font-mono);
          color: var(--text-dim);
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          max-height: 80px;
          overflow: auto;
        }
        .system-prompt-custom-error {
          margin-top: 6px;
          font-size: 11px;
          color: #dc2626;
        }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px 16px;
        }
        .system-prompt-text {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
      `}</style>
    </section>
  );
}
