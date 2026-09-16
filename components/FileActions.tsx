"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsDesktopApp } from "@/hooks/useIsDesktopApp";
import { copyText } from "@/lib/clipboard";
import { openDesktopPath, revealDesktopPath } from "@/lib/desktop";
import { getFileName, toAbsoluteFilePath } from "@/lib/file-paths";

interface Props {
  filePath: string;
  /** Resolves a workspace-relative path for the desktop shell commands. */
  cwd?: string | null;
  /** Download URL fallback; the browser build keeps the download affordance. */
  downloadUrl: string;
}

/**
 * File actions for the viewer header.
 *
 * Pi Web Desktop browses a project on the local machine, so a download is
 * pointless — the header opens the file with the system default application
 * instead, with a caret menu for the OS application chooser, revealing the file
 * in the file manager, and copying the absolute path. The browser build (where
 * the server may live on another host) keeps the original download link.
 */
export function FileActions({ filePath, cwd, downloadUrl }: Props) {
  const { t } = useI18n();
  const desktop = useIsDesktopApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const absolutePath = toAbsoluteFilePath(filePath, cwd);
  const available = desktop && Boolean(absolutePath);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setMenuOpen(false);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  if (!available || !absolutePath) {
    return (
      <a
        href={downloadUrl}
        download={getFileName(filePath)}
        title={t("i18n.downloadFile")}
        aria-label={t("i18n.downloadFile")}
        className="file-viewer-icon-button"
      >
        <DownloadIcon />
      </a>
    );
  }

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => void run(() => openDesktopPath(absolutePath))}
        title={t("files.openWithSystem")}
        aria-label={t("files.openWithSystem")}
        className="file-viewer-icon-button file-viewer-open-button"
      >
        <ExternalIcon />
      </button>
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        title={t("files.openOptions")}
        aria-label={t("files.openOptions")}
        aria-expanded={menuOpen}
        className="file-viewer-icon-button file-viewer-open-caret"
      >
        <CaretIcon />
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="file-viewer-open-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 130,
            minWidth: 208,
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 1,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 10px 30px rgba(0,0,0,0.24)",
          }}
        >
          <MenuItem
            label={t("files.openWithOther")}
            onClick={() => void run(() => openDesktopPath(absolutePath, "chooser"))}
          />
          <MenuItem
            label={t("files.revealInExplorer")}
            onClick={() => void run(() => revealDesktopPath(absolutePath))}
          />
          <MenuItem
            label={copied ? t("i18n.copied") : t("files.copyFullPath")}
            onClick={() => {
              setMenuOpen(false);
              void copyText(absolutePath)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch(() => setError(t("files.copyPathFailed")));
            }}
          />
        </div>
      )}

      {error && (
        <div
          role="alert"
          title={error}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 130,
            maxWidth: 320,
            padding: "5px 9px",
            background: "var(--bg-panel)",
            border: "1px solid rgba(239,68,68,0.4)",
            borderRadius: 6,
            color: "#ef4444",
            fontSize: 11,
            lineHeight: 1.4,
            boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
          }}
        >
          {t("files.openFileFailed", { error })}
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="file-viewer-open-menu-item"
      style={{
        display: "block",
        width: "100%",
        padding: "6px 9px",
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "var(--text)",
        fontSize: 12,
        textAlign: "left",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
