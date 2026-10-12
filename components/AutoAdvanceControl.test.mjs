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
  assert.match(allText, /autoAdvance\.budgetHint/);
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
    tokensUsed: 8400,
    config: {
      goal: "Refactor core",
      scope: "src/core",
      model: { provider: "anthropic", modelId: "claude-3-5-sonnet/v2" },
      maxRounds: 5,
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
  assert.match(bodyText, /autoAdvance\.tokens:\{"used":8400,"budget":20000\}/);
  assert.match(bodyText, /autoAdvance\.limits:\{"rounds":5,"minutes":15\}/);

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
  const options = harness.findAll((n) => n.type === "option");
  assert.equal(options.length, 2);
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
  assert.equal(startedConfig.maxMinutes, 10);
  assert.equal(startedConfig.tokenBudget, 20000);

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
  assert.match(bodyText, /autoAdvance\.tokens:\{"used":12500,"budget":20000\}/);

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

  // Out-of-range and non-integer limits keep the form invalid; drafts are not rewritten.
  const [roundsInput, minutesInput, budgetInput] = numberInputs();
  roundsInput.props.onChange({ target: { value: "99" } });
  harness.render();
  assert.equal(harness.button("autoAdvance.start").props.disabled, true);
  assert.equal(numberInputs()[0].props.value, "99", "the user's draft is preserved for correction");
  numberInputs()[0].props.onChange({ target: { value: "4" } });
  minutesInput.props.onChange({ target: { value: "7.5" } });
  harness.render();
  assert.equal(harness.button("autoAdvance.start").props.disabled, true);
  numberInputs()[1].props.onChange({ target: { value: "12" } });
  budgetInput.props.onChange({ target: { value: "500" } });
  harness.render();
  assert.equal(harness.button("autoAdvance.start").props.disabled, true);
  numberInputs()[2].props.onChange({ target: { value: "12000" } });
  harness.render();

  harness.button("autoAdvance.start").props.onClick();
  assert.equal(submitted.length, 1, "exactly one submission after the form became valid");
  assert.equal(submitted[0].model.provider, "openai");
  assert.equal(submitted[0].model.modelId, "gpt-4o");
  assert.equal(submitted[0].maxRounds, 4);
  assert.equal(submitted[0].maxMinutes, 12);
  assert.equal(submitted[0].tokenBudget, 12000);

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
  assert.match(dialogText, /预算统计启用后的主模型与替身用量/);
  assert.match(dialogText, /已用 Token：3500 \/ 20000/);
  assert.match(dialogText, /最多 3 轮 · 10 分钟/);
  assert.match(dialogText, /主模型正在推进/);

  const stopBtn = harness.button("停止自动推进");
  assert.ok(stopBtn);
  assert.equal(stopBtn.props.disabled, false);

  harness.cleanup();
});
