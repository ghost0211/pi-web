import assert from "node:assert/strict";
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
