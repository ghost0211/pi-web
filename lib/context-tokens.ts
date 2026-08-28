import type { AgentMessage, AgentUsage } from "./types";

const ESTIMATED_IMAGE_CHARS = 4800;

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
    const b = block as { type?: string; text?: string; thinking?: string; arguments?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      chars += b.text.length;
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      chars += b.thinking.length;
    } else if (b.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    } else if (b.type === "toolCall") {
      try {
        chars += JSON.stringify(b.arguments ?? "").length;
      } catch {
        chars += 64;
      }
    }
  }
  return chars;
}

export function estimateMessageTokens(message: AgentMessage): number {
  if (!message) return 0;
  let chars = 0;
  switch (message.role) {
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
  messages: AgentMessage[],
  contextWindow = 128_000,
): ActiveContextUsage {
  if (!messages || messages.length === 0) {
    return { tokens: 0, contextWindow, percent: 0 };
  }

  const windowSize = contextWindow > 0 ? contextWindow : 128_000;

  // Find the compaction index if one exists
  let compactionIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "custom" && msg.customType === "compaction") {
      compactionIndex = i;
      break;
    }
  }

  // Look for the last assistant message with valid usage after compaction boundary
  const searchFloor = compactionIndex >= 0 ? compactionIndex : 0;
  let lastAssistantIndex = -1;
  let baseTokens = 0;

  for (let i = messages.length - 1; i >= searchFloor; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.usage) {
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
    for (let i = searchFloor; i < messages.length; i++) {
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
