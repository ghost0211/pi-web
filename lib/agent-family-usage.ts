/**
 * Main-agent + subagent usage for one session family.
 *
 * The composer already shows the *active* session's tokens and cost; this
 * answers the delegation question instead: which branch of the family was
 * expensive or slow. It is a read-only aggregation:
 *
 * - cost is the historical `usage.cost.total` recorded per request, summed —
 *   never re-priced from a catalog that may have changed since;
 * - duration prefers pi-web's precise `pi-web:run-timing` records and falls
 *   back to the legacy entry-timestamp estimate, which is reported separately
 *   so an estimate is never presented as a measurement;
 * - the family total is the sum of each member's own totals. Members can run
 *   concurrently, so it is accumulated execution time, not wall-clock time.
 *
 * Nothing here starts a session or touches a live runtime: the caller passes
 * files that were read from disk.
 */
import type { SessionFileStats } from "./session-stats";
import { buildRunDurationIndex } from "./run-duration";
import type { SessionEntry } from "./types";

export type FamilyRole = "main" | "subagent";

export interface FamilyMemberUsage {
  sessionId: string;
  role: FamilyRole;
  /** Display label: the subagent's description, or the session name. */
  label?: string;
  tokens: number;
  /** Sum of cost totals that were actually recorded. */
  cost: number;
  /** True when at least one usage record carried no cost figure. */
  costIncomplete: boolean;
  /** Assistant turns that contributed usage. */
  turns: number;
  /** Precise accumulated run duration from `pi-web:run-timing`, when present. */
  measuredDurationMs: number;
  /** Legacy estimate from entry timestamps; used only where no precise record exists. */
  estimatedDurationMs: number;
  /** True when any duration in this row is the legacy estimate. */
  durationEstimated: boolean;
  /** True when the session file could not be read at all. */
  unreadable?: boolean;
}

export interface FamilyUsageTotal {
  tokens: number;
  cost: number;
  costIncomplete: boolean;
  measuredDurationMs: number;
  estimatedDurationMs: number;
  durationEstimated: boolean;
}

const EMPTY_TOTAL: FamilyUsageTotal = {
  tokens: 0,
  cost: 0,
  costIncomplete: false,
  measuredDurationMs: 0,
  estimatedDurationMs: 0,
  durationEstimated: false,
};

/**
 * Split a usage total into "recorded" and "missing" contributions.
 * `SessionFileStats.cost` is 0 both for free models and for records without a
 * price, so the caller must pass how many usage records existed to tell them
 * apart; a row is incomplete when any priced field was absent.
 */
export function detectCostIncomplete(entries: readonly SessionEntry[]): boolean {
  let sawUsage = false;
  let sawCost = false;
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (!entry.usage) continue;
      sawUsage = true;
      if (typeof entry.usage.cost?.total === "number") sawCost = true;
      else return true;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; usage?: { cost?: { total?: unknown } } };
    if (message.role !== "assistant" && message.role !== "toolResult") continue;
    if (!message.usage) continue;
    sawUsage = true;
    if (typeof message.usage.cost?.total === "number") sawCost = true;
    else return true;
  }
  return sawUsage && !sawCost;
}

/**
 * Duration for one session: precise run-timing records when they exist,
 * otherwise the legacy estimate. Both are reported so the UI can label an
 * estimate honestly instead of blending the two into one number.
 */
export function computeMemberDuration(entries: readonly SessionEntry[]): {
  measuredDurationMs: number;
  estimatedDurationMs: number;
  durationEstimated: boolean;
} {
  const index = buildRunDurationIndex(entries);
  let measured = 0;
  let estimated = 0;
  let sawPrecise = false;
  let sawEstimate = false;
  for (const record of index.values()) {
    if (!Number.isFinite(record.durationMs) || record.durationMs <= 0) continue;
    if (record.estimated) {
      estimated += record.durationMs;
      sawEstimate = true;
    } else {
      measured += record.durationMs;
      sawPrecise = true;
    }
  }
  return {
    measuredDurationMs: measured,
    estimatedDurationMs: estimated,
    // An estimate anywhere means this row is not fully measured.
    durationEstimated: sawEstimate || !sawPrecise,
  };
}

export interface MemberInput {
  sessionId: string;
  role: FamilyRole;
  label?: string;
  entries: readonly SessionEntry[];
  stats: SessionFileStats;
}

/** One family member's row. */
export function buildMemberUsage(input: MemberInput): FamilyMemberUsage {
  const duration = computeMemberDuration(input.entries);
  const turns = input.entries.filter((entry) => (
    entry.type === "message"
    && (entry.message as { role?: string }).role === "assistant"
    && Boolean((entry.message as { usage?: unknown }).usage)
  )).length;
  return {
    sessionId: input.sessionId,
    role: input.role,
    ...(input.label ? { label: input.label } : {}),
    tokens: input.stats.tokens.total,
    cost: input.stats.cost,
    costIncomplete: detectCostIncomplete(input.entries),
    turns,
    ...duration,
  };
}

/**
 * Sum member rows. A member that could not be read marks the total incomplete
 * instead of contributing zeros.
 */
export function totalFamilyUsage(members: readonly FamilyMemberUsage[]): FamilyUsageTotal {
  if (members.length === 0) return { ...EMPTY_TOTAL };
  let total: FamilyUsageTotal = { ...EMPTY_TOTAL };
  for (const member of members) {
    total = {
      tokens: total.tokens + member.tokens,
      cost: total.cost + member.cost,
      costIncomplete: total.costIncomplete || member.costIncomplete || Boolean(member.unreadable),
      measuredDurationMs: total.measuredDurationMs + member.measuredDurationMs,
      estimatedDurationMs: total.estimatedDurationMs + member.estimatedDurationMs,
      durationEstimated: total.durationEstimated || member.durationEstimated,
    };
  }
  return total;
}
