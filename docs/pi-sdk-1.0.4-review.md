# Pi SDK 1.0.4 compatibility review and CLI update fix

This review started from Pi Web 0.9.39 / embedded SDK 1.0.3. SDK 1.0.4 was first installed only in an isolated checkout for investigation. Pi Web 0.9.40 promotes the embedded dependency declarations and lockfile after verification; source changes and service deployment remain separate from the global CLI installation.

Official release: <https://github.com/earendil-works/pi/releases/tag/v1.0.4>.

## SDK changes

- Codemode `tools.read()` returns an image block for image files, which `image()` can display and save. The existing standard-image rendering and exact-session-file-reference authorization cover this; do not grant access to an entire temporary directory.
- The QuickJS sandbox freezes builtins before running scripts, preventing prototype changes from corrupting serialization or leaving calls unsettled.
- MCP dynamic registration identifies loopback clients as native clients, improving OpenID Connect compatibility. Connecting MCP transports are also cleaned up on shutdown. Web continues to use the official factory, command and lifecycle bridge; no separate authentication implementation is needed.
- Hidden tool declarations no longer leave their rules or named file-reader hints in the main system prompt. Codemode receives the appropriate prompt guidelines through the public loadout API.
- CLI tool patterns and `--no-mcp` do not require matching GUI controls. Normal Web sessions do not pass a nonempty startup tool allowlist; they use `setActiveToolsByName` with the existing exact selection and exposure logic. Chat-only still uses an empty tool list with resources disabled. Subagents retain their existing resource and reserved-tool restrictions.
- Bedrock stalled-stream retry and terminal syntax highlighting are upstream fixes, not separate Web implementations.

Existing 1,345 tests and type checking passed against the isolated SDK 1.0.4 installation. Three additional isolated, actual QuickJS probes verified image read/display/private saved bytes, prototype freezing with a settled result, and exact tool selection excluding read/bash. The image probe generates a valid PNG through the SDK's actual BMP conversion instead of assuming an arbitrary base64 fixture decodes correctly.

The 0.9.40 rollout uses updated dependency declarations/lockfile and fresh regular/standalone asset and release checks; see [the release notes](releases/v0.9.40.md) for final verification evidence. This compatibility investigation is not native Windows operation, real-account sign-in, or paid-provider certification.

## Why Settings → Update CLI failed with EEXIST

The CLI updater previously invoked the `npm` on the Web service's PATH using its default global prefix. That prefix need not own the active `pi` command: a hand-created `~/.local/bin/pi` alias may lead to the npm installation under another Node prefix. Npm correctly refuses to overwrite that unrelated alias. `node-domexception` deprecation is only a warning; `EEXIST` is the actual failure.

The source fix locates the first Pi launcher on PATH, follows its symlinks, and validates the public package manifest, `bin.pi`, real entrypoint and platform's npm global layout. It supplies that installation's prefix explicitly to `npm install -g`, retaining the outer alias. It never uses `--force`, removes launchers, migrates provider credentials, or runs `pi update`/login/logout.

Unrecognized wrappers, source-linked packages, pnpm/npx layouts, invalid metadata and ambiguous launchers fail closed with advice to use the original installation method. Standard Windows npm `.cmd` shims are checked against the actual entrypoint; unsupported shell characters are rejected. Windows shim tests are filesystem simulations, not native Windows execution certification. Existing local SDK update command behavior is unchanged.

An npm zero exit status cannot report a successful CLI update if the active CLI version cannot be verified afterward. A missing CLI can still use npm's default fresh global installation; its bin directory must be on PATH to verify success.

Regression tests use temporary HOME/PATH, synthetic credentials, package manifests, launchers and fake npm executables. The original source reproduces EEXIST; corrected source updates the same synthetic CLI and leaves its alias and authentication bytes intact. No real CLI installation or production authentication files are modified by these tests.
