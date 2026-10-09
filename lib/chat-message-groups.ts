import { splitFinalAssistantBlocks } from "./message-display";
import type { AgentMessage, AssistantMessage } from "./types";

/** A report is a display boundary, not a user turn or a navigation target. */
export function isSubagentReport(message: Partial<AgentMessage>): boolean {
  return message.role === "custom" && message.customType === "pi-web:subagent-notification";
}

export function isChatGroupAnchor(message: AgentMessage): boolean {
  return message.role === "user" || (message.role === "custom"
    && (message.customType === "compaction" || isSubagentReport(message)));
}

export interface ChatMessageGroup {
  kind: "standalone" | "prompt" | "compaction" | "subagent-report";
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
    const kind = anchor.role === "user" ? "prompt"
      : isSubagentReport(anchor) ? "subagent-report"
      : isChatGroupAnchor(anchor) ? "compaction" : "standalone";
    if (kind === "prompt") parentFollowUp = false;
    else if (kind === "subagent-report") parentFollowUp = true;

    let contentStartIndex = startIndex + (kind === "standalone" ? 0 : 1);
    if (kind === "subagent-report") {
      while (contentStartIndex < messages.length && isSubagentReport(messages[contentStartIndex])) {
        contentStartIndex++;
      }
    }
    let endIndex = contentStartIndex;
    while (endIndex < messages.length && !isChatGroupAnchor(messages[endIndex])) endIndex++;
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
