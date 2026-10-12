/** Memory-only controller state. Reopening a saved session never arms it. */
export interface AutoAdvanceConfig {
  goal: string;
  /** User-provided scope, not authorization invented by the surrogate. */
  scope: string;
  model: { provider: string; modelId: string };
  maxRounds: number;
  maxMinutes: number;
  tokenBudget: number;
}
export type AutoAdvancePhase = "waiting" | "evaluating" | "running" | "completed" | "paused" | "stopped";
export interface AutoAdvanceState {
  id: string;
  /** Monotonic within one controller activation, for late HTTP/SSE snapshots. */
  revision: number;
  phase: AutoAdvancePhase;
  config: AutoAdvanceConfig;
  round: number;
  startedAt: number;
  tokensUsed: number;
  reason?: string;
  detail?: string;
}
export interface AutoAdvanceDecision {
  decision: "continue" | "complete" | "needs_user";
  reason: string;
  nextPrompt?: string;
  requiresConfirmation: boolean;
}
export function isAutoAdvanceActive(state: AutoAdvanceState | null | undefined): boolean {
  return Boolean(state && ["waiting", "evaluating", "running"].includes(state.phase));
}
