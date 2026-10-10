import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { classifyQuotaExhaustion } = await jiti.import("./quota-errors.ts");

const classified = (input, kind, ruleId) => {
  assert.deepEqual(classifyQuotaExhaustion(input), { kind, ruleId });
};
const unclassified = (input) => assert.equal(classifyQuotaExhaustion(input), null);

test("OpenAI explicit billing and spend codes qualify, including prefixed JSON", () => {
  classified({
    provider: "openai",
    providerError: { status: 429, body: { error: { code: "credit_balance_exhausted" } } },
  }, "credit-balance", "portable.credit_balance_exhausted");
  classified({ provider: "openai", providerError: { body: { error: { type: "insufficient_quota" } } } },
    "spend-limit", "portable.insufficient_quota");
  classified({ provider: "openai", providerError: { body: { error: { code: "organization_usage_limit_exceeded" } } } },
    "spend-limit", "openai.organization_usage_limit_exceeded");
  classified({ provider: "openai", providerError: { body: { error: { code: "organization_spend_limit_exceeded" } } } },
    "spend-limit", "openai.organization_spend_limit_exceeded");
  classified({ provider: "openai", providerError: { body: { error: { code: "project_spend_limit_exceeded" } } } },
    "spend-limit", "openai.project_spend_limit_exceeded");
  classified({
    provider: "openai",
    errorMessage: 'OpenAI API error (429): {"error":{"code":"organization_spend_limit_exceeded"}}',
  }, "spend-limit", "openai.organization_spend_limit_exceeded");
});

test("DeepSeek 402 is provider-scoped; its generic rate limit is not quota", () => {
  classified({ provider: "deepseek", providerError: { status: 402 } },
    "credit-balance", "deepseek.http_402_insufficient_balance");
  unclassified({ provider: "deepseek", providerError: { status: 429, body: { error: { message: "rate limit" } } } });
  unclassified({ provider: "other-provider", providerError: { status: 402 } });
});

test("MiniMax numeric codes are scoped to MiniMax and map to the documented buckets", () => {
  classified({ provider: "minimax", providerError: { body: { base_resp: { status_code: 1008 } } } },
    "credit-balance", "minimax.code_1008_insufficient_balance");
  classified({ provider: "minimax", providerError: { body: { base_resp: { status_code: 2056 } } } },
    "daily-quota", "minimax.code_2056_five_hour_limit");
  classified({ provider: "MiniMax", errorMessage: "Usage limit exceeded for the five-hour window." },
    "daily-quota", "minimax.explicit_five_hour_limit");
  unclassified({ provider: "other-provider", providerError: { body: { code: 1008 } } });
  unclassified({ provider: "minimax", providerError: { body: { base_resp: { status_code: 1002 } } } });
  unclassified({ provider: "minimax", errorMessage: "Usage limit exceeded." });
});

test("Anthropic qualifies only scoped spend-cap codes or explicit credit/spend-cap wording", () => {
  classified({ provider: "anthropic", providerError: { status: 400, body: { error: {
    type: "invalid_request_error",
    message: "Your credit balance is too low to access the API.",
  } } } }, "credit-balance", "portable.explicit_insufficient_balance");
  classified({ provider: "anthropic", providerError: { status: 400, body: { error: {
    type: "invalid_request_error",
    details: { error_code: "enforced_spend_limit_reached" },
  } } } }, "spend-limit", "anthropic.enforced_spend_limit_reached");
  classified({ provider: "anthropic", providerError: { status: 429, body: { error: {
    type: "rate_limit_error",
    message: "Your monthly spend limit has been reached.",
  } } } }, "spend-limit", "anthropic.explicit_spend_cap");
  unclassified({ provider: "anthropic", providerError: { status: 400, body: { error: {
    type: "invalid_request_error", message: "Invalid parameter value.",
  } } } });
  unclassified({ provider: "anthropic", providerError: { status: 429, body: { error: {
    type: "rate_limit_error", message: "Rate limit exceeded. Retry shortly.",
  } } } });
  unclassified({ provider: "gateway", providerError: { status: 400, body: { error: {
    details: { error_code: "enforced_spend_limit_reached" },
  } } } });
});

test("OpenRouter requires explicit credit/key metadata and excludes in-flight budgets", () => {
  classified({ provider: "openrouter", providerError: { status: 402, body: { error: {
    metadata: { limit_source: "openrouter_key_limit" },
  } } } }, "spend-limit", "openrouter.key_limit");
  classified({ provider: "openrouter", providerError: { body: { error: {
    metadata: { limit_source: "openrouter_credits" },
  } } } }, "credit-balance", "openrouter.credits");
  unclassified({ provider: "openrouter", providerError: { status: 402, body: { error: { message: "Payment required" } } } });
  unclassified({ provider: "openrouter", providerError: { status: 402, body: { error: {
    code: "insufficient_quota",
    metadata: { limit_source: "openrouter_in_flight_budget" },
  } } } });
  unclassified({ provider: "openrouter", providerError: { body: { error: {
    metadata: { reason: "in_flight_budget_exhausted" },
  } } } });
});

test("explicit subscription tokens qualify but access and transformed Codex errors do not", () => {
  classified({ provider: "gateway", errorMessage: "usage_limit_reached" },
    "subscription-limit", "portable.usage_limit_reached");
  classified({ provider: "gateway", providerError: { body: { error: {
    code: "subscription_sharing_usage_limit_exceeded",
  } } } }, "subscription-limit", "portable.subscription_sharing_usage_limit_exceeded");
  unclassified({ provider: "openai-codex", providerError: { status: 429 },
    errorMessage: "You have hit your ChatGPT usage limit. Try again later." });
  unclassified({ provider: "openai-codex", providerError: { status: 429, body: {
    error: { code: "rate_limit_exceeded", type: "rate_limit_error" },
  } } });
  unclassified({ provider: "openai", errorMessage: "usage_not_included" });
});

test("Codex in-stream quota errors classify via the thrown code or terminal phrasing", () => {
  // SSE/WebSocket `error` events have no HTTP status/body; CodexApiError.code
  // carries the upstream machine code and must be treated like a body code.
  classified({ provider: "openai-codex", errorCode: "usage_limit_reached" },
    "subscription-limit", "portable.usage_limit_reached");
  classified({ provider: "openai-codex", errorCode: " USAGE_LIMIT_REACHED " },
    "subscription-limit", "portable.usage_limit_reached");
  classified({ provider: "openai-codex", errorMessage: "Codex error: The usage limit has been reached" },
    "subscription-limit", "openai.codex_usage_limit_message");
  classified({ provider: "openai", errorMessage: "The usage limit has been reached" },
    "subscription-limit", "openai.codex_usage_limit_message");
  // Transient throttles, unknown codes, other providers and non-string codes stay null.
  unclassified({ provider: "openai-codex", errorCode: "rate_limit_exceeded" });
  unclassified({ provider: "openai-codex", errorMessage: "Codex error: The rate limit has been reached" });
  unclassified({ provider: "other-gateway", errorMessage: "Codex error: The usage limit has been reached" });
  unclassified({ provider: "openai-codex", errorCode: 429 });
  unclassified({ provider: "openai-codex", errorCode: { nested: "usage_limit_reached" } });
});

test("ordinary transport, auth, server, and rate-limit failures stay null", () => {
  for (const status of [401, 403, 429, 503]) {
    unclassified({ provider: "openai", providerError: { status, body: { error: { message: "Request failed" } } } });
  }
  unclassified({ provider: "google", providerError: { status: 429, body: {
    error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for requests per minute." },
  } } });
  unclassified({ provider: "openai", errorMessage: "Too many requests; rate limit exceeded." });
  unclassified({ provider: "unknown", errorMessage: "billing quota exceeded; usage limit" });
  unclassified({ provider: "unknown", providerError: { body: { error: { code: "RESOURCE_EXHAUSTED" } } } });
});

test("only recognized fields and bounded, parseable JSON are examined", () => {
  unclassified({ provider: "unknown", providerError: { body: {
    debug: "credit_balance_exhausted",
    remedy: "Please increase the spend limit that was reached.",
  } } });
  unclassified({ provider: "anthropic", errorMessage: '{"error":{"message":"Invalid request"},"remedy":"monthly spend limit reached"}' });
  unclassified({ provider: "openai", errorMessage: `x${" ".repeat(9_000)} credit_balance_exhausted` });
  unclassified({ provider: "unknown", providerError: { body: "not JSON: {\"code\":\"insufficient_quota\"}" } });
  unclassified({ provider: "openai", providerError: { headers: { "x-error-code": "insufficient_quota" } } });

  const circular = {};
  circular.self = circular;
  unclassified({ provider: "unknown", providerError: { body: circular } });
  unclassified(null);
  unclassified({ provider: "unknown", providerError: { body: new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error("malformed proxy"); },
  }) } });
});
