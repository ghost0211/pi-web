import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  createModelFallbackExtension,
  observeModelFallbackErrors,
} = await jiti.import("./model-fallback-runtime.ts");
const { MODEL_FALLBACK_EVENT_TYPE } = await jiti.import("./session-model-fallback.ts");
const { parseModelFallbackNotice } = await jiti.import("./model-fallback.ts");

const primary = { provider: "openai", id: "primary", api: "openai-completions", reasoning: true, input: ["text", "image"], contextWindow: 100_000, maxTokens: 4096 };
const backup = { provider: "anthropic", id: "backup", api: "anthropic-messages", reasoning: true, input: ["text", "image"], contextWindow: 100_000, maxTokens: 4096 };
const failedMessage = (overrides = {}) => ({
  role: "assistant",
  content: [{ type: "text", text: "" }],
  api: primary.api,
  provider: primary.provider,
  model: primary.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  stopReason: "error",
  errorMessage: "usage_limit_reached",
  timestamp: 1,
  ...overrides,
});
const userMessage = { role: "user", content: [{ type: "text", text: "continue this task" }], timestamp: 0 };

function extensionFixture(options = {}) {
  const state = {
    resolveDefaultThinkingLevel: async () => options.modelDefault,
    selection: { provider: backup.provider, modelId: backup.id, ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}) },
    notice: null,
    cancelled: false,
    resolveModel: async () => options.target === undefined ? backup : options.target,
    onSwitch: (notice, thinkingLevel) => { state.switched = { notice, thinkingLevel }; },
  };
  const handlers = new Map();
  const calls = [];
  const thinkingCalls = [];
  let activeThinkingLevel = options.primaryThinkingLevel ?? "high";
  const extension = createModelFallbackExtension(state);
  extension.factory({
    on: (type, handler) => handlers.set(type, handler),
    setModel: async (model) => { calls.push(model); return options.setModelSucceeds ?? true; },
    getThinkingLevel: () => activeThinkingLevel,
    setThinkingLevel: (level) => { assert.equal(calls.length, 1, "set model before applying backup thinking"); thinkingCalls.push(level); activeThinkingLevel = level; },
  });
  const failed = options.failedMessage ?? failedMessage();
  const failedEntry = { sourceEntry: { id: "failed-entry" }, messages: [failed] };
  const event = {
    type: "agent_before_settle",
    outcome: "error",
    entries: [],
    continue: false,
    context: {
      contextEntries: [
        { sourceEntry: { id: "user-entry" }, messages: [userMessage] },
        failedEntry,
      ],
      contextMessages: options.contextMessages ?? [userMessage, failed],
      llmMessages: options.contextMessages ?? [userMessage, failed],
      pendingMessages: [],
      canContinue: false,
    },
  };
  const ctx = {
    model: primary,
  };
  return { state, handlers, event, ctx, calls, thinkingCalls, failed };
}

test("confirmed quota exhaustion switches once, audits metadata, excludes only the failed reply, and continues", async () => {
  const { state, handlers, event, ctx, calls, failed } = extensionFixture();
  handlers.get("before_agent_start")();
  handlers.get("message_end")({ type: "message_end", message: failed });

  const result = await handlers.get("agent_before_settle")(event, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, backup.id);
  assert.equal(result.continue, true);
  assert.deepEqual(result.entries.map((entry) => entry.type), ["custom", "context_edit"]);
  assert.equal(result.entries[0].customType, MODEL_FALLBACK_EVENT_TYPE);
  assert.deepEqual(parseModelFallbackNotice(result.entries[0].data.notice), result.entries[0].data.notice);
  assert.equal(result.entries[0].data.notice.ruleId, "portable.usage_limit_reached");
  assert.equal(result.entries[0].data.notice.kind, "subscription-limit");
  assert.deepEqual(result.entries[1], { type: "context_edit", targetId: "failed-entry", replacement: null });
  assert.equal(state.notice.to.modelId, backup.id);
  assert.deepEqual(state.switched, { notice: state.notice, thinkingLevel: "medium" });
  assert.equal(event.context.contextMessages.includes(failed), true, "raw history fixture remains intact");

  const second = await handlers.get("agent_before_settle")(event, ctx);
  assert.equal(second, undefined);
  assert.equal(calls.length, 1);
});

test("failover applies backup thinking independently of the primary, including model-only legacy configs", async () => {
  const restricted = { ...backup, thinkingLevelMap: { off: null, minimal: null, low: "lite", medium: null, high: "strong", xhigh: null, max: null } };
  for (const [name, options, expected] of [
    ["explicit", { target: restricted, thinkingLevel: "low", primaryThinkingLevel: "max" }, "low"],
    ["legacy", { primaryThinkingLevel: "off" }, "medium"],
    ["auto-pin", { target: restricted, thinkingLevel: "auto", modelDefault: "low", primaryThinkingLevel: "high" }, "low"],
    ["incompatible", { target: restricted, thinkingLevel: "xhigh", modelDefault: "low" }, "low"],
    ["no-reasoning", { target: { ...backup, reasoning: false }, thinkingLevel: "high" }, "off"],
  ]) {
    const f = extensionFixture(options);
    f.handlers.get("before_agent_start")();
    f.handlers.get("message_end")({ type: "message_end", message: f.failed });
    const result = await f.handlers.get("agent_before_settle")(f.event, f.ctx);
    assert.equal(result?.continue, true, name);
    assert.deepEqual(f.thinkingCalls, [expected], name);
    assert.equal(f.state.switched.thinkingLevel, expected, name);
    assert.equal(f.state.selection.thinkingLevel, options.thinkingLevel, "runtime does not mutate the backup preference");
  }
});

test("ordinary 429/rate-limit text, cancellation, unavailable or same model, and failed auth never switch", async () => {
  for (const [name, options] of [
    ["rate-limit", { failedMessage: failedMessage({ errorMessage: "rate limit exceeded" }) }],
    ["cancelled", { cancelled: true }],
    ["unavailable", { target: undefined, resolveUnavailable: true }],
    ["auth-failed", { setModelSucceeds: false }],
  ]) {
    const fixture = extensionFixture(options);
    if (name === "unavailable") {
      fixture.state.selection = { provider: "missing", modelId: "missing" };
      fixture.state.resolveModel = async () => undefined;
    }
    fixture.handlers.get("before_agent_start")();
    if (name === "cancelled") fixture.state.cancelled = true;
    fixture.handlers.get("message_end")({ type: "message_end", message: fixture.failed });
    assert.equal(await fixture.handlers.get("agent_before_settle")(fixture.event, fixture.ctx), undefined, name);
    assert.equal(fixture.calls.length, name === "auth-failed" ? 1 : 0, name);
  }

  const same = extensionFixture();
  same.state.selection = { provider: primary.provider, modelId: primary.id };
  same.handlers.get("before_agent_start")();
  same.handlers.get("message_end")({ type: "message_end", message: same.failed });
  assert.equal(await same.handlers.get("agent_before_settle")(same.event, same.ctx), undefined);
  assert.equal(same.calls.length, 0);
});

test("image history and undersized backup contexts are rejected conservatively", async () => {
  const imageUser = { ...userMessage, content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] };
  const textOnly = { ...backup, input: ["text"] };
  const imageFixture = extensionFixture({ target: textOnly, contextMessages: [imageUser, failedMessage()] });
  imageFixture.event.context.contextMessages = [imageUser, imageFixture.failed];
  imageFixture.handlers.get("before_agent_start")();
  imageFixture.handlers.get("message_end")({ type: "message_end", message: imageFixture.failed });
  assert.equal(await imageFixture.handlers.get("agent_before_settle")(imageFixture.event, imageFixture.ctx), undefined);
  assert.equal(imageFixture.calls.length, 0);

  const longText = "x".repeat(80_000);
  const largeUser = { ...userMessage, content: [{ type: "text", text: longText }] };
  const smallTarget = { ...backup, contextWindow: 8_000, maxTokens: 1_000 };
  const smallFixture = extensionFixture({ target: smallTarget, contextMessages: [largeUser, failedMessage()] });
  smallFixture.event.context.contextMessages = [largeUser, smallFixture.failed];
  smallFixture.handlers.get("before_agent_start")();
  smallFixture.handlers.get("message_end")({ type: "message_end", message: smallFixture.failed });
  assert.equal(await smallFixture.handlers.get("agent_before_settle")(smallFixture.event, smallFixture.ctx), undefined);
  assert.equal(smallFixture.calls.length, 0);
});

test("observer preserves callbacks and captures bounded raw evidence for transformed Codex errors", async () => {
  const state = {
    selection: { provider: backup.provider, modelId: backup.id },
    notice: null,
    cancelled: false,
    resolveModel: async () => backup,
  };
  const calls = [];
  const rawBody = JSON.stringify({ error: { code: "usage_limit_reached", type: "rate_limit_error" } });
  const wrapped = observeModelFallbackErrors(async (model, context, options) => {
    calls.push(["fetch-wrapped", typeof options.fetch]);
    const response = await options.fetch("https://fixture.invalid/responses", { headers: { authorization: "secret-not-stored" } });
    await options.onResponse({ status: response.status, headers: {} }, model);
    return { observed: true };
  }, state);
  const result = await wrapped(
    { ...primary, provider: "openai-codex", api: "openai-codex-responses" },
    { messages: [] },
    {
      fetch: async () => new Response(rawBody, { status: 429, headers: { "content-type": "application/json" } }),
      onResponse: async () => { calls.push(["original-on-response", 429]); },
    },
  );
  assert.deepEqual(result, { observed: true });
  assert.deepEqual(calls, [["fetch-wrapped", "function"], ["original-on-response", 429]]);

  // The same observer/state pair is what production uses; drive it through one stateful extension.
  const handlers = new Map();
  const switchedModels = [];
  createModelFallbackExtension(state).factory({
    on: (type, handler) => handlers.set(type, handler),
    setModel: async (model) => { switchedModels.push(model); return true; },
    getThinkingLevel: () => "auto",
    setThinkingLevel: () => {},
  });
  const failed = failedMessage({ provider: "openai-codex", api: "openai-codex-responses", errorMessage: "You have hit your ChatGPT usage limit." });
  const failedEvent = {
    type: "agent_before_settle",
    outcome: "error",
    entries: [],
    continue: false,
    context: {
      contextEntries: [{ sourceEntry: { id: "user-entry" }, messages: [userMessage] }, { sourceEntry: { id: "failed-entry" }, messages: [failed] }],
      contextMessages: [userMessage, failed],
      llmMessages: [userMessage, failed],
      pendingMessages: [],
      canContinue: false,
    },
  };
  handlers.get("before_agent_start")();
  const wrappedAgain = observeModelFallbackErrors(async (model, context, options) => {
    const response = await options.fetch("https://fixture.invalid/responses");
    await options.onResponse({ status: response.status, headers: {} }, model);
    return { observed: true };
  }, state);
  await wrappedAgain(
    { ...primary, provider: "openai-codex", api: "openai-codex-responses" },
    { messages: [] },
    { fetch: async () => new Response(rawBody, { status: 429 }) },
  );
  handlers.get("message_end")({ type: "message_end", message: failed });
  const switched = await handlers.get("agent_before_settle")(failedEvent, {
    model: { ...primary, provider: "openai-codex", api: "openai-codex-responses" },
  });
  assert.equal(switched.continue, true);
  assert.equal(switchedModels.length, 1);
  assert.equal(state.notice.ruleId, "portable.usage_limit_reached");
});

test("google adapters are not forced onto a custom fetch and successful responses clear stale evidence", async () => {
  const state = { selection: null, notice: null, cancelled: false, resolveModel: async () => undefined };
  const wrapped = observeModelFallbackErrors(async (model, context, options = {}) => {
    assert.equal(options.fetch, undefined);
    await options.onResponse?.({ status: 200, headers: {} }, model);
    return { ok: true };
  }, state);
  const result = await wrapped(
    { provider: "google", id: "gemini", api: "google-generative-ai", input: ["text"], contextWindow: 1, maxTokens: 1 },
    { messages: [] },
    { onResponse: async () => {} },
  );
  assert.deepEqual(result, { ok: true });

  const fixture = extensionFixture();
  fixture.handlers.get("before_agent_start")();
  fixture.handlers.get("message_end")({ type: "message_end", message: fixture.failed });
  fixture.handlers.get("message_end")({ type: "message_end", message: { ...fixture.failed, stopReason: "stop", errorMessage: undefined } });
  assert.equal(await fixture.handlers.get("agent_before_settle")({ ...fixture.event, outcome: "error" }, fixture.ctx), undefined);
  assert.equal(fixture.calls.length, 0);
});
