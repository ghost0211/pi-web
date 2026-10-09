import { isValidSessionId } from "./session-file-references-core";

export type SubagentReportStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted"
  | "cancelled"
  | "unknown";

export interface SubagentReport {
  /** Text-only raw result; never serialized or rendered as arbitrary JSON. */
  content: string;
  taskDescription: string | null;
  profile: string | null;
  status: SubagentReportStatus;
  completedAt: string | null;
  sessionId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseStatus(value: unknown): SubagentReportStatus {
  switch (value) {
    case "starting":
    case "running":
    case "completed":
    case "failed":
    case "aborted":
    case "interrupted":
      return value;
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

function toIsoDate(value: unknown): string | null {
  let time: number;
  if (typeof value === "number") {
    time = value;
  } else if (typeof value === "string" && value.trim()) {
    time = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Prefer the subagent's completion timestamp; fall back to the notification timestamp. */
export function resolveSubagentReportTime(completedAt: unknown, messageTimestamp?: unknown): string | null {
  return toIsoDate(completedAt) ?? toIsoDate(messageTimestamp);
}

function extractTextBlock(block: unknown): string | null {
  if (!isRecord(block)) return null;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  // Some older serialized custom messages omit the block discriminator.
  if (block.type === undefined && typeof block.text === "string") return block.text;
  if (block.type === "text" && typeof block.content === "string") return block.content;
  return null;
}

/** Extract Markdown only from known text-block shapes, preserving all source text. */
export function extractSubagentReportText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(extractTextBlock)
    .filter((text): text is string => text !== null)
    .join("\n");
}

/**
 * Decode only the documented, version-independent UI fields from the notification.
 * Unknown details and statuses fail closed instead of implying successful completion.
 */
export function parseSubagentReport(
  details: unknown,
  content: unknown,
  messageTimestamp?: unknown,
): SubagentReport {
  const isKnownDetails = isRecord(details) && details.kind === "pi-web-subagent";
  const metadata = isKnownDetails ? details : null;
  const rawSessionId = metadata?.sessionId;
  // The SDK sends notification content to the model but omits details. When a
  // trusted notification carries the exact report separately, prefer it—even
  // when intentionally empty—so integration guidance is never shown as output.
  const reportText = metadata && typeof metadata.reportText === "string"
    ? metadata.reportText
    : extractSubagentReportText(content);

  return {
    content: reportText,
    taskDescription: metadata ? nonEmptyString(metadata.description) : null,
    profile: metadata ? nonEmptyString(metadata.profile) : null,
    status: metadata ? parseStatus(metadata.status) : "unknown",
    completedAt: metadata ? resolveSubagentReportTime(metadata.completedAt, messageTimestamp) : toIsoDate(messageTimestamp),
    // Session ids are opaque UUIDs, not paths or URLs. Never pass arbitrary details to the callback.
    sessionId: typeof rawSessionId === "string" && isValidSessionId(rawSessionId) ? rawSessionId : null,
  };
}
