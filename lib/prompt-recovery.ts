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

/**
 * Pi may normalize prompt text when persisting (trim, CRLF→LF), while the
 * optimistic bubble keeps the composer's raw string. Normalize before
 * keying so the two representations of the same prompt compare equal.
 */
function normalizeMessageText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
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
  if (typeof content === "string") return JSON.stringify({ text: normalizeMessageText(content), images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: normalizeMessageText(extractMessageText(message)),
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
  // The optimistic bubble is not necessarily the last message: with long text
  // or attachments the assistant can start streaming (message_start snapshot)
  // before the prompt's own message_end arrives. Find it wherever it is.
  if (optimisticKey) {
    const optimisticIndex = messages.findLastIndex((message) => (
      message.role === "user" && userMessageKey(message) === optimisticKey
    ));
    if (optimisticIndex !== -1) {
      return optimisticKey === deliveredKey
        ? messages
        : [
          ...messages.slice(0, optimisticIndex),
          delivered,
          ...messages.slice(optimisticIndex + 1),
        ];
    }
  }
  if (typeof delivered.timestamp === "number" && messages.some((message) => (
    message.role === "user"
    && message.timestamp === delivered.timestamp
    && userMessageKey(message) === deliveredKey
  ))) return messages;
  return [...messages, delivered];
}
