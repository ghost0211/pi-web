import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { readSessionModelFallback } = await jiti.import("./session-model-fallback.ts");
const { beginSessionDeletion } = await jiti.import("./session-deletion-guard.ts");
const target = { provider: "fixture", modelId: "backup" };

function fixture() {
  const manager = SessionManager.inMemory(tmpdir());
  let streaming = false;
  const state = { selection: null, notice: null, cancelled: false, resolveModel: async (ref) => ref.modelId === "backup" || ref.modelId === "primary" ? { provider: "fixture", id: ref.modelId } : undefined };
  const thinkingCalls = [];
  const inner = {
    sessionId: manager.getSessionId(), sessionManager: manager, agent: { state: { thinkingLevel: "high" } }, extensionRunner: {},
    setThinkingLevel: (level) => { thinkingCalls.push(level); inner.agent.state.thinkingLevel = level; },
    model: { provider: "fixture", id: "primary" },
    modelRuntime: { getModel: (provider, modelId) => provider === "fixture" ? { provider, id: modelId } : undefined },
    setModel: async (model) => { inner.model = model; return true; },
    isCompacting: false, isBashRunning: false, autoRetryEnabled: true, autoCompactionEnabled: true,
    get isStreaming() { return streaming; },
    bindExtensions: async () => {}, getContextUsage: () => undefined, messages: [],
    getSteeringMessages: () => [], getFollowUpMessages: () => [], dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, { modelFallbackState: state });
  return { wrapper, manager, state, inner, thinkingCalls, setStreaming: (value) => { streaming = value; } };
}

test("configuring/clearing fallback persists session metadata without changing the primary model", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.wrapper.send({ type: "set_fallback_model", model: target }), target);
    assert.deepEqual(f.state.selection, target);
    assert.deepEqual(f.wrapper.getFallbackModelConfiguration(), target);
    assert.deepEqual(readSessionModelFallback(f.manager.getEntries()), target);
    assert.deepEqual((await f.wrapper.send({ type: "get_state" })).fallbackModel, target);
    assert.equal(f.manager.getEntries().some((entry) => entry.type === "model_change"), false);
    await assert.rejects(
      f.wrapper.send({ type: "set_model", provider: "fixture", modelId: "backup" }),
      /different from the configured fallback/,
    );
    assert.equal(await f.wrapper.send({ type: "set_fallback_model", model: null }), null);
    assert.equal(f.wrapper.getFallbackModelConfiguration(), null);
    assert.equal(readSessionModelFallback(f.manager.getEntries()), null);
  } finally { f.wrapper.destroy(); }
});

test("backup thinking is an atomic independent preference, not a change to the active level", async () => {
  const f = fixture();
  const resolvedBackup = { provider: "fixture", id: "backup", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "lite", medium: null, high: "strong", xhigh: null, max: null } };
  f.state.resolveModel = async () => resolvedBackup;
  try {
    const selection = { ...target, thinkingLevel: "low" };
    assert.deepEqual(await f.wrapper.send({ type: "set_fallback_model", model: selection }), selection);
    assert.equal(f.inner.agent.state.thinkingLevel, "high");
    assert.deepEqual(f.thinkingCalls, []);
    assert.deepEqual(readSessionModelFallback(f.manager.getEntries()), selection);
    await f.wrapper.send({ type: "set_thinking_level", level: "medium" });
    assert.deepEqual(f.state.selection, selection, "primary changes never touch backup thinking");
    const normalized = await f.wrapper.send({ type: "set_fallback_model", model: { ...target, thinkingLevel: "max" } });
    assert.deepEqual(normalized, { ...target, thinkingLevel: "auto" });
    assert.deepEqual(readSessionModelFallback(f.manager.getEntries()), normalized);
    await assert.rejects(f.wrapper.send({ type: "set_fallback_model", model: { ...target, thinkingLevel: "bad" } }), /fallbackModel/);

    // After failover the configured backup is also the active model. Its saved
    // future-run preference is still editable without changing the live level.
    f.inner.model = resolvedBackup;
    await f.wrapper.send({ type: "set_fallback_model", model: selection });
    assert.equal(f.inner.agent.state.thinkingLevel, "medium");
  } finally { f.wrapper.destroy(); }
});

test("auto thinking resolves against the active model, never reaching the SDK as auto", async () => {
  const f = fixture();
  f.inner.model = { ...f.inner.model, reasoning: true };
  f.inner.settingsManager = { getModelThinkingLevel: () => "low", getDefaultThinkingLevel: () => "high" };
  try {
    await f.wrapper.send({ type: "set_thinking_level", level: "auto" });
    assert.deepEqual(f.thinkingCalls, ["low"]);
    await assert.rejects(f.wrapper.send({ type: "set_thinking_level", level: "invalid" }), /Invalid thinking level/);
  } finally { f.wrapper.destroy(); }
});

test("invalid, unavailable, busy and deletion-barrier configuration never writes fallback metadata", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.wrapper.send({ type: "set_fallback_model", model: { ...target, apiKey: "fixture" } }), /fallbackModel/);
    await assert.rejects(f.wrapper.send({ type: "set_fallback_model", model: { ...target, modelId: "unavailable" } }), /unavailable/);
    await assert.rejects(f.wrapper.send({ type: "set_fallback_model", model: { provider: "fixture", modelId: "primary" } }), /different from the primary/);
    f.setStreaming(true);
    await assert.rejects(f.wrapper.send({ type: "set_fallback_model", model: target }), /finish/);
    f.setStreaming(false);
    const barrier = beginSessionDeletion([f.wrapper.sessionId]);
    try { await assert.rejects(f.wrapper.send({ type: "set_fallback_model", model: target }), /permanently deleted/); }
    finally { barrier.release(); }
    assert.equal(readSessionModelFallback(f.manager.getEntries()), undefined);
  } finally { f.wrapper.destroy(); }
});

test("availability resolution rechecks concurrent runs before persisting", async () => {
  const f = fixture();
  try {
    f.state.resolveModel = async () => { f.setStreaming(true); return { provider: "fixture", id: "backup" }; };
    await assert.rejects(f.wrapper.send({ type: "set_fallback_model", model: target }), /finish/);
    assert.equal(readSessionModelFallback(f.manager.getEntries()), undefined);
  } finally { f.setStreaming(false); f.wrapper.destroy(); }
});

test("fallback startup, forks and ephemeral chat-only rebuilds carry authoritative state", async () => {
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  assert.ok(rpc.includes("options.fallbackModel === undefined || sessionFile"), "existing sessions ignore fresh-browser startup preference");
  assert.match(rpc, /fallbackModel,\s*\n\s*ephemeral: existing\.isEphemeral\(\)/);
  assert.ok(rpc.includes("appendSessionModelFallback(newManager, fallbackConfig)"));
  assert.equal((rpc.match(/appendSessionModelFallback\(sourceManager, fallbackConfig\)/g) ?? []).length, 2);
  assert.ok(rpc.includes("createModelFallbackExtension(modelFallbackState)"));
  assert.ok(rpc.includes("observeModelFallbackErrors(inner.agent.streamFunction, modelFallbackState)"));
  assert.ok(route.includes("thinkingLevel, fallbackModel, ...promptCommand"));
  assert.ok(route.includes("fallbackSelection !== undefined ? { fallbackModel: fallbackSelection }"));
});

test("RPC state and fallback SSE distinguish configured primary xhigh from executing backup low", async () => {
  const f = fixture();
  const primary = { provider: "fixture", modelId: "primary", thinkingLevel: "xhigh" };
  f.state.pending = { primary, backup: target };
  f.inner.model = { provider: "fixture", id: "backup" };
  f.inner.agent.state.thinkingLevel = "low";
  const events = [];
  const unsubscribe = f.wrapper.onEvent((event) => events.push(event));
  try {
    const result = await f.wrapper.send({ type: "get_state" });
    assert.deepEqual(result.primaryModel, primary);
    assert.deepEqual(result.model, { provider: "fixture", id: "backup" });
    assert.equal(result.thinkingLevel, "low");
    const notice = { from: { provider: "fixture", modelId: "primary" }, to: target, ruleId: "portable.usage_limit_reached", kind: "subscription-limit", timestamp: 123 };
    f.state.onSwitch(notice, "low", primary);
    assert.equal(events.at(-1).type, "model_fallback");
    assert.deepEqual(events.at(-1).primaryModel, primary);
    assert.equal(events.at(-1).thinkingLevel, "low");
  } finally { unsubscribe(); f.wrapper.destroy(); }
});

test("an explicit new primary clears a failed temporary checkpoint rather than restoring over the user", async () => {
  const f = fixture();
  f.state.pending = { primary: { provider: "fixture", modelId: "primary", thinkingLevel: "xhigh" }, backup: target };
  f.state.restoreError = "auth missing";
  try {
    await f.wrapper.send({ type: "set_model", provider: "fixture", modelId: "manual" });
    assert.equal(f.inner.model.id, "manual");
    assert.equal(f.state.pending, null);
    assert.equal(f.state.restoreError, undefined);
    assert.equal(f.wrapper.getPrimaryModel().modelId, "manual");
  } finally { f.wrapper.destroy(); }
});

test("failed primary restoration rejects prompt admission before any backup request", async () => {
  const f = fixture();
  let prompted = false;
  f.inner.prompt = async () => { prompted = true; };
  f.state.restorePrimary = async () => { throw new Error("primary auth missing"); };
  try {
    await assert.rejects(f.wrapper.send({ type: "prompt", message: "next task" }), /primary auth missing/);
    assert.equal(prompted, false);
    assert.equal((await f.wrapper.send({ type: "get_state" })).isPromptRunning, false);
  } finally { f.wrapper.destroy(); }
});

test("in-flight settlement restoration stays busy and a new prompt waits for it before admission", async () => {
  const f = fixture();
  const gate = Promise.withResolvers();
  f.state.restorePromise = gate.promise;
  f.state.restorePrimary = () => gate.promise;
  let prompted = false;
  f.inner.prompt = async () => { prompted = true; };
  try {
    assert.equal(f.wrapper.isRunning(), true);
    assert.equal((await f.wrapper.send({ type: "get_state" })).isPromptRunning, true);
    await assert.rejects(f.wrapper.send({ type: "set_model", provider: "fixture", modelId: "manual" }), /finish/);
    const next = f.wrapper.send({ type: "prompt", message: "next task" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prompted, false);
    f.state.restorePromise = undefined;
    gate.resolve();
    await next;
    assert.equal(prompted, true);
  } finally { gate.resolve(); f.wrapper.destroy(); }
});
