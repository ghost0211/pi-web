import { splitFinalAssistantBlocks } from "./message-display";
import type { AgentMessage, AssistantMessage } from "./types";

/** A report is a display boundary, not a user turn or a navigation target. */
export function isSubagentReport(message: Partial<AgentMessage>): boolean {
  return message.role === "custom" && message.customType === "pi-web:subagent-notification";
}

export function isChatGroupAnchor(message: AgentMessage): boolean {
  // A steering ("引导插队") delivery is not a group anchor: it belongs to the
  // ongoing run it was injected into, so the run stays one prompt group.
  if (message.role === "user") return message.delivery !== "steer";
  return message.role === "custom"
    && (message.customType === "compaction" || message.customType === "pi-web:auto-advance" || isSubagentReport(message));
}

export interface ChatMessageGroup {
  kind: "standalone" | "prompt" | "compaction" | "subagent-report" | "auto-advance";
  startIndex: number;
  /** Exclusive end of this contiguous history segment. */
  endIndex: number;
  /** First process/answer message, after the prompt or consecutive report cards. */
  contentStartIndex: number;
  /** The parent is responding to a report, rather than answering a new user prompt. */
  parentFollowUp: boolean;
}

/**
 * Keep persisted order, but never fold a parent's original final answer into
 * the process details of a later background-report follow-up. Adjacent reports
 * form one segment; their cards remain visible before the parent's supplement.
 * Compaction can split a supplement without changing its source attribution.
 */
export function buildChatMessageGroups(messages: readonly AgentMessage[]): ChatMessageGroup[] {
  const groups: ChatMessageGroup[] = [];
  let parentFollowUp = false;
  for (let startIndex = 0; startIndex < messages.length;) {
    const anchor = messages[startIndex];
    const kind = anchor.role === "user" && anchor.delivery !== "steer" ? "prompt"
      : anchor.role === "custom" && anchor.customType === "pi-web:auto-advance" ? "auto-advance"
      : isSubagentReport(anchor) ? "subagent-report"
      : isChatGroupAnchor(anchor) ? "compaction" : "standalone";
    if (kind === "prompt" || kind === "auto-advance") parentFollowUp = false;
    else if (kind === "subagent-report") parentFollowUp = true;

    let contentStartIndex = startIndex + (kind === "standalone" ? 0 : 1);
    if (kind === "subagent-report") {
      while (contentStartIndex < messages.length && isSubagentReport(messages[contentStartIndex])) {
        contentStartIndex++;
      }
    }
    let endIndex = contentStartIndex;
    let completedRun = false;
    while (endIndex < messages.length && !isChatGroupAnchor(messages[endIndex])) {
      const message = messages[endIndex];
      // An autonomous SDK run can follow a completed answer without a new user
      // prompt/report. Preserve that answer instead of folding it into the next
      // run's process. Trailing tool results still belong to the completed run.
      if (completedRun && message.role === "assistant") break;
      if (message.role === "assistant" && message.runDurationMs !== undefined && Number.isFinite(message.runDurationMs)
        && message.runDurationMs >= 0 && message.runDurationEstimated === false) completedRun = true;
      endIndex++;
    }
    groups.push({ kind, startIndex, endIndex, contentStartIndex, parentFollowUp });
    startIndex = endIndex;
  }
  return groups;
}

export function findFinalAssistantIndex(
  messages: readonly AgentMessage[],
  beforeContentIndex: number,
  endIndex: number,
): number {
  for (let index = endIndex - 1; index > beforeContentIndex; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
      block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
    ))) return index;
  }
  for (let index = endIndex - 1; index > beforeContentIndex; index--) {
    if (messages[index].role === "assistant") return index;
  }
  return -1;
}

/** A streaming supplement gets a label only when its segment has no assistant bubble yet. */
export function needsStreamingFollowUpLabel(
  messages: readonly AgentMessage[],
  group: ChatMessageGroup | undefined,
): boolean {
  return Boolean(group?.parentFollowUp
    && !messages.slice(group.contentStartIndex, group.endIndex).some((message) => message.role === "assistant"));
}
