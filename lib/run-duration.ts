import type { AgentMessage, AssistantMessage, SessionEntry } from "./types";
import type { Locale } from "./i18n/types";

export interface RunDuration {
  durationMs: number;
  estimated: boolean;
}

export function formatRunDuration(durationMs: number, locale: Locale = "en"): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  const seconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  if (locale === "en") {
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(rest).padStart(2, "0")}s`;
    if (minutes) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
    return `${rest}s`;
  }
  if (hours) return `${hours}${locale === "zh-TW" ? "小時" : "小时"}${String(minutes).padStart(2, "0")}分${String(rest).padStart(2, "0")}秒`;
  if (minutes) return `${minutes}分${String(rest).padStart(2, "0")}秒`;
  return `${rest}秒`;
}

interface EstimateState {
  startedAt?: number;
  assistantId?: string;
  finishedAt?: number;
}

/**
 * UI-only annotations, keyed by the actual assistant entry, never by array
 * position or the next prompt. Reading all entries keeps a timing record usable
 * when a page ends just before its custom metadata, or a branch ends at the
 * original answer. No SDK transcript or model context is mutated.
 *
 * Legacy estimates use entry append times, NOT assistant.message.timestamp
 * (which marks the start of a model request, not its completion). Compaction
 * inherits the prompt's start; reports and direct bash executions delimit it.
 */
export function buildRunDurationIndex(entries: readonly SessionEntry[]): Map<string, RunDuration> {
  const durations = new Map<string, RunDuration>();
  const states = new Map<string, EstimateState>();
  const children = new Set<string>();
  const assistantIds = new Set<string>();
  const finishEstimate = (state: EstimateState | undefined) => {
    if (!state?.assistantId || state.startedAt === undefined || state.finishedAt === undefined) return;
    const durationMs = state.finishedAt - state.startedAt;
    if (Number.isFinite(durationMs) && durationMs >= 0) durations.set(state.assistantId, { durationMs, estimated: true });
  };

  for (const entry of entries) {
    if (entry.parentId) children.add(entry.parentId);
    let state = entry.parentId ? states.get(entry.parentId) ?? {} : {};
    const customType = entry.type === "custom_message" ? entry.customType
      : entry.type === "message" && entry.message.role === "custom" ? entry.message.customType : undefined;
    const isReport = customType === "pi-web:subagent-notification" || customType === "pi-web:auto-advance";
    const isPrompt = (entry.type === "message" && entry.message.role === "user") || entry.type === "branch_summary";
    const isBash = entry.type === "message" && entry.message.role === "bashExecution";
    const isTiming = entry.type === "custom" && entry.customType === "pi-web:run-timing";
    if (isPrompt || isReport || isBash || isTiming) {
      finishEstimate(state);
      const startedAt = Date.parse(entry.timestamp);
      state = !isBash && !isTiming && Number.isFinite(startedAt) ? { startedAt } : {};
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      assistantIds.add(entry.id);
      state = { ...state, assistantId: entry.id, finishedAt: Date.parse(entry.timestamp) };
    }
    states.set(entry.id, state);
  }
  for (const entry of entries) {
    if (!children.has(entry.id)) finishEstimate(states.get(entry.id));
  }

  // Exact monotonic measurements win over historical wall-clock estimates.
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "pi-web:run-timing") continue;
    const data = entry.data as Record<string, unknown> | null | undefined;
    if (!data || data.version !== 1 || typeof data.finalAssistantEntryId !== "string"
      || !assistantIds.has(data.finalAssistantEntryId) || typeof data.durationMs !== "number"
      || !Number.isFinite(data.durationMs) || data.durationMs < 0) continue;
    durations.set(data.finalAssistantEntryId, { durationMs: data.durationMs, estimated: false });
  }
  return durations;
}

export function withRunDuration(message: AgentMessage, entryId: string, index: ReadonlyMap<string, RunDuration>): AgentMessage {
  const timing = message.role === "assistant" ? index.get(entryId) : undefined;
  return timing ? { ...message, runDurationMs: timing.durationMs, runDurationEstimated: timing.estimated } as AssistantMessage : message;
}

/** Only a completed run's final assistant carries an annotation. */
export function getGroupRunDuration(messages: readonly AgentMessage[], start: number, end: number): RunDuration | undefined {
  for (let i = end - 1; i >= start; i--) {
    const message = messages[i];
    if (message?.role !== "assistant" || message.runDurationMs === undefined
      || !Number.isFinite(message.runDurationMs) || message.runDurationMs < 0) continue;
    return { durationMs: message.runDurationMs, estimated: message.runDurationEstimated === true };
  }
  return undefined;
}
