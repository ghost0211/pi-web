import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createJiti } from "jiti";
import { componentHarness } from "./mcp-test-harness.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const { ThinkingLevelSelector } = await jiti.import("./ThinkingLevelSelector.tsx");
const model = { provider: "fixture", modelId: "primary" };

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
before(() => Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } }));
after(() => { if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document; });

function fixture(t, overrides = {}) {
  const changes = [];
  const props = { variant: "primary", model, level: "auto", onChange: (level) => changes.push(level), availableLevels: ["off", "medium", "max"], ...overrides };
  const harness = componentHarness(ThinkingLevelSelector, props);
  t.after(() => harness.cleanup());
  harness.render();
  const trigger = () => harness.find((node) => node.type === "button" && node.props["aria-haspopup"] === "listbox");
  const option = (value) => harness.find((node) => node.props.role === "option" && node.key === value);
  return { harness, props, changes, trigger, option };
}

test("backup without a model is visibly gray, truly disabled and cannot open", (t) => {
  const f = fixture(t, { variant: "fallback", model: null, availableLevels: null });
  const button = f.trigger();
  assert.equal(button.props.disabled, true);
  assert.equal(button.props["aria-disabled"], true);
  assert.equal(button.props.style.opacity, 0.5);
  assert.equal(button.props.style.cursor, "not-allowed");
  assert.equal(button.props.title, "chat.fallbackSelectFirst");
  button.props.onClick(); f.harness.render();
  assert.equal(f.harness.find((node) => node.props.role === "listbox"), undefined);
  assert.deepEqual(f.changes, []);
});

test("primary and backup filter their own capabilities and call only their own handler", (t) => {
  const main = fixture(t);
  const backup = fixture(t, { variant: "fallback", model: { provider: "other", modelId: "backup" }, availableLevels: ["low", "high"] });
  main.trigger().props.onClick(); main.harness.render();
  assert.ok(main.option("max")); assert.equal(main.option("low"), undefined);
  main.option("max").props.onClick(); main.harness.render();
  backup.trigger().props.onClick(); backup.harness.render();
  assert.ok(backup.option("auto")); assert.ok(backup.option("high"));
  assert.equal(backup.option("max"), undefined); assert.equal(backup.option("off"), undefined);
  backup.option("low").props.onClick(); backup.harness.render();
  assert.deepEqual(main.changes, ["max"]);
  assert.deepEqual(backup.changes, ["low"]);
});

test("native thinking map is shown without changing the canonical value sent", (t) => {
  const f = fixture(t, { variant: "fallback", level: "low", availableLevels: ["low", "high"], levelMap: { low: "lite", high: "strong" } });
  assert.match(f.harness.text(), /lite/);
  f.trigger().props.onClick(); f.harness.render();
  assert.match(f.harness.text(), /strong\(high\)/);
  f.option("high").props.onClick();
  assert.deepEqual(f.changes, ["high"]);
});

test("model changes and busy states synchronously suppress and close an old menu", (t) => {
  const f = fixture(t);
  f.trigger().props.onClick(); f.harness.render();
  assert.ok(f.option("max"));
  const other = { ...f.props, model: { provider: "fixture", modelId: "other" }, availableLevels: ["low", "high"] };
  f.harness.render(other);
  assert.equal(f.option("max"), undefined);
  f.trigger().props.onClick(); f.harness.render(other);
  assert.ok(f.option("high"));
  f.harness.render({ ...other, disabled: true });
  assert.equal(f.harness.find((node) => node.props.role === "listbox"), undefined);
  assert.equal(f.trigger().props.disabled, true);
  f.harness.render(other);
  assert.equal(f.harness.find((node) => node.props.role === "listbox"), undefined);
});

test("unknown metadata and off-only models stay disabled with a clear reason", (t) => {
  const loading = fixture(t, { availableLevels: null });
  assert.equal(loading.trigger().props.disabled, true);
  assert.equal(loading.trigger().props.title, "chat.thinkingLoading");
  const plain = fixture(t, { availableLevels: ["off"], level: "high" });
  assert.equal(plain.trigger().props.disabled, true);
  assert.equal(plain.trigger().props.title, "chat.thinkingUnsupported");
  assert.match(plain.harness.text(), /off/);
});

test("read-only controls are not rendered", (t) => {
  const f = fixture(t, { onChange: undefined });
  assert.equal(f.trigger(), undefined);
});
