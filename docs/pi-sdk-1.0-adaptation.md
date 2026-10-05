# Pi SDK 1.0 integration

The initial integration targeted **1.0.0**; see [the 1.0.1–1.0.3 companion updates](pi-sdk-1.0.3-adaptation.md) for current compatibility. Node **22.19.0 or newer** is required. This builds on the [0.99 integration](pi-sdk-0.99-adaptation.md), including its tool exposure, Chat-only isolation, model identity, and usage rules.

## Codemode and image models

The Web embeds the official, replaceable Codemode factory; the slimmer descriptions, sandbox APIs, classifier calls, and `models.generateImages()` therefore come from the SDK rather than a second Web implementation. Enable `codemode` through **Tools → Custom**. Saving Codemode settings still does not enable tools or change `defaultTools`.

A script can generate images with an available image model:

```js
// @options: {"timeout_ms": 300000}
const painter = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
const result = await models.generateImages(painter, {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return result.errorMessage;
for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
```

The example needs that provider's credentials and an available image model; generation may incur charges. Use `await models.getAvailableOfType("image")` to discover models. `getModelOfType()` inside the sandbox is also asynchronous. Web chat selectors continue to select chat models, not image models.

Generated images are standard image blocks in the paired Codemode result. Expand the tool call to see and preview them. Do not print base64 through `text()` or `console.log()`. SDK 1.0.0 did not automatically save image files; SDK 1.0.3 also saves each `image(block)` result to a private temporary file (see the companion guide). The SDK records image-call usage on the tool result, which the Web counts exactly once; nested-call details are not another billable transcript.

## Provider login

Radius uses the existing capability-driven API-key/OAuth provider lists and the official credential store. Anthropic's browser/copy-code selection is handled through the existing select → authorization URL → manual-code SSE interaction. No provider-specific credential format or extra login endpoint is introduced.

Unlike CLI startup/login helpers, the Web does not automatically install or rewrite a Radius MCP server configuration. MCP configuration remains an explicitly saved change followed by explicit session reload.

## MCP OAuth metadata override

In **Settings → MCP**, an HTTP server's OAuth JSON can include:

```json
{"authServerMetadataUrl":"https://issuer.example/.well-known/oauth-authorization-server"}
```

The URL must use HTTPS, or HTTP on `localhost`, `127.0.0.1`, or `[::1]`, without embedded URL credentials. Metadata fetching, issuer/endpoint checks, authentication, and persistence belong to the official SDK. The editor validates and preserves the setting without fetching it. URLs with query/fragment values are masked on reads and restored only from the same saved server. `null` removes this option; unchanged private options remain preserved. Existing [MCP security and reload rules](mcp-settings.md) remain in force.

## Shared CLI startup preference

**Settings → General → Automation** now preserves all SDK values for `quietStartup`: `false` (all notices), `"header"` (header only), and `true` (quiet). This changes shared CLI startup output, not Web chat rendering. Unrelated settings edits do not downgrade `"header"` to a boolean. The CLI's new full-screen TUI default is not replicated in the Web UI.

## Standalone and desktop assets

SDK 1.0 splits runtime components into `pi-codemode`, `pi-mcp`, and `chord`. Standalone tracing includes complete packages in hoisted or nested layouts, including `package.json`, JS entry points, QuickJS/Photon WASM, worker dependencies, and the SDK's runtime-referenced `docs/codemode.md`. Desktop assembly validates runtime assets against the installed source tree; a successful Next build alone is not sufficient. Missing nested Chord manifests and telemetry packages are explicit regression cases.

Regression fixtures use temporary settings, a local stdio MCP server, loopback OAuth, and a synthetic image provider. They do not access user credentials or paid models. These are not a substitute for browser/WebView certification or a real-provider login test.
