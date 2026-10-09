"use client";

import { MarkdownBody } from "./MarkdownBody";
import { useI18n } from "@/hooks/useI18n";
import { parseSubagentReport } from "@/lib/subagent-report";
import type { CustomMessage } from "@/lib/types";

interface Props {
  message: CustomMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  sessionId?: string;
}

/** A subagent's original report, kept separate from the main agent response. */
export function SubagentReport({ message, cwd, onOpenFile, onOpenSession, sessionId }: Props) {
  const { locale, t } = useI18n();
  const report = parseSubagentReport(message.details, message.content, message.timestamp);
  const statusLabel = t(`subagent.status.${report.status}`);
  const formattedTime = report.completedAt
    ? new Date(report.completedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
    : null;

  return (
    <div className="subagent-report-shell">
      <details className="subagent-report-details">
        <summary className="subagent-report-summary">
          <span className="subagent-report-chevron" aria-hidden="true">›</span>
          <span className="subagent-report-summary-content">
            <span className="subagent-report-heading-row">
              <span className="subagent-report-title">{t("subagent.reportTitle")}</span>
              <span className={`subagent-report-status subagent-report-status--${report.status}`}>
                {statusLabel}
              </span>
            </span>
            <span className="subagent-report-task-label">{t("subagent.task")}</span>
            <span className="subagent-report-task">
              {report.taskDescription ?? t("subagent.noDescription")}
            </span>
            {(report.profile || formattedTime) && (
              <span className="subagent-report-metadata">
                {report.profile && (
                  <span className="subagent-report-field">
                    <span className="subagent-report-field-label">{t("subagent.profile")}:</span> {report.profile}
                  </span>
                )}
                {formattedTime && (
                  <span className="subagent-report-field">
                    <span className="subagent-report-field-label">{t("subagent.completedAt")}:</span>{" "}
                    <time dateTime={report.completedAt ?? undefined}>{formattedTime}</time>
                  </span>
                )}
              </span>
            )}
            <span className="subagent-report-note">{t("subagent.originalResultNote")}</span>
          </span>
        </summary>

        <div className="subagent-report-body">
          {report.content
            ? <MarkdownBody className="markdown-subagent-report" cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId}>{report.content}</MarkdownBody>
            : <p className="subagent-report-empty">{t("subagent.emptyResult")}</p>}
        </div>
      </details>

      {report.sessionId && onOpenSession && (
        <button
          type="button"
          className="subagent-report-open"
          onClick={() => onOpenSession(report.sessionId!)}
          title={t("subagent.open")}
          aria-label={t("subagent.open")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </button>
      )}
    </div>
  );
}
