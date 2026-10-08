# Pi SDK 1.1.0 adaptation

Pi Web 0.9.42 upgrades the four direct SDK dependencies (`pi-agent-core`, `pi-ai`,
`pi-coding-agent`, and `pi-tui`) together from 1.0.4 to 1.1.0. The lockfile also
updates the official codemode, MCP, telemetry and chord packages, without changing
unrelated dependencies. The Node.js minimum and desktop sidecar remain 22.19.0.

Official release: <https://github.com/earendil-works/pi/releases/tag/v1.1.0>.

## Lifecycle and cancellation

SDK 1.1.0 adds `aborted` to `agent_settled`. Settlement still needs to clear the
running UI, refresh history, and maintain idle/SSE timers, even when cancelled.
Only completion side effects (completion sound and successful-run notifications)
should be suppressed. Both SDK-injected runs and RPC prompts must obey this rule;
filtering only the `agent_settled` callback is insufficient because prompt
completion and state reconciliation are additional notification paths.

Cancellation state must not leak into a later normal run. Retrying, compaction,
queued work and extension-injected runs continue to use the existing lifecycle
and monotonic run-id protections.

## Recorded tool duration

The SDK records an optional `durationMs` on finalized tool results and exposes it
on `tool_execution_end`. Web prefers the persisted result's finite, nonnegative
value, including zero, over the assistant/result timestamp difference. Old
sessions without a recorded duration retain the previous timestamp estimate.

The finalized `message_end` result remains authoritative. Existing result
normalization and session-history conversion preserve additional result fields;
Web does not require a second result object synthesized from tool-end events.
Terminal renderer `outputPad` is not a browser layout setting.

## Models, classifiers and pricing

- Haiku 5.5 and its supported `xhigh`/`max` thinking levels come from the official
  runtime catalog and thinking-level helper, not a new hardcoded Web list.
- Classifiers use typed model operations and codemode's `models.classify()`,
  including the new image context. They are not manually appended to the chat
  selector. The actual 1.1.0 catalog contains both a chat `gpt-6-luna` entry using
  `openai-responses` and a classifier entry using `openai-decisions`; do not filter
  the chat entry merely because it shares the classifier's ID.
- Native llama.cpp decision models are discovered by the SDK. No separate Web
  classifier selector or provider protocol implementation is introduced.
- Request-wide prompt-length pricing tiers are computed by the SDK, including
  cached input. Session statistics sum the recorded usage/cost rather than
  repricing old messages, so upgrading does not retroactively correct old costs.
- Valid configuration containing the four base cost rates plus `tiers` must
  survive Web configuration normalization. An ordinary model definition's SDK
  cost schema requires those four base rates; a tiers-only object is not a newly
  supported 1.1.0 model configuration. A tier editor is a separate optional UI
  feature, not a prerequisite for correct SDK pricing.

## Unchanged integration boundaries

The service-based SDK construction, official codemode/tool-search/MCP builtin
factories, exact tool selections, Chat-only isolation and subagent resource
restrictions stay in place. CLI `+name`/`-name` parsing and OSC 7501 terminal status
reporting do not need equivalent browser command-line parsing or escape output.
MCP OAuth cancellation/timeouts, provider retries, login port fallback and model
cost corrections are upstream runtime fixes.

Updating a global Pi CLI is independent of updating Web's embedded SDK. Tests
and this release do not update the user's CLI, sessions, credentials, model
configuration, or installed desktop application in place.

## Verification and desktop delivery

Offline regression tests use temporary storage and fake sessions/providers,
without paid provider calls or production credentials. Local pre-push verification
passes 217 targeted tests, 5 Rust shell tests, type checking and zero-warning lint.
Targeted Windows checks include the actual compiled NSIS upgrade/rollback tests. Full Web
regressions run on Ubuntu; Windows branch CI retains type checking/lint, and the
desktop workflow runs Rust plus mandatory compiled NSIS checks.

Desktop packaging continues to validate OAuth modules, codemode/WASM assets,
workers, documentation and all runtime package layouts against the source
installation. The existing staged-payload installer fix is retained so old nested
SDK packages cannot shadow the new runtime after an upgrade. Signed installers
and updater manifests are published under a new immutable desktop version tag.

See [the release notes](releases/v0.9.42.md) for the verification and release scope.
