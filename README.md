# Pi Web

[中文文档](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

Modern, full-featured Web UI for the [Pi coding agent](https://github.com/earendil-works/pi), redesigned with a clean, ergonomic workspace experience inspired by Kimi Code Web.

Pi Web shares configuration and session storage directly with the Pi CLI, allowing you to seamlessly manage project workspaces, browse and branch conversations, monitor background tasks, configure providers and models, and edit settings in an intuitive browser interface.

![Pi Web](https://raw.githubusercontent.com/ghost0211/pi-web/main/docs/screenshot2.png)

## Highlights & Features

- **Kimi Code-Style Workspace Layout**:
  - **Collapsible Project & Session Tree**: Grouped by project roots and Git worktrees, featuring intuitive folder expand/collapse icons and search filtering.
  - **Dual Branching**: Fork independent sessions from any historical message or branch in-place within the active session.
  - **Comprehensive Settings Modal**: Left navigation tabs with right-side subtabs for General (Appearance, Automation, Environment), Models, Skills, and Plugins.
  - **Customizable Appearance**: Light / Dark / System themes, adjustable font sizing (Small, Medium, Large, Extra Large), and multilingual support (EN, zh-CN, zh-TW).
- **Session & Task Management**:
  - **Real-time SSE Streaming**: Smooth streaming responses with automatic reconnection and background polling.
  - **Background Task Dock**: Track and inspect asynchronous tasks, tools, and subagents in a dedicated dock.
  - **Session Actions**: Rename, delete with confirmation, export to standalone HTML, and auto-generate session titles.
- **Model & Resource Management**:
  - **Universal Model Configuration**: Manage OAuth logins and API keys (OpenAI, Anthropic, Gemini, DeepSeek, local models, etc.) with real-time testing and pricing presets.
  - **Skills & Plugins Hub**: Manage `.agents/skills`, package manager plugins, and standalone local extensions (`~/.pi/agent/extensions/*.ts`).
- **File Explorer & Diff Viewer**:
  - Built-in file explorer, code syntax highlighting, Markdown math (KaTeX) & Mermaid diagrams, and real-time Git diff inspection.
- **PWA & Mobile Support**:
  - Progressive Web App support with optimized network caching, responsive layouts, and mobile toolbar.

## Quick Start

### Prerequisites
- Node.js `22.19.0` or newer (check with `node -v`).

### Running via npx / npm

```bash
# Run directly with npx
npx @agegr/pi-web@latest

# Or install globally
npm install -g @agegr/pi-web@latest
pi-web
```

The server listens on `http://127.0.0.1:30141` by default and automatically opens your browser.

### Local Development

```bash
git clone https://github.com/ghost0211/pi-web.git
cd pi-web
npm install
npm run dev
```

Visit `http://localhost:30141` in your browser.

## Configuration & Options

Command-line flags override environment variables:

| Option / Environment Variable | Description | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p`, or `PORT` | Server listening port | `30141` |
| `--hostname <host>`, `-H`, or `PI_WEB_HOSTNAME` | Hostname to bind | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Disable automatic browser opening | `false` |
| `PI_WEB_PASSWORD` | Enable HTTP Basic Auth (username: `pi`) | Disabled |
| `PI_WEB_ALLOWED_HOSTS` | Comma-separated list of allowed hostnames/proxies | Unset |
| `PI_CODING_AGENT_DIR` | Custom Pi agent configuration directory | `~/.pi/agent` |

### Remote LAN / Server Deployment

When binding to `0.0.0.0` or exposing on a local network, enable password authentication:

```bash
PI_WEB_PASSWORD='your-secure-password' pi-web -H 0.0.0.0 -p 30141 --no-open
```

### HTTP / HTTPS Proxy

Model requests and web lookups honor standard proxy environment variables:

```bash
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 pi-web
```

## Testing & Quality Assurance

```bash
# Run unit and integration tests
npm test

# Run TypeScript type check
node_modules/.bin/tsc --noEmit

# Run ESLint check
npm run lint
```

## Repository Structure

```text
app/             Next.js App Router pages, layouts, styles, and API routes
components/      React components (SettingsPanel, ChatWindow, SessionSidebar, etc.)
hooks/           React hooks for state, streaming, theme, font size, and shortcuts
lib/             Core business logic, SDK wrappers, file security, and i18n
public/          Static icons, PWA manifest, and Service Worker
bin/             CLI executable and bootstrap options
docs/            Detailed architecture docs, guides, and ADRs
```

## License

[MIT](./LICENSE)
