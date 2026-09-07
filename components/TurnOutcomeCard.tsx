"use client";

import { useI18n } from "@/hooks/useI18n";
import type { TurnOutcome } from "@/lib/turn-outcome";
import { TurnWrittenFiles } from "./TurnWrittenFiles";

export function TurnOutcomeCard({ outcome, onOpenFile }: {
  outcome: TurnOutcome;
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  if (!outcome.files.length && !outcome.commands.length) return null;
  return (
    <section aria-label={t("chat.turnOutcome")} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", marginBottom: 20, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 }}>
        {t("chat.turnOutcome")}
      </div>
      <TurnWrittenFiles files={outcome.files} onOpenFile={onOpenFile} />
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
