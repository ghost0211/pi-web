"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  ariaLabel?: string;
}

const MENU_WIDTH = 176;
const MENU_ESTIMATED_ITEM_HEIGHT = 30;
const VIEWPORT_MARGIN = 8;

/**
 * Fixed-position right-click menu rendered in a portal. Closes on outside
 * pointer down, Escape, scroll and resize. Shared by the session and project
 * rows so both expose the same Codex-style context menu interaction.
 */
export function ContextMenu({ x, y, items, onClose, ariaLabel }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = menu?.offsetWidth ?? MENU_WIDTH;
    const height = menu?.offsetHeight ?? items.length * MENU_ESTIMATED_ITEM_HEIGHT + 8;
    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(x, viewportWidth - width - VIEWPORT_MARGIN)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(y, viewportHeight - height - VIEWPORT_MARGIN)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const handleDismiss = () => onClose();
    document.addEventListener("mousedown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("scroll", handleDismiss, true);
    window.addEventListener("resize", handleDismiss);
    window.addEventListener("blur", handleDismiss);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", handleDismiss, true);
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("blur", handleDismiss);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        zIndex: 10000,
        minWidth: MENU_WIDTH,
        padding: 4,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.24)",
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "6px 10px",
            background: "none",
            border: "none",
            borderRadius: 6,
            color: item.danger ? "#ef4444" : "var(--text)",
            fontSize: 12,
            textAlign: "left",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = item.danger ? "rgba(239, 68, 68, 0.1)" : "var(--bg-hover)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = "none";
          }}
        >
          {item.checked !== undefined && (
            <span style={{ width: 12, flexShrink: 0, display: "inline-flex", justifyContent: "center", color: "var(--accent)" }} aria-hidden="true">
              {item.checked && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1.5 5 4 7.5 8.5 2.5" />
                </svg>
              )}
            </span>
          )}
          {item.icon && (
            <span style={{ flexShrink: 0, display: "inline-flex", color: item.danger ? "#ef4444" : "var(--text-muted)" }} aria-hidden="true">
              {item.icon}
            </span>
          )}
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
