# Pi Web Desktop (Windows)

Tauri 2 shell around the local pi-web server. The app spawns a bundled
Node.js sidecar running the Next.js standalone build, then loads it in a
WebView2 window. All UI, API, and agent-session code is shared with the web
version — this directory only contains the shell's loading page.

The shell adds the desktop-only behaviors on top: a system tray icon
(show/quit/left-click to restore), the close-behavior setting
(Settings → General → Desktop, or the tray menu's "Minimize to tray on
close" check item), and the file open/reveal actions. Closing the window
minimizes to the tray by default so agent sessions keep running; "Quit" from
the tray menu always exits for real. The setting is persisted in
`<app_config>/desktop-settings.json` and reaches the web settings UI through
IPC commands granted to loopback origins only
(`src-tauri/capabilities/desktop-remote.json`).

Because the desktop client browses a project on the local machine, the file
viewer header opens the file with the system default application instead of
downloading a copy: the caret menu offers the OS application chooser, "show in
file manager", and "copy full path". The browser build keeps the download link
(the server may run elsewhere). Those actions go through the
`open_local_path` / `open_local_path_with` / `reveal_local_path` commands, which
reject relative and missing paths before touching the shell.

## Localized tray and recent sessions

The tray follows the UI language (English, Simplified Chinese, Traditional
Chinese, or translated labels supplied by a locale plugin). It provides Show,
New session, the three most recently modified normal conversations, the
minimize-on-close checkbox, and Quit. Archived and subagent conversations are
excluded; project removal affects only the sidebar, not this recent list.

`sync_tray_menu({ menu })` accepts bounded translated labels and at most three
opaque session IDs/titles. Only the language and labels are persisted in
`desktop-settings.json` for startup before the UI hydrates; recent conversation
IDs/titles are kept in memory. Settings writes are serialized, atomic and
preserve unknown fields; corrupt settings fail closed. Native IDs encode actual
session IDs, not mutable slot numbers. Windows ampersands are escaped literally.

Explicit New/Recent clicks reveal the window, queue a pending action and emit
`pi-web:tray-action` as a wake signal. `take_tray_action` consumes that action;
the frontend drains it at startup and on wakes/focus, including clicks made
before hydration. Focus or notifications alone never create a navigation target.
Actions wait while legacy migration, confirmed session operations or project
trust dialogs block navigation. Recent selection refreshes lifecycle metadata
before opening, and never implicitly restores an archive. New session opens an
empty composer in the current project; it does not submit a prompt or abort
existing work. Ordinary browsers and older shells safely no-op on the bridge.

The production sidecar receives `PI_WEB_DESKTOP_INSTALL_DIR` from the native
executable's parent directory. About shows this installation root, not the
`server/` runtime cwd; copied diagnostics retain both distinct values. Web mode
(or an absent/invalid marker) labels the cwd as the runtime working directory.

## Native notifications

Session-complete and extension-attention events use native Windows toasts via
`tauri-plugin-notification` instead of the Web Notification API. The shell
exposes one command, granted to loopback origins only
(`src-tauri/capabilities/desktop-remote.json`):

- `send_desktop_notification(title, body, sessionId?, tag?)` — shows a toast.
  Title/body are whitespace-collapsed and truncated (120/400 chars) and
  `sessionId`/`tag` must be bounded opaque ids (`[A-Za-z0-9._:-]{1,128}`), so
  this channel can never pass a URL, path, or shell argument. A toast sharing a
  `tag` within 1.5 s is suppressed, which absorbs re-renders and retried events.

The JS bridge is `showDesktopNotification` in
`lib/desktop.ts`; it no-ops outside the desktop shell.

### Wiring plan for the main thread (AppShell)

`components/AppShell.tsx` is intentionally not modified by the notification
change, so it still needs this wiring:

1. `deliverSessionNotification`: keep the attention/visibility guard, then
   prefer the native toast inside the desktop shell and fall back to the
   existing browser path otherwise. The same `tag` should be passed to both so
   either path replaces the previous notification for that session.

   ```ts
   const sessionUrl = ...; // unchanged
   if (isDesktopApp()) {
     void showDesktopNotification({
       title,
       body,
       sessionId: targetSession?.id,
       tag,
     });
     return;
   }
   void showBrowserNotification({ title, body, sessionUrl, tag, onClick: ... });
   ```

2. Drop the Web Push call on the desktop path. `setupPushSubscription()` now
   returns `false` inside the shell, and `teardownDesktopPushSubscription()`
   removes a subscription created by an older install so the server stops
   pushing a second copy of the same event (it prunes the endpoint after the
   next 404/410). Call it once from the existing mount effect in `AppShell`,
   next to `setupPushSubscription(locale)`.

3. Deep-linking a toast click: **not reliably possible on Windows.**
   `tauri-plugin-notification`'s desktop backend forwards only
   title/body/icon/sound to `notify-rust`, which has no toast-activation
   callback outside XDG; clicking an unpackaged app's toast without a registered
   COM activator does nothing. An earlier iteration consumed the last toast's
   session id on every window-focus event and opened it — but any unrelated
   focus (alt-tab, tray restore) triggered the jump and cleared the session's
   unread marker, so that bridge was removed again. If `sessionId` deep-linking
   is required, that needs a WinRT toast backend plus COM activator registration
   — a larger change than this one. Raising the window itself already works
   from the tray icon and from a second launch.

See `docs/adr/0004-windows-desktop-tauri.md` for the architecture rationale.

## Layout

```
desktop/loading/          loading page (kept hidden unless startup fails)
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

## Phone access through Tailscale

**The installed desktop app already starts the Web server** on a loopback-only,
per-installation port; it does not need a second `npm run dev` process. Find the
live URL under Settings → General → Desktop, or the persisted `serverPort` in
`%APPDATA%\com.github.ghost0211.pi-web\desktop-settings.json`. A temporary
port conflict can make the live port differ from the saved one. Development
(`npm run desktop:dev`) is different: start `npm run dev` separately.

For access from a phone in the *same tailnet*, install Tailscale on both devices.
The desktop app deliberately does **not** expose the unauthenticated agent API
on LAN or automatically publish it to other tailnet users. On the Windows host,
opt in once (replace `3029` with the live port displayed in settings):

```powershell
tailscale serve --bg 3029
# tailscale serve status                 # shows your tailnet-only HTTPS URL
```

The command persists across desktop launches; if a port conflict forces a
fallback port, reconfigure Serve for that launch. The URL uses a MagicDNS
hostname like `machine.tailnet.ts.net`. If the site responds with **403
Untrusted request**, add that exact hostname to `PI_WEB_ALLOWED_HOSTS` in the
Windows user environment and fully quit/restart Pi Web Desktop (not just close
the window to the tray). For example, *before starting the app* from a terminal:

```powershell
$env:PI_WEB_ALLOWED_HOSTS = "machine.tailnet.ts.net"
# Start the desktop executable from this terminal, or persist the variable
# with setx PI_WEB_ALLOWED_HOSTS "machine.tailnet.ts.net" and restart Desktop.
```

Restrict who can reach the host with Tailscale ACLs; if your tailnet has other
users, consider `PI_WEB_PASSWORD` (HTTP Basic Auth, username `pi`) before
starting Desktop. **Never enable Tailscale Funnel** for an unauthenticated Pi
Web server: the agent can run shell commands and read files. The HTTPS Serve
URL is also needed for browser service workers and mobile push notifications.

Once the server accepts a prompt, the agent runs in Desktop's Node sidecar,
not on the phone. Locking the phone or switching apps can disconnect its SSE
stream; returning to the page reconnects and reloads missed messages. Keep
Desktop running (tray is fine), the Windows machine awake, and the network
available. Quitting Desktop or putting Windows to sleep suspends/stops server
work; an extension waiting for user confirmation can also pause the agent.

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

Naming note: the runtime titlebar, sidebar brand, About panel, and tray use
**Pi Desktop**. The installer `productName` remains "Pi Web Desktop" (installer,
Start Menu entry, install dir), while the `identifier` stays
`com.github.ghost0211.pi-web` so a newer installer upgrades an older install in
place instead of leaving a duplicate entry, and the app-data/log location stays
stable.

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

### Signed desktop updates

Desktop checks for a newer desktop release when it opens and shows an update
notice. Settings → About also checks when opened and offers a manual retry.
Clicking **Download and install update** downloads the signed NSIS installer
and applies it through Tauri's updater; Windows exits Desktop to run the
installer. This interrupts running agent sessions. The installer replaces the
generated `server/` and `node/` payload directories rather than overlaying them:
NSIS `/UPDATE` skips uninstalling, so files removed or re-hoisted in a newer
build would otherwise survive and shadow the new dependencies. After checking
the running app, preinstall renames old payloads to `server.previous` and
`node.previous`; if staging the second directory fails, it restores the first
before aborting. Postinstall removes these backups only after copying the new
payloads. A locked backup is retained outside the live runtime paths; existing
recovery copies are never overwritten. This applies to fresh installs,
reinstalls and updates, and never removes the installation root, `~/.pi/` or
the Desktop app-data directories. Regular browser and phone
pages cannot invoke the native updater, even when they access the same server.
The existing 0.9.20 and older installers do not contain the updater and must be
upgraded manually **once** to an updater-enabled release.

CI requires the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY` containing
the Tauri signer private key. Generate one with `npx tauri signer generate
--ci -w <path-outside-repo>` (or use the securely stored key for this app),
back it up securely, and add its private contents to that secret. Never commit
it or expose it to the Next.js server. The corresponding **public** key is in
`src-tauri/tauri.conf.json`; losing the private key prevents signed updates
for existing installs. Tauri update signatures are separate from optional
Windows Authenticode signing (unsigned NSIS installers may still trigger
SmartScreen warnings). Missing CI signing credentials must fail the release,
not silently publish an installable but non-updatable bundle.

The tag workflow signs the NSIS `.exe`, publishes its `.exe.sig`, and creates
`desktop-latest.json` with the exact version, installer URL and signature.
The updater reads the manifest via
`https://github.com/ghost0211/pi-web/releases/latest/download/desktop-latest.json`.
Keep the GitHub **latest** non-prerelease release on this repo a desktop release;
if other release channels are added, move the updater endpoint to a dedicated
desktop-only feed first. GitHub release checks and downloads require internet
access. CI `workflow_dispatch` produces signed artifacts but does not change
the published update feed.

CI layout: the `ubuntu-latest` test job runs `npm test` / `tsc` / `lint` — the
web test suite is Linux-validated and several pre-existing tests encode POSIX
assumptions (CRLF source markers, `PATH` vs `Path` casing). The Windows test job
runs Rust shell tests. After building the signed installer, Windows also runs
`desktop-installer.test.mjs` with Tauri's actual NSIS compiler; fresh install,
reinstall, `/UPDATE`, staging rollback and recovery-copy protection must pass
before publication. A missing compiler fails the release instead of silently
skipping the installer regressions. Making the full Web suite Windows-native
is a separate work item.

## Troubleshooting

- **Startup shows the bundled loading page** — the app UI never reported a
  finished page load, so the window was revealed by the 15-second fallback.
  Check the sidecar log:
  `%LOCALAPPDATA%\com.github.ghost0211.pi-web\logs\pi-web-server.log`.
  The normal path reveals the window as soon as the real UI loads.
- **The app starts but shows a connection error** — the sidecar payload was
  not bundled where expected. `tauri.conf.json` deliberately uses the *list*
  form of `bundle.resources` (`["server/", "node/"]`); the map form regressed
  in Tauri CLI 2.11 (tauri-apps/tauri#15342). If you upgrade the CLI and
  resources go missing, verify the install directory contains `server/` and
  `node/` next to the exe.
- **Installer reports existing recovery payloads** — an interrupted copy or a
  locked old runtime left `server.previous` / `node.previous` in the install
  directory. Fully Quit Desktop and its old sidecar. Move these directories
  outside the install directory as backups before retrying the installer. If
  you need to restore the old installation instead, move any partial new
  `server/` / `node/` aside and rename the recovery copies back to their original
  names. Never overwrite a recovery copy or remove user app-data/session folders.
- **Session list shows HTTP 500 after an update, with `pi-tui` missing
  `setImageTranscoder` in the sidecar log** — check for obsolete nested packages,
  not just the top-level SDK version. The 0.99 → 1.0 upgrade can leave
  `server/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui`
  at 0.99.1 while the hoisted SDK is 1.0.3. Node resolves the stale nested package
  first. The preinstall hook now cleans the generated payloads before copying
  the new release. For an affected older installer, fully **Quit** Desktop,
  move the install directory's `server/` and `node/` folders outside the install
  directory as backups, then rerun the installer. Do not delete or move `~/.pi/`
  or the Desktop app-data directories — these hold user sessions and settings.
- **OAuth reports `Cannot find module .../pi-ai/dist/auth/oauth/*.js`** — the
  standalone trace omitted a variable dynamic import. `next.config.ts` must
  include both top-level and `pi-coding-agent`-nested `pi-ai/dist` trees;
  `build-desktop-server.mjs` validates every installed OAuth runtime before an
  installer can be produced.
- **Codemode or image processing reports missing worker/WASM/docs** — SDK 1.0
  uses `pi-codemode`, `pi-mcp`, and `chord` runtimes, which may be hoisted or
  installed under `pi-coding-agent/node_modules`. The standalone trace includes
  complete runtime trees, QuickJS/Photon WASM, and SDK documentation. Desktop
  assembly checks worker dependencies, docs, WASM, and OAuth files against the
  installed sources. See [SDK 1.0 integration](../docs/pi-sdk-1.0-adaptation.md).
- **SmartScreen warning on first install** — expected until the installer is
  code-signed.
- **Firewall prompt** — none should appear; the sidecar binds `127.0.0.1`
  only. Tailnet HTTPS access requires the explicit Tailscale Serve setup above.

## Not included yet

- code signing certificate
- notification click activation / session deep-linking on Windows (the native
  toast itself is implemented; see "Native notifications" above)
- localized tray menu labels (the web settings UI is fully localized; the
  tray menu is English-only for now)
