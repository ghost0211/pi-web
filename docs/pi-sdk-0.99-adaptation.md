# Pi SDK 0.99 integration

Pi Web embeds the SDK in-process. Updating the global `pi` CLI does **not** update
that embedded SDK or automatically install the CLI's built-in extensions.

## Supported in normal sessions

- Embedded `pi-coding-agent`, `pi-agent-core`, `pi-ai`, and `pi-tui`: 0.99.2 minimum.
- Official `codemode`, `tool-search`, and `mcp` factories, registered with the
  CLI's `builtin:<name>` identity and replacement policy. Existing adapters can
  replace them; `extensions: ["-builtin:mcp"]` etc. still disable them.
- `codemode` and `tool_search` in the composer's **Tools → Custom** picker. The
  existing Default, Full, and Read-only presets are unchanged; the new tools are
  opt-in. A persisted explicit selection overrides the global default selection.
- MCP configurations and credentials shared with the CLI:
  `~/.pi/agent/mcp.json` and trusted projects' `.pi/mcp.json`. No separate config
  format, credential store, or duplicate transport implementation.
- `/mcp` displays server status in Web mode. `/mcp reconnect <name>`,
  `/mcp login <name>`, and `/mcp logout <name>` use the SDK command/UI bridge.
  The CLI's interactive terminal manager is not a graphical Web settings panel.
- SDK tool exposure is preserved: registered hidden/indirect tools are not
  indiscriminately activated when changing a preset. Tools already declared by
  `tool_search` stay declared when changing a nonempty selection.
- `/reload` retains Pi 0.99.2's newly added `defaultTools`, rather than resetting
  the SDK's effective selection to a stale pre-reload snapshot.
- Bounded `nestedCalls` records appear under the parent tool call, with status,
  timing, arguments, and incomplete-record notices. They are **not** synthesized
  as standalone transcript messages. Tool-result usage is already included in
  Pi Web's session totals; nested usage must not be added again.
- Virtual model selections stay selected across history/branch reads:
  `model_change` identifies the router, assistant messages identify its physical
  dispatch. Existing assistant labels and usage retain the physical model.

## Enable Codemode without MCP

Select `codemode` in **Tools → Custom**, or configure Pi's defaults for sessions
without an explicit tool selection:

```json
{
  "defaultTools": ["+codemode"],
  "codemode": { "mode": "on", "inlineBudget": 3000 }
}
```

`mode: "only"` delegates callable tools through Codemode; `on` keeps their direct
model declarations. These are SDK settings, not a second Pi Web implementation.

## Add an MCP server

For example (this launches the configured command with the server user's permissions):

```sh
pi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /path/to/project
pi mcp list
```

Then `/reload` the Web session. Default MCP `codemode` exposure auto-enables
Codemode when the server connects; `deferred` enables `tool_search`; `direct`
declares server tools. With 0.99.2, non-direct servers connect in the background
and are discovered through `searchTools()`/`describeNamespace()`. Project MCP
configuration remains behind Pi Web's existing project-trust gate.

## Deliberate boundaries

Chat-only sessions still load no executable extensions and have no tools.
Subagents retain their profile tool allowlists/resource switches; this change
adds no MCP servers or Codemode capability to them. Read-only is a tool preset,
not an OS sandbox: adding Codemode cannot make inactive write/bash tools
callable, but installed extensions or configured MCP tools can have their own
side effects. Review configurations and use appropriate OS isolation.

A graphical MCP configuration/OAuth management panel, classifier/image-generation
UI, and a live virtual-route indicator are follow-up work, not part of this
baseline integration. Terminal theme changes do not replace Web CSS themes.

## Validation

`lib/pi-builtin-extensions.test.mjs` uses temporary configuration, a local stdio
MCP fixture, a deterministic fake model, and the real Codemode sandbox. It covers
inactive defaults, additions/reload, exclusions, installed replacements,
Chat-only loading, MCP exposure and project trust, nested-call recording, and
MCP subprocess cleanup without real credentials or paid API calls.

Desktop standalone builds explicitly trace QuickJS's `quickjs.wasm` for both
hoisted and SDK-nested dependencies. The desktop assembly validates those assets
against the source installation so a missing or truncated WASM fails the build,
not the first Codemode call.

After an embedded SDK/code update, rebuild/restart Pi Web before using the new
implementation; reloading a session alone cannot replace the server's SDK module.
