import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startRpcSession, getRpcSession } = await jiti.import("./rpc-manager.ts");
const { readSessionPrimaryModel, readSessionTemporaryFallback, PRIMARY_MODEL_SNAPSHOT_TYPE } = await jiti.import("./session-primary-model.ts");
const { appendSessionModelFallback, MODEL_FALLBACK_EVENT_TYPE } = await jiti.import("./session-model-fallback.ts");
const primary = { provider: "primary-fixture", modelId: "gpt-sol", thinkingLevel: "xhigh" };
const backup = { provider: "backup-fixture", modelId: "deepseek", thinkingLevel: "low" };

async function fixture(t, { legacy = false, auth = true, manual = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-primary-reopen-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  let sm;
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    const wrapper = sm ? getRpcSession(sm.getSessionId()) : undefined;
    if (wrapper) await wrapper.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const model = (id) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost, thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "primary-fixture": { api: "openai-completions", baseUrl: "https://fixture.invalid", ...(auth ? { apiKey: "fixture-key-not-real" } : {}), models: [model(primary.modelId), model("manual")] },
    "backup-fixture": { api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "fixture-key-not-real", models: [model(backup.modelId)] },
  } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: primary.provider, defaultModel: primary.modelId, defaultThinkingLevel: "medium", retry: { enabled: false } }));
  sm = SessionManager.create(root, join(root, "sessions"));
  sm.appendModelChange(primary.provider, primary.modelId);
  sm.appendThinkingLevelChange("xhigh");
  appendSessionModelFallback(sm, backup);
  sm.appendMessage({ role: "user", content: "fixture task", timestamp: 1 });
  const message = { role: "assistant", api: "openai-completions", content: [], stopReason: "error", errorMessage: "usage_limit_reached", timestamp: 2, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { ...cost, total: 0 } } };
  sm.appendMessage({ ...message, provider: primary.provider, model: primary.modelId });
  if (!legacy) sm.appendCustomEntry(PRIMARY_MODEL_SNAPSHOT_TYPE, { version: 1, primary, backup });
  sm.appendModelChange(backup.provider, backup.modelId);
  sm.appendThinkingLevelChange("medium");
  sm.appendThinkingLevelChange("low");
  sm.appendCustomEntry(MODEL_FALLBACK_EVENT_TYPE, { version: 1, notice: { from: { provider: primary.provider, modelId: primary.modelId }, to: { provider: backup.provider, modelId: backup.modelId }, kind: "subscription-limit", ruleId: "portable.usage_limit_reached", timestamp: 3 } });
  sm.appendMessage({ ...message, provider: backup.provider, model: backup.modelId, stopReason: "stop", errorMessage: undefined, content: [{ type: "text", text: "backup answer" }], timestamp: 4 });
  if (manual) {
    sm.appendModelChange(primary.provider, "manual");
    sm.appendThinkingLevelChange("high");
  }
  assert.ok(sm.getSessionFile());
  return { root, agentDir, sm, open: () => startRpcSession(sm.getSessionId(), sm.getSessionFile(), root, { toolNames: [] }) };
}

for (const legacy of [false, true]) {
  test(`real RPC reopen restores ${legacy ? "legacy audit" : "interrupted checkpoint"} primary xhigh without a model request`, async (t) => {
    const f = await fixture(t, { legacy });
    const { session: wrapper } = await f.open();
    const state = await wrapper.send({ type: "get_state" });
    assert.deepEqual(state.primaryModel, primary);
    assert.deepEqual(state.model, { provider: primary.provider, id: primary.modelId });
    assert.equal(state.thinkingLevel, "xhigh");
    assert.deepEqual(state.fallbackModel, backup);
    assert.equal(readSessionTemporaryFallback(wrapper.inner.sessionManager.getBranch()), null);
    assert.equal(wrapper.inner.messages.at(-1).model, backup.modelId, "history records its actual answering model");
    const settings = JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8"));
    assert.equal(settings.defaultThinkingLevel, "medium");
    assert.equal(settings.defaultModel, primary.modelId);
    await wrapper.shutdown();
    const reopened = await f.open();
    assert.deepEqual(reopened.session.getPrimaryModel(), primary);
    assert.deepEqual(readSessionPrimaryModel(SessionManager.open(f.sm.getSessionFile()).getBranch()), primary);
    assert.equal(reopened.session.inner.messages.length, 3, "restoring doesn't replay prompts or tools");
  });
}

test("missing primary auth fails safely and preserves recovery intent instead of silently starting with backup", async (t) => {
  const f = await fixture(t, { legacy: true, auth: false });
  await assert.rejects(f.open(), /No API key|primary model unavailable/);
  assert.equal(getRpcSession(f.sm.getSessionId()), undefined);
  const branch = SessionManager.open(f.sm.getSessionFile()).getBranch();
  assert.deepEqual(readSessionPrimaryModel(branch), primary);
  assert.deepEqual(readSessionTemporaryFallback(branch).primary, primary);
});

test("a user's later explicit model choice supersedes a legacy quota audit on real reopen", async (t) => {
  const f = await fixture(t, { legacy: true, manual: true });
  const { session: wrapper } = await f.open();
  assert.equal(wrapper.inner.model.id, "manual");
  assert.equal(wrapper.inner.thinkingLevel, "high");
  assert.equal(wrapper.getPrimaryModel().modelId, "manual");
  assert.equal(readSessionTemporaryFallback(wrapper.inner.sessionManager.getBranch()), null);
});
