// Browser-safe UI choices. `auto` is an application preference, never a
// provider/SDK thinking level; resolve it against the selected model on the server.
export const THINKING_LEVEL_OPTIONS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelOption = typeof THINKING_LEVEL_OPTIONS[number];

export function isThinkingLevelOption(value: unknown): value is ThinkingLevelOption {
  return typeof value === "string" && THINKING_LEVEL_OPTIONS.includes(value as ThinkingLevelOption);
}

/** An incompatible preference becomes model-default, not another model's level. */
export function normalizeThinkingLevelOption(
  value: unknown,
  supported?: readonly string[] | null,
): ThinkingLevelOption {
  if (!isThinkingLevelOption(value)) return "auto";
  if (value === "auto" || supported == null || supported.includes(value)) return value;
  return "auto";
}
