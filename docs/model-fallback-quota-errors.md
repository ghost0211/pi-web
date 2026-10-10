# Quota-only model fallback signals

`lib/quota-errors.ts` provides a **classifier only**. It does not make a fallback decision, retry a request, or contact a provider. A caller may use a non-null result to offer an opt-in alternate model, but should call it only for a known assistant/provider error—not for tool output, user text, or arbitrary logs. The caller remains responsible for fallback policy and for retaining the original error.

```ts
classifyQuotaExhaustion({
  provider: "openai",
  errorMessage: "...",
  providerError: { status: 429, body: { error: { code: "insufficient_quota" } } },
});
// { ruleId: "portable.insufficient_quota", kind: "spend-limit" }
```

The result is `null` unless there is an explicit supported signal. The `kind` values are `credit-balance`, `spend-limit`, `subscription-limit`, and `daily-quota`. MiniMax's documented five-hour usage window uses `daily-quota` because that is the closest available recurring quota bucket; it does not mean that the source specifies a 24-hour window. `ruleId` names the matched rule and is suitable for diagnostics/tests, not a provider API contract.

## Runtime fallback policy

`lib/model-fallback-runtime.ts` is the only caller wired into sessions. At `agent_before_settle` it runs at most once per logical run, only for the active assistant failure, only when the configured backup differs from the active model, and only after the backup is still visible/authenticated, accepts any image history, and has sufficient estimated context/output room. It does not resend the user prompt or replay completed tool calls: the failed assistant entry is excluded with `context_edit`, the original user message and completed tool results remain, and the SDK continues the current run with the backup model.

A successful switch writes a bounded `pi-web:model-fallback-event` audit entry containing `{ from, to, ruleId, kind, timestamp }` and emits the same notice to the web client. Raw upstream response bodies, request headers, API keys, and prompt content are never persisted. Raw response capture is request/session isolated, bounded to 16 KiB, and is invalidated by a new request or a successful response. Google adapters are not forced onto a custom fetch because their SDK adapters reject one; non-Google adapters keep any existing `fetch`/`onResponse` behavior while the wrapper observes error responses.

## Independent thinking levels

The composer has one thinking button with primary/current-model and backup tabs in its popup. The toolbar summarizes the primary model's level; switching tabs only changes which preference is edited. Each tab uses its own model's supported SDK levels and native `thinkingLevelMap` labels. The backup tab is visible but disabled when no backup is selected; unknown capabilities and off-only models also disable their own tab. The shared button stays usable when either model can be edited, and busy/compacting sessions disable the whole control. Changing either model closes the old popup, and an incompatible level returns to `auto` rather than carrying another model's level.

The optional backup `thinkingLevel` is stored together with its public model reference in the existing session configuration and fresh-composer preference:

```json
{ "provider": "backup-provider", "modelId": "backup-model", "thinkingLevel": "low" }
```

Only the existing canonical levels plus `auto` are accepted; credentials and other fields remain rejected. Model-only legacy entries still work and mean `auto`. Configuring backup thinking never changes the active SDK thinking level or global primary defaults. Primary thinking changes never rewrite the backup configuration. Clearing the backup removes its level too. Forks, resumes and tool-selection rebuilds carry the same atomic configuration.

On a confirmed quota failover, the server explicitly applies the backup's level **after** switching models and **before** continuing the run; it does not inherit the primary session's thinking. Backup `auto` uses that model's scope pin/per-model setting, otherwise SDK `medium` clamped to that model's capabilities. Unsupported legacy choices fall back to this same model-specific default; non-reasoning models resolve to `off`. The client displays the resulting actual level, without replacing an explicit choice with an implicit scope pin.

## Supported signals and boundaries

- **OpenAI:** exact `credit_balance_exhausted`, `insufficient_quota`, `organization_usage_limit_exceeded`, `organization_spend_limit_exceeded`, and `project_spend_limit_exceeded` codes/types. The three organization/project codes classify as spend limits. `usage_limit_reached` and `subscription_sharing_usage_limit_exceeded` are exact subscription-limit tokens.
- **DeepSeek:** HTTP status 402 only when the provider/API identifier is DeepSeek. An explicit insufficient-balance message is also accepted. A 429 is not quota exhaustion.
- **MiniMax:** exact response codes 1008 (insufficient balance) and 2056 (five-hour usage limit), read from known `code`/`status_code` fields. Numeric codes are ignored for other providers. A narrowly worded five-hour usage-limit message is also accepted. Codes 1002 (rate limit), 1039 (token limit), 1041 (connection limit), and 2045 (rate growth) do not qualify.
- **Anthropic:** no classification from status, `invalid_request_error`, or `rate_limit_error` alone. Only Anthropic-scoped `error.details.error_code = "enforced_spend_limit_reached"`, explicit credit-balance-low wording, or an explicit spend/spending limit/cap reached/exceeded message qualifies.
- **OpenRouter:** only `metadata.limit_source` values `openrouter_key_limit` or `openrouter_credits` qualify. `openrouter_in_flight_budget` and `in_flight_budget_exhausted` are explicitly transient exclusions and override other signals in that response.
- **Portable exact signals:** the exact machine tokens `credit_balance_exhausted`, `insufficient_quota`, `usage_limit_reached`, and `subscription_sharing_usage_limit_exceeded`, plus explicit insufficient-balance wording. They can be useful through gateways that obscure the upstream provider. Vendor numeric codes remain provider-scoped.

The parser reads only a small set of documented error fields (`code`, `type`, known messages, MiniMax `base_resp`, and OpenRouter metadata paths). It also accepts bounded JSON in `errorMessage`, including an error-prefix form such as `OpenAI API error (429): {...}`. It does not recursively search arbitrary payload properties or headers. Input text and parsed structures are bounded; malformed values return `null` rather than throwing.

## Deliberate non-matches / unsupported ambiguity

- HTTP 429, `rate_limit_exceeded`, `rate_limit_error`, ordinary retry wording, and rate-limit headers are not evidence of exhausted quota.
- HTTP 401/403/5xx, transport errors, and generic 402 responses do not qualify.
- Generic `billing`, `quota exceeded`, `usage limit`, `RESOURCE_EXHAUSTED`, and provider-neutral numeric codes are not matched. In particular, generic minute/token/connection quotas are not treated as account exhaustion.
- OpenRouter 402 is insufficient by itself; in-flight budget exhaustion is transient.
- Anthropic's broad 400/429 error types are ambiguous between validation/transient rate limiting and account caps.
- OpenAI Codex SDK's friendly “You have hit your ChatGPT usage limit...” text alone is not a signal. If an SDK has already replaced the raw code with that generic message, this classifier intentionally returns `null`; a caller may lose a true positive rather than risk treating an ordinary 429 as quota exhaustion.
- Other vendor-specific codes/messages, localized or paraphrased errors, and nested formats outside the explicitly read paths are unsupported until reviewed. False negatives are preferred to false-positive fallback.

## Source basis and fixture provenance

The supported cases and exclusions above are based on these provider documents (reviewed as documentation, not validated with live requests):

1. [OpenAI: How can I solve 429 Too Many Requests errors?](https://help.openai.com/en/articles/5955604-how-can-i-solve-429-too-many-requests-errors%3F.zst) — distinguishes named billing/spend exhaustion codes from generic transient `rate_limit_exceeded`.
2. [DeepSeek API error codes](https://api-docs.deepseek.com/quick_start/error_codes) — documents 402 insufficient balance and 429 rate limit.
3. [MiniMax API error codes](https://platform.minimax.io/docs/api-reference/errorcode) — documents 1008, 2056, and the non-quota codes listed above.
4. [Anthropic API errors](https://platform.claude.com/docs/en/api/errors) — shows that broad 400/429 types are ambiguous; this implementation requires the documented spend-limit detail code or explicit cap/balance wording.
5. [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits) — distinguishes key/credit limits from transient in-flight budget exhaustion.

The unit tests use hand-authored representative fixtures derived from these documented behaviors. They are **not captured real provider responses**: no paid API calls were made, and no real user errors, configurations, sessions, or credentials were collected. The OpenAI Codex SDK message caveat is based on the installed SDK behavior noted during implementation; the transformed friendly message is deliberately tested as a negative fixture.
