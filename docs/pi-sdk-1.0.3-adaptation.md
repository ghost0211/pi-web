# Pi SDK 1.0.1–1.0.3 compatibility

This builds on [the SDK 1.0 integration](pi-sdk-1.0-adaptation.md). Pi Web uses
its own installed dependencies; updating the global CLI does not update a Web
build, and changing dependencies on disk does not replace already-loaded code.

## Shared configuration

- SDK 1.0.2 accepts model-level `samplingParams` and
  `samplingParamsByThinkingLevel` in `models.json`, including `modelOverrides`.
  Web configuration edits retain these fields; the SDK owns validation, supported
  thinking-level clamping and request parameter merging. These are not automatic
  tuning and upstream endpoints must accept the parameters. The Web model panel
  does not currently provide a dedicated sampling-parameter editor.
- SDK 1.0.1 lets a trusted project's `.pi/mcp.json` override a same-name global
  server using only `enabled`, `exposure` and `toolExposure`, without duplicating
  its transport or authentication. Web editing must preserve explicit `true`
  and `"codemode"` values in these overrides, even though ordinary server entries
  omit them as defaults. Forms display inherited permissions and submit only
  changed fields, so an unchanged save does not enable a disabled global server
  or replace hidden per-tool permissions with an empty map. Full project
  definitions still replace global entries.
- HTTP MCP OAuth exposes `clientRegistration: "dcr" | "cimd"` in the existing
  JSON editor. CIMD cannot include `clientId` or `clientName`; an explicit
  callback URL must use `localhost` or `127.0.0.1` and the `/callback` path.
  Unrelated private OAuth fields and existing masked values remain protected.
  This does not edit model-provider subscription credentials.

## Generated images

SDK 1.0.3 `image(block)` produces both a normal image block and an
`[Image saved to ...]` text block pointing at a private temporary file. Images
continue to render inline from the image block. Assistant Markdown that refers
back to a local image must carry the source session ID to `/api/files`.

The file endpoint's existing exact-session-reference authorization remains the
boundary: this does **not** authorize the whole temporary directory, permit
listing it, or expose unrelated files. Move generated files into a project if
they need permanent storage. Recorded tool-result usage remains counted once.

## Providers and subscription safety

- SDK 1.0.3 renames the Azure **provider ID** to `azure`; the API identifier
  `azure-openai-responses` and the `AZURE_OPENAI_*` environment variables remain
  valid. Web icons support both new and historical provider IDs. Pi Web does
  not automatically rewrite `auth.json`, provider keys or scoped-model patterns.
- OAuth refresh remains entirely SDK-owned. Once a refresh has started and may
  have rotated a token, SDK 1.0.3 finishes and persists it even if the caller
  cancels. Web tests cover cancellation and reuse through synthetic Codex and
  Kimi Code provider implementations and temporary credential files, not real
  accounts or provider authentication.
- Read-only provider listing must not refresh tokens. Tests also check that
  unrelated subscription entries remain unchanged during a synthetic refresh.

Do not run a CLI update or login/logout as a Web deployment step. Preserve
working subscription credentials; use isolated installs/builds and wait for
active sessions to settle before an explicitly authorized service restart.
The SDK changelog's OAuth fix does not establish the cause of any particular
past login failure without its error evidence.

## Other SDK changes

Terminal keybindings, terminal-image fixes, `registerToolRenderer()` and Nix
installation are CLI/TUI features; the Web renderer does not execute TUI
renderers. MCP fixtures nevertheless provide the new registration API because
they exercise the actual official extension.

The existing complete-package, OAuth, worker, WASM and SDK-documentation guards
remain required for standalone/desktop output. A passing source-layout check is
not a substitute for validating the built bundle. Fixtures do not certify real
provider logins or browser/WebView behaviour.

## Verification

- 1,345 tests passed, plus type checking and zero-warning lint.
- Fresh isolated regular and standalone builds; 30 HTTP checks each.
- Built-bundle validation: six runtime packages / 77 files, one OAuth runtime,
  one Codemode runtime, two WASM assets, three workers and SDK documentation.
  Six public package imports and 15 actual SDK/OAuth/image fixtures passed.
- Tests and HTTP servers used temporary HOME/agent directories; no production
  credentials, CLI update/login/logout or service restart was performed.
  No release or Windows installer was produced by this adaptation task.

Official release notes:
[1.0.1](https://github.com/earendil-works/pi/releases/tag/v1.0.1),
[1.0.2](https://github.com/earendil-works/pi/releases/tag/v1.0.2),
[1.0.3](https://github.com/earendil-works/pi/releases/tag/v1.0.3).
