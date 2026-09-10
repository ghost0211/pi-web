import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getDesktopCloseBehavior,
  isDesktopApp,
  listenDesktopFileDrop,
  pickDesktopAttachmentPaths,
  setDesktopCloseBehavior,
} = await jiti.import("./desktop.ts");

function withFakeWindow(t, options) {
  const previous = globalThis.window;
  if (options.bridge) {
    globalThis.window = { __TAURI__: options.bridge };
  } else if (options.invoke) {
    globalThis.window = { __TAURI__: { core: { invoke: options.invoke } } };
  } else {
    globalThis.window = {};
  }
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

test("isDesktopApp is false without the Tauri bridge", async (t) => {
  withFakeWindow(t, {});
  assert.equal(isDesktopApp(), false);
});

test("isDesktopApp is true when the bridge exposes core.invoke", async (t) => {
  withFakeWindow(t, { invoke: () => Promise.resolve(null) });
  assert.equal(isDesktopApp(), true);
});

test("getDesktopCloseBehavior returns null outside the desktop app", async (t) => {
  withFakeWindow(t, {});
  assert.equal(await getDesktopCloseBehavior(), null);
});

test("getDesktopCloseBehavior validates the shell value", async (t) => {
  withFakeWindow(t, { invoke: () => Promise.resolve("minimize-to-tray") });
  assert.equal(await getDesktopCloseBehavior(), "minimize-to-tray");
});

test("getDesktopCloseBehavior rejects unexpected shell values", async (t) => {
  withFakeWindow(t, { invoke: () => Promise.resolve("explode") });
  assert.equal(await getDesktopCloseBehavior(), null);
});

test("setDesktopCloseBehavior forwards the behavior argument", async (t) => {
  const calls = [];
  withFakeWindow(t, {
    invoke: (cmd, args) => {
      calls.push([cmd, args]);
      return Promise.resolve(null);
    },
  });
  assert.equal(await setDesktopCloseBehavior("quit"), true);
  assert.deepEqual(calls, [["set_close_behavior", { behavior: "quit" }]]);
});

test("setDesktopCloseBehavior returns false outside the desktop app", async (t) => {
  withFakeWindow(t, {});
  assert.equal(await setDesktopCloseBehavior("quit"), false);
});

test("desktop native attachment picker returns absolute paths and distinguishes browser fallback", async (t) => {
  const calls = [];
  withFakeWindow(t, {
    bridge: {
      core: {
        invoke: (command) => {
          calls.push(command);
          return Promise.resolve(["C:\\Desktop\\a.xlsx", "C:\\Desktop\\b.txt"]);
        },
      },
    },
  });
  assert.deepEqual(await pickDesktopAttachmentPaths(), ["C:\\Desktop\\a.xlsx", "C:\\Desktop\\b.txt"]);
  assert.deepEqual(calls, ["pick_attachment_paths"]);

  delete globalThis.window.__TAURI__;
  assert.equal(await pickDesktopAttachmentPaths(), null);
});

test("desktop native drop listener forwards paths and cleans up every event", async (t) => {
  const listeners = new Map();
  const removed = [];
  withFakeWindow(t, {
    bridge: {
      core: { invoke: () => Promise.resolve(null) },
      event: {
        listen: async (name, handler) => {
          listeners.set(name, handler);
          return () => removed.push(name);
        },
      },
    },
  });
  const calls = [];
  const unlisten = await listenDesktopFileDrop({
    onEnter: () => calls.push("enter"),
    onOver: () => calls.push("over"),
    onLeave: () => calls.push("leave"),
    onDrop: (paths) => calls.push(paths),
  });
  listeners.get("tauri://drag-enter")({ payload: { paths: ["C:\\Desktop\\a.xlsx"] } });
  listeners.get("tauri://drag-over")({ payload: {} });
  listeners.get("tauri://drag-drop")({ payload: { paths: ["C:\\Desktop\\a.xlsx", 42] } });
  listeners.get("tauri://drag-leave")({ payload: null });
  assert.deepEqual(calls, ["enter", "over", ["C:\\Desktop\\a.xlsx"], "leave"]);
  unlisten();
  assert.deepEqual(removed.sort(), [...listeners.keys()].sort());
});

test("desktop shell persists and reuses its server port for a stable WebView origin", async () => {
  const source = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.match(source, /fn read_server_port\(/);
  assert.match(source, /fn persist_server_port\(/);
  assert.match(source, /match read_server_port\(app\)/);
  assert.match(source, /Some\(port\) if loopback_port_available\(port\)/);
  assert.match(source, /let port_selection = desktop_server_port\(app\);/);
  assert.match(source, /if port_selection\.persist_on_ready \{\s*persist_server_port\(&ready_handle, port\)/);
});

test("desktop verifies the sidecar nonce before navigating the WebView", async () => {
  const source = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.match(source, /\.env\("PI_WEB_DESKTOP_HEALTH_TOKEN", &health_token\)/);
  assert.match(source, /GET \/api\/desktop-health/);
  assert.match(source, /if http_ready\(port, &health_token\)/);
  const readyBranch = source.slice(source.indexOf("if ready {"), source.indexOf("// On timeout keep"));
  assert.match(readyBranch, /window\.navigate\(url\)/);
});

test("desktop standalone tracing includes nested pi-ai dynamic runtime modules", async () => {
  const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  const buildScript = await readFile(new URL("../scripts/build-desktop-server.mjs", import.meta.url), "utf8");
  const validation = await readFile(new URL("../scripts/desktop-bundle-validation.mjs", import.meta.url), "utf8");

  assert.match(
    config,
    /\.\/node_modules\/@earendil-works\/pi-coding-agent\/node_modules\/@earendil-works\/pi-ai\/dist\/\*\*\/\*/,
  );
  assert.match(buildScript, /validatePiAiOAuthModules\(\{/);
  assert.match(buildScript, /sourceNodeModulesDir: join\(repoRoot, "node_modules"\)/);
  assert.match(validation, /name\.endsWith\("\.js"\)/);
  assert.match(validation, /checkedPiAiRuntimes === 0/);
  assert.match(validation, /standalone output is missing dynamic pi-ai module/);
});

test("desktop settings updates preserve fields owned by other desktop features", async () => {
  const source = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.match(source, /fn update_setting[\s\S]*?load_settings_object\(app\)[\s\S]*?settings\.insert\(key\.to_string\(\), value\)/);
  assert.match(source, /update_setting\(app, "closeBehavior"/);
  assert.match(source, /update_setting\(app, "serverPort"/);
  assert.match(source, /refusing to overwrite desktop settings/);
});

test("desktop enables native file picking and native drag event permissions", async () => {
  const source = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
  const cargo = await readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
  const capability = await readFile(new URL("../src-tauri/capabilities/desktop-remote.json", import.meta.url), "utf8");
  assert.match(source, /\.plugin\(tauri_plugin_dialog::init\(\)\)/);
  assert.match(source, /fn pick_attachment_paths\(app: AppHandle\)/);
  assert.match(cargo, /tauri-plugin-dialog = "2"/);
  assert.match(capability, /"allow-pick-attachment-paths"/);
  assert.match(capability, /"core:event:allow-listen"/);
  assert.match(capability, /"core:event:allow-unlisten"/);
});

test("desktop opens web links in the system browser", async () => {
  const source = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.match(source, /fn is_external_browser_url\(/);
  assert.match(source, /open::that_detached\(url\.as_str\(\)\)/);
  assert.match(source, /\.on_navigation\(\|url\|/);
  assert.match(source, /\.on_new_window\(\|url, _features\|/);
  assert.match(source, /NewWindowResponse::Deny/);
});
