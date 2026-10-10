import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createJiti } from "jiti";
import { componentHarness } from "./mcp-test-harness.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const { ThinkingLevelSelector } = await jiti.import("./ThinkingLevelSelector.tsx");
const model = { provider: "fixture", modelId: "primary" };
const fallbackModel = { provider: "other", modelId: "backup" };

const listeners = new Set();
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
before(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener(type, handler) { if (type === "pointerdown") listeners.add(handler); },
    removeEventListener(type, handler) { if (type === "pointerdown") listeners.delete(handler); },
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    innerWidth: 320, innerHeight: 568, addEventListener() {}, removeEventListener() {},
  } });
});
after(() => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete globalThis.window;
});

function fixture(t, overrides = {}) {
  const changes = [], fallbackChanges = [];
  const props = {
    model, level: "auto", onChange: (level) => changes.push(level), availableLevels: ["off", "medium", "max"],
    fallbackModel, fallbackLevel: "auto", onFallbackChange: (level) => fallbackChanges.push(level), fallbackAvailableLevels: ["low", "high"],
    ...overrides,
  };
  const harness = componentHarness(ThinkingLevelSelector, props);
  t.after(() => harness.cleanup());
  harness.render();
  const trigger = () => harness.find((node) => node.type === "button" && node.props["aria-haspopup"] === "dialog");
  const tab = (value) => harness.find((node) => node.props.role === "tab" && node.props["data-thinking-tab"] === value);
  const option = (value) => harness.find((node) => node.props.role === "option" && node.key === value);
  const open = () => { trigger().props.onClick(); harness.render(); };
  const switchTab = (value) => { tab(value).props.onClick(); harness.render(); };
  return { harness, props, changes, fallbackChanges, trigger, tab, option, open, switchTab };
}

test("one compact toolbar button opens both model tabs without changing preferences", (t) => {
  const f = fixture(t, { level: "max", fallbackLevel: "low" });
  assert.match(f.harness.text(), /chat.thinkingShort: max/);
  assert.doesNotMatch(f.harness.text(), /low|chat.fallbackThinkingShort/);
  assert.match(f.trigger().props.title, /chat.fallbackThinkingLevel: low/);
  f.open();
  assert.equal(f.tab("primary").props["aria-selected"], true);
  assert.equal(f.tab("fallback").props["aria-selected"], false);
  const panel = f.harness.find((node) => node.props.role === "tabpanel");
  assert.equal(panel.props.id, f.tab("primary").props["aria-controls"]);
  assert.equal(panel.props["aria-labelledby"], f.tab("primary").props.id);
  f.switchTab("fallback");
  assert.equal(f.tab("fallback").props["aria-selected"], true);
  assert.equal(f.option("low").props["aria-selected"], true);
  f.switchTab("primary");
  assert.equal(f.option("max").props["aria-selected"], true);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.fallbackChanges, []);
});

test("backup without a model is a gray disabled tab, while primary stays editable", (t) => {
  const f = fixture(t, { fallbackModel: null, fallbackAvailableLevels: null });
  assert.equal(f.trigger().props.disabled, false);
  f.open();
  const tab = f.tab("fallback");
  assert.equal(tab.props.disabled, true);
  assert.equal(tab.props["aria-disabled"], true);
  assert.equal(tab.props.style.opacity, 0.5);
  assert.equal(tab.props.style.cursor, "not-allowed");
  assert.equal(tab.props.title, "chat.fallbackSelectFirst");
  f.switchTab("fallback");
  assert.equal(f.tab("primary").props["aria-selected"], true);
  assert.equal(f.option("low"), undefined);
  f.option("max").props.onClick(); f.harness.render();
  assert.deepEqual(f.changes, ["max"]);
  assert.deepEqual(f.fallbackChanges, []);
});

test("tabs filter their own capabilities and call only their own handler", (t) => {
  const f = fixture(t);
  f.open();
  assert.ok(f.option("max")); assert.equal(f.option("low"), undefined);
  f.option("max").props.onClick(); f.harness.render();
  assert.equal(f.harness.find((node) => node.props.role === "dialog"), undefined);
  f.open(); f.switchTab("fallback");
  assert.ok(f.option("auto")); assert.ok(f.option("high"));
  assert.equal(f.option("max"), undefined); assert.equal(f.option("off"), undefined);
  f.option("low").props.onClick(); f.harness.render();
  assert.deepEqual(f.changes, ["max"]);
  assert.deepEqual(f.fallbackChanges, ["low"]);
  f.open();
  assert.equal(f.tab("primary").props["aria-selected"], true, "each open starts with primary, not the last-edited backup");
});

test("native maps stay model-specific and send canonical levels", (t) => {
  const f = fixture(t, {
    level: "max", levelMap: { max: "deep", medium: "standard" },
    fallbackLevel: "low", fallbackLevelMap: { low: "lite", high: "strong" },
  });
  assert.match(f.harness.text(), /chat.thinkingShort: deep/);
  f.open();
  assert.match(f.harness.text(), /standard\(medium\)/);
  f.switchTab("fallback");
  assert.match(f.harness.text(), /strong\(high\)/);
  assert.doesNotMatch(f.harness.text(), /standard/);
  f.option("high").props.onClick(); f.harness.render();
  assert.deepEqual(f.fallbackChanges, ["high"]);
  assert.deepEqual(f.changes, []);
  assert.match(f.harness.text(), /chat.thinkingShort: deep/, "backup edits never replace the toolbar's primary summary");
});

test("changing either model or becoming busy synchronously suppresses and closes the panel", (t) => {
  for (const patch of [
    { model: { provider: "fixture", modelId: "other" } },
    { fallbackModel: { provider: "other", modelId: "new-backup" } },
    { fallbackModel: null },
    { disabled: true },
  ]) {
    const f = fixture(t);
    f.open(); f.switchTab("fallback");
    assert.ok(f.option("high"));
    f.harness.render({ ...f.props, ...patch });
    assert.equal(f.harness.find((node) => node.props.role === "dialog"), undefined);
    f.harness.render(f.props);
    assert.equal(f.harness.find((node) => node.props.role === "dialog"), undefined);
  }
});

test("unknown metadata and off-only models disable only their own tab", (t) => {
  for (const [availableLevels, reason] of [[null, "chat.thinkingLoading"], [["off"], "chat.thinkingUnsupported"]]) {
    const f = fixture(t, { availableLevels, level: "high" });
    assert.equal(f.trigger().props.disabled, false, "the configured backup remains editable");
    f.open();
    assert.equal(f.tab("primary").props.disabled, true);
    assert.equal(f.tab("primary").props.title, reason);
    assert.equal(f.tab("fallback").props["aria-selected"], true);
    assert.ok(f.option("high"));
    f.switchTab("primary");
    assert.equal(f.tab("fallback").props["aria-selected"], true);
  }
  const backupLoading = fixture(t, { fallbackAvailableLevels: null });
  backupLoading.open();
  assert.equal(backupLoading.tab("fallback").props.disabled, true);
  assert.equal(backupLoading.tab("fallback").props.title, "chat.thinkingLoading");
});

test("shared trigger is disabled when busy or neither model is editable", (t) => {
  for (const patch of [
    { disabled: true },
    { availableLevels: null, fallbackAvailableLevels: null },
    { availableLevels: ["off"], fallbackModel: null },
    { model: null, fallbackModel: null },
  ]) {
    const f = fixture(t, patch);
    assert.equal(f.trigger().props.disabled, true);
    assert.equal(f.trigger().props.style.opacity, 0.5);
    f.open();
    assert.equal(f.harness.find((node) => node.props.role === "dialog"), undefined);
    assert.deepEqual(f.changes, []);
    assert.deepEqual(f.fallbackChanges, []);
  }
});

test("keyboard tab navigation skips disabled backup and Escape closes the popup", (t) => {
  const f = fixture(t);
  f.open();
  let prevented = 0;
  const keyboard = (key) => {
    f.harness.find((node) => node.props.role === "tablist").props.onKeyDown({ key, preventDefault() { prevented++; } });
    f.harness.render();
  };
  keyboard("ArrowRight");
  assert.equal(f.tab("fallback").props["aria-selected"], true);
  keyboard("ArrowLeft");
  assert.equal(f.tab("primary").props["aria-selected"], true);
  keyboard("End");
  assert.equal(f.tab("fallback").props["aria-selected"], true);
  keyboard("Home");
  assert.equal(f.tab("primary").props["aria-selected"], true);
  assert.equal(prevented, 4);
  let stopped = false;
  f.harness.find((node) => node.props["data-thinking-selector"]).props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() { stopped = true; } });
  f.harness.render();
  assert.equal(stopped, true);
  assert.equal(f.harness.find((node) => node.props.role === "dialog"), undefined);

  const unset = fixture(t, { fallbackModel: null });
  unset.open();
  unset.harness.find((node) => node.props.role === "tablist").props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
  unset.harness.render();
  assert.equal(unset.tab("primary").props["aria-selected"], true);
});

test("listbox supports arrow-key focus navigation without mutating either preference", (t) => {
  const f = fixture(t);
  f.open();
  const focused = [];
  const options = ["auto", "off", "medium", "max"].map((value) => ({ focus() { focused.push(value); globalThis.document.activeElement = this; } }));
  const list = f.harness.find((node) => node.props.role === "listbox");
  assert.equal(f.option("auto").props.tabIndex, 0);
  assert.equal(f.option("max").props.tabIndex, -1);
  for (const key of ["ArrowDown", "ArrowDown", "End", "ArrowUp", "Home"]) {
    list.props.onKeyDown({ key, preventDefault() {}, currentTarget: { querySelectorAll: () => options } });
  }
  assert.deepEqual(focused, ["auto", "off", "max", "medium", "auto"]);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.fallbackChanges, []);
  delete globalThis.document.activeElement;
});

test("outside pointer interaction closes the shared popup for mouse and touch", (t) => {
  const f = fixture(t);
  f.open();
  for (const handler of listeners) handler({ target: {} });
  f.harness.render();
  assert.equal(f.harness.find((node) => node.props.role === "dialog"), undefined);
});

test("popup clamps to the viewport and uses the roomier side with scrollable height", (t) => {
  for (const [anchor, expected] of [
    [{ left: -10, right: 80, top: 481, bottom: 509 }, { left: 18, top: "auto", maxHeight: 467 }],
    [{ left: 280, right: 370, top: 100, bottom: 128 }, { left: -188, top: "calc(100% + 6px)", maxHeight: 426 }],
    [{ left: 20, right: 110, top: 50, bottom: 78 }, { left: 0, top: "calc(100% + 6px)", maxHeight: 476 }],
    [{ left: 20, right: 110, top: 250, bottom: 278 }, { left: 0, top: "calc(100% + 6px)", maxHeight: 276, height: 400 }],
  ]) {
    const f = fixture(t, { isMobile: true });
    f.open();
    f.harness.find((node) => node.props["data-thinking-selector"]).props.ref.current = {
      getBoundingClientRect: () => anchor, querySelector: () => null,
    };
    f.harness.find((node) => node.props.role === "dialog").props.ref.current = {
      getBoundingClientRect: () => ({ width: 220 }), scrollHeight: expected.height ?? 240,
    };
    f.switchTab("fallback"); f.harness.render();
    const style = f.harness.find((node) => node.props.role === "dialog").props.style;
    assert.equal(style.left, expected.left);
    assert.equal(style.top, expected.top);
    assert.equal(style.maxHeight, expected.maxHeight);
    assert.equal(style.overflowY, "auto");
  }
});

test("read-only controls and unavailable editing callbacks are omitted", (t) => {
  const readonly = fixture(t, { onChange: undefined, onFallbackChange: undefined });
  assert.equal(readonly.trigger(), undefined);
  const mainOnly = fixture(t, { onFallbackChange: undefined });
  mainOnly.open();
  assert.ok(mainOnly.tab("primary"));
  assert.equal(mainOnly.tab("fallback"), undefined);
  const backupOnly = fixture(t, { onChange: undefined });
  backupOnly.open();
  assert.equal(backupOnly.tab("primary"), undefined);
  assert.equal(backupOnly.tab("fallback").props["aria-selected"], true);
});
