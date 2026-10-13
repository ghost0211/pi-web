import { isThinkingLevelOption } from "./thinking-level-options";
import {
  type AutoAdvanceConfig,
  type AutoAdvanceDecision,
  type AutoAdvancePhase,
  type AutoAdvanceState,
  isAutoAdvanceActive,
} from "./auto-advance-types";

export {
  type AutoAdvanceConfig,
  type AutoAdvanceDecision,
  type AutoAdvancePhase,
  type AutoAdvanceState,
  isAutoAdvanceActive,
};

export const TERMINAL_REASONS = [
  "goal_complete",
  "needs_user",
  "round_limit",
  "no_progress",
  "run_error",
  "aborted",
  "user_stop",
  "manual_takeover",
  "configuration_changed",
  "extension_ui",
  "archived",
  "destroyed",
] as const;

export type TerminalReason = (typeof TERMINAL_REASONS)[number];

const MAX_GOAL_LENGTH = 4000;
const MAX_SCOPE_LENGTH = 2000;
const MAX_MODEL_STRING_LENGTH = 256;
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 99;
const MAX_REASON_LENGTH = 2000;
const MAX_NEXT_PROMPT_LENGTH = 4000;
const MAX_DETAIL_LENGTH = 2000;

const MAX_IDLE_RETRIES = 5;
const IDLE_RETRY_INTERVAL_MS = 25;

/**
 * Validates untrusted configuration input with strict bounds and types.
 * Disallows silent coercion.
 */
export function validateAutoAdvanceConfig(input: unknown): AutoAdvanceConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Configuration must be a non-null object");
  }

  const raw = input as Record<string, unknown>;

  if (typeof raw.goal !== "string" || raw.goal.trim().length === 0 || raw.goal.length > MAX_GOAL_LENGTH) {
    throw new Error(`goal must be a non-empty string <= ${MAX_GOAL_LENGTH} characters`);
  }

  if (typeof raw.scope !== "string" || raw.scope.trim().length === 0 || raw.scope.length > MAX_SCOPE_LENGTH) {
    throw new Error(`scope must be a non-empty string <= ${MAX_SCOPE_LENGTH} characters`);
  }

  if (!raw.model || typeof raw.model !== "object" || Array.isArray(raw.model)) {
    throw new Error("model must be an object with provider and modelId");
  }

  const model = raw.model as Record<string, unknown>;

  if (
    typeof model.provider !== "string" ||
    model.provider.trim().length === 0 ||
    model.provider.length > MAX_MODEL_STRING_LENGTH
  ) {
    throw new Error(`model.provider must be a non-empty string <= ${MAX_MODEL_STRING_LENGTH} characters`);
  }

  if (
    typeof model.modelId !== "string" ||
    model.modelId.trim().length === 0 ||
    model.modelId.length > MAX_MODEL_STRING_LENGTH
  ) {
    throw new Error(`model.modelId must be a non-empty string <= ${MAX_MODEL_STRING_LENGTH} characters`);
  }

  if (raw.thinkingLevel !== undefined && !isThinkingLevelOption(raw.thinkingLevel)) {
    throw new Error("thinkingLevel must be auto, off, minimal, low, medium, high, xhigh or max");
  }

  if (
    typeof raw.maxRounds !== "number" ||
    !Number.isInteger(raw.maxRounds) ||
    raw.maxRounds < MIN_ROUNDS ||
    raw.maxRounds > MAX_ROUNDS
  ) {
    throw new Error(`maxRounds must be an integer between ${MIN_ROUNDS} and ${MAX_ROUNDS}`);
  }

  // Old clients may still send maxMinutes/tokenBudget; ignore and strip them.
  // They must never reintroduce a deadline or consumption threshold.

  return {
    goal: raw.goal,
    scope: raw.scope,
    model: {
      provider: model.provider,
      modelId: model.modelId,
    },
    ...(raw.thinkingLevel !== undefined ? { thinkingLevel: raw.thinkingLevel as AutoAdvanceConfig["thinkingLevel"] } : {}),
    maxRounds: raw.maxRounds,
  };
}

/**
 * Parses decision JSON strictly as an entire object or entire fenced code block.
 * Unknown or invalid decision formats fail closed (return null).
 */
export function parseAutoAdvanceDecision(text: unknown): AutoAdvanceDecision | null {
  if (typeof text !== "string") {
    return null;
  }

  let candidate = text.trim();
  if (!candidate) {
    return null;
  }

  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.decision !== "continue" && obj.decision !== "complete" && obj.decision !== "needs_user") {
    return null;
  }

  if (typeof obj.reason !== "string" || obj.reason.length > MAX_REASON_LENGTH) {
    return null;
  }

  if (typeof obj.requiresConfirmation !== "boolean") {
    return null;
  }

  if (obj.decision === "continue") {
    if (
      typeof obj.nextPrompt !== "string" ||
      obj.nextPrompt.trim().length === 0 ||
      obj.nextPrompt.length > MAX_NEXT_PROMPT_LENGTH
    ) {
      return null;
    }
  } else if (
    obj.nextPrompt !== undefined &&
    (typeof obj.nextPrompt !== "string" || obj.nextPrompt.length > MAX_NEXT_PROMPT_LENGTH)
  ) {
    return null;
  }

  return {
    decision: obj.decision,
    reason: obj.reason,
    requiresConfirmation: obj.requiresConfirmation,
    ...(typeof obj.nextPrompt === "string" ? { nextPrompt: obj.nextPrompt } : {}),
  };
}

export interface AutoAdvancePorts {
  isIdle: () => boolean;
  evaluate: (
    config: AutoAdvanceConfig,
    signal: AbortSignal,
  ) => Promise<{ decision: AutoAdvanceDecision | null; tokens?: number }>;
  advance: (
    config: AutoAdvanceConfig,
    instruction: string,
    signal: AbortSignal,
  ) => Promise<void>;
  onState: (state: AutoAdvanceState) => void;
  onTerminal?: (state: AutoAdvanceState) => void;
  abortOwnedRun?: () => void | Promise<void>;
  now?: () => number;
}

export class AutoAdvanceController {
  private readonly ports: AutoAdvancePorts;
  private state: AutoAdvanceState | null = null;
  private generation = 0;
  private ownsRunActive = false;
  private advancePending = false;
  private evaluating = false;
  private evalScheduled = false;
  private evalTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private lastPrompt: string | null = null;
  private settledDeferred = false;
  private destroyed = false;

  constructor(ports: AutoAdvancePorts) {
    this.ports = ports;
  }

  private now(): number {
    try {
      return typeof this.ports.now === "function" ? this.ports.now() : Date.now();
    } catch {
      return Date.now();
    }
  }

  private isIdle(): boolean {
    try {
      return Boolean(this.ports.isIdle());
    } catch {
      return false;
    }
  }

  getState(): AutoAdvanceState | null {
    if (!this.state) return null;
    return {
      ...this.state,
      config: {
        ...this.state.config,
        model: { ...this.state.config.model },
      },
    };
  }

  isActive(): boolean {
    return isAutoAdvanceActive(this.state);
  }

  ownsRun(): boolean {
    return this.ownsRunActive;
  }

  private emitInitialState(): void {
    if (!this.state) return;
    const snapshot = this.getState()!;
    try {
      this.ports.onState(snapshot);
    } catch {
      // onState exceptions must not cause unhandled/controller failure
    }
  }

  private emitNextState(): void {
    if (!this.state) return;
    this.state.revision += 1;
    const snapshot = this.getState()!;
    try {
      this.ports.onState(snapshot);
    } catch {
      // onState exceptions must not cause unhandled/controller failure
    }
  }

  private emitTerminal(snapshot: AutoAdvanceState): void {
    try {
      this.ports.onTerminal?.(snapshot);
    } catch {
      // onTerminal exceptions must not cause unhandled/controller failure
    }
  }

  private clearEvalTimeout(): void {
    if (this.evalTimeout !== null) {
      clearTimeout(this.evalTimeout);
      this.evalTimeout = null;
    }
    if (this.retryTimeout !== null) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
    this.evalScheduled = false;
  }

  private safeAbortOwnedRun(): void {
    try {
      const res = this.ports.abortOwnedRun?.();
      if (res && typeof (res as Promise<void>).catch === "function") {
        void (res as Promise<void>).catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  start(config: unknown): AutoAdvanceState {
    if (this.isActive()) {
      throw new Error("Auto advance is already active");
    }

    const validated = validateAutoAdvanceConfig(config);
    this.destroyed = false;
    this.generation += 1;

    this.clearEvalTimeout();
    this.abortController?.abort();
    this.abortController = null;

    this.ownsRunActive = false;
    this.advancePending = false;
    this.evaluating = false;
    this.evalScheduled = false;
    this.settledDeferred = false;
    this.lastPrompt = null;

    const startedAt = this.now();
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `auto-advance-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;

    this.state = {
      id,
      revision: 1,
      phase: "waiting",
      config: validated,
      round: 0,
      startedAt,
      tokensUsed: 0,
    };

    this.emitInitialState();

    if (this.isIdle()) {
      this.scheduleEval();
    }

    return this.getState()!;
  }

  stop(reason = "user_stop"): void {
    if (!this.isActive() || !this.state) return;

    const wasOwnsRun = this.ownsRunActive;
    this.generation += 1;
    this.clearEvalTimeout();
    this.abortController?.abort();
    this.abortController = null;
    this.evaluating = false;
    this.evalScheduled = false;
    this.advancePending = false;
    this.ownsRunActive = false;
    this.settledDeferred = false;

    if (wasOwnsRun) {
      this.safeAbortOwnedRun();
    }

    this.state.phase = "stopped";
    this.state.reason = reason;

    this.emitNextState();
    this.emitTerminal(this.getState()!);
  }

  pause(reason: string, detail?: string): void {
    if (!this.isActive() || !this.state) return;

    const wasOwnsRun = this.ownsRunActive;
    this.generation += 1;
    this.clearEvalTimeout();
    this.abortController?.abort();
    this.abortController = null;
    this.evaluating = false;
    this.evalScheduled = false;
    this.advancePending = false;
    this.ownsRunActive = false;
    this.settledDeferred = false;

    // pause must NOT abort main for manual_takeover/configuration_changed/archived/extension_ui;
    // only stop/destroy or actual run_error may abort own.
    if (wasOwnsRun && reason === "run_error") {
      this.safeAbortOwnedRun();
    }

    this.state.phase = "paused";
    this.state.reason = reason;
    if (detail !== undefined) {
      this.state.detail = detail.slice(0, MAX_DETAIL_LENGTH);
    }

    this.emitNextState();
    this.emitTerminal(this.getState()!);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.isActive()) {
      const wasOwnsRun = this.ownsRunActive;
      this.generation += 1;
      this.clearEvalTimeout();
      this.abortController?.abort();
      this.abortController = null;
      this.evaluating = false;
      this.evalScheduled = false;
      this.advancePending = false;
      this.ownsRunActive = false;
      this.settledDeferred = false;

      if (wasOwnsRun) {
        this.safeAbortOwnedRun();
      }

      if (this.state) {
        this.state.phase = "stopped";
        this.state.reason = "destroyed";
        this.emitNextState();
      }
      // "no active terminal state notification on destroy" -> do NOT call onTerminal!
    } else {
      this.clearEvalTimeout();
      this.abortController?.abort();
      this.abortController = null;
    }
  }

  private stopTerminal(reason: string, detail?: string): void {
    if (!this.isActive() || !this.state) return;

    const wasOwnsRun = this.ownsRunActive;
    this.generation += 1;
    this.clearEvalTimeout();
    this.abortController?.abort();
    this.abortController = null;
    this.evaluating = false;
    this.evalScheduled = false;
    this.advancePending = false;
    this.ownsRunActive = false;
    this.settledDeferred = false;

    if (wasOwnsRun) {
      this.safeAbortOwnedRun();
    }

    this.state.phase = "stopped";
    this.state.reason = reason;
    if (detail !== undefined) {
      this.state.detail = detail.slice(0, MAX_DETAIL_LENGTH);
    }

    this.emitNextState();
    this.emitTerminal(this.getState()!);
  }

  private scheduleEval(): void {
    if (!this.isActive() || !this.state) return;
    if (this.evaluating || this.evalScheduled) return;
    if (this.advancePending) {
      this.settledDeferred = true;
      return;
    }

    this.evalScheduled = true;
    const currentGen = this.generation;

    this.evalTimeout = setTimeout(() => {
      this.evalScheduled = false;
      this.evalTimeout = null;
      if (this.generation !== currentGen || !this.isActive()) return;
      void this.runEval(currentGen, 0);
    }, 0);
  }

  private async runEval(gen: number, retryCount = 0): Promise<void> {
    if (this.generation !== gen || !this.isActive() || !this.state) return;

    if (!this.isIdle()) {
      // Retry up to bounded budget (5 * 25ms = 125ms) so unwinding SDK finishes
      if (retryCount < MAX_IDLE_RETRIES) {
        this.retryTimeout = setTimeout(() => {
          this.retryTimeout = null;
          if (this.generation !== gen || !this.isActive()) return;
          void this.runEval(gen, retryCount + 1);
        }, IDLE_RETRY_INTERVAL_MS);
        return;
      }
      if (this.state.phase !== "waiting") {
        this.state.phase = "waiting";
        this.emitNextState();
      }
      return;
    }

    if (this.state.round >= this.state.config.maxRounds) {
      this.stopTerminal("round_limit");
      return;
    }

    this.state.phase = "evaluating";
    this.emitNextState();
    this.evaluating = true;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let result: { decision: AutoAdvanceDecision | null; tokens?: number };
    try {
      result = await this.ports.evaluate(this.state.config, signal);
    } catch (error) {
      if (this.generation === gen) {
        this.evaluating = false;
      }
      if (this.generation !== gen || !this.isActive()) return;
      if (signal.aborted) return;
      const detail = String(error instanceof Error ? error.message : error).slice(0, MAX_DETAIL_LENGTH);
      this.pause("run_error", detail);
      return;
    } finally {
      if (this.generation === gen) {
        this.evaluating = false;
      }
    }

    if (this.generation !== gen || !this.isActive() || !this.state) return;

    if (!result || typeof result !== "object") {
      this.pause("run_error", "Invalid evaluation result");
      return;
    }

    // Usage is observational now, not a permission to continue or a budget gate.
    this.addTokens(result.tokens);
    if (this.generation !== gen || !this.isActive() || !this.state) return;

    const decision = result.decision;
    if (
      !decision ||
      typeof decision !== "object" ||
      typeof decision.requiresConfirmation !== "boolean" ||
      typeof decision.reason !== "string" ||
      decision.reason.length > MAX_REASON_LENGTH ||
      (decision.decision !== "continue" &&
        decision.decision !== "complete" &&
        decision.decision !== "needs_user")
    ) {
      this.pause("run_error", "Invalid or missing decision from evaluation");
      return;
    }

    // requiresConfirmation=true must precede even decision complete
    // (cannot report completion if user confirmation required)
    if (decision.requiresConfirmation === true || decision.decision === "needs_user") {
      this.stopTerminal("needs_user", (decision.reason || "").slice(0, MAX_DETAIL_LENGTH));
      return;
    }

    if (decision.decision === "complete") {
      this.generation += 1;
      this.clearEvalTimeout();
      this.state.phase = "completed";
      this.state.reason = "goal_complete";
      this.state.detail = (decision.reason || "").slice(0, MAX_DETAIL_LENGTH);
      this.emitNextState();
      this.emitTerminal(this.getState()!);
      return;
    }

    if (decision.decision === "continue") {
      const nextPrompt = decision.nextPrompt;
      if (typeof nextPrompt !== "string" || !nextPrompt.trim() || nextPrompt.length > MAX_NEXT_PROMPT_LENGTH) {
        this.pause("run_error", "Continue decision missing valid nextPrompt");
        return;
      }

      const normalizedPrompt = nextPrompt.trim().replace(/\r\n/g, "\n");
      if (this.lastPrompt !== null && this.lastPrompt === normalizedPrompt) {
        this.stopTerminal("no_progress", "Repeated prompt detected");
        return;
      }
      this.lastPrompt = normalizedPrompt;

      if (this.state.round >= this.state.config.maxRounds) {
        this.stopTerminal("round_limit");
        return;
      }

      await this.runAdvance(nextPrompt, gen);
      return;
    }

    this.pause("run_error", `Unrecognized decision: ${String((decision as { decision?: unknown }).decision)}`);
  }

  private async runAdvance(instruction: string, gen: number): Promise<void> {
    if (this.generation !== gen || !this.isActive() || !this.state) return;

    this.state.phase = "running";
    this.state.round += 1;
    this.ownsRunActive = true;
    this.advancePending = true;
    this.settledDeferred = false;
    this.emitNextState();

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let advanceError: unknown = null;
    try {
      await this.ports.advance(this.state.config, instruction, signal);
    } catch (error) {
      advanceError = error;
    } finally {
      if (this.generation === gen) {
        this.ownsRunActive = false;
        this.advancePending = false;
      }
    }

    if (this.generation !== gen || !this.isActive() || !this.state) return;

    if (advanceError !== null) {
      if (signal.aborted) {
        return;
      }
      const detail = String(advanceError instanceof Error ? advanceError.message : advanceError).slice(
        0,
        MAX_DETAIL_LENGTH,
      );
      this.pause("run_error", detail);
      return;
    }

    if (this.state.round >= this.state.config.maxRounds) {
      this.stopTerminal("round_limit");
      return;
    }

    if (!this.isIdle()) {
      this.state.phase = "waiting";
      this.emitNextState();
    }

    // Schedule eval via timeout, which handles bounded idle retry if wrapper is still unwinding
    this.settledDeferred = false;
    this.scheduleEval();
  }

  onSettled(event?: { aborted?: boolean; error?: unknown }): void {
    if (!this.isActive() || !this.state) return;

    if (event?.aborted) {
      this.stopTerminal("aborted");
      return;
    }

    if (event?.error) {
      const detail = String(
        event.error instanceof Error ? event.error.message : event.error,
      ).slice(0, MAX_DETAIL_LENGTH);
      this.pause("run_error", detail);
      return;
    }

    if (this.advancePending) {
      this.settledDeferred = true;
      return;
    }

    // Schedule via setTimeout even if isIdle is momentarily false so
    // extension / SDK settle emission unwinding gets evaluated via bounded retry
    this.scheduleEval();
  }

  onIdle(): void {
    if (!this.isActive() || !this.state) return;
    if (this.advancePending) return;
    if (this.isIdle()) {
      this.scheduleEval();
    }
  }

  addTokens(n: number | undefined): void {
    if (!this.state || !this.isActive()) return;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isFinite(this.state.tokensUsed + n)) {
      this.state.usageIncomplete = true;
    } else {
      this.state.tokensUsed += n;
    }
    this.emitNextState();
  }
}
