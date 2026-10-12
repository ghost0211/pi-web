import { randomUUID } from "crypto";

export const RUN_TIMING_CUSTOM_TYPE = "pi-web:run-timing";

export interface RunTimingData {
  version: 1;
  runId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  finalAssistantEntryId: string;
  aborted: boolean;
}

export interface ActiveRunSnapshot {
  runId: string;
  startedAt: number;
  startedPerf: number;
  startLeafId: string | null;
  origin: "prompt" | "agent_start";
}

export interface RunTimingRuntimeOptions {
  getSessionManager: () => unknown;
  isDestroyed?: () => boolean;
}

export interface MinimalSessionEntry {
  id?: string;
  type?: string;
  message?: {
    role?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Determine the current leaf entry id from sessionManager.
 * Falls back across getLeafId(), getBranch(), and getEntries().
 */
export function getLeafEntryId(sessionManager: unknown): string | null {
  if (!sessionManager || typeof sessionManager !== "object") return null;
  const sm = sessionManager as {
    getLeafId?: () => string | null;
    getBranch?: () => Array<{ id?: string }>;
    getEntries?: () => Array<{ id?: string }>;
  };

  try {
    if (typeof sm.getLeafId === "function") {
      const leafId = sm.getLeafId();
      // null is an authoritative empty/reset root, not permission to use an
      // unrelated historical leaf from getEntries().
      return typeof leafId === "string" && leafId.length > 0 ? leafId : null;
    }
    if (typeof sm.getBranch === "function") {
      const branch = sm.getBranch();
      if (Array.isArray(branch) && branch.length > 0) {
        const last = branch[branch.length - 1];
        if (last && typeof last.id === "string") return last.id;
      }
    }
    if (typeof sm.getEntries === "function") {
      const entries = sm.getEntries();
      if (Array.isArray(entries) && entries.length > 0) {
        const last = entries[entries.length - 1];
        if (last && typeof last.id === "string") return last.id;
      }
    }
  } catch (error) {
    console.error("[pi-web:run-timing] failed to determine leaf entry id:", error);
  }
  return null;
}

/**
 * Find the latest assistant message entry appended after startLeafId.
 * Never binds to an assistant entry created before startLeafId.
 * Returns null if no new assistant message was produced.
 */
export function findLatestAssistantEntryIdAfter(
  sessionManager: unknown,
  startLeafId: string | null,
): string | null {
  if (!sessionManager || typeof sessionManager !== "object") return null;
  const sm = sessionManager as {
    getBranch?: () => MinimalSessionEntry[];
    getEntries?: () => MinimalSessionEntry[];
  };

  let entries: MinimalSessionEntry[] = [];
  try {
    if (typeof sm.getBranch === "function") {
      entries = sm.getBranch() ?? [];
    } else if (typeof sm.getEntries === "function") {
      entries = sm.getEntries() ?? [];
    }
  } catch (error) {
    console.error("[pi-web:run-timing] failed to get entries from sessionManager:", error);
    return null;
  }

  if (!Array.isArray(entries) || entries.length === 0) return null;

  let candidateEntries: MinimalSessionEntry[];
  if (startLeafId) {
    const idx = entries.findIndex((e) => e && e.id === startLeafId);
    if (idx !== -1) {
      candidateEntries = entries.slice(idx + 1);
    } else {
      // A changed branch cannot borrow an assistant from another branch in the
      // complete file. Refuse attribution when the start boundary is missing.
      return null;
    }
  } else {
    candidateEntries = entries;
  }

  for (let i = candidateEntries.length - 1; i >= 0; i--) {
    const entry = candidateEntries[i];
    if (!entry) continue;
    if (entry.type === "message" && entry.message && entry.message.role === "assistant" && typeof entry.id === "string") {
      return entry.id;
    }
  }

  return null;
}

/**
 * Safely append custom run-timing entry with optional mock protection.
 * Logs on failure without disrupting caller flow or throwing exceptions.
 */
export function safeAppendRunTiming(
  sessionManager: unknown,
  timing: RunTimingData,
  isDestroyed?: () => boolean,
): boolean {
  if (isDestroyed?.()) return false;
  if (!sessionManager || typeof sessionManager !== "object") return false;
  const sm = sessionManager as { appendCustomEntry?: (type: string, data: unknown) => void };
  if (typeof sm.appendCustomEntry !== "function") return false;

  try {
    sm.appendCustomEntry(RUN_TIMING_CUSTOM_TYPE, timing);
    return true;
  } catch (error) {
    console.error(
      "[pi-web:run-timing] failed to append timing entry:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export class RunTimingRuntime {
  private activeRun: ActiveRunSnapshot | null = null;
  private destroyed = false;
  private readonly getSessionManager: () => unknown;
  private readonly isDestroyedExternal?: () => boolean;

  constructor(options: RunTimingRuntimeOptions) {
    this.getSessionManager = options.getSessionManager;
    this.isDestroyedExternal = options.isDestroyed;
  }

  isDestroyed(): boolean {
    return this.destroyed || (this.isDestroyedExternal ? this.isDestroyedExternal() : false);
  }

  destroy(): void {
    this.destroyed = true;
    this.activeRun = null;
  }

  getActiveRun(): ActiveRunSnapshot | null {
    return this.activeRun;
  }

  getRunningStartedAt(): number | null {
    if (this.isDestroyed()) return null;
    return this.activeRun ? this.activeRun.startedAt : null;
  }

  /**
   * Begin timing for a regular, non-streaming prompt before invoking inner.prompt.
   * If a run is already active, preserves it instead of restarting.
   */
  beginPromptRun(): ActiveRunSnapshot | null {
    if (this.isDestroyed()) return null;
    if (this.activeRun) {
      return this.activeRun;
    }
    const sm = this.getSessionManager();
    const run: ActiveRunSnapshot = {
      runId: randomUUID(),
      startedAt: Date.now(),
      startedPerf: performance.now(),
      startLeafId: getLeafEntryId(sm),
      origin: "prompt",
    };
    this.activeRun = run;
    return run;
  }

  /**
   * Discard the active prompt run without creating any timing records.
   * Used when preflight rejects or prompt validation fails before execution.
   */
  discardPromptRun(run?: ActiveRunSnapshot | null): void {
    if (!this.activeRun) return;
    if (!run || this.activeRun.runId === run.runId) {
      this.activeRun = null;
    }
  }

  /**
   * SDK agent_start can trigger independent extension/subagent runs.
   * Repeated agent_start calls during multi-tool iterations or retries do not reset the run.
   */
  onAgentStart(): ActiveRunSnapshot | null {
    if (this.isDestroyed()) return null;
    if (this.activeRun) {
      // Already running (either started by prompt or a previous agent_start iteration).
      // Do not reset startedAt, startedPerf, or leaf boundary.
      return this.activeRun;
    }
    const sm = this.getSessionManager();
    const run: ActiveRunSnapshot = {
      runId: randomUUID(),
      startedAt: Date.now(),
      startedPerf: performance.now(),
      startLeafId: getLeafEntryId(sm),
      origin: "agent_start",
    };
    this.activeRun = run;
    return run;
  }

  /**
   * Repeated agent_end calls during intermediate tool executions do not settle the run.
   */
  onAgentEnd(): void {
    // No-op to protect against premature settlement.
  }

  /**
   * Official settlement for the logical run.
   * Resolves the latest assistant entry appended after the start leaf boundary.
   * If found, persists the run-timing entry and clears active run.
   * If no new assistant was produced, discards the run without writing a record.
   */
  onAgentSettled(event?: { aborted?: boolean }): RunTimingData | null {
    if (this.isDestroyed()) {
      this.activeRun = null;
      return null;
    }
    const run = this.activeRun;
    if (!run) return null;

    // Clear active run immediately so subsequent queries show idle.
    this.activeRun = null;

    const sm = this.getSessionManager();
    const finalAssistantEntryId = findLatestAssistantEntryIdAfter(sm, run.startLeafId);

    // If preflight was rejected, handled without assistant, or aborted before assistant, no record.
    if (!finalAssistantEntryId) {
      return null;
    }

    const finishedAt = Date.now();
    const durationMs = Math.max(0, Math.round(performance.now() - run.startedPerf));
    const aborted = event?.aborted === true;

    const record: RunTimingData = {
      version: 1,
      runId: run.runId,
      startedAt: run.startedAt,
      finishedAt,
      durationMs,
      finalAssistantEntryId,
      aborted,
    };

    safeAppendRunTiming(sm, record, () => this.isDestroyed());
    return record;
  }

  /**
   * Fallback settlement for legacy SDKs without agent_settled event.
   * Only settles if the active run matches the prompt's run and there is no active streaming.
   */
  fallbackPromptFinish(
    promptRun: ActiveRunSnapshot | null,
    options?: { isStreaming?: boolean; aborted?: boolean },
  ): RunTimingData | null {
    if (this.isDestroyed()) {
      this.activeRun = null;
      return null;
    }
    if (!promptRun || !this.activeRun) return null;
    if (this.activeRun.runId !== promptRun.runId) return null;
    if (options?.isStreaming) return null;

    return this.onAgentSettled({ aborted: options?.aborted });
  }
}
