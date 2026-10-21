# Pi Web

[简体中文](./README.md) · [繁體中文](./README.zh-TW.md) · English

A full-featured web UI for the [Pi coding agent](https://github.com/earendil-works/pi), plus a **Windows desktop client (Pi Desktop)**. The workspace layout is inspired by Kimi Code and is built for long conversations, multiple projects, and traceable operations.

Pi Web **shares configuration and session storage with the Pi CLI** (`~/.pi/agent`): a session created in the browser or the desktop app opens directly in the CLI, and vice versa.

This repository is a fork of [`agegr/pi-web`](https://github.com/agegr/pi-web). It keeps the upstream web experience and adds a Windows desktop shell, remote directory mounts, built-in subagents, unified session management, and more.

## Two ways to run it

| Form | Description |
| --- | --- |
| **Pi Desktop (Windows)** | Tauri + WebView2 shell with a bundled Node runtime and the full server — **no Node.js installation required**. Tray icon, minimize-on-close, automatic updates. |
| **Browser** | `npm run dev` for local development, or deploy to a LAN/server and open it in a browser. |

## Features

### Sessions and workspaces

- Sidebar tree grouped by **project / Git worktree**, with collapse, search, pin, archive, and project removal.
- **Two kinds of branching**: fork any historical message into an independent session file, or switch/add branches inside one session (branch navigator).
- Rename sessions, export a session to standalone HTML, and review the turn's changed files and declared deliverables in a result card.
- **Unified session management**: pin, archive, permanent delete (with confirmation), and cross-window sync. Archived sessions are read-only but keep live status and completion notices.
- Long-session work: streaming content is subscribed separately, history is paged on demand, plus a turn minimap/scrollbar and a whole-branch turn index.

### Conversation and reasoning

- SSE streaming with automatic reconnect; background tabs reconcile by polling so terminal events are not lost.
- **Steering** while a run is active: the message joins the current turn instead of interrupting it.
- Thinking levels are filtered by model capability, and the **primary and quota-backup models keep independent levels**.
- Context-usage ring, manual compaction, and automatic compaction status.
- Per-turn duration and token accounting (historical sessions replay recorded values; missing data is labelled as an estimate).

### Models and quota

- Provider sign-in (OAuth / device code / manual code) and API key management. Keys live only in Pi's `auth.json`; status endpoints never return them in plain text.
- Model configuration center: edit `models.json`, models.dev pricing presets, upstream model discovery, and connectivity tests.
- **Model scope** (`enabledModels`) with the same semantics as Pi CLI's `--models`, including globs and a `:thinkingLevel` suffix.
- **Quota failover**: switches to the backup model only for quota-class errors, each model keeping its own thinking level; the primary is restored when the run ends (success, failure, or stop) and pending switches are repaired when a session is reopened.

### Automation and tools

- **Auto Advance**: server-owned and in-memory (it does not survive a restart); 1–99 rounds driven by a tool-less judge that must return strict `continue / complete / needs_user` JSON. It fails closed on blocking UI, manual input, archiving, or configuration changes.
- **Tool presets**: full / default / read-only / chat-only. Chat-only loads no extensions, skills, prompt templates, or themes, keeping only the context files Pi discovered.
- **Built-in subagents**: `Agent`, `get_subagent_result`, `steer_subagent`. Background results are **pulled, never pushed**, which avoids an extra model turn.
- **MCP**: manage stdio and HTTP/SSE servers, persisted to Pi's `mcp.json`, with OAuth support.
- **Plugins and skills**: global/project package management (install, update, enable/disable), per-skill model-invocation toggles, `npx skills add` installation, and skills.sh search.
- **Declared deliverables**: `present_files` performs a read-only check inside the allowed roots — it never reads contents, executes HTML, or opens a window.
- **Structured questionnaire**: `ask_user_question` asks 1–4 multiple-choice questions and returns the answers as a tool result in the same run. Dismissing it counts as a decline, never as a guessed default.

### Files and remote work

- File explorer, syntax highlighting, Markdown (KaTeX math and Mermaid diagrams), image/attachment preview and upload, and edit anchors.
- **Git diff**: red/green diffs for tracked changes and for new files inside a repository; when there is no diff the viewer states why (identical to HEAD / ignored / outside the repo / binary / too large).
- File access is restricted to allowed roots (session cwd, project roots, explicitly added directories) and validated against real paths to prevent escapes.
- **Remote projects**: SSH host management (key or password), a remote directory picker, and SSHFS/UNC mounts that expose a remote directory as a local working directory.

### Interface and platform

- Light / dark / system themes, four font sizes, and Simplified Chinese / Traditional Chinese / English (the tray follows the UI language).
- PWA support and a mobile layout (mobile toolbar, safe-area handling).
- **Usage dashboard**: aggregates by project, provider, and model, with a time range (timezone-aware) and historical cost read verbatim rather than re-priced.
- **Pi Desktop**: tray (show, new session, recent sessions, quit), minimize-to-tray on close, open/reveal files with system apps, and signed automatic updates.

## Getting started

### Windows desktop app (recommended)

Download the latest `Pi-Web-Desktop_*_x64-setup.exe` from [GitHub Releases](https://github.com/ghost0211/pi-web/releases/latest). No Node.js installation is needed.

- The installer identity stays **Pi Web Desktop** for upgrade compatibility; the desktop shortcut is named **pi**.
- Updates come from `desktop-latest.json` on GitHub Releases; installers are minisign-signed.
- Data (sessions, settings, credentials) still lives in `~/.pi/agent`, shared with the CLI and other clients.

### From source

Requires **Node.js ≥ 22.19.0**:

```bash
git clone https://github.com/ghost0211/pi-web.git
cd pi-web
npm install
npm run dev          # http://127.0.0.1:30141
```

Production mode (after a local build):

```bash
npm run build
npm start            # or npm run start:lan to listen on 0.0.0.0
```

> Note: this fork is not published to npm. `npx @agegr/pi-web` installs the upstream package, not this repository.

### Desktop development

```bash
npm run dev            # terminal 1: web dev server (30141)
npm run desktop:dev    # terminal 2: Tauri shell, attaches to 30141, spawns no sidecar
```

Building the installer requires assembling the server and the Node runtime first:

```bash
npm run desktop:server   # produces src-tauri/server and src-tauri/node
npm run desktop:build    # NSIS installer (with signing and a server boot smoke test)
```

See [`desktop/README.md`](./desktop/README.md) and [`docs/adr/0004-windows-desktop-tauri.md`](./docs/adr/0004-windows-desktop-tauri.md).

## Configuration

Command-line flags take precedence over environment variables.

| Flag / environment variable | Description | Default |
| --- | --- | --- |
| `-p, --port <port>` / `PORT` | Listening port | `30141` |
| `-H, --hostname <host>` / `PI_WEB_HOSTNAME` | Bind address | `127.0.0.1` |
| `--no-open` / `PI_WEB_NO_OPEN=1` | Do not open a browser | off |
| `--unsafe-no-auth` / `PI_WEB_UNSAFE_NO_AUTH=1` | Explicitly allow unauthenticated non-loopback access | off |
| `PI_WEB_PASSWORD` | Enable HTTP Basic Auth (username is always `pi`) | disabled |
| `PI_WEB_ALLOWED_HOSTS` | Extra allowed proxy/custom hostnames, comma-separated | unset |
| `PI_WEB_ALLOWED_DEV_ORIGINS` | Extra origins allowed by the dev server | unset |
| `PI_CODING_AGENT_DIR` | Pi agent configuration directory | `~/.pi/agent` |
| `PI_WEB_SESSION_IDLE_TIMEOUT_MS` | Idle session teardown in ms (`0` disables) | `600000` (10 min) |
| `PI_WEB_DESKTOP` / `PI_WEB_SKIP_VERSION_CHECK` | Set by the desktop shell to mark the desktop environment and skip the npm version check | — |
| `HTTP_PROXY` / `HTTPS_PROXY` | Proxy used by model requests and web lookups | unset |

### LAN / server deployment

Binding to a non-loopback address requires authentication by default:

```bash
PI_WEB_PASSWORD='a-strong-password' pi-web -H 0.0.0.0 -p 30141 --no-open
```

Basic Auth over plain HTTP **does not encrypt** the password. Put Pi Web behind an HTTPS reverse proxy or use a trusted VPN. `--unsafe-no-auth` is only for isolated trusted networks.

### Data locations

```
~/.pi/agent/
  settings.json              default model, thinking level, compaction, enabledModels, …
  models.json                custom providers and models
  auth.json                  OAuth / API key credentials
  ssh-hosts.json             remote hosts (passwords stored locally)
  agents/settings.json       built-in subagent switch and agent profiles
  pi-web/session-management.json  Pi Web metadata such as pins and archives
  sessions/<encoded cwd>/*.jsonl  session files
```

## Development and testing

```bash
npm run dev                                  # dev server
node node_modules/typescript/bin/tsc --noEmit   # typecheck
npm run lint                                 # ESLint
npm test                                     # node --test (unit + integration)
node --test desktop-branding.test.mjs desktop-installer.test.mjs   # desktop shell and installer
```

Conventions and pitfalls (session lifecycle, SSE reconciliation, branching semantics, route export rules, desktop bundle completeness, and more) are documented in [`AGENTS.md`](./AGENTS.md).

## Repository layout

```text
app/          Next.js App Router pages and API routes
components/   UI components (sidebar, chat, settings, file viewer, …)
hooks/        React hooks for state, streaming, theme, shortcuts
lib/          Core logic: SDK wrappers, session reading, models/quota, subagents, security boundaries
bin/          CLI entry point and launch options
desktop/      Loading page of the desktop shell
src-tauri/    Tauri 2 shell (tray, updater, installer hooks)
docs/         Architecture notes, ADRs, SDK adaptation records
scripts/      Desktop packaging, bundle validation, server boot smoke test
```

## Documentation

- [`docs/adr/`](./docs/adr): architecture decision records (chat-only tool selection, built-in subagent toggle, desktop shell, unified session management)
- [`docs/auto-advance.md`](./docs/auto-advance.md): Auto Advance boundaries and fail-closed conditions
- [`docs/model-fallback-quota-errors.md`](./docs/model-fallback-quota-errors.md): quota failover
- [`docs/mobile-web-layout.md`](./docs/mobile-web-layout.md): mobile layout
- [`docs/run-timing.md`](./docs/run-timing.md): run timing records
- [`docs/i18n.md`](./docs/i18n.md): localization and language plugins
- [`docs/pi-sdk-*.md`](./docs): Pi SDK upgrade adaptations and verification notes
- [`docs/release.md`](./docs/release.md): release process

## Relationship to upstream

This repository is a fork of `agegr/pi-web` maintained by **selective ports rather than wholesale merges**: the desktop shell, remote mounts, built-in subagents, unified session management, quota failover, Auto Advance, and the usage dashboard are specific to this branch, while upstream improvements are ported when they fit.

## License

[MIT](./LICENSE)
