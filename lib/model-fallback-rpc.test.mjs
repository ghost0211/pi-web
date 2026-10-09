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
  const inner = {
    sessionId: manager.getSessionId(), sessionManager: manager, agent: { state: {} }, extensionRunner: {},
    model: { provider: "fixture", id: "primary" },
    modelRuntime: { getModel: (provider, modelId) => provider === "fixture" ? { provider, id: modelId } : undefined },
    setModel: async (model) => { inner.model = model; return true; },
    isCompacting: false, isBashRunning: false, autoRetryEnabled: true, autoCompactionEnabled: true,
    get isStreaming() { return streaming; },
    bindExtensions: async () => {}, getContextUsage: () => undefined, messages: [],
    getSteeringMessages: () => [], getFollowUpMessages: () => [], dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, { modelFallbackState: state });
  return { wrapper, manager, state, setStreaming: (value) => { streaming = value; } };
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
