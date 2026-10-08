import type { ToolResultMessage } from "./types";

export interface ToolExecutionDuration {
  /** Tool execution time in seconds, rounded for display to millisecond precision. */
  seconds: number;
  /** True when estimated from legacy message timestamps instead of a monotonic clock. */
  approximate: boolean;
}

/**
 * Prefer the SDK's monotonic tool duration. Older session results have no
 * durationMs, so retain the previous rounded timestamp estimate as a fallback.
 */
export function getToolExecutionDuration(
  result: Pick<ToolResultMessage, "durationMs" | "timestamp"> | undefined,
  assistantTimestamp?: number,
): ToolExecutionDuration | undefined {
  const durationMs = result?.durationMs;
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    return { seconds: durationMs / 1000, approximate: false };
  }

  const resultTimestamp = result?.timestamp;
  if (
    !assistantTimestamp
    || !resultTimestamp
    || !Number.isFinite(assistantTimestamp)
    || !Number.isFinite(resultTimestamp)
  ) {
    return undefined;
  }

  const seconds = Math.round((resultTimestamp - assistantTimestamp) / 1000);
  return Number.isFinite(seconds) && seconds > 0
    ? { seconds, approximate: true }
    : undefined;
}

/** Format seconds without losing the millisecond precision supplied by the SDK. */
export function formatToolExecutionDuration(duration: ToolExecutionDuration): string {
  const seconds = Number(duration.seconds.toFixed(3));
  return `${duration.approximate ? "≈" : ""}${seconds}s`;
}
