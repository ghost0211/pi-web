"use client";

import { useState, type ReactNode } from "react";

interface Props {
  messageCount: number;
  toolCallCount: number;
  durationText?: string;
  defaultExpanded?: boolean;
  children?: ReactNode;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function ProcessDetailsGroup({ messageCount, toolCallCount, durationText, defaultExpanded = false, children, t }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const parts = [t("chat.processDetails")];
  if (messageCount > 0) parts.push(`${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`);
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);
  if (durationText) parts.push(durationText);

  // A simple text-only answer still gets a duration, without an empty disclosure.
  if (messageCount === 0) {
    return <div data-run-duration={durationText} style={{ marginBottom: 14, padding: "2px 0", color: "var(--text-muted)", fontSize: 12, overflowWrap: "anywhere" }}>{parts.join(" · ")}</div>;
  }
  return (
    <div data-run-duration={durationText} style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "auto", maxWidth: "100%", minHeight: 24, padding: "2px 0", border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{parts.join(" · ")}</span>
      </button>
      {expanded && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}
