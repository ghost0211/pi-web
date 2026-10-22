"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";

export interface ScheduledSendSubmit {
  /** Epoch milliseconds (minute precision). */
  at: number;
  message: string;
}

export interface ScheduleSendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  onSubmit: (input: ScheduledSendSubmit) => void;
  /** Prefills the message field, e.g. the current composer draft. */
  initialMessage?: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function defaultScheduleValue(): string {
  const next = new Date(Date.now() + 5 * 60_000);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  return toLocalInputValue(next);
}

/** Parse the local `datetime-local` value; returns null when invalid or in the past. */
export function parseScheduleTime(value: string, now = Date.now()): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return null;
  // Round to the minute and require it to be (strictly) in the future.
  const minute = Math.floor(at / 60_000) * 60_000;
  if (minute <= now) return null;
  return minute;
}

export function ScheduleSendDialog({ open, onOpenChange, disabled = false, onSubmit, initialMessage = "" }: ScheduleSendDialogProps) {
  const { t } = useI18n();
  const [message, setMessage] = useState(initialMessage);
  const [timeValue, setTimeValue] = useState(defaultScheduleValue);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const messageId = useId();
  const timeId = useId();

  // Resync the draft and default time each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setMessage(initialMessage);
    setTimeValue(defaultScheduleValue());
    setError(null);
  }, [open, initialMessage]);

  // Global window Escape key listener
  useEffect(() => {
    if (!open) return;
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [open, onOpenChange]);

  // Focus the primary field on open
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>("[data-schedule-field='time']")?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onOpenChange(false);
      return;
    }
    if (event.key === "Tab") {
      const container = panelRef.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey) {
        if (document.activeElement === first || !container.contains(document.activeElement)) {
          event.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last || !container.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = message.trim();
    const at = parseScheduleTime(timeValue);
    if (!text) {
      setError(t("scheduleSend.messageRequired"));
      return;
    }
    if (at === null) {
      setError(t("scheduleSend.timeInvalid"));
      return;
    }
    setError(null);
    onSubmit({ at, message: text });
    onOpenChange(false);
  };

  if (!open) return null;

  return createPortal(
    <div
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.45)", backdropFilter: "blur(2px)", padding: 16,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={handleKeyDown}
        style={{
          width: "100%", maxWidth: 440, boxSizing: "border-box",
          display: "flex", flexDirection: "column",
          backgroundColor: "var(--bg)", color: "var(--text)",
          border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 12px 36px rgba(0, 0, 0, 0.3)", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("scheduleSend.title")}</h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t("scheduleSend.cancel")}
            title={t("scheduleSend.cancel")}
            style={{ border: 0, background: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer", padding: "2px 6px", lineHeight: 1, borderRadius: 4 }}
          >
            ×
          </button>
        </div>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14, padding: 18, overflowY: "auto" }}>
          <p id={descId} style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {t("scheduleSend.description")}
          </p>

          <div>
            <label htmlFor={timeId} style={{ display: "block", marginBottom: 4, fontWeight: 500, fontSize: 12 }}>
              {t("scheduleSend.time")}
            </label>
            <input
              id={timeId}
              data-schedule-field="time"
              type="datetime-local"
              step={60}
              value={timeValue}
              disabled={disabled}
              onChange={(event) => setTimeValue(event.target.value)}
              style={{
                width: "100%", boxSizing: "border-box", height: 38, padding: "0 10px",
                borderRadius: 6, border: "1px solid var(--border)",
                background: "var(--bg-panel, transparent)", color: "var(--text)", fontSize: 13,
              }}
            />
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <label htmlFor={messageId} style={{ fontWeight: 500, fontSize: 12 }}>{t("scheduleSend.message")}</label>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{message.length}/8000</span>
            </div>
            <textarea
              id={messageId}
              value={message}
              disabled={disabled}
              maxLength={8000}
              onChange={(event) => setMessage(event.target.value.slice(0, 8000))}
              placeholder={t("scheduleSend.messagePlaceholder")}
              rows={4}
              style={{
                width: "100%", boxSizing: "border-box", padding: "8px 10px",
                borderRadius: 6, border: "1px solid var(--border)",
                background: "var(--bg-panel, transparent)", color: "var(--text)",
                fontSize: 13, resize: "vertical", minHeight: 80,
              }}
            />
          </div>

          {error && (
            <div style={{ fontSize: 12, color: "#ef4444" }}>{error}</div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid var(--border)", background: "none", color: "var(--text)", fontSize: 13, cursor: "pointer" }}
            >
              {t("scheduleSend.cancel")}
            </button>
            <button
              type="submit"
              disabled={disabled || !message.trim()}
              style={{
                padding: "8px 14px", borderRadius: 7, border: 0,
                background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 500,
                cursor: disabled || !message.trim() ? "not-allowed" : "pointer",
                opacity: disabled || !message.trim() ? 0.55 : 1,
              }}
            >
              {t("scheduleSend.confirm")}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
