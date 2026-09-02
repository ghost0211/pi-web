import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getDesktopCloseBehavior,
  isDesktopApp,
  setDesktopCloseBehavior,
} = await jiti.import("./desktop.ts");

function withFakeWindow(t, options) {
  const previous = globalThis.window;
  if (options.invoke) {
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

test("desktop settings updates preserve fields owned by other desktop features", async () => {
  const source = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.match(source, /fn update_setting[\s\S]*?load_settings_object\(app\)[\s\S]*?settings\.insert\(key\.to_string\(\), value\)/);
  assert.match(source, /update_setting\(app, "closeBehavior"/);
  assert.match(source, /update_setting\(app, "serverPort"/);
  assert.match(source, /refusing to overwrite desktop settings/);
});
