import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AutoAdvanceControl } = await jiti.import("./AutoAdvanceControl.tsx");

// Global document/window mocks for headless execution
const listeners = new Map();
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

before(() => {
  listeners.clear();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { nodeType: 1 },
      activeElement: null,
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(handler);
      },
      removeEventListener(type, handler) {
        listeners.get(type)?.delete(handler);
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(handler);
      },
      removeEventListener(type, handler) {
        listeners.get(type)?.delete(handler);
      },
    },
  });
});

after(() => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else delete globalThis.window;
});

/**
 * Lightweight React component test harness supporting portals and standard hooks.
 */
function createHarness(Component, initialProps) {
  let nextId = 0;
  const idPrefix = "harness-" + nextId++;
  const slots = [];
  let cursor = 0;
  let pending = [];
  let currentProps = initialProps;

  const context = {
    t: (key, params) => {
      if (params) {
        return `${key}:${JSON.stringify(params)}`;
      }
      return key;
    },
  };

  const hooks = {
    useContext: () => context,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (value) => {
          slots[index] = typeof value === "function" ? value(slots[index]) : value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ??= { current: initial });
    },
    useId() {
      const index = cursor++;
      return (slots[index] ??= `${idPrefix}-${index}`);
    },
    useLayoutEffect(callback, deps) {
      hooks.useEffect(callback, deps);
    },
    useMemo(callback, deps) {
      const index = cursor++;
      const old = slots[index];
      if (old && deps?.every((val, i) => Object.is(val, old.deps?.[i]))) return old.value;
      return (slots[index] = { deps, value: callback() }).value;
    },
    useCallback(callback, deps) {
      return hooks.useMemo(() => callback, deps);
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const old = slots[index];
      if (old && deps?.every((val, i) => Object.is(val, old.deps?.[i]))) return;
      old?.cleanup?.();
      slots[index] = { deps };
      pending.push(() => {
        slots[index].cleanup = callback();
      });
    },
  };

  const expand = (value) => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== "object") return value;
    if (value.containerInfo && value.children !== undefined) return expand(value.children);
    if (typeof value.type === "function") return expand(value.type(value.props));
    if (value.type?.$$typeof === Symbol.for("react.memo")) {
      return expand(React.createElement(value.type.type, value.props));
    }
    return { ...value, props: { ...value.props, children: expand(value.props?.children) } };
  };

  const nodes = (value) => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object") return [];
    if (value.containerInfo && value.children !== undefined) return nodes(value.children);
    return [value, ...nodes(value.props?.children)];
  };

  const text = (value) => {
    if (Array.isArray(value)) return value.map(text).join("");
    if (!value || typeof value !== "object") {
      return value === false || value === null || value === undefined ? "" : String(value);
    }
    if (value.containerInfo && value.children !== undefined) return text(value.children);
    return text(value.props?.children);
  };

  let tree;
  const render = (nextProps = currentProps) => {
    currentProps = nextProps;
    cursor = 0;
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const before = internals.H;
    internals.H = hooks;
    const beforeReact = globalThis.React;
    globalThis.React = React;
    try {
      tree = expand(Component(currentProps));
    } finally {
      internals.H = before;
      if (beforeReact === undefined) delete globalThis.React;
      else globalThis.React = beforeReact;
    }
    const effects = pending;
    pending = [];
    effects.forEach((effect) => effect());
    return tree;
  };

  return {
    render,
    find(predicate) {
      return nodes(tree).find(predicate);
    },
    findAll(predicate) {
      return nodes(tree).filter(predicate);
    },
    button(label) {
      return nodes(tree).find((node) => node.type === "button" && text(node) === label);
    },
    input(predicate) {
      return nodes(tree).find((node) => ["input", "textarea", "select"].includes(node.type) && predicate(node));
    },
    text: () => text(tree),
    cleanup() {
      slots.forEach((val) => val?.cleanup?.());
    },
  };
}

const fixtureModels = [
  { provider: "anthropic", modelId: "claude-3-5-sonnet/v2", name: "Claude 3.5 Sonnet" },
  { provider: "openai", modelId: "gpt-4o", name: "GPT-4o" },
];

test("renders title button when idle and opens dialog on click", () => {
  const harness = createHarness(AutoAdvanceControl, {
    models: fixtureModels,
    onStart: async () => {},
    onStop: async () => {},
  });

  harness.render();
  assert.equal(harness.text(), "autoAdvance.title");

  const trigger = harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog");
  assert.ok(trigger);
  assert.equal(trigger.props["aria-expanded"], false);

  // Click opens dialog
  trigger.props.onClick();
  harness.render();

  const dialog = harness.find((n) => n.props?.role === "dialog");
  assert.ok(dialog);
  assert.equal(dialog.props["aria-modal"], "true");
  assert.ok(dialog.props["aria-labelledby"]);
  assert.ok(dialog.props["aria-describedby"]);

  // Contains notices
  const allText = harness.text();
  assert.match(allText, /autoAdvance\.warning/);
  assert.match(allText, /autoAdvance\.runHint/);
  assert.match(allText, /autoAdvance\.surrogateMessage/);

  // Initial required state: Start is disabled
  const startBtn = harness.button("autoAdvance.start");
  assert.ok(startBtn);
  assert.equal(startBtn.props.disabled, true);
  assert.match(allText, /autoAdvance\.missing/);

  harness.cleanup();
});

test("shows active round and leaves trigger & stop enabled when active even if disabled prop is true", () => {
  const activeState = {
    id: "run-1",
    revision: 1,
    phase: "running",
    round: 3,
    startedAt: Date.now() - 60000,
    tokensUsed: 4000000,
    usageIncomplete: true,
    config: {
      goal: "Refactor core",
      scope: "src/core",
      model: { provider: "anthropic", modelId: "claude-3-5-sonnet/v2" },
      maxRounds: 99,
      // Legacy server fields must not restore removed controls or displays.
      maxMinutes: 15,
      tokenBudget: 20000,
    },
  };

  let stopCalled = false;
  const harness = createHarness(AutoAdvanceControl, {
    state: activeState,
    models: fixtureModels,
    disabled: true, // disabled prop passed!
    busy: true,
    onStart: async () => {},
    onStop: async () => {
      stopCalled = true;
    },
  });

  harness.render();

  // Active trigger shows round and is NOT disabled
  const trigger = harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog");
  assert.equal(trigger.props.disabled, false);
  assert.match(harness.text(), /autoAdvance\.active:\{"round":3\}/);

  // Open dialog
  trigger.props.onClick();
  harness.render();

  // Active dialog displays phase, tokens, limits
  const bodyText = harness.text();
  assert.match(bodyText, /autoAdvance\.phase\.running/);
  assert.match(bodyText, /autoAdvance\.tokens:\{"used":4000000\}/);
  assert.match(bodyText, /autoAdvance\.usageIncomplete/);
  assert.match(bodyText, /autoAdvance\.limits:\{"rounds":99\}/);
  assert.equal(harness.findAll(n => n.type === "input" && n.props.type === "number").length, 1);
  assert.doesNotMatch(bodyText, /autoAdvance\.maxMinutes|autoAdvance\.tokenBudget|"minutes"|"budget"/);

  // Stop button MUST remain enabled despite disabled={true}
  const stopBtn = harness.button("autoAdvance.stop");
  assert.ok(stopBtn);
  assert.equal(stopBtn.props.disabled, false);

  stopBtn.props.onClick();
  assert.equal(stopCalled, true);

  harness.cleanup();
});

test("closes dialog on backdrop click, Escape key, or close button", () => {
  const harness = createHarness(AutoAdvanceControl, {
    models: fixtureModels,
    onStart: async () => {},
    onStop: async () => {},
  });

  harness.render();
  const trigger = harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog");

  // Open dialog
  trigger.props.onClick();
  harness.render();
  assert.ok(harness.find((n) => n.props?.role === "dialog"));

  // Close via backdrop click (target === currentTarget)
  const backdrop = harness.find((n) => n.props?.className === "auto-advance-backdrop");
  assert.ok(backdrop);
  const fakeEvent = { target: backdrop, currentTarget: backdrop };
  backdrop.props.onClick(fakeEvent);
  harness.render();
  assert.equal(harness.find((n) => n.props?.role === "dialog"), undefined);

  // Open again and close via close button
  trigger.props.onClick();
  harness.render();
  const closeBtn = harness.find((n) => n.type === "button" && n.props["aria-label"] === "autoAdvance.close");
  assert.ok(closeBtn);
  closeBtn.props.onClick();
  harness.render();
  assert.equal(harness.find((n) => n.props?.role === "dialog"), undefined);

  // Open again and close via Escape keydown on panel
  trigger.props.onClick();
  harness.render();
  const panel = harness.find((n) => n.props?.role === "dialog");
  panel.props.onKeyDown({ key: "Escape", stopPropagation() {} });
  harness.render();
  assert.equal(harness.find((n) => n.props?.role === "dialog"), undefined);

  harness.cleanup();
});

test("preserves slashes in native model selector and validates constraints", () => {
  let startedConfig = null;
  const harness = createHarness(AutoAdvanceControl, {
    models: fixtureModels,
    onStart: async (cfg) => {
      startedConfig = cfg;
    },
    onStop: async () => {},
  });

  harness.render();
  harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();

  // Model select options preserve slashes in modelId
  const select = harness.find((n) => n.type === "select");
  assert.ok(select);
  const options = select.props.children;
  assert.equal(options.length, 2, "count only model options, not the independent thinking selector");
  assert.match(options[0].props.value, /claude-3-5-sonnet\/v2/);

  // Goal and scope textareas with maxLength
  const goalTextarea = harness.find((n) => n.type === "textarea" && n.props.maxLength === 4000);
  assert.ok(goalTextarea);
  const scopeTextarea = harness.find((n) => n.type === "textarea" && n.props.maxLength === 2000);
  assert.ok(scopeTextarea);

  // Fill valid inputs
  goalTextarea.props.onChange({ target: { value: "Ship new feature" } });
  scopeTextarea.props.onChange({ target: { value: "components/ and lib/" } });
  harness.render();

  // Start button should now be enabled
  const startBtn = harness.button("autoAdvance.start");
  assert.equal(startBtn.props.disabled, false);

  startBtn.props.onClick();
  assert.ok(startedConfig);
  assert.equal(startedConfig.goal, "Ship new feature");
  assert.equal(startedConfig.scope, "components/ and lib/");
  assert.equal(startedConfig.model.modelId, "claude-3-5-sonnet/v2");
  assert.equal(startedConfig.maxRounds, 3);
  assert.equal(Object.hasOwn(startedConfig, "maxMinutes"), false);
  assert.equal(Object.hasOwn(startedConfig, "tokenBudget"), false);

  harness.cleanup();
});

function field(harness, name) {
  return harness.find(n => n.type === "select" && n.props["data-auto-advance-field"] === name);
}
function openAndFill(harness) {
  harness.render();
  harness.find(n => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();
  harness.find(n => n.type === "textarea" && n.props.maxLength === 4000).props.onChange({ target: { value: "Bounded goal" } });
  harness.find(n => n.type === "textarea" && n.props.maxLength === 2000).props.onChange({ target: { value: "Tests only; no commit or publish" } });
  harness.render();
}
const reasonerKey = "anthropic:claude-3-5-sonnet/v2";
const plainKey = "openai:gpt-4o";
const capabilities = { [reasonerKey]: ["off", "minimal", "low", "medium", "high"], [plainKey]: ["off"] };

test("surrogate thinking filters supported choices, shows provider mapping and submits canonical preference", async () => {
  let submitted;
  const harness = createHarness(AutoAdvanceControl, {
    models: fixtureModels, thinkingLevels: capabilities, thinkingLevelMaps: { [reasonerKey]: { high: "2048" } },
    onStart: async config => { submitted = config; }, onStop: async () => {},
  });
  openAndFill(harness);
  const select = field(harness, "thinking");
  assert.equal(select.props.value, "auto");
  assert.equal(select.props.disabled, false);
  assert.deepEqual(select.props.children.map(n => n.props.value), ["auto", "off", "minimal", "low", "medium", "high"]);
  assert.match(harness.text(), /high → 2048/);
  select.props.onChange({ target: { value: "high" } });
  harness.render();
  await harness.button("autoAdvance.start").props.onClick();
  assert.equal(submitted.thinkingLevel, "high");
  assert.equal(submitted.model.modelId, fixtureModels[0].modelId);
  assert.equal(submitted.scope, "Tests only; no commit or publish");
  assert.equal(Object.hasOwn(submitted, "primaryThinkingLevel"), false);
  assert.equal(Object.hasOwn(submitted, "fallbackThinkingLevel"), false);
  harness.cleanup();
});

test("model switching preserves compatible thinking but resets incompatible preferences and locks nonreasoning models", async () => {
  let submitted;
  const extra = { provider: "fixture", modelId: "reasoner", name: "Other reasoner" };
  const models = [...fixtureModels, extra];
  const harness = createHarness(AutoAdvanceControl, {
    models, thinkingLevels: { ...capabilities, "fixture:reasoner": ["off", "low", "high"] },
    onStart: async config => { submitted = config; }, onStop: async () => {},
  });
  openAndFill(harness);
  field(harness, "thinking").props.onChange({ target: { value: "high" } });
  harness.render();
  field(harness, "model").props.onChange({ target: { value: JSON.stringify({ provider: extra.provider, modelId: extra.modelId }) } });
  harness.render();
  assert.equal(field(harness, "thinking").props.value, "high");
  field(harness, "model").props.onChange({ target: { value: JSON.stringify({ provider: "openai", modelId: "gpt-4o" }) } });
  harness.render();
  assert.equal(field(harness, "thinking").props.value, "off");
  assert.equal(field(harness, "thinking").props.disabled, true);
  assert.deepEqual(field(harness, "thinking").props.children.map(n => n.props.value), ["off"]);
  await harness.button("autoAdvance.start").props.onClick();
  assert.equal(submitted.thinkingLevel, "off");
  harness.cleanup();

  const reset = createHarness(AutoAdvanceControl, {
    models, thinkingLevels: { ...capabilities, "fixture:reasoner": ["off", "low"] }, onStart: async () => {}, onStop: async () => {},
  });
  openAndFill(reset);
  field(reset, "thinking").props.onChange({ target: { value: "high" } });
  reset.render();
  field(reset, "model").props.onChange({ target: { value: JSON.stringify({ provider: extra.provider, modelId: extra.modelId }) } });
  reset.render();
  assert.equal(field(reset, "thinking").props.value, "auto");
  field(reset, "thinking").props.onChange({ target: { value: "max" } });
  reset.render();
  assert.equal(field(reset, "thinking").props.value, "auto", "unlisted injected choices are rejected");
  reset.cleanup();
});

test("unknown surrogate metadata stays auto-only and does not invent another model's preference", async () => {
  let submitted;
  const props = { models: fixtureModels, onStart: async config => { submitted = config; }, onStop: async () => {} };
  const harness = createHarness(AutoAdvanceControl, props);
  openAndFill(harness);
  assert.equal(field(harness, "thinking").props.disabled, true);
  assert.deepEqual(field(harness, "thinking").props.children.map(n => n.props.value), ["auto"]);
  assert.match(harness.text(), /chat\.thinkingLoading/);
  await harness.button("autoAdvance.start").props.onClick();
  assert.equal(submitted.thinkingLevel, "auto", "server resolves against the surrogate itself");
  harness.render({ ...props, thinkingLevels: capabilities });
  harness.find(n => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();
  assert.equal(field(harness, "thinking").props.disabled, false);
  harness.cleanup();
});

test("scope is explicit, empty by default, required and described by its example/help rather than prefilled authorization", () => {
  const harness = createHarness(AutoAdvanceControl, { models: fixtureModels, thinkingLevels: capabilities, onStart: async () => {}, onStop: async () => {} });
  harness.render();
  harness.find(n => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();
  const scope = harness.find(n => n.type === "textarea" && n.props.maxLength === 2000);
  assert.equal(scope.props.value, "");
  assert.equal(scope.props.required, true);
  assert.equal(scope.props.placeholder, "autoAdvance.scopePlaceholder");
  assert.ok(harness.find(n => n.props?.htmlFor === scope.props.id));
  assert.ok(harness.find(n => n.props?.id === scope.props["aria-describedby"]));
  const thinking = field(harness, "thinking");
  assert.ok(harness.find(n => n.props?.htmlFor === thinking.props.id));
  assert.ok(harness.find(n => n.props?.id === thinking.props["aria-describedby"]));
  harness.find(n => n.type === "textarea" && n.props.maxLength === 4000).props.onChange({ target: { value: "Goal" } });
  scope.props.onChange({ target: { value: "   " } });
  harness.render();
  assert.equal(harness.button("autoAdvance.start").props.disabled, true);
  harness.cleanup();
});

test("legacy activations restore auto and active/busy locks do not prevent Stop", async () => {
  let stopped = 0;
  const config = { goal: "G", scope: "S", model: { provider: "anthropic", modelId: "claude-3-5-sonnet/v2" }, maxRounds: 3, maxMinutes: 10, tokenBudget: 20000 };
  const props = { models: fixtureModels, thinkingLevels: capabilities, state: { id: "legacy", revision: 1, phase: "running", round: 1, startedAt: Date.now(), tokensUsed: 0, config }, busy: true, disabled: true, onStart: async () => {}, onStop: async () => { stopped++; } };
  const harness = createHarness(AutoAdvanceControl, props);
  harness.render();
  harness.find(n => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();
  assert.equal(field(harness, "thinking").props.value, "auto");
  assert.equal(field(harness, "thinking").props.disabled, true);
  assert.match(harness.text(), /anthropic\/claude-3-5-sonnet\/v2/);
  assert.match(harness.text(), /auto · chat\.thinkingUseDefault/);
  assert.equal(harness.button("autoAdvance.stop").props.disabled, false);
  await harness.button("autoAdvance.stop").props.onClick();
  assert.equal(stopped, 1);
  harness.cleanup();
});

test("terminal activation restores its own thinking and revisions preserve the editable draft", async () => {
  let submitted;
  const config = { goal: "G", scope: "Local tests only", thinkingLevel: "high", model: { provider: "anthropic", modelId: "claude-3-5-sonnet/v2" }, maxRounds: 3, maxMinutes: 10, tokenBudget: 20000 };
  const state = { id: "done", revision: 2, phase: "completed", round: 1, startedAt: Date.now(), tokensUsed: 100, config };
  const props = { models: fixtureModels, thinkingLevels: capabilities, state, onStart: async value => { submitted = value; }, onStop: async () => {} };
  const harness = createHarness(AutoAdvanceControl, props);
  harness.render();
  harness.find(n => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();
  assert.equal(field(harness, "thinking").props.value, "high");
  field(harness, "thinking").props.onChange({ target: { value: "low" } });
  harness.render({ ...props, state: { ...state, revision: 3, tokensUsed: 110 } });
  assert.equal(field(harness, "thinking").props.value, "low", "same-activation observations must not overwrite the draft");
  harness.button("autoAdvance.restart").props.onClick();
  harness.render();
  assert.equal(field(harness, "thinking").props.value, "high");
  await harness.button("autoAdvance.start").props.onClick();
  assert.equal(submitted.thinkingLevel, "high");
  harness.cleanup();
});

test("duplicate clicks are blocked via ref before rerender", async () => {
  let startCallCount = 0;
  let resolveStart;
  const startPromise = new Promise((resolve) => {
    resolveStart = resolve;
  });

  const harness = createHarness(AutoAdvanceControl, {
    models: fixtureModels,
    onStart: async () => {
      startCallCount++;
      return startPromise;
    },
    onStop: async () => {},
  });

  harness.render();
  harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();

  harness.find((n) => n.type === "textarea" && n.props.maxLength === 4000).props.onChange({
    target: { value: "Test Goal" },
  });
  harness.find((n) => n.type === "textarea" && n.props.maxLength === 2000).props.onChange({
    target: { value: "Test Scope" },
  });
  harness.render();

  const startBtn = harness.button("autoAdvance.start");

  // Fire two rapid clicks synchronously before any re-render
  const p1 = startBtn.props.onClick();
  const p2 = startBtn.props.onClick();

  assert.equal(startCallCount, 1, "second start call blocked synchronously by ref before rerender");

  resolveStart();
  await Promise.all([p1, p2]);
  harness.cleanup();
});

test("pending start does not block stop when stop is clicked", async () => {
  let stopCalled = false;
  let resolveStart;
  const slowStart = new Promise((resolve) => {
    resolveStart = resolve;
  });

  const harness = createHarness(AutoAdvanceControl, {
    state: {
      id: "run-pending",
      revision: 1,
      phase: "running",
      round: 1,
      startedAt: Date.now(),
      tokensUsed: 100,
      config: {
        goal: "G",
        scope: "S",
        model: { provider: "anthropic", modelId: "claude-3-5-sonnet/v2" },
        maxRounds: 3,
        maxMinutes: 10,
        tokenBudget: 20000,
      },
    },
    models: fixtureModels,
    onStart: () => slowStart,
    onStop: async () => {
      stopCalled = true;
    },
  });

  harness.render();
  harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();

  const stopBtn = harness.button("autoAdvance.stop");
  assert.ok(stopBtn);
  assert.equal(stopBtn.props.disabled, false);

  await stopBtn.props.onClick();
  assert.equal(stopCalled, true, "stop handler succeeded even while start pending");

  resolveStart?.();
  harness.cleanup();
});

test("catches error inline when start or stop rejects", async () => {
  const harness = createHarness(AutoAdvanceControl, {
    models: fixtureModels,
    onStart: async () => {
      throw new Error("Quota exceeded");
    },
    onStop: async () => {},
  });

  harness.render();
  harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();

  harness.find((n) => n.type === "textarea" && n.props.maxLength === 4000).props.onChange({
    target: { value: "Test Goal" },
  });
  harness.find((n) => n.type === "textarea" && n.props.maxLength === 2000).props.onChange({
    target: { value: "Test Scope" },
  });
  harness.render();

  await harness.button("autoAdvance.start").props.onClick();
  harness.render();

  // Dialog remains open with error alert displayed
  const errorAlert = harness.find((n) => n.props?.role === "alert");
  assert.ok(errorAlert);
  assert.match(harness.text(), /Quota exceeded/);

  harness.cleanup();
});

test("renders terminal state with phase, reason, detail, and restart button", () => {
  const terminalState = {
    id: "run-done",
    revision: 2,
    phase: "completed",
    round: 2,
    startedAt: Date.now() - 120000,
    tokensUsed: 12500,
    reason: "goal_complete",
    detail: "All test cases passed and verified.",
    config: {
      goal: "Fix bug",
      scope: "lib/",
      model: { provider: "anthropic", modelId: "claude-3-5-sonnet/v2" },
      maxRounds: 3,
      maxMinutes: 10,
      tokenBudget: 20000,
    },
  };

  const harness = createHarness(AutoAdvanceControl, {
    state: terminalState,
    models: fixtureModels,
    onStart: async () => {},
    onStop: async () => {},
  });

  harness.render();
  // In terminal state, button returns to autoAdvance.title
  assert.equal(harness.text(), "autoAdvance.title");

  harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();

  const bodyText = harness.text();
  assert.match(bodyText, /autoAdvance\.phase\.completed/);
  assert.match(bodyText, /autoAdvance\.reason\.goal_complete/);
  assert.match(bodyText, /All test cases passed and verified\./);
  assert.match(bodyText, /autoAdvance\.tokens:\{"used":12500\}/);

  // Restart button is visible
  const restartBtn = harness.button("autoAdvance.restart");
  assert.ok(restartBtn);

  harness.cleanup();
});

test("rejects malformed model ids and out-of-range limits instead of silently coercing them", () => {
  const submitted = [];
  const harness = createHarness(AutoAdvanceControl, {
    models: fixtureModels,
    onStart: async (cfg) => {
      submitted.push(cfg);
    },
    onStop: async () => {},
  });

  harness.render();
  harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();

  const select = harness.find((n) => n.type === "select");
  const goalField = () => harness.find((n) => n.type === "textarea" && n.props.maxLength === 4000);
  const scopeField = () => harness.find((n) => n.type === "textarea" && n.props.maxLength === 2000);
  const numberInputs = () => harness.findAll((n) => n.type === "input" && n.props.type === "number");

  // A model that is not in the enabled list cannot stay selected.
  select.props.onChange({ target: { value: JSON.stringify({ provider: "removed", modelId: "x" }) } });
  goalField().props.onChange({ target: { value: "Goal" } });
  scopeField().props.onChange({ target: { value: "Scope" } });
  harness.render();
  assert.equal(harness.button("autoAdvance.start").props.disabled, true);

  // Legacy index values are not a second model-identity encoding.
  harness.find((n) => n.type === "select").props.onChange({ target: { value: "1" } });
  harness.render();
  assert.equal(harness.button("autoAdvance.start").props.disabled, true);

  harness.find((n) => n.type === "select").props.onChange({
    target: { value: JSON.stringify({ provider: "openai", modelId: "gpt-4o" }) },
  });
  harness.render();
  assert.equal(harness.button("autoAdvance.start").props.disabled, false);

  // Only one numeric constraint remains. Drafts are preserved, never clamped.
  assert.equal(numberInputs().length, 1);
  assert.equal(numberInputs()[0].props.min, 1);
  assert.equal(numberInputs()[0].props.max, 99);
  assert.equal(numberInputs()[0].props.step, 1);
  for (const value of ["", " ", "0", "-1", "1.5", "100", "NaN", "Infinity", "1e309"]) {
    numberInputs()[0].props.onChange({ target: { value } });
    harness.render();
    assert.equal(harness.button("autoAdvance.start").props.disabled, true, value);
    assert.equal(numberInputs()[0].props.value, value, "invalid draft remains editable");
  }
  for (const value of ["1", "6", "25", "99"]) {
    numberInputs()[0].props.onChange({ target: { value } });
    harness.render();
    assert.equal(harness.button("autoAdvance.start").props.disabled, false, value);
  }

  harness.button("autoAdvance.start").props.onClick();
  assert.equal(submitted.length, 1, "exactly one submission after the form became valid");
  assert.equal(submitted[0].model.provider, "openai");
  assert.equal(submitted[0].model.modelId, "gpt-4o");
  assert.equal(submitted[0].maxRounds, 99);
  assert.equal(Object.hasOwn(submitted[0], "maxMinutes"), false);
  assert.equal(Object.hasOwn(submitted[0], "tokenBudget"), false);

  harness.cleanup();
});

test("formats messages properly with real zh-CN locale translations", async () => {
  const { autoAdvanceMessagesZhCN } = await jiti.import("../lib/auto-advance-messages.ts");

  const localizedHarness = (Component, initialProps) => {
    const interpolate = (msg, params = {}) =>
      msg.replace(/\{([\w.-]+)\}/g, (_, name) => (params[name] === undefined ? `{${name}}` : String(params[name])));
    const context = {
      t: (key, params) => {
        const msg = autoAdvanceMessagesZhCN[key] ?? key;
        return interpolate(msg, params);
      },
    };
    return createHarness((props) => {
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const originalContext = internals.H.useContext;
      internals.H.useContext = () => context;
      try {
        return Component(props);
      } finally {
        internals.H.useContext = originalContext;
      }
    }, initialProps);
  }

  const harness = localizedHarness(AutoAdvanceControl, {
    state: {
      id: "run-zh",
      revision: 1,
      phase: "running",
      round: 2,
      startedAt: Date.now(),
      tokensUsed: 3500,
      config: {
        goal: "测试目标",
        scope: "范围",
        model: { provider: "anthropic", modelId: "claude-3-5-sonnet/v2" },
        maxRounds: 3,
        maxMinutes: 10,
        tokenBudget: 20000,
      },
    },
    models: fixtureModels,
    onStart: async () => {},
    onStop: async () => {},
  });

  harness.render();
  const text = harness.text();
  assert.match(text, /自动推进中 · 第 2 轮/);

  // Open dialog
  harness.find((n) => n.type === "button" && n.props["aria-haspopup"] === "dialog").props.onClick();
  harness.render();

  const dialogText = harness.text();
  assert.match(dialogText, /替身消息 · 非用户授权/);
  assert.match(dialogText, /替身不是用户，不能新增授权/);
  assert.match(dialogText, /无总时长或 Token 预算限制/);
  assert.match(dialogText, /已用 Token：3500/);
  assert.match(dialogText, /最多 3 轮/);
  assert.doesNotMatch(dialogText, /3500 \/ 20000|10 分钟/);
  assert.match(dialogText, /主模型正在推进/);

  const stopBtn = harness.button("停止自动推进");
  assert.ok(stopBtn);
  assert.equal(stopBtn.props.disabled, false);

  harness.cleanup();
});
