import type { AgentMessage, AgentUsage } from "./types";

const ESTIMATED_IMAGE_CHARS = 4800;

/** SDK context roles are not present in the UI's normalized message union. */
interface ContextSummaryMessage {
  role: "compactionSummary" | "branchSummary";
  summary: string;
  timestamp?: number;
}

interface ContextSystemMessage {
  role: "system";
  content: unknown;
  timestamp?: number;
  sections?: Record<string, string | null>;
  toolsAdded?: unknown[];
}

type ContextMessage = AgentMessage | ContextSummaryMessage | ContextSystemMessage;

export function getMessageContextTokens(usage?: AgentUsage | null): number {
  if (!usage) return 0;
  const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (promptTokens > 0) return promptTokens;
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    return usage.totalTokens;
  }
  return usage.output ?? 0;
}

function estimateTextAndImageContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; thinking?: string; arguments?: unknown; input?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      chars += b.text.length;
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      chars += b.thinking.length;
    } else if (b.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    } else if (b.type === "toolCall") {
      try {
        chars += JSON.stringify(b.arguments ?? b.input ?? "").length;
      } catch {
        chars += 64;
      }
    }
  }
  return chars;
}

export function estimateMessageTokens(message: ContextMessage): number {
  if (!message) return 0;
  let chars = 0;
  switch (message.role) {
    case "system": {
      chars = estimateTextAndImageContentChars(message.content);
      for (const section of Object.values(message.sections ?? {})) {
        if (section) chars += section.length;
      }
      if (message.toolsAdded) {
        try {
          chars += JSON.stringify(message.toolsAdded).length;
        } catch {
          chars += 64;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "compactionSummary":
    case "branchSummary":
      return Math.ceil(message.summary.length / 4);
    case "bashExecution":
      return message.excludeFromContext ? 0 : Math.ceil((message.command.length + message.output.length) / 4);
    case "user": {
      chars = estimateTextAndImageContentChars(message.content);
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      chars = estimateTextAndImageContentChars(message.content);
      return Math.ceil(chars / 4);
    }
    case "toolResult": {
      chars = estimateTextAndImageContentChars(message.content);
      return Math.ceil(chars / 4);
    }
    case "custom": {
      if (typeof message.content === "string") {
        chars = message.content.length;
      } else {
        chars = estimateTextAndImageContentChars(message.content);
      }
      return Math.ceil(chars / 4);
    }
    default:
      return 0;
  }
}

export interface ActiveContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export function calculateActiveContextTokens(
  messages: ContextMessage[],
  contextWindow = 128_000,
  options: { estimateOnly?: boolean } = {},
): ActiveContextUsage {
  if (!messages || messages.length === 0) {
    return { tokens: 0, contextWindow, percent: 0 };
  }

  const windowSize = contextWindow > 0 ? contextWindow : 128_000;

  // Find the compaction index if one exists
  let compactionIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "compactionSummary" || (msg.role === "custom" && msg.customType === "compaction")) {
      compactionIndex = i;
      break;
    }
  }

  const searchFloor = compactionIndex >= 0 ? compactionIndex : 0;
  const compactionTimestamp = compactionIndex >= 0 ? messages[compactionIndex].timestamp : undefined;
  // A native SDK projection already excludes old history; keep its leading
  // system checkpoint in the estimate, even though it precedes the summary.
  const estimateFloor = compactionIndex >= 0 && messages[compactionIndex].role === "compactionSummary"
    ? 0 : searchFloor;

  // The SDK deliberately returns tokens:null until a post-compaction response.
  // Retained assistants still carry usage for the old, larger context. Never
  // reuse that usage when the caller says it is stale: estimate the rebuilt
  // projection, including its system checkpoint and SDK summary roles.
  if (options.estimateOnly) {
    const tokens = messages.slice(estimateFloor).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    return {
      tokens,
      contextWindow: windowSize,
      percent: Math.min(100, Math.max(0, Math.round((tokens / windowSize) * 100))),
    };
  }

  // Look for the last assistant message with valid usage after compaction boundary.
  let lastAssistantIndex = -1;
  let baseTokens = 0;

  for (let i = messages.length - 1; i >= searchFloor; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.usage) {
      // buildSessionContext puts the summary BEFORE retained old assistants.
      // Their position alone cannot make their old usage post-compaction.
      if (typeof compactionTimestamp === "number" && typeof msg.timestamp === "number"
        && msg.timestamp <= compactionTimestamp) continue;
      const msgTokens = getMessageContextTokens(msg.usage);
      if (msgTokens > 0) {
        lastAssistantIndex = i;
        baseTokens = msgTokens;
        break;
      }
    }
  }

  let totalTokens = 0;
  if (lastAssistantIndex >= 0) {
    // We have a solid baseline from provider usage
    let trailingTokens = 0;
    for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
      trailingTokens += estimateMessageTokens(messages[i]);
    }
    totalTokens = baseTokens + trailingTokens;
  } else {
    // No assistant usage in the active window (e.g. freshly compacted or newly started)
    // Sum estimated tokens for all messages from searchFloor to end
    let estimated = 0;
    for (let i = estimateFloor; i < messages.length; i++) {
      estimated += estimateMessageTokens(messages[i]);
    }
    totalTokens = estimated;
  }

  const percent = Math.min(100, Math.max(0, Math.round((totalTokens / windowSize) * 100)));

  return {
    tokens: totalTokens,
    contextWindow: windowSize,
    percent,
  };
}
