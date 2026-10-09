import { isThinkingLevelOption, type ThinkingLevelOption } from "./thinking-level-options";

export interface FallbackModelRef {
  provider: string;
  modelId: string;
  /** Independent backup preference. Missing legacy values use model-default. */
  thinkingLevel?: ThinkingLevelOption;
}

export interface ModelFallbackNotice {
  from: FallbackModelRef;
  to: FallbackModelRef;
  ruleId: string;
  kind: "credit-balance" | "spend-limit" | "subscription-limit" | "daily-quota";
  timestamp: number;
}

/** Undefined means malformed; null is an explicit opt-out. Only public model/preferences. */
export function parseFallbackModel(value: unknown): FallbackModelRef | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "provider" && key !== "modelId" && key !== "thinkingLevel")) return undefined;
  if (candidate.thinkingLevel !== undefined && !isThinkingLevelOption(candidate.thinkingLevel)) return undefined;
  if (typeof candidate.provider !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(candidate.provider)) return undefined;
  if (typeof candidate.modelId !== "string" || candidate.modelId.length < 1 || candidate.modelId.length > 512
    || candidate.modelId.trim() !== candidate.modelId || /[\u0000-\u001f\u007f]/.test(candidate.modelId)) return undefined;
  return {
    provider: candidate.provider,
    modelId: candidate.modelId,
    ...(candidate.thinkingLevel !== undefined ? { thinkingLevel: candidate.thinkingLevel as ThinkingLevelOption } : {}),
  };
}

export function sameFallbackModel(a: FallbackModelRef | null | undefined, b: FallbackModelRef | null | undefined): boolean {
  return Boolean(a && b && a.provider === b.provider && a.modelId === b.modelId);
}

export function parseModelFallbackNotice(value: unknown): ModelFallbackNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const from = parseFallbackModel(candidate.from);
  const to = parseFallbackModel(candidate.to);
  if (!from || !to || typeof candidate.ruleId !== "string" || !/^[a-z0-9._-]{1,100}$/.test(candidate.ruleId)
    || !["credit-balance", "spend-limit", "subscription-limit", "daily-quota"].includes(String(candidate.kind))
    || typeof candidate.timestamp !== "number" || !Number.isSafeInteger(candidate.timestamp) || candidate.timestamp < 0) return null;
  return { from, to, ruleId: candidate.ruleId, kind: candidate.kind as ModelFallbackNotice["kind"], timestamp: candidate.timestamp };
}
