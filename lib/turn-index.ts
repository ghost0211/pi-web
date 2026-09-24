import { splitFinalAssistantBlocks } from "./message-display";
import { normalizeDisplayMath } from "./markdown";
import type { AgentMessage, AssistantMessage, CustomMessage, TextContent } from "./types";

/**
 * One navigable turn: the prompt (or compaction heading) that anchors it plus a
 * plain-text digest of its final answer. The server builds these for the whole
 * active branch so the chat's turn rail can show every turn even though the
 * client only lazy-loads the most recent page of history.
 */
export interface TurnPreview {
  /** Entry id anchoring the turn — the lazy-load target when it is not loaded yet. */
  entryId: string;
  /** Prompt text shown in the turn's preview card. */
  previewText: string;
  /** Plain-text digest of the turn's final answer. */
  summary: string;
  /**
   * True when the turn only exists because a loaded window starts mid-turn:
   * it is a placeholder for the segment above the first anchor in range, not a
   * turn of its own. Never set by the server's whole-branch index.
   */
  head?: boolean;
  /**
   * Index of the anchoring message in the window this preview was built from.
   * Window-derived previews only — the server index leaves it undefined.
   */
  messageIndex?: number;
}

/** Prompt text kept per turn; the preview card clamps it to two lines anyway. */
const PREVIEW_LIMIT = 120;
/** Answer digest kept per turn; the preview card clamps it to four lines. */
const SUMMARY_LIMIT = 200;

/**
 * A user prompt starts a turn; so does a compaction summary, mirroring
 * ChatWindow's grouping (otherwise every post-compaction message would render
 * standalone and never collapse).
 */
export function isTurnAnchor(message: AgentMessage | Partial<AgentMessage>): boolean {
  if (message.role === "user") return true;
  return message.role === "custom"
    && (message as Partial<CustomMessage>).customType === "compaction";
}

export function getMessagePreview(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((block): block is TextContent => (block as TextContent)?.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
  return "";
}

export function firstTextLine(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return (line ?? "").replace(/^#+\s*/, "") || "…";
}

/**
 * Flattens an answer into the single paragraph shown under the prompt in the
 * preview card: markdown structure (headings, lists, emphasis, tables, code
 * fences) is dropped and math delimiters are unwrapped so the digest reads as
 * prose instead of source.
 */
export function turnSummaryFromMarkdown(markdown: string): string {
  return normalizeDisplayMath(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/\$\$?([^$]*)\$\$?/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/[*~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getAssistantAnswerMarkdown(message: AgentMessage | Partial<AgentMessage>): string {
  if (message.role !== "assistant") return "";
  const { answerBlocks } = splitFinalAssistantBlocks(message as AssistantMessage);
  return answerBlocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

/**
 * Groups messages into turns. `entryIds` runs parallel to `messages` and may
 * hold `undefined` for optimistic/streaming messages. A window whose first
 * message is not an anchor opens a `head` turn for the segment above the first
 * anchor in range, so the rail is never empty on a long session.
 */
export function buildTurnPreviews(
  messages: (AgentMessage | Partial<AgentMessage>)[],
  entryIds: (string | undefined)[],
): TurnPreview[] {
  const turns: TurnPreview[] = [];
  let current: TurnPreview | null = null;

  messages.forEach((message, index) => {
    const entryId = entryIds[index] ?? "";
    if (isTurnAnchor(message)) {
      const isCompaction = message.role === "custom";
      const preview = getMessagePreview(message);
      current = {
        entryId,
        previewText: clip(isCompaction ? firstTextLine(preview) : preview || "…", PREVIEW_LIMIT),
        summary: "",
        messageIndex: index,
      };
      turns.push(current);
      return;
    }
    if (message.role !== "assistant") return;

    const answerMarkdown = getAssistantAnswerMarkdown(message);
    if (!current && turns.length === 0) {
      current = {
        entryId,
        previewText: clip(firstTextLine(answerMarkdown), PREVIEW_LIMIT),
        summary: "",
        head: true,
        messageIndex: index,
      };
      turns.push(current);
    }
    if (current && answerMarkdown) {
      current.summary = clip(turnSummaryFromMarkdown(answerMarkdown), SUMMARY_LIMIT);
    }
  });

  return turns;
}

/** What the turn rail could measure for one turn of the loaded window. */
export interface LocalTurnMeasure {
  /** Scroll offset of the element anchoring the turn, or null when nothing was measured. */
  top: number | null;
  /**
   * The turn anchors no element of its own (a compaction card), so it borrows
   * the offset of the next measured turn.
   */
  borrowNext?: boolean;
}

/**
 * Maps the loaded window onto positions in the full turn list. The loaded
 * history is always a contiguous suffix of the active branch, so the window's
 * last turn is the index's last turn and everything lines up from there — no
 * entry-id lookups needed, which keeps optimistic (not yet persisted) turns
 * measurable too.
 */
export function mapTurnOffsets(
  localTurns: LocalTurnMeasure[],
  turnCount: number,
  endOfHistory?: number,
): Map<number, number> {
  const offsets = new Map<number, number>();
  if (localTurns.length === 0) return offsets;
  const firstIndex = turnCount - localTurns.length;
  const pending: number[] = [];

  localTurns.forEach((turn, ordinal) => {
    const index = firstIndex + ordinal;
    if (index < 0) return;
    if (turn.top !== null) {
      offsets.set(index, turn.top);
      for (const earlier of pending) offsets.set(earlier, turn.top);
      pending.length = 0;
      return;
    }
    if (turn.borrowNext) pending.push(index);
  });

  // A trailing compaction has no following message element to borrow from.
  // It lives at the end of the chat, not at the previous turn's offset.
  if (endOfHistory !== undefined) {
    for (const index of pending) offsets.set(index, endOfHistory);
  }
  return offsets;
}
