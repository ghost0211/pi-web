# Windows desktop client via Tauri sidecar

The Windows desktop app is a thin Tauri 2 shell around the existing pi-web
stack. The Next.js server keeps hosting `AgentSession` in-process — exactly as
it does for the web version — and the shell's only job is to spawn that server
as a sidecar and point a WebView2 window at it. No frontend or API code has a
desktop-specific branch; the loopback request-security rules apply unchanged.

## Why not Electron

Electron bundles its own Chromium (~200 MB installers) while every supported
Windows 10/11 machine already ships the Chromium-based WebView2 runtime that
Tauri uses. The pi-web frontend needs no Node integration in the renderer, so
Electron's main selling point buys nothing here.

## Why a bundled Node.js runtime instead of a rewrite

The server cannot be replaced by Rust: `lib/rpc-manager.ts` creates
`AgentSession` objects from the pi SDK in-process, and the whole API surface is
Next.js route handlers. The desktop build therefore ships:

- `src-tauri/server/` — the Next.js standalone build (`PI_WEB_STANDALONE_BUILD=1`
  gates `output: "standalone"` in `next.config.ts` so npm releases stay
  unchanged), with static assets and `public/` copied in by
  `scripts/build-desktop-server.mjs`.
- `src-tauri/node/` — a pinned Windows Node.js distribution (zip, verified
  against `SHASUMS256.txt`). The full distribution (not bare `node.exe`) is
  bundled so server features that shell out to npm/npx — skill install,
  plugin management — keep working on machines without Node. The shell
  prepends this directory to the sidecar's PATH.

Single-executable approaches (Node SEA, pkg) were rejected: the pi SDK is a
large dependency tree with dynamic requires, and standalone output is the
supported, traced packaging format.

## Runtime behavior

`src-tauri/src/main.rs` reserves an ephemeral loopback port on the first launch
and stores it in `desktop-settings.json` only after the sidecar passes a
nonce-authenticated readiness check. Later launches reuse that port when it is
available. A temporary collision uses an unpersisted fallback for that launch,
then retries the canonical port next time. The stable port keeps the WebView
origin stable so browser-local preferences (including hidden projects/sessions)
survive restarts, while still allowing the desktop app to coexist with the fixed
30141 dev server. The shell spawns `node.exe server.js` with
`HOSTNAME=127.0.0.1`, shows a bundled loading page, polls
`/api/desktop-health` for the per-launch nonce, then navigates the window to the
server URL. A timeout leaves the trusted loading page visible rather than
navigating to an unverified process that won a loopback bind race. Binding only to loopback avoids the Windows firewall prompt and keeps the
existing threat model ("local UI for a local agent") intact.

The shell sets `PI_WEB_DESKTOP=1` (marker for future desktop-only server
behavior) and `PI_WEB_SKIP_VERSION_CHECK=1`, because version updates ship
through the installer, not the npm registry self-check in
`app/api/app-update`.

Closing the app kills the sidecar's entire process tree (`taskkill /T /F`):
agent sessions and any shells their tools spawned live in that tree, mirroring
what Ctrl+C does to `pi-web` on the CLI.

## Build and release

Windows installers can only be produced natively (WebView2 + NSIS), so
`.github/workflows/desktop-windows.yml` builds on `windows-latest` — manually
or from `desktop-v*` tags, which also attach the NSIS setup exe to a GitHub
release. Code signing is intentionally left out of the MVP (SmartScreen will
warn); auto-update via `tauri-plugin-updater` is the documented next step.
