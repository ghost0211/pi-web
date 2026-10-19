"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileApiUrl, getFileName } from "@/lib/file-paths";
import { isClaimedFileFromTurn } from "@/lib/turn-outcome";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";
import { TURN_DIFF_BUTTON_STYLE, TURN_FILE_BUTTON_STYLE } from "./TurnWrittenFiles";

/**
 * Files the reply text claims as deliverables but no write/edit tool call
 * recorded — typically shell-command outputs (a generator script writing the
 * real artifact). Every entry shown here has been corroborated against the
 * filesystem: it exists and its mtime falls inside the turn window
 * (`sinceTs`). Anything failing verification is omitted silently — a claim is
 * a candidate, never evidence on its own.
 */
export function TurnClaimedFiles({
  claimed,
  sinceTs,
  onOpenFile,
  onOpenGitDiff,
  showDiffNotice,
  diffNotice,
}: {
  claimed: WrittenFile[];
  /** Turn start (user-message timestamp, ms). Claims are hidden without it. */
  sinceTs?: number;
  onOpenFile?: (filePath: string) => void;
  onOpenGitDiff?: (filePath: string) => void;
  /** Show the repository-level diff notice (only when no written-files row did). */
  showDiffNotice?: boolean;
  diffNotice?: string;
}) {
  const { t } = useI18n();
  const [verified, setVerified] = useState<WrittenFile[]>([]);
  const pathsKey = claimed.map((file) => file.filePath).join("\n");

  useEffect(() => {
    let cancelled = false;
    setVerified([]);
    if (pathsKey.length === 0 || typeof sinceTs !== "number") return;
    const paths = pathsKey.split("\n");
    void Promise.all(
      paths.map(async (filePath) => {
        try {
          const response = await fetch(getFileApiUrl(filePath, "meta"));
          if (!response.ok) return null;
          const meta = (await response.json()) as { mtimeMs?: unknown };
          return isClaimedFileFromTurn(meta, sinceTs) ? ({ filePath } satisfies WrittenFile) : null;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (!cancelled) setVerified(results.filter((file): file is WrittenFile => file !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [pathsKey, sinceTs]);

  if (verified.length === 0) return null;

  return (
    <div style={{ marginTop: 8 }}>
      <div aria-label={t("chat.commandGeneratedFiles")} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <span
          title={t("chat.commandGeneratedHint")}
          style={{ fontSize: 11, color: "var(--text-dim)", cursor: "help" }}
        >
          {t("chat.commandGeneratedFiles")}
        </span>
        {verified.map(({ filePath }) => {
          const name = getFileName(filePath);
          return (
            <span key={filePath} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                title={`${filePath}\n${t("chat.commandGeneratedHint")}`}
                aria-label={t("chat.openWrittenFile", { name })}
                onClick={() => onOpenFile?.(filePath)}
                style={TURN_FILE_BUTTON_STYLE}
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
                  style={TURN_DIFF_BUTTON_STYLE}
                >
                  {t("i18n.diff")}
                </button>
              )}
            </span>
          );
        })}
      </div>
      {showDiffNotice && diffNotice && (
        <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--text-dim)" }}>
          {diffNotice}
        </p>
      )}
    </div>
  );
}
