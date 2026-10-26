"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";

/** Render inside a body portal, outside the composer's clipping/stacking contexts. */
export function MobileComposerSheet({ title, onClose, panelRef, children }: {
  title: string;
  onClose: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [viewport, setViewport] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const visible = window.visualViewport;
      setViewport({ top: visible?.offsetTop ?? 0, left: visible?.offsetLeft ?? 0, width: visible?.width ?? window.innerWidth, height: visible?.height ?? window.innerHeight });
    };
    update();
    // Focus a button, never a text field: opening a picker must not summon the keyboard.
    closeRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);

  return (
    <div
      data-mobile-composer-sheet="true"
      data-composer-controls-portal="picker"
      className="mobile-composer-sheet-backdrop"
      style={viewport ? { top: viewport.top, left: viewport.left, width: viewport.width, height: viewport.height } : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); onClose();
        } else if (event.key === "Tab") {
          const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])
            .filter((element) => element.tabIndex >= 0 && !element.hasAttribute("disabled"));
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault(); last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first?.focus();
          }
        }
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="mobile-composer-sheet">
        <div className="mobile-composer-sheet-header">
          <span id={titleId}>{title}</span>
          <button ref={closeRef} type="button" aria-label={t("chat.close")} onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
