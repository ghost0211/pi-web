import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const { AgentSessionWrapper } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, hook) {
  const root = await mkdtemp(join(tmpdir(), "pi-sdk-1.2-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("startup-fixture", { api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "fixture-not-real", models: [{ id: "main", name: "Main", reasoning: false, input: ["text"], contextWindow: 50000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = runtime.getModel("startup-fixture", "main");
  const manager = SessionManager.inMemory(root);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => pi.on("before_agent_start", hook)] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: manager, settingsManager: settings, modelRuntime: runtime, model, thinkingLevel: "off", resourceLoader: loader, noTools: true });
  const errors = [];
  await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
  const requests = [];
  const streamSignals = [];
  session.agent.streamFunction = (selected, context, options) => {
    const aborted = options?.signal?.aborted === true;
    streamSignals.push(aborted);
    // The SDK invokes the stream adapter with the cancellation signal. Like
    // a real transport, this fixture must honor it rather than return success.
    if (!aborted) requests.push(context);
    const message = { role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), content: aborted ? [] : [{ type: "text", text: "Fixture answer" }], stopReason: aborted ? "aborted" : "stop", usage };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push(aborted ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: "stop", message }); stream.end(); });
    return stream;
  };
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  t.after(() => { wrapper.destroy(); assert.deepEqual(errors, [], "no extension runtime errors"); });
  return { session, wrapper, requests, streamSignals, manager };
}

for (const messageType of ["user", "custom"]) {
  test(`SDK 1.2 ${messageType} preparation is busy and Stop carries abort into the first stream`, { timeout: 10000 }, async t => {
    const entered = deferred();
    const release = deferred();
    const events = [];
    const { session, wrapper, requests, streamSignals } = await fixture(t, async (event, ctx) => {
      events.push({ type: event.messageType, idle: ctx.isIdle() });
      entered.resolve();
      await release.promise;
    });
    t.after(() => release.resolve());
    let settled = 0;
    session.subscribe(event => { if (event.type === "agent_settled") settled++; });
    const run = messageType === "user" ? session.prompt("Bounded task") : session.sendCustomMessage({ customType: "pi-web:auto-advance", content: "AI-generated continuation, not user authorization", display: true }, { triggerTurn: true });
    await entered.promise;
    assert.equal(session.isStreaming, true);
    assert.equal(session.isIdle, false);
    assert.equal(wrapper.isRunning(), true, "wrapper sees preparation as active, not just the low-level model stream");
    const abortEntered = deferred();
    const abortSession = session.abort.bind(session);
    session.abort = () => { const pending = abortSession(); abortEntered.resolve(); return pending; };
    const abort = wrapper.send({ type: "abort" });
    // send() first crosses the async mutation guard. Hold preparation until
    // that command actually reaches the SDK, rather than racing its dispatch.
    await abortEntered.promise;
    release.resolve();
    await Promise.all([run, abort]);
    await session.waitForIdle();
    assert.deepEqual(events, [{ type: messageType, idle: false }]);
    assert.deepEqual(streamSignals, [true], "the initial adapter receives an already-aborted signal");
    assert.equal(requests.length, 0, "a cancellation-aware transport does not issue a request");
    assert.equal(session.messages.at(-1).stopReason, "aborted");
    assert.equal(settled, 1);
    assert.equal(session.isIdle, true);
    assert.equal(wrapper.isRunning(), false);
  });
}

test("custom messages queued during startup remain in the same run without fabricated user prompts", { timeout: 10000 }, async t => {
  const entered = deferred();
  const release = deferred();
  let preparations = 0;
  const { session, manager, requests } = await fixture(t, async event => {
    preparations++;
    assert.equal(event.messageType, "custom");
    assert.equal(event.prompt, undefined);
    entered.resolve();
    await release.promise;
  });
  t.after(() => release.resolve());
  const run = session.sendCustomMessage({ customType: "pi-web:auto-advance", content: "Bounded suggestion, not permission", display: true }, { triggerTurn: true });
  await entered.promise;
  await session.sendCustomMessage({ customType: "pi-web:subagent-notification", content: "Fixture report, not approval", display: true }, { triggerTurn: true });
  release.resolve();
  await run;
  await session.waitForIdle();
  assert.equal(preparations, 1);
  assert.ok(requests.length >= 1);
  assert.deepEqual(manager.getEntries().filter(entry => entry.type === "custom_message").map(entry => entry.customType), ["pi-web:auto-advance", "pi-web:subagent-notification"]);
  assert.equal(manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user").length, 0);
  assert.equal(session.isIdle, true);
});
