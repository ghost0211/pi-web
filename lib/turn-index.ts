import { splitFinalAssistantBlocks } from "./message-display";
import { normalizeDisplayMath } from "./markdown";
import type { AgentMessage, AssistantMessage, CustomMessage, TextContent } from "./types";

/**
 * One navigable turn: a user prompt plus a plain-text digest of its answer.
 * The server builds these for the whole active branch so the chat's turn rail
 * can show every user turn even though the client only lazy-loads recent history.
 */
export interface TurnPreview {
  /** User entry id for navigation; head-only window placeholders are not targets. */
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
 * A user prompt and a compaction summary both start ChatWindow display groups.
 * Only genuine user prompts are navigable turn anchors: compaction cards remain
 * visible group boundaries, and steering ("引导插队") deliveries stay inside
 * the ongoing run instead of becoming independent rail nodes.
 */
export function isTurnGroupBoundary(message: AgentMessage | Partial<AgentMessage>): boolean {
  if (message.role === "user") return isTurnAnchor(message);
  return message.role === "custom"
    && (message as Partial<CustomMessage>).customType === "compaction";
}

/**
 * Only a real user prompt can anchor a navigable chat turn. Steering messages
 * injected into an ongoing run belong to that run's turn, never to a new one.
 */
export function isTurnAnchor(message: AgentMessage | Partial<AgentMessage>): boolean {
  return message.role === "user" && (message as { delivery?: string }).delivery !== "steer";
}

/** How one transcript message affects whether a run is still open for steering. */
export type SteeringRunEffect = "open" | "close" | "neutral";

/**
 * Structural steering ("引导插队") detection. Pi persists steered user messages
 * as plain user entries, so they can only be recognized by where they land: a
 * user message delivered while a run is still open was injected by the steering
 * queue. A run is open after an assistant turn with tool calls (unless it was
 * aborted or errored — abort-synthetic "Operation aborted" tool results must
 * not reopen it) and closed by a completed answer or a standalone `!` bash
 * execution. User messages, tool results, compaction cards and custom cards are
 * neutral: consecutive drained steering messages stay inside the open run, and
 * auto-compaction can sit between mid-run traffic and a steering delivery.
 *
 * The one unavoidable approximation: a steering message drained right after the
 * run's final answer is structurally identical to a fresh prompt, so it stays a
 * normal turn — consistently in live delivery and after reload.
 */
export function steeringRunEffect(message: AgentMessage | Partial<AgentMessage>): SteeringRunEffect {
  if (message.role === "assistant") {
    const content = (message as Partial<AssistantMessage>).content;
    const hasToolCalls = Array.isArray(content)
      && content.some((block) => (block as { type?: string } | null)?.type === "toolCall");
    const stopReason = (message as { stopReason?: string }).stopReason;
    return hasToolCalls && stopReason !== "aborted" && stopReason !== "error" ? "open" : "close";
  }
  if (message.role === "bashExecution") return "close";
  return "neutral";
}

/**
 * True when a user message appended after `messages` would be a steering-queue
 * delivery into a still-open run. Used to tag live deliveries with the same
 * rule that marks reloaded history, so the marker survives a refresh unchanged.
 */
export function isSteeringDeliveryContext(messages: readonly (AgentMessage | Partial<AgentMessage>)[]): boolean {
  let runOpen = false;
  for (const message of messages) {
    const effect = steeringRunEffect(message);
    if (effect === "open") runOpen = true;
    else if (effect === "close") runOpen = false;
  }
  return runOpen;
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
 * Builds navigable previews from messages. `entryIds` runs parallel to
 * `messages` and may hold `undefined` for optimistic/streaming messages. A
 * window starting mid-turn opens a non-navigable `head` placeholder for offset
 * alignment. Compaction remains a display-group boundary, but its summary and
 * following assistant output stay associated with the current user turn.
 */
export function buildTurnPreviews(
  messages: (AgentMessage | Partial<AgentMessage>)[],
  entryIds: (string | undefined)[],
): TurnPreview[] {
  const turns: TurnPreview[] = [];
  let current: TurnPreview | null = null;

  messages.forEach((message, index) => {
    const entryId = entryIds[index] ?? "";
    if (isTurnGroupBoundary(message)) {
      // A compaction card starts a separate ChatWindow process group, not a new
      // user turn. Keep the current navigable turn so its post-compaction answer
      // remains in the same rail preview.
      if (!isTurnAnchor(message)) return;

      const preview = getMessagePreview(message);
      current = {
        entryId,
        previewText: clip(preview || "…", PREVIEW_LIMIT),
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

/** What the turn rail could measure for one user turn or head placeholder. */
export interface LocalTurnMeasure {
  /** Scroll offset of the user/assistant element anchoring the turn, if measured. */
  top: number | null;
}

/**
 * Maps the loaded window onto positions in the full user-turn list. Loaded
 * history is a contiguous suffix of the active branch, so its last real user
 * turn aligns with the index's last turn. A leading `head` placeholder accounts
 * for a partial turn above the first user prompt in the window; it is excluded
 * from the displayed rail, but keeps suffix alignment correct when measured.
 */
export function mapTurnOffsets(
  localTurns: LocalTurnMeasure[],
  turnCount: number,
): Map<number, number> {
  const offsets = new Map<number, number>();
  if (localTurns.length === 0) return offsets;
  const firstIndex = turnCount - localTurns.length;

  localTurns.forEach((turn, ordinal) => {
    const index = firstIndex + ordinal;
    if (index >= 0 && turn.top !== null) offsets.set(index, turn.top);
  });
  return offsets;
}

/**
 * Combines the server's whole-branch index with user turns measured in the
 * loaded suffix. A `head` item is only an alignment placeholder and must never
 * be shown or navigated, including when a new session has no server index yet.
 */
export function mergeNavigableTurnPreviews(
  turnIndex: TurnPreview[],
  localTurns: TurnPreview[],
): TurnPreview[] {
  const navigableLocalTurns = localTurns.filter((turn) => !turn.head);
  const navigableIndex = turnIndex.filter((turn) => !turn.head);
  if (navigableIndex.length === 0) return navigableLocalTurns;

  const known = new Set(navigableIndex.map((turn) => turn.entryId));
  const extra = navigableLocalTurns.filter((turn) => turn.entryId && !known.has(turn.entryId));
  return extra.length > 0 ? [...navigableIndex, ...extra] : navigableIndex;
}
