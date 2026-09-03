# Pi Web Desktop (Windows)

Tauri 2 shell around the local pi-web server. The app spawns a bundled
Node.js sidecar running the Next.js standalone build, then loads it in a
WebView2 window. All UI, API, and agent-session code is shared with the web
version — this directory only contains the shell's loading page.

The shell adds the desktop-only behaviors on top: a system tray icon
(show/quit/left-click to restore) and the close-behavior setting
(Settings → General → Desktop, or the tray menu's "Minimize to tray on
close" check item). Closing the window minimizes to the tray by default so
agent sessions keep running; "Quit" from the tray menu always exits for
real. The setting is persisted in `<app_config>/desktop-settings.json` and
reaches the web settings UI through IPC commands granted to loopback
origins only (`src-tauri/capabilities/desktop-remote.json`).

See `docs/adr/0004-windows-desktop-tauri.md` for the architecture rationale.

## Layout

```
desktop/loading/          loading page shown while the sidecar boots
src-tauri/                Tauri project (Rust shell)
  src/main.rs             sidecar lifecycle: spawn, readiness poll, kill-on-exit
  tauri.conf.json         bundle config; version stays in sync with package.json
  resources/              `bundle.resources` entries are staged directly as:
  server/                 Next.js standalone output (server.js + node_modules)
  node/                   pinned Windows Node.js runtime (node.exe, npm, npx)
scripts/build-desktop-server.mjs   builds + collects the payload above
.github/workflows/desktop-windows.yml   Windows CI producing the NSIS installer
```

## Development

On a Windows machine (or any desktop OS) with Node 22+ and a stable Rust
toolchain:

```bash
# terminal 1: the regular Next.js dev server (http://127.0.0.1:30141)
npm run dev

# terminal 2: the desktop shell attached to it (no sidecar is spawned in dev)
npm run desktop:dev
```

`src-tauri` has no package.json of its own, so npm scripts always resolve to
the repository root. If port 30141 is already serving a healthy dev server,
reuse it — a second `next dev` fights over `.next/dev/lock`.

Web app changes hot-reload through the dev server as usual. Rust-side changes
restart the shell. `cargo check` works for quick validation; on Linux the
system needs the webkit2gtk-4.1 development packages.

## Building the installer

```bash
npm run desktop:build
```

`tauri build` first runs `npm run desktop:server` (via `beforeBuildCommand`),
which:

1. runs `next build` with `PI_WEB_STANDALONE_BUILD=1` so `next.config.ts`
   enables `output: "standalone"` (npm release builds are unaffected),
2. copies `.next/standalone` + `.next/static` + `public/` into
   `src-tauri/server/`,
3. downloads the pinned Windows Node.js zip into `src-tauri/node/`,
   verifying it against the official `SHASUMS256.txt`. The full distribution
   is bundled so in-app skill installs (`npx skills add`) and plugin
   management work without a system Node.js install.

Set `PI_DESKTOP_SKIP_NEXT_BUILD=1` to reuse an existing `.next/` during
iterations. Bump `DESKTOP_NODE_VERSION` in the script when the engines floor
moves.

The output is `src-tauri/target/release/bundle/nsis/Pi Web Desktop_<version>_x64-setup.exe`
(per-user install, no admin required, WebView2 bootstrapper embedded).

Naming note: `productName` is "Pi Web Desktop" (installer, Start Menu entry,
install dir), while the `identifier` stays `com.github.ghost0211.pi-web` so a
newer installer upgrades an older install in place instead of leaving a
duplicate entry, and the app-data/log location stays stable.

## Release

CI (`.github/workflows/desktop-windows.yml`) builds the installer on
`windows-latest`:

Every installer update must increment the patch version; never move or reuse a
tag once its release has been published. Keep `package.json`, the root
`package-lock.json`, and `src-tauri/Cargo.toml` / `Cargo.lock` in sync, commit
the bump, then tag it:

```bash
# Example: 0.9.0 -> 0.9.1
git tag desktop-v0.9.1 && git push origin desktop-v0.9.1
```

The workflow rejects a tag that does not match all four package versions. Or trigger
the workflow manually and download the artifact (without creating a release).
Tag pushes create a GitHub release with the installer attached.

CI layout: an `ubuntu-latest` job runs `npm test` / `tsc` / `lint` first — the
web test suite is Linux-validated and several pre-existing tests encode POSIX
assumptions (CRLF source markers, `PATH` vs `Path` casing). The Windows job then
focuses on the installer build. Fixing those tests to be Windows-native is a
separate work item.

## Troubleshooting

- **The loading page never advances** — check the sidecar log:
  `%LOCALAPPDATA%\com.github.ghost0211.pi-web\logs\pi-web-server.log`.
- **The app starts but shows a connection error** — the sidecar payload was
  not bundled where expected. `tauri.conf.json` deliberately uses the *list*
  form of `bundle.resources` (`["server/", "node/"]`); the map form regressed
  in Tauri CLI 2.11 (tauri-apps/tauri#15342). If you upgrade the CLI and
  resources go missing, verify the install directory contains `server/` and
  `node/` next to the exe.
- **OAuth reports `Cannot find module .../pi-ai/dist/auth/oauth/*.js`** — the
  standalone trace omitted a variable dynamic import. `next.config.ts` must
  include both top-level and `pi-coding-agent`-nested `pi-ai/dist` trees;
  `build-desktop-server.mjs` validates every installed OAuth runtime before an
  installer can be produced.
- **SmartScreen warning on first install** — expected until the installer is
  code-signed.
- **Firewall prompt** — none should appear; the sidecar binds `127.0.0.1`
  only.

## Not included yet

- `tauri-plugin-updater` auto-updates (needs signing keys + release wiring)
- code signing certificate
- native notifications (the in-app sound and web-push still work)
- localized tray menu labels (the web settings UI is fully localized; the
  tray menu is English-only for now)
