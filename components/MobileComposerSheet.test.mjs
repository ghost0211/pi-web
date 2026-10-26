import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { componentHarness } from "./mcp-test-harness.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const { MobileComposerSheet } = await jiti.import("./MobileComposerSheet.tsx");

test("mobile sheet follows visual viewport changes and removes its listeners", (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const listeners = new Map();
  const viewport = { offsetTop: 20, offsetLeft: 3, width: 390, height: 400,
    addEventListener: (key, callback) => listeners.set(key, callback), removeEventListener: (key) => listeners.delete(key) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { visualViewport: viewport, addEventListener() {}, removeEventListener() {} } });
  const harness = componentHarness(MobileComposerSheet, { title: "Models", onClose() {}, panelRef: { current: null }, children: "Options" });
  t.after(() => { harness.cleanup(); if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete globalThis.window; });
  harness.render(); harness.render();
  const backdrop = () => harness.find((node) => node.props["data-mobile-composer-sheet"]);
  assert.deepEqual(backdrop().props.style, { top: 20, left: 3, width: 390, height: 400 });
  viewport.height = 240; viewport.offsetTop = 40;
  listeners.get("resize")(); harness.render();
  assert.equal(backdrop().props.style.height, 240);
  assert.equal(backdrop().props.style.top, 40);
  assert.equal(harness.find((node) => node.props.role === "dialog").props["aria-modal"], "true");
  harness.cleanup(); assert.equal(listeners.size, 0);
});

test("Escape and scrim clicks dismiss, while inside clicks do not", (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 320, innerHeight: 568, addEventListener() {}, removeEventListener() {} } });
  let closed = 0, prevented = 0, stopped = 0;
  const harness = componentHarness(MobileComposerSheet, { title: "Thinking", onClose() { closed++; }, panelRef: { current: null } });
  t.after(() => { harness.cleanup(); if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete globalThis.window; });
  harness.render();
  const backdrop = harness.find((node) => node.props["data-mobile-composer-sheet"]);
  backdrop.props.onClick({ target: {}, currentTarget: {} }); assert.equal(closed, 0);
  const target = {}; backdrop.props.onClick({ target, currentTarget: target }); assert.equal(closed, 1);
  backdrop.props.onKeyDown({ key: "Escape", preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  assert.equal(closed, 2); assert.equal(prevented, 1); assert.equal(stopped, 1);
});

test("focus trapping follows the actual Tab order, skipping negative-tabindex options", (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 320, innerHeight: 568, addEventListener() {}, removeEventListener() {} } });
  let focused = "", prevented = 0;
  const first = { tabIndex: 0, hasAttribute: () => false, focus() { focused = "close"; } };
  const selected = { tabIndex: 0, hasAttribute: () => false, focus() { focused = "selected"; } };
  const unselected = { tabIndex: -1, hasAttribute: () => false, focus() { focused = "unselected"; } };
  const doc = { activeElement: selected };
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  const harness = componentHarness(MobileComposerSheet, { title: "Thinking", onClose() {}, panelRef: { current: { querySelectorAll: () => [first, selected, unselected] } } });
  t.after(() => {
    harness.cleanup();
    for (const [name, previous] of [["window", previousWindow], ["document", previousDocument]]) {
      if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name];
    }
  });
  harness.render();
  const keydown = harness.find((node) => node.props["data-mobile-composer-sheet"]).props.onKeyDown;
  keydown({ key: "Tab", preventDefault() { prevented++; } });
  assert.equal(focused, "close");
  doc.activeElement = first;
  keydown({ key: "Tab", shiftKey: true, preventDefault() { prevented++; } });
  assert.equal(focused, "selected");
  assert.equal(prevented, 2);
});
