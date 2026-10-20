"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import { presentPathKey, type PresentFilesDetails, type PresentItem } from "@/lib/present-files";
import { getFileIcon } from "./FileIcons";

/**
 * The turn's declared deliverables, shown above the ordinary changed files.
 *
 * Every entry was probed server-side (`present_files`): it exists and sits
 * inside the allowed workspace, so a chip here always opens in the viewer.
 * `kind` only drives a short label — no inline media, because the chat already
 * has a viewer and rendering reports inline would fight with it.
 */

const CHIP_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  maxWidth: "100%",
  padding: "3px 9px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  background: "var(--bg-subtle)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  // A chip is a control, not prose: clicking it must not select its label.
  userSelect: "none",
};

const KIND_LABELS: Record<string, string> = {
  image: "img",
  video: "video",
  audio: "audio",
  markdown: "md",
  html: "html",
  pdf: "pdf",
  text: "text",
  binary: "file",
  dir: "dir",
};

function formatSize(bytes: number | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function PresentDeliverables({
  deliverables,
  cwd,
  onOpenFile,
  onOpenGitDiff,
}: {
  deliverables: PresentFilesDetails;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenGitDiff?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  if (deliverables.items.length === 0) return null;

  const displayPath = (item: PresentItem) => {
    if (!cwd) return item.path;
    const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    const prefix = `${normalizedCwd}/`;
    const normalizedAbs = item.abs.replace(/\\/g, "/");
    return normalizedAbs.startsWith(prefix) ? normalizedAbs.slice(prefix.length) : item.path;
  };

  return (
    <div style={{ marginTop: 6 }} data-present-deliverables="true">
      {deliverables.title && (
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
          {deliverables.title}
        </div>
      )}
      {deliverables.note && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, overflowWrap: "anywhere" }}>
          {deliverables.note}
        </div>
      )}
      <div
        aria-label={t("chat.deliverables")}
        style={{ display: "flex", flexDirection: "column", gap: 5 }}
      >
        {deliverables.items.map((item) => {
          // The server's `name` is the file's real basename; fall back to the
          // path only for a payload that omitted it.
          const name = item.name || getFileName(item.abs);
          const size = formatSize(item.size);
          const kind = KIND_LABELS[item.kind] ?? null;
          return (
            <div
              key={presentPathKey(item.abs)}
              style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}
            >
              <button
                type="button"
                title={displayPath(item)}
                aria-label={t("chat.openWrittenFile", { name })}
                onClick={() => onOpenFile?.(item.abs)}
                style={CHIP_BASE}
              >
                {getFileIcon(name, 12)}
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {name}
                </span>
              </button>
              {onOpenGitDiff && (
                <button
                  type="button"
                  title={t("i18n.compareHead")}
                  aria-label={`${t("i18n.diff")} · ${name}`}
                  onClick={() => onOpenGitDiff(item.abs)}
                  style={{ ...CHIP_BASE, padding: "3px 7px", fontFamily: "inherit", background: "transparent", color: "var(--text-muted)" }}
                >
                  {t("i18n.diff")}
                </button>
              )}
              {kind && (
                <span style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: 0.3, textTransform: "uppercase" }}>
                  {kind}
                </span>
              )}
              {size && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{size}</span>}
              {item.caption && (
                <span style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{item.caption}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
