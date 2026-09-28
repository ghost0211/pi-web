"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

/**
 * The viewer's git diff compares the working tree against HEAD for the whole
 * repository, so it is not proof that every hunk came from this turn. Exposed
 * as an overridable default because these components must not add i18n keys;
 * callers can pass a localized `diffNotice`.
 */
export const DEFAULT_TURN_DIFF_NOTICE =
  "Git diff compares the working tree with HEAD and may include changes from outside this turn.";

const FILE_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  background: "var(--bg-subtle)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
};

const DIFF_BUTTON_STYLE: CSSProperties = {
  ...FILE_BUTTON_STYLE,
  padding: "2px 6px",
  fontFamily: "inherit",
  color: "var(--text-muted)",
  background: "transparent",
};

/**
 * Lists the files a turn actually wrote, as buttons that open each one in the
 * preview pane. Entries come from the turn's successful `write`/`edit` tool
 * calls — the reply text is never scanned for paths.
 *
 * When `onOpenGitDiff` is provided, each entry also gets a "Diff" button that
 * should open the file with FileViewer's git-diff mode. That diff is a
 * repository-level comparison against HEAD, not an attribution of this turn,
 * so the `diffNotice` text is shown whenever the entry is offered.
 */
export function TurnWrittenFiles({
  files,
  onOpenFile,
  onOpenGitDiff,
  diffNotice = DEFAULT_TURN_DIFF_NOTICE,
}: {
  files: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
  /** Open this file in the viewer's git-diff mode (working tree vs HEAD). */
  onOpenGitDiff?: (filePath: string) => void;
  /** Explains that the git diff is repository-level, not scoped to this turn. */
  diffNotice?: string;
}) {
  const { t } = useI18n();
  if (files.length === 0) return null;

  return (
    <div style={{ marginTop: 6 }}>
      <div aria-label={t("chat.filesWritten")} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {files.map(({ filePath }) => {
          const name = getFileName(filePath);
          return (
            <span key={filePath} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                title={filePath}
                aria-label={t("chat.openWrittenFile", { name })}
                onClick={() => onOpenFile?.(filePath)}
                style={FILE_BUTTON_STYLE}
              >
                {getFileIcon(name, 12)}
                <span>{name}</span>
              </button>
              {onOpenGitDiff && (
                <button
                  type="button"
                  title={t("i18n.compareHead")}
                  aria-label={`${t("i18n.diff")} · ${name}`}
                  onClick={() => onOpenGitDiff(filePath)}
                  style={DIFF_BUTTON_STYLE}
                >
                  {t("i18n.diff")}
                </button>
              )}
            </span>
          );
        })}
      </div>
      {onOpenGitDiff && (
        <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--text-dim)" }}>
          {diffNotice}
        </p>
      )}
    </div>
  );
}
