"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

export interface ComposerToolMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Small status text shown on the right (e.g. the scheduled time). */
  status?: string;
  onSelect: () => void;
}

export interface ComposerToolsMenuProps {
  items: ComposerToolMenuItem[];
  /** When true the trigger shows an accent badge (something is active/scheduled). */
  active?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

const menuIconProps = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * A small dropdown menu for composer actions that open dialogs (auto advance,
 * scheduled send, …). Desktop opens a floating panel next to the trigger;
 * mobile opens a bottom sheet.
 */
export function ComposerToolsMenu({ items, active = false, disabled = false, ariaLabel }: ComposerToolsMenuProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ top: number; right: number; bottom: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const triggerLabel = ariaLabel ?? t("chat.tools");

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchorRect({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width });
          setOpen((current) => !current);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          height: 32,
          minWidth: 32,
          padding: "0 8px",
          border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 50%, transparent)" : "var(--border)"}`,
          borderRadius: 8,
          background: active ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "none",
          color: active ? "var(--accent)" : "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 12,
          fontWeight: 500,
          opacity: disabled ? 0.6 : 1,
          transition: "background-color 0.15s, border-color 0.15s, color 0.15s",
        }}
      >
        {/* wrench */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span>{triggerLabel}</span>
        {!isMobile && (
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        )}
      </button>

      {open && anchorRect && typeof document !== "undefined" && createPortal(
        isMobile ? (
          <div
            role="presentation"
            data-composer-controls-portal="tools"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => { if (event.target === event.currentTarget) close(); }}
            style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.32)" }}
          >
            <div
              ref={panelRef}
              data-composer-controls-portal="tools"
              role="menu"
              aria-label={triggerLabel}
              onKeyDown={onKeyDown}
              style={{
                position: "fixed",
                left: 8,
                right: 8,
                bottom: "max(8px, env(safe-area-inset-bottom))",
                zIndex: 9999,
                border: "1px solid var(--border)",
                borderRadius: 12,
                background: "var(--bg)",
                boxShadow: "0 -8px 30px rgba(0,0,0,0.22)",
                overflow: "hidden",
                paddingBottom: 4,
              }}
            >
              <div style={{ padding: "10px 14px 6px", fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{triggerLabel}</div>
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => { setOpen(false); item.onSelect(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "12px 14px", border: 0, background: "none",
                    color: item.disabled ? "var(--text-dim)" : "var(--text)",
                    cursor: item.disabled ? "not-allowed" : "pointer",
                    fontSize: 14, textAlign: "left",
                  }}
                >
                  {item.icon}
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.status && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{item.status}</span>}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div
            ref={panelRef}
            role="menu"
            aria-label={triggerLabel}
            onKeyDown={onKeyDown}
            style={{
              position: "fixed",
              bottom: window.innerHeight - anchorRect.top + 6,
              left: Math.min(anchorRect.left, window.innerWidth - 200),
              zIndex: 9999,
              minWidth: 190,
              border: "1px solid var(--border)",
              borderRadius: 9,
              background: "var(--bg)",
              boxShadow: "0 -6px 20px rgba(0,0,0,0.16)",
              overflow: "hidden",
              padding: 4,
            } as CSSProperties}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { setOpen(false); item.onSelect(); }}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%",
                  padding: "8px 9px", border: 0, borderRadius: 6, background: "none",
                  color: item.disabled ? "var(--text-dim)" : "var(--text)",
                  cursor: item.disabled ? "not-allowed" : "pointer",
                  fontSize: 12, textAlign: "left",
                }}
                onMouseEnter={(event) => { if (!item.disabled) event.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = "none"; }}
              >
                <span style={{ display: "inline-flex", color: "var(--text-muted)", flexShrink: 0 }}>{item.icon}</span>
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.status && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{item.status}</span>}
              </button>
            ))}
          </div>
        ),
        document.body,
      )}
    </div>
  );
}

export { menuIconProps };
