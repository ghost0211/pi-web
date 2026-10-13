# Pi CLI / SDK 1.2.0 adaptation

Official release: <https://github.com/earendil-works/pi/releases/tag/v1.2.0>.

The four direct Web SDK dependencies (`pi-agent-core`, `pi-ai`, `pi-coding-agent`,
`pi-tui`) and lockfile are synchronized to 1.2.0. Updating the global CLI alone
would not update Web's embedded SDK or the next desktop bundle. Application
version remains unchanged until a separately authorized release.

## Required integration work and regression checks

### User and custom-run preparation

`before_agent_start` is now a union: user runs have `messageType: "user"`,
`prompt` and optional `images`; custom runs have `messageType: "custom"` and
`message`, not `prompt`/`images`. The Web system-prompt extension uses the common
`systemPrompt` field, so it intentionally applies to both kinds of run. Do not
add a user-only guard: Auto Advance and subagent-report follow-ups also need the
configured system prompt. A real-SDK test verifies it survives a tool follow-up.

SDK preparation is already busy before the first low-level `agent_start`.
Existing `inner.isStreaming`/wrapper busy guards observe that state. Stop during
an async preparation hook reaches the first stream adapter with an already
aborted signal; cancellation-aware transports must honor it. Custom messages
queued during preparation remain in that run. No extra Web prompt replay or
private SDK lifecycle patch is needed.

### Quota fallback and automatic compaction

The quota incident exposed an existing integration bug, not a missing Codex
error-text rule. SDK automatic compaction also uses `agent.streamFunction`
before `agent_before_settle`. The observer used to clear the main failure on
that summarization request, so a valid backup could remain unused.

`model-fallback-runtime.ts` now separates transient adapter throws from finalized
assistant failures. The authoritative `message_end` captures that assistant's
request evidence; summary calls cannot erase it or lend their quota errors to a
non-quota main error. Bounded late HTTP body reads remain attached to their own
request. The narrow quota classifier, once-per-logical-run policy, context/image
checks, failed-entry `context_edit`, independent backup thinking and durable
primary restoration are unchanged. Tests cover user and custom runs with real
SDK compaction enabled and no network. See [quota fallback](model-fallback-quota-errors.md).

### Independent Auto Advance thinking

`AutoAdvanceConfig.thinkingLevel` is an optional surrogate-only preference;
legacy omission means `auto`. The UI filters canonical choices using the selected
surrogate's supported levels, displays provider mappings, and submits the
canonical value. The server independently rejects unsupported explicit choices
and resolves `auto` from that surrogate's scope pin or SDK default, never the
main or quota backup's thinking. `completeSimple` receives the resolved reasoning
option with no tools. Scope remains explicit and required, with a clearer label,
example and warning that natural-language boundaries are not a permission sandbox.
See [Auto Advance](auto-advance.md).

### User-requested round-only advancement policy

The Web controller now permits 1–99 additional logical main-agent runs (default
3) with no total wall-clock or Token budget. Legacy `maxMinutes`/`tokenBudget`
input is stripped rather than translated into hidden defaults. Token usage is
observational; unavailable/invalid metrics mark the total incomplete and do not
pause an otherwise valid decision. The concise surrogate decision response and
provider/model context/output capacities remain separate from this aggregate
policy. Stop, manual takeover, error/confirmation/repetition guards and lifecycle
barriers remain in place. Long-running work can incur ongoing costs.

## SDK features automatically available or optional in Web

| SDK 1.2 feature | Web integration |
| --- | --- |
| OpenRouter per-key catalogs, regional filtering, limits/prices | Existing `ModelRuntime` and shared scope expose the personalized snapshot. Tests verify context/output/pricing and offline restoration. Web startup remains offline-first; it reads SDK catalog cache, not a new unbounded per-key network request on every `/api/models` call. Refresh through CLI `pi update --models` or a future bounded Web refresh feature. A changed key can retain the previous catalog until refresh. |
| Configuration JSON schemas and stricter startup validation | Preserve existing `$schema` and unrelated fields when saving `models.json`; tests cover normalization/round-trip. Frontend spreads also preserve root metadata. No automatic schema injection or forced rewrite of user files. Dedicated schema-aware source editors are optional. |
| Theme reusable `vars` and schema URL | SDK owns loading/validation. Web themes use CSS variables, not the TUI JSON theme schema. Invalid personal TUI themes still need correction by their owner. |
| MCP lazy resources and `structuredContent: unknown` | Web status consumes the SDK `/mcp` safe text, not CLI JSON resource counters. The SDK status text contract remains compatible; no direct structured-content object-field consumer was found. Do not loosen credential redaction or add speculative boolean/count conversions. |
| Codemode input constraints, elapsed/total timings, output performance fixes | Native SDK/codemode builtin factories receive them. A richer browser timing/capability view is optional; Web's existing outer tool timing remains separate. |
| `PI_CLIPBOARD_OSC52=1` | Terminal/remote-terminal feature; browser clipboard is a different integration. No escape sequence forwarding added. |
| Removal of `@earendil-works/chord` | Source-aware desktop validators already skip absent packages. Keep backwards-compatible trace/validator support for older layouts; verify current OAuth, workers, JS/WASM and documentation assets. No dependency reintroduction. |

## Validation boundaries

Tests use fake provider streams, isolated runtime stores and mocked HTTP responses.
OpenRouter catalog tests exercise the real runtime plus the shared Web scope
without paid requests. SDK lifecycle, fallback-compaction and Auto Advance tests
exercise the real session/extension machinery. They do not prove live-provider
billing/rate-limit behavior or an installed desktop upgrade end to end.

Local validation for this working tree:

- TypeScript, zero-warning repository ESLint and `git diff --check`: passed.
- Focused SDK/Auto Advance/quota/controls/idle-lifecycle regression suite: 176 passed.
- Complete suite: 1906 total, 1874 passed, 28 skipped, 4 existing Windows
  symlink-fixture `EPERM` failures before assertions. The tests were not weakened.
- Real React browser fixture: 320/390/1440px × zh-CN/en/zh-TW, plus a reduced
  390×440 viewport and real ChatInput passthrough. Verified canonical payloads,
  mapped labels, model switching, unknown/nonreasoning metadata, required scope,
  focus restoration, usable Stop (including busy/pending start), 1–99 round
  validation, absence of time/budget fields in UI/payload, partial usage statistics
  and no horizontal overflow. Mock-clock tests cover eight-hour main/surrogate
  work without deadline or idle reaping; controller tests execute all 99 rounds
  with tens of millions of reported Tokens.
- One initial full run also saw a transient loopback MCP OAuth metadata-override
  fixture failure; its isolated rerun and both later full reruns passed. No
  production auth behavior or redaction rule was changed to suppress it.

Do not run a local Next production build during development. Desktop assembly
and signed installer verification remain release-CI tasks. No sessions,
credentials or model configuration are rewritten by this adaptation; inspecting
an incident and replaying a disposable copy does not resume or mutate the user's
real conversation.
