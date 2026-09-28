/**
 * Pure display formatters for usage and cost values.
 *
 * These live outside `lib/session-usage.ts` because that module reads session
 * files through Node APIs. `components/UsagePanel.tsx` is a client component, so
 * importing the formatters from there would drag `fs` into the browser bundle
 * and break the webpack build. Keep this module free of Node-only imports.
 */

/** Compact, bounded cost string. Keeps sub-cent amounts visible. */
export function formatUsageCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.001) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Compact token string (1.2K / 3.40M / 1.00B). */
export function formatUsageTokens(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
