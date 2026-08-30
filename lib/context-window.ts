export interface ContextWindowModelRef {
  provider: string;
  modelId: string;
}

export interface ContextWindowModelEntry {
  id: string;
  provider: string;
  contextWindow?: number;
}

export interface ContextUsageValue {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

function positiveNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function inferModelContextWindow(modelId?: string): number {
  if (!modelId) return 128_000;
  const lower = modelId.toLowerCase();
  if (lower.includes("gemini") || lower.includes("luna") || lower.includes("1m") || lower.includes("glm-5") || lower.includes("deepseek-v4-flash")) {
    return 1_048_576;
  }
  if (lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus") || lower.includes("haiku") || lower.includes("200k")) {
    return 200_000;
  }
  if (lower.includes("step") || lower.includes("256k") || lower.includes("mai-code")) {
    return 256_000;
  }
  if (lower.includes("deepseek") || lower.includes("64k")) {
    return 64_000;
  }
  return 128_000;
}

/** Resolve the active model's window from authoritative catalog metadata first. */
export function resolveModelContextWindow(
  model: ContextWindowModelRef | null | undefined,
  modelList: readonly ContextWindowModelEntry[] | null | undefined,
  fallbackContextWindow?: number | null,
): number {
  if (model && modelList?.length) {
    const exact = modelList.find((entry) => (
      entry.id === model.modelId && entry.provider === model.provider
    ));
    const sameId = exact
      ? undefined
      : modelList.filter((entry) => entry.id === model.modelId);
    const catalogWindow = positiveNumber(
      exact?.contextWindow ?? (sameId?.length === 1 ? sameId[0]?.contextWindow : undefined),
    );
    if (catalogWindow !== undefined) return catalogWindow;
  }

  return positiveNumber(fallbackContextWindow)
    ?? inferModelContextWindow(model?.modelId);
}

export function calculateContextUsageDisplay({
  contextWindow,
  contextUsage,
  compactTokens,
}: {
  contextWindow: number;
  contextUsage?: ContextUsageValue | null;
  compactTokens?: number | null;
}): { tokens: number; contextWindow: number; percent: number } {
  const windowSize = positiveNumber(contextWindow) ?? 128_000;
  let tokens = positiveNumber(compactTokens) ?? positiveNumber(contextUsage?.tokens) ?? 0;
  let percent: number;

  if (tokens > 0) {
    percent = Math.round((tokens / windowSize) * 100);
  } else {
    percent = Math.round(positiveNumber(contextUsage?.percent) ?? 0);
    if (percent > 0) tokens = Math.round((percent / 100) * windowSize);
  }

  return {
    tokens,
    contextWindow: windowSize,
    percent: Math.min(100, Math.max(0, percent)),
  };
}
