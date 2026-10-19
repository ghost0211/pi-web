# Pi CLI / SDK 1.3.0 adaptation

Official release: <https://github.com/earendil-works/pi/releases/tag/v1.3.0>.

The four direct Web SDK dependencies (`pi-agent-core`, `pi-ai`, `pi-coding-agent`,
`pi-tui`) and the lockfile are synchronized to `^1.3.0`; the transitive
`pi-mcp`/`pi-codemode` packages follow the SDK's new exact pinning. Application
version remains unchanged until a separately authorized release.

## Compatibility audit

The public surface used by Web is unchanged: `createAgentSessionFromServices`,
extension event types, the session file format (`session-manager` is byte-identical),
and `resolveModelScopeWithDiagnostics` all keep their 1.2.0 shapes. The removed
`parseModelPattern` helper and pi-ai's removed `assistant-message-frame` export
were never imported by Web. The HTML export template keeps the exact
`sortChildren`/`mapNodes` snippets that `/api/sessions/[id]/export` patches, so
deep-session exports still work.

## Behavior changes Web inherits

- **Scope ambiguity (#10160)**: `enabledModels` patterns now resolve to every
  provider offering a matched id, with an `ambiguous` diagnostic, instead of
  silently picking catalog order. Web keeps its stricter guard for exact
  patterns (`assertNoAmbiguousExactPatterns` throws with provider hints) and
  surfaces the new warning verbatim for fuzzy matches; globs stay warning-free
  by design. The selector groups by provider, so duplicate ids render normally.
  Covered by `lib/pi-sdk-1.3.test.mjs`.
- **Resume restores active tools (#10785)**: the SDK rebuilds the transcript's
  tool loadout on resume. Web always reapplies its persisted
  `pi-web:tool-selection` after construction, so its presets still win; legacy
  sessions without a Web entry now restore their own loadout instead of the
  default set, which is strictly more correct.
- **Retry coverage (#10920, #10965)**: gateway `Unable to forward upstream
  stream` and `The service is temporarily unavailable` errors are retried,
  including during compaction summarization. The quota-fallback classifier is
  unchanged and stays quota-only.
- **Model switching drops foreign thinking blocks (#10995)**: a previous model's
  reasoning is no longer shown to the new model as text.
- **Provider/catalog fixes**: `openai-codex/gpt-6.1-sol` is 500K context,
  OpenCode Zen/Go moved to `opencode.ai/inference`, `kimi-coding` speaks Chat
  Completions (custom base URLs must include `/v1`), Gemini 4 Argon thinking
  budgets, Xiaomi MiMo and Claude Haiku/Opus thinking levels, malformed
  tool-call arguments fail validation, and invalid `\u` escapes no longer drop
  argument fields. Web's own gateway (`agy-router`) entries are untouched.
- **`sessionShareDestination`** is a TUI `/share` setting; Web has no share UI
  and ignores it.

## Desktop bundle

SDK-internal dependencies are now exact-pinned upstream. The desktop server
assembly (`scripts/build-desktop-server.mjs`) and the runtime-package validation
tests were re-run against the 1.3.0 tree and pass unchanged.
