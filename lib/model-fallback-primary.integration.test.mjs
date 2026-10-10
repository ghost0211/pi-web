import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createModelFallbackExtension, observeModelFallbackErrors } = await jiti.import("./model-fallback-runtime.ts");
const { readSessionPrimaryModel, readSessionTemporaryFallback } = await jiti.import("./session-primary-model.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test("real SDK mid-tool quota fallback uses backup low, then restores primary xhigh for the next prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fallback-primary-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
  runtime.registerProvider("primary-fixture", { api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "fixture-key-not-real", models: [{ id: "gpt-sol", name: "GPT Sol", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 4096, thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  runtime.registerProvider("backup-fixture", { api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "fixture-key-not-real", models: [{ id: "deepseek", name: "DeepSeek", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const primary = runtime.getModel("primary-fixture", "gpt-sol");
  const backup = runtime.getModel("backup-fixture", "deepseek");
  assert.ok(primary && backup);
  const manager = SessionManager.inMemory(root);
  const settings = SettingsManager.inMemory({ defaultThinkingLevel: "medium", retry: { enabled: false }, compaction: { enabled: false } });
  const state = { selection: { provider: backup.provider, modelId: backup.id, thinkingLevel: "low" }, notice: null, cancelled: false, resolveModel: async (ref) => runtime.getModel(ref.provider, ref.modelId) };
  const switches = [];
  state.onSwitch = (notice, thinkingLevel, primaryModel) => switches.push({ notice, thinkingLevel, primaryModel });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [createModelFallbackExtension(state)] });
  await loader.reload();
  let tools = 0;
  const { session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: manager, settingsManager: settings, modelRuntime: runtime, model: primary, thinkingLevel: "xhigh", resourceLoader: loader, tools: ["fixture_tool"], customTools: [{ name: "fixture_tool", label: "Fixture", description: "No side effects", parameters: { type: "object", properties: {} }, execute: async () => { tools++; return { content: [{ type: "text", text: "tool-completed" }], details: {} }; } }] });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc", onError: (error) => assert.fail(JSON.stringify(error)) });
  const requests = [];
  let primaryRequests = 0;
  session.agent.streamFunction = observeModelFallbackErrors((model, context) => {
    requests.push({ model: model.id, thinking: session.thinkingLevel, messages: context.messages });
    let content = [{ type: "text", text: "Backup finished the task" }];
    let stopReason = "stop";
    let errorMessage;
    if (model.id === primary.id) {
      primaryRequests++;
      if (primaryRequests === 1) { content = [{ type: "toolCall", id: "tool-1", name: "fixture_tool", arguments: {} }]; stopReason = "toolUse"; }
      else { content = []; stopReason = "error"; errorMessage = "usage_limit_reached"; }
    } else {
      assert.equal(readSessionPrimaryModel(manager.getBranch()).thinkingLevel, "xhigh");
      assert.equal(state.pending.primary.modelId, primary.id);
    }
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason, ...(errorMessage ? { errorMessage } : {}), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push(stopReason === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: stopReason, message });
      stream.end();
    });
    return stream;
  }, state);
  const settled = [];
  session.subscribe((event) => { if (event.type === "agent_settled") settled.push({ model: session.model.id, thinking: session.thinkingLevel }); });
  await session.prompt("Do the task using the fixture tool once");
  assert.deepEqual(requests.map((request) => request.model), [primary.id, primary.id, backup.id]);
  assert.deepEqual(requests.map((request) => request.thinking), ["xhigh", "xhigh", "low"]);
  assert.equal(tools, 1);
  assert.equal(requests.at(-1).messages.filter((message) => message.role === "user").length, 1, "does not resend the user prompt");
  assert.equal(requests.at(-1).messages.filter((message) => message.role === "toolResult").length, 1, "completed tool is retained, not replayed");
  assert.equal(requests.at(-1).messages.some((message) => message.stopReason === "error"), false);
  assert.equal(session.messages.at(-1).model, backup.id, "historical answer keeps actual backup attribution");
  assert.deepEqual(settled, [{ model: primary.id, thinking: "xhigh" }]);
  assert.equal(readSessionTemporaryFallback(manager.getBranch()), null);
  assert.equal(readSessionPrimaryModel(manager.getBranch()).thinkingLevel, "xhigh");
  const wrapper = new AgentSessionWrapper(session, { modelFallbackState: state });
  t.after(() => wrapper.destroy());
  const snapshot = await wrapper.send({ type: "get_state" });
  assert.equal(snapshot.primaryModel.modelId, primary.id);
  assert.equal(snapshot.primaryModel.thinkingLevel, "xhigh");
  await session.prompt("Continue with the next task");
  assert.deepEqual(requests.slice(3).map((request) => request.model), [primary.id, backup.id]);
  assert.deepEqual(requests.slice(3).map((request) => request.thinking), ["xhigh", "low"]);
  assert.equal(tools, 1, "a new run does not replay a completed tool");
  assert.equal(session.model.id, primary.id);
  assert.equal(session.thinkingLevel, "xhigh");
  assert.equal(settings.getDefaultThinkingLevel(), "medium", "temporary mutations never rewrite global defaults");
  assert.equal(switches.length, 1, "second switch is owned by the wrapper SSE callback");
});
