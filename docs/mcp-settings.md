# MCP and Codemode settings

## User interface

- **Settings → General → Automation → Codemode** edits the shared global
  `settings.json` fields `codemode.mode` (`on` / `only`) and
  `codemode.inlineBudget` (default 3000 estimated tokens, zero is valid).
  This is not an enable switch: choose `codemode` under **Tools → Custom**.
  Trusted project settings can override these global defaults.
- **Settings → MCP** manages global and explicitly trusted project `mcp.json`
  entries: add/edit/delete, enabled state, exposure, description, timeout,
  per-tool exposure, stdio command/args/cwd/env, or Streamable HTTP
  URL/headers/OAuth options. Global HTTP entries can reuse a Pi credential via
  `auth.provider`; this cannot be combined with OAuth options or an
  `Authorization` header. HTTP OAuth JSON also accepts
  `clientRegistration: "dcr" | "cimd"`; CIMD forbids `clientId` / `clientName`
  and requires any explicit callback to use `localhost` or `127.0.0.1`
  with the exact `/callback` path.
- Trusted project entries can be thin overrides of a same-name global server:
  omit `command`, `url` and `type`, and set only `enabled`, `exposure` or
  `toolExposure`. Select **Project override** when adding one, or edit an
  existing override. Transport/authentication remain inherited; unchanged
  controls stay omitted rather than silently enabling hidden tools.
- Saving does not connect, run a prompt, or automatically reload. Use **Reload
  session** explicitly. Other live sessions need their own reload. Reload from
  these controls uses `requireLiveSession: true`; an idle/disposed session is
  not silently recreated. Resume a normal conversation first.
- Live status is the existing session's native `/mcp` status, not an estimate
  based on `enabled`. Disabled/replaced builtins, Chat-only sessions and
  subagents do not expose the built-in management bridge. The status query has
  a two-second response bound; it does not start a session or MCP server.
- Reconnect and HTTP OAuth login/logout delegate directly to the official
  `/mcp` handler, not `session.prompt()`. These operations block concurrent
  prompt/reload/fork/tool changes and protect the idle lifetime.
- OAuth authorization links open in the user's browser. On a remote host, copy
  the complete failed loopback redirect URL into the input. Pi performs PKCE,
  code/token exchange and storage in the shared global `mcp-auth.json`.
  Authorization links allow only HTTPS or loopback HTTP, without URL credentials.
  Cancelling, closing the page or changing session cancels pending input.
- Stdio executables (`npx`, `uvx`, Python, etc.) must be available on the server's
  PATH. The desktop installer does not bundle arbitrary MCP server dependencies.

## Configuration and privacy

The file editor uses `getAgentDir()/mcp.json` and `<cwd>/.pi/mcp.json`; there is no
parallel configuration or credential store. MCP transports, environment/header
value resolution (including Pi-supported command references), provider tokens,
OAuth and subprocess cleanup remain SDK responsibilities. The web file editor
never evaluates values or opens `mcp-auth.json`.

GET only returns known configuration fields. Sensitive env/header values,
nonempty arguments, OAuth client secrets and credential/query/fragment URLs
are represented by `__PI_WEB_SAVED_VALUE__`. Keeping the marker preserves the
saved value; replacing it changes that value. A new entry cannot use markers.
Omitted patch fields remain unchanged, `null` removes an optional field,
`[]` / `{}` clear containers. Unknown fields are preserved on disk but are not
exposed as arbitrary credential-bearing API payloads. Successful saves refresh
the form with redacted data. Unchanged authentication fields are omitted from
form patches so hidden future fields survive ordinary saves. Enter JSON `null`
in the OAuth options box to explicitly remove all options, including hidden
ones; this does not delete SDK-owned login credentials (use Logout for that).

Raw file SHA-256 revisions reject stale writes with 409 instead of overwriting.
The RMW transaction uses `proper-lockfile` and private temporary-file + atomic
rename, retaining indentation and unrelated fields. Default `enabled: true`
and `exposure: "codemode"` are omitted for ordinary definitions, matching Pi's
editor. Thin overrides retain explicit defaults because they override global
values. Malformed JSON is
not overwritten. The lock serializes cooperating web writers; it is not a
claim that the SDK CLI's unlocked edits participate in that transaction.

Project paths must be existing authorized directories with allowed realpaths.
`.pi`, config-file and lock-file symlinks (including dangling links) are refused;
config files must be regular files, up to 10 MiB. Project path identity, file
kind and explicit trust are rechecked after awaiting the lock. This is not an
OS sandbox or a complete defense against a hostile process racing filesystem
operations under the same user account.

Only `ProjectTrustStore.get(cwd) === true` permits project MCP reads/writes.
A bare project is not implicitly trusted by this page. Its explicit two-step
trust action uses the existing trust API and closes idle runtimes for that cwd;
busy runtimes block it. Consent grants normal Pi project trust to extensions,
skills and MCP, including future resources — not a narrower MCP-only grant.
Full same-name project definitions replace global entries; thin overrides
merge only the three allowed fields and may inherit global `auth.provider`
without copying credentials into the project. Different names that
collapse to the same `mcp__` namespace (`foo-bar` / `foo_bar`) are conflicts,
not overrides. Name comparison remains case-sensitive.

## Integration constraints and tests

The SDK publicly exports MCP types and `createMcpExtension()`, but not its file
editing helpers. The thin web editor therefore validates/edits shared JSON
without importing private package subpaths. The runtime facade captures the
native command through public `ExtensionAPI`, binds only on `session_start`,
and unbinds on shutdown/reload. Resource-loader probes and excluded/replaced
factories cannot create a stale management binding.

Native status/operation errors are filtered to avoid returning transport stderr,
config fragments or credentials. OAuth input tokens are random, session-bound,
once-only, and expire after five minutes; cancellation cleans them up. The
status text whitelist may need adjustment after SDK upgrades.

Tests use temporary directories, deterministic UI hook drivers, a local stdio
server and loopback-only OAuth metadata/token endpoints. They cover real SDK
login/reconnect/logout and shared credential storage without paid model calls
or production credentials. These are not a browser/WebView or real-provider
OAuth certification. Next standalone must retain the already-required SDK
runtime files and QuickJS assets; no additional browser OAuth implementation
or installer dependency is introduced.
