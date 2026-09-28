import type { AgentMessage } from "@/lib/types";

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

export function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

/**
 * Merge an SSE user-message completion with the optimistic bubble or a disk
 * snapshot. A background reconciliation can read the persisted prompt before
 * its message_end arrives; appending that event again briefly shows two prompts.
 * Timestamp + content identify the persisted entry, while the optimistic key
 * only applies to the run's initial prompt. Later identical queue deliveries
 * with different timestamps remain separate messages.
 */
export function mergeDeliveredUserMessage(
  messages: AgentMessage[],
  delivered: AgentMessage & { role: "user" },
  optimisticKey: string | null,
): AgentMessage[] {
  const deliveredKey = userMessageKey(delivered);
  const last = messages.at(-1);
  if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
    return optimisticKey === deliveredKey
      ? messages
      : [...messages.slice(0, -1), delivered];
  }
  if (typeof delivered.timestamp === "number" && messages.some((message) => (
    message.role === "user"
    && message.timestamp === delivered.timestamp
    && userMessageKey(message) === deliveredKey
  ))) return messages;
  return [...messages, delivered];
}
