"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  desktopWindowClose,
  desktopWindowIsMaximized,
  desktopWindowMinimize,
  desktopWindowToggleMaximize,
  isDesktopApp,
  listenDesktopWindowResize,
} from "@/lib/desktop";

/**
 * Minimize / maximize-restore / close buttons for the undecorated desktop
 * window. Rendered at the right end of the top bar; null in plain browsers.
 * Close goes through CloseRequested, so the close-behavior setting (tray vs
 * quit) is honored.
 */
export function DesktopWindowControls() {
  const { t } = useI18n();
  const [desktop] = useState(() => isDesktopApp());
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const sync = () => {
      void desktopWindowIsMaximized().then((value) => {
        if (!disposed) setMaximized(value);
      });
    };
    sync();
    void listenDesktopWindowResize(sync).then((fn) => {
      if (disposed) fn?.();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop]);

  if (!desktop) return null;

  return (
    <div className="desktop-window-controls">
      <button
        type="button"
        className="desktop-window-control"
        onClick={() => void desktopWindowMinimize()}
        title={t("window.minimize")}
        aria-label={t("window.minimize")}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button
        type="button"
        className="desktop-window-control"
        onClick={() => void desktopWindowToggleMaximize()}
        title={maximized ? t("window.restore") : t("window.maximize")}
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
      >
        {maximized ? (
          // Standard Windows restore glyph: front square bottom-left (full),
          // back square top-right (only the visible top/right stubs drawn).
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
            <path d="M5 5V3.5A1.5 1.5 0 0 1 6.5 2h6A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H11" />
            <rect x="2" y="5" width="9" height="9" rx="1.5" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
            <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="desktop-window-control desktop-window-control-close"
        onClick={() => void desktopWindowClose()}
        title={t("window.close")}
        aria-label={t("window.close")}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
