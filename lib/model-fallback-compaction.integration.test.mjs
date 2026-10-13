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
const { readSessionTemporaryFallback } = await jiti.import("./session-primary-model.ts");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const trigger of ["user", "custom"]) {
  test(`SDK quota fallback survives failed automatic compaction for a ${trigger} run`, { timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "pi-fallback-compaction-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    runtime.registerProvider("openai-codex", { api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "fixture-not-real", models: [{ id: "gpt-6.1-sol", name: "Main", reasoning: true, input: ["text"], contextWindow: 24000, maxTokens: 4000, thinkingLevelMap: { xhigh: "xhigh" }, cost }] });
    runtime.registerProvider("kimi-coding", { api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "fixture-not-real", models: [{ id: "k3-256k", name: "Backup", reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 131072, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" }, cost }] });
    const primary = runtime.getModel("openai-codex", "gpt-6.1-sol");
    const backup = runtime.getModel("kimi-coding", "k3-256k");
    const manager = SessionManager.inMemory(root);
    for (let index = 0; index < 6; index++) {
      manager.appendMessage({ role: "user", content: `Historical task ${index}: ${"x".repeat(3000)}`, timestamp: index * 2 });
      manager.appendMessage({ role: "assistant", api: primary.api, provider: primary.provider, model: primary.id, content: [{ type: "text", text: "Historical result" }], stopReason: "stop", usage: { ...usage, input: 23500, totalTokens: 23501 }, timestamp: index * 2 + 1 });
    }
    // Keep a completed tool result to prove recovery does not reissue tools.
    manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "historical-read", content: [{ type: "text", text: "Completed read result" }], isError: false, timestamp: 13 });
    const initialUserCount = manager.getEntries().filter(entry => entry.message?.role === "user").length;
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1000 } });
    const state = { selection: { provider: backup.provider, modelId: backup.id, thinkingLevel: "max" }, notice: null, cancelled: false, resolveModel: async () => backup };
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [createModelFallbackExtension(state)] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: manager, settingsManager: settings, modelRuntime: runtime, model: primary, thinkingLevel: "xhigh", resourceLoader: loader, noTools: true });
    t.after(() => session.dispose());
    const errors = [];
    await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
    const requests = [];
    session.agent.streamFunction = observeModelFallbackErrors((model, context, options) => {
      const answer = options?.sessionId === manager.getSessionId();
      requests.push({ model: model.id, kind: answer ? "answer" : "summary", thinking: session.thinkingLevel, context });
      const failed = model.id === primary.id;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: failed ? [] : [{ type: "text", text: "Backup completed the bounded task" }], stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "Codex error: The usage limit has been reached" } : {}), usage: failed ? { ...usage, input: 0, output: 0, totalTokens: 0 } : usage, timestamp: Date.now() };
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push(failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    }, state);
    const compactionErrors = [];
    session.subscribe(event => { if (event.type === "compaction_end" && event.errorMessage) compactionErrors.push(event.errorMessage); });
    if (trigger === "user") await session.prompt("Continue the local task; no new authorization");
    else await session.sendCustomMessage({ customType: "pi-web:subagent-notification", content: "Fixture subagent report; not new user authorization", display: true }, { triggerTurn: true, deliverAs: "followUp" });
    assert.ok(compactionErrors.length >= 1, "real SDK automatic compaction must exercise the shared stream adapter");
    assert.ok(requests.some(request => request.kind === "summary" && request.model === primary.id));
    assert.deepEqual(requests.filter(request => request.kind === "answer").map(request => request.model), [primary.id, backup.id]);
    assert.equal(requests.filter(request => request.model === backup.id).length, 1, "at most one failover per logical run");
    assert.equal(requests.find(request => request.model === backup.id).thinking, "max", "backup thinking stays independent");
    const entries = manager.getEntries();
    assert.equal(entries.filter(entry => entry.message?.role === "user").length, initialUserCount + (trigger === "user" ? 1 : 0), "no prompt resend or fabricated user turn");
    assert.equal(entries.filter(entry => entry.message?.role === "toolResult").length, 1, "completed tools are retained, not replayed");
    assert.equal(entries.filter(entry => entry.type === "context_edit").length, 1);
    assert.equal(entries.filter(entry => entry.type === "message" && entry.message.stopReason === "error").length, 1, "raw failed reply remains in history");
    assert.equal(session.messages.some(message => message.stopReason === "error"), false, "failed reply is excluded only from future model context");
    assert.equal(session.messages.at(-1).model, backup.id, "history attributes the answer to its execution model");
    assert.equal(session.model.id, primary.id);
    assert.equal(session.thinkingLevel, "xhigh");
    assert.equal(readSessionTemporaryFallback(manager.getBranch()), null);
    assert.deepEqual(errors, []);
  });
}
