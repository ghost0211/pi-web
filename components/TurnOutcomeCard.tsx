"use client";

import { useI18n } from "@/hooks/useI18n";
import type { TurnOutcome } from "@/lib/turn-outcome";
import { PresentDeliverables } from "./PresentDeliverables";
import { TurnClaimedFiles } from "./TurnClaimedFiles";
import { TurnWrittenFiles } from "./TurnWrittenFiles";

/**
 * Per-turn review card.
 *
 * Order matters: the deliverables the model declared through `present_files`
 * come first, because that is what the user asked for; the files this turn's
 * `write`/`edit` calls touched are secondary, and reply-text guesses come
 * last. A file that is already a deliverable never repeats in the lower rows.
 *
 * `onOpenGitDiff` enables the per-file diff entry. The host (ChatWindow /
 * AppShell) owns that wiring and should open the file with FileViewer's
 * `initialDisplayMode="diff"`, i.e. FileViewer's own working-tree-vs-HEAD diff
 * request — see `TurnWrittenFiles` for the accompanying scope notice.
 */
export function TurnOutcomeCard({ outcome, sinceTs, cwd, onOpenFile, onOpenGitDiff, diffNotice }: {
  outcome: TurnOutcome;
  /** Turn start (user-message timestamp, ms); gates claimed-file verification. */
  sinceTs?: number;
  /** Session cwd, used to shorten declared deliverable paths. */
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  /** Open a written file in the viewer's repository-level git-diff mode. */
  onOpenGitDiff?: (filePath: string) => void;
  /** Localized replacement for the default repository-level diff notice. */
  diffNotice?: string;
}) {
  const { t } = useI18n();
  const claimed = outcome.claimed ?? [];
  const deliverables = outcome.deliverables ?? null;
  if (!deliverables && !outcome.files.length && !outcome.commands.length && !claimed.length) return null;
  return (
    <section aria-label={t("chat.turnOutcome")} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", marginBottom: 20, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 }}>
        {t("chat.turnOutcome")}
      </div>
      {deliverables && (
        <PresentDeliverables
          deliverables={deliverables}
          cwd={cwd}
          onOpenFile={onOpenFile}
          onOpenGitDiff={onOpenGitDiff}
        />
      )}
      {deliverables && (outcome.files.length > 0 || claimed.length > 0) && (
        <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-dim)" }}>
          {t("chat.otherChangedFiles")}
        </div>
      )}
      <TurnWrittenFiles
        files={outcome.files}
        onOpenFile={onOpenFile}
        onOpenGitDiff={onOpenGitDiff}
        diffNotice={diffNotice}
      />
      <TurnClaimedFiles
        claimed={claimed}
        sinceTs={sinceTs}
        onOpenFile={onOpenFile}
        onOpenGitDiff={onOpenGitDiff}
        showDiffNotice={Boolean(onOpenGitDiff) && outcome.files.length === 0 && !deliverables}
        diffNotice={diffNotice}
      />
      {outcome.commands.length > 0 && (
        <details style={{ marginTop: outcome.files.length ? 12 : 0, fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>
            {t("chat.recordedCommands", { count: outcome.commands.length })}
            {outcome.commands.some((command) => command.status === "failed") && ` · ${t("chat.commandFailures")}`}
          </summary>
          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {outcome.commands.map((command) => (
              <details key={command.id} style={{ padding: 8, background: "var(--bg-hover)", borderRadius: 6 }}>
                <summary style={{ cursor: "pointer", overflowWrap: "anywhere" }}>
                  <span style={{ color: "var(--text-muted)", marginRight: 8 }}>{t(`chat.command.${command.status}`)}</span>
                  <code style={{ whiteSpace: "pre-wrap" }}>{command.command}</code>
                </summary>
                {command.truncated && <p style={{ color: "var(--text-muted)" }}>{t("chat.commandOutputTail")}</p>}
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflowY: "auto", marginBottom: 0 }}>{command.output || t("chat.commandNoOutput")}</pre>
              </details>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
