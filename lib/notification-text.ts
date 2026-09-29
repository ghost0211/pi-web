/**
 * Notification text helpers: build a compact, plain-text snippet from a chat
 * timeline so task-completion notifications can show *what* finished instead
 * of a generic "done" message (like Codex's task notification).
 */
import type { AgentMessage } from "./types";

export const NOTIFICATION_SNIPPET_MAX_CHARS = 160;

/** Collapse markdown-ish assistant text into a single plain-text line. */
export function plainNotificationText(raw: string, maxChars = NOTIFICATION_SNIPPET_MAX_CHARS): string {
  let text = raw;
  // Drop fenced code blocks entirely — useless in a toast.
  text = text.replace(/```[\s\S]*?(```|$)/g, " ");
  // Images and links keep their human-readable label.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Inline code keeps its content.
  text = text.replace(/`([^`]*)`/g, "$1");
  // Strip list/quote/heading markers at line starts.
  text = text.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s?|\d+\.\s+)/gm, "");
  // Collapse all whitespace runs.
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  return `${clipped.slice(0, clipped.lastIndexOf(" ") > 40 ? clipped.lastIndexOf(" ") : maxChars).trimEnd()}…`;
}

/**
 * Text of the most recent assistant message, ready for a notification body.
 * Returns null when the timeline has no assistant text.
 */
export function extractAssistantSnippet(
  messages: readonly AgentMessage[],
  maxChars = NOTIFICATION_SNIPPET_MAX_CHARS,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) parts.push(block.text);
    }
    const joined = parts.join("\n").trim();
    if (!joined) continue;
    const snippet = plainNotificationText(joined, maxChars);
    if (snippet) return snippet;
  }
  return null;
}
