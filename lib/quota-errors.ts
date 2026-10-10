export interface QuotaErrorInput {
  provider: string;
  api?: string;
  errorMessage?: string;
  /**
   * Machine code attached to the thrown provider error object. Codex delivers
   * subscription exhaustion as an in-stream SSE/WebSocket `error` event where
   * no HTTP error status/body exists; the thrown CodexApiError still carries
   * the upstream `code` (for example `usage_limit_reached`).
   */
  errorCode?: unknown;
  providerError?: {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  };
}

export type QuotaExhaustion = {
  ruleId: string;
  kind: "credit-balance" | "spend-limit" | "subscription-limit" | "daily-quota";
};

type ErrorShape = {
  codes: string[];
  messages: string[];
  anthropicSpendCodes: string[];
  openRouterLimits: string[];
};

const MAX_ERROR_TEXT = 8_192;
const MAX_JSON_TEXT = 8_192;
const MAX_FIELD_TEXT = 2_048;
const MAX_ID_TEXT = 128;
const TOKEN_CLASSIFICATIONS: Record<string, QuotaExhaustion> = {
  credit_balance_exhausted: { ruleId: "portable.credit_balance_exhausted", kind: "credit-balance" },
  insufficient_quota: { ruleId: "portable.insufficient_quota", kind: "spend-limit" },
  usage_limit_reached: { ruleId: "portable.usage_limit_reached", kind: "subscription-limit" },
  subscription_sharing_usage_limit_exceeded: {
    ruleId: "portable.subscription_sharing_usage_limit_exceeded",
    kind: "subscription-limit",
  },
};

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

function codeValue(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || Math.abs(value) > 999_999) return undefined;
    return String(value);
  }
  const text = boundedString(value, 128)?.trim().toLowerCase();
  if (!text || !/^[a-z0-9_]{1,128}$/.test(text)) return undefined;
  return text;
}

function messageValue(value: unknown): string | undefined {
  return boundedString(value, MAX_FIELD_TEXT);
}

function asShape(value: unknown): ErrorShape {
  if (value === null || typeof value !== "object") {
    return { codes: [], messages: [], anthropicSpendCodes: [], openRouterLimits: [] };
  }

  const shape: ErrorShape = { codes: [], messages: [], anthropicSpendCodes: [], openRouterLimits: [] };
  const addCode = (candidate: unknown) => {
    const code = codeValue(candidate);
    if (code !== undefined && shape.codes.length < 12) shape.codes.push(code);
  };
  const addMessage = (candidate: unknown) => {
    const message = messageValue(candidate);
    if (message !== undefined && shape.messages.length < 8) shape.messages.push(message);
  };
  const addLimit = (candidate: unknown) => {
    const limit = codeValue(candidate);
    if (limit !== undefined && shape.openRouterLimits.length < 8) shape.openRouterLimits.push(limit);
  };
  const addAnthropicSpendCode = (candidate: unknown) => {
    const code = codeValue(candidate);
    if (code !== undefined && shape.anthropicSpendCodes.length < 4) shape.anthropicSpendCodes.push(code);
  };

  const rootError = ownValue(value, "error");
  const nestedError = ownValue(rootError, "error");
  const baseResp = ownValue(value, "base_resp");
  const rootMetadata = ownValue(value, "metadata");
  const errorMetadata = ownValue(rootError, "metadata");
  const nestedMetadata = ownValue(nestedError, "metadata");
  const errorDetails = ownValue(rootError, "details");
  const nestedErrorDetails = ownValue(nestedError, "details");

  for (const record of [value, rootError, nestedError, baseResp]) {
    addCode(ownValue(record, "code"));
    addCode(ownValue(record, "type"));
    addCode(ownValue(record, "status_code"));
    addMessage(ownValue(record, "message"));
    addMessage(ownValue(record, "status_msg"));
  }

  // Anthropic's documented spend-cap code has a distinct, intentionally narrow path.
  addAnthropicSpendCode(ownValue(errorDetails, "error_code"));
  addAnthropicSpendCode(ownValue(nestedErrorDetails, "error_code"));

  // OpenRouter's limit metadata is intentionally read only from these documented paths.
  for (const metadata of [rootMetadata, errorMetadata, nestedMetadata]) {
    addLimit(ownValue(metadata, "limit_source"));
    addLimit(ownValue(metadata, "reason"));
  }
  // Some gateway wrappers put the response error in a string field.
  if (typeof rootError === "string") addMessage(rootError);

  return shape;
}

function parseJsonObject(text: string | undefined, allowErrorPrefix: boolean): unknown {
  if (!text || text.length > MAX_JSON_TEXT) return undefined;
  let candidate = text.trim();
  if (!candidate.startsWith("{")) {
    if (!allowErrorPrefix) return undefined;
    const firstBrace = candidate.indexOf("{");
    if (firstBrace < 1 || firstBrace > 200) return undefined;
    const prefix = candidate.slice(0, firstBrace).trim();
    if (!/^[a-z0-9_. /-]{1,80}(?:api )?error(?:\s*\(\d{3}\))?:$/i.test(prefix)) return undefined;
    candidate = candidate.slice(firstBrace);
  }
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function containsToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text.slice(0, MAX_ERROR_TEXT));
}

function providerIs(provider: string, api: string, vendor: string): boolean {
  const matches = (id: string) => {
    const normalized = id.trim().toLowerCase().slice(0, MAX_ID_TEXT);
    return normalized === vendor || normalized.startsWith(`${vendor}-`) ||
      normalized.startsWith(`${vendor}_`) || normalized.startsWith(`${vendor}/`) ||
      normalized.startsWith(`${vendor}.`);
  };
  return matches(provider) || matches(api);
}

function matchesCreditBalanceMessage(messages: string[]): boolean {
  return messages.some((message) =>
    /\binsufficient balance\b|\bbalance is insufficient\b|\bnot enough (?:account )?balance\b|\bcredit balance (?:is )?too low\b/i.test(message),
  );
}

function matchesAnthropicSpendCap(messages: string[]): boolean {
  return messages.some((message) =>
    /\b(?:monthly\s+)?(?:spend|spending)\s+(?:limit|cap)\s+(?:has been\s+)?(?:reached|exceeded)\b/i.test(message) ||
    /^\s*you have reached your api usage limits:\s*your organization has crossed its monthly api usage threshold,\s*set based on your organization's api tier\b/i.test(message) ||
    /^\s*you have reached your specified (?:workspace )?api usage limits\b/i.test(message),
  );
}

function matchesMiniMaxFiveHourLimit(messages: string[]): boolean {
  return messages.some((message) =>
    /\busage limit exceeded\b.{0,80}\b(?:5|five)[ -]?hour(?:\s+window)?\b/i.test(message) ||
    /\b(?:5|five)[ -]?hour(?:\s+window)?\b.{0,80}\busage limit exceeded\b/i.test(message),
  );
}

function matchesCodexUsageLimitMessage(messages: string[]): boolean {
  // Codex subscription exhaustion arrives as an in-stream error event whose
  // only text is this terminal phrase. Transient throttles say "rate limit"
  // instead, and pi-ai itself treats "usage limit" failures as non-retryable.
  // The friendlier "hit your ChatGPT usage limit" text stays unclassified:
  // pi-ai also generates it for transient 429/rate_limit_exceeded responses.
  return messages.some((message) => /\busage limit has been reached\b/i.test(message));
}

/**
 * Classify only explicit, documented quota/billing exhaustion signals.
 * This is a bounded, side-effect-free classifier; it does not infer quota from
 * HTTP status, generic rate-limit wording, arbitrary response fields, or headers.
 */
export function classifyQuotaExhaustion(input: QuotaErrorInput): QuotaExhaustion | null {
  try {
    const provider = boundedString(ownValue(input, "provider"), MAX_ID_TEXT) ?? "";
    const api = boundedString(ownValue(input, "api"), MAX_ID_TEXT) ?? "";
    const errorMessage = boundedString(ownValue(input, "errorMessage"), MAX_ERROR_TEXT) ?? "";
    const providerError = ownValue(input, "providerError");
    const status = ownValue(providerError, "status");
    const bodyValue = ownValue(providerError, "body");
    const body = typeof bodyValue === "string"
      ? parseJsonObject(bodyValue.slice(0, MAX_JSON_TEXT), false)
      : bodyValue;
    const errorJson = parseJsonObject(errorMessage, true);
    const shapes = [asShape(body), asShape(errorJson)];
    // Thrown-error machine codes are as authoritative as response-body codes.
    const thrownCode = codeValue(ownValue(input, "errorCode"));
    const codes = [
      ...(thrownCode !== undefined ? [thrownCode] : []),
      ...shapes.flatMap((shape) => shape.codes),
    ];
    const anthropicSpendCodes = shapes.flatMap((shape) => shape.anthropicSpendCodes);
    const messages = [
      ...shapes.flatMap((shape) => shape.messages),
      // Do not search the entire serialized payload: it may contain remedy hints or unrelated diagnostics.
      ...(!errorJson && errorMessage ? [errorMessage] : []),
    ];
    const openRouterLimits = shapes.flatMap((shape) => shape.openRouterLimits);
    const isOpenRouter = providerIs(provider, api, "openrouter");
    const isOpenAI = providerIs(provider, api, "openai");
    const isDeepSeek = providerIs(provider, api, "deepseek");
    const isMiniMax = providerIs(provider, api, "minimax");
    const isAnthropic = providerIs(provider, api, "anthropic");

    // An explicit in-flight budget is temporary and must beat every generic 402/error signal.
    if (isOpenRouter && openRouterLimits.some((value) =>
      value === "openrouter_in_flight_budget" || value === "in_flight_budget_exhausted",
    )) return null;

    if (isOpenRouter && openRouterLimits.includes("openrouter_key_limit")) {
      return { ruleId: "openrouter.key_limit", kind: "spend-limit" };
    }
    if (isOpenRouter && openRouterLimits.includes("openrouter_credits")) {
      return { ruleId: "openrouter.credits", kind: "credit-balance" };
    }

    for (const token of ["usage_limit_reached", "subscription_sharing_usage_limit_exceeded"]) {
      if (codes.includes(token) || messages.some((message) => containsToken(message, token))) {
        return TOKEN_CLASSIFICATIONS[token];
      }
    }

    // These exact portable codes remain useful when a gateway obscures the upstream provider.
    if (codes.includes("credit_balance_exhausted") || messages.some((message) => containsToken(message, "credit_balance_exhausted"))) {
      return TOKEN_CLASSIFICATIONS.credit_balance_exhausted;
    }
    if (codes.includes("insufficient_quota") || messages.some((message) => containsToken(message, "insufficient_quota"))) {
      return TOKEN_CLASSIFICATIONS.insufficient_quota;
    }

    if (isOpenAI) {
      if (codes.includes("organization_usage_limit_exceeded")) {
        return { ruleId: "openai.organization_usage_limit_exceeded", kind: "spend-limit" };
      }
      if (codes.includes("organization_spend_limit_exceeded")) {
        return { ruleId: "openai.organization_spend_limit_exceeded", kind: "spend-limit" };
      }
      if (codes.includes("project_spend_limit_exceeded")) {
        return { ruleId: "openai.project_spend_limit_exceeded", kind: "spend-limit" };
      }
      if (matchesCodexUsageLimitMessage(messages)) {
        return { ruleId: "openai.codex_usage_limit_message", kind: "subscription-limit" };
      }
    }

    if (isDeepSeek && status === 402) {
      return { ruleId: "deepseek.http_402_insufficient_balance", kind: "credit-balance" };
    }
    if (isMiniMax && (codes.includes("1008"))) {
      return { ruleId: "minimax.code_1008_insufficient_balance", kind: "credit-balance" };
    }
    if (isMiniMax && codes.includes("2056")) {
      return { ruleId: "minimax.code_2056_five_hour_limit", kind: "daily-quota" };
    }

    if (matchesCreditBalanceMessage(messages)) {
      return { ruleId: "portable.explicit_insufficient_balance", kind: "credit-balance" };
    }
    if (isAnthropic && anthropicSpendCodes.includes("enforced_spend_limit_reached")) {
      return { ruleId: "anthropic.enforced_spend_limit_reached", kind: "spend-limit" };
    }
    if (isAnthropic && matchesAnthropicSpendCap(messages)) {
      return { ruleId: "anthropic.explicit_spend_cap", kind: "spend-limit" };
    }
    if (isMiniMax && matchesMiniMaxFiveHourLimit(messages)) {
      return { ruleId: "minimax.explicit_five_hour_limit", kind: "daily-quota" };
    }

    return null;
  } catch {
    // Provider payloads can be malformed or accessor-backed; classification must never throw.
    return null;
  }
}
