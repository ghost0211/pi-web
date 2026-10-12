import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, getRunningRpcSessionStartedAt } = await jiti.import("./rpc-manager.ts");
const { buildSessionHistory } = await jiti.import("./session-reader.ts");
const { GET } = await jiti.import("../app/api/agent/running/route.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const sm = SessionManager.inMemory();
  let listener = () => {}, streaming = false, resolvePrompt, rejectPrompt;
  let mode = "normal";
  const events = [];
  const inner = {
    sessionId: sm.getSessionId(), sessionManager: sm, sessionFile: undefined,
    get isStreaming() { return streaming; }, isCompacting: false, isBashRunning: false,
    agent: { state: {} }, extensionRunner: {}, model: undefined,
    getContextUsage: () => undefined, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    subscribe: cb => { listener = cb; return () => { listener = () => {}; }; }, dispose() {},
    prompt(message, options) {
      if (mode === "reject") return Promise.reject(new Error("preflight denied"));
      if (mode === "handled") { options.preflightResult?.("handled"); return Promise.resolve(); }
      if (streaming) { options.preflightResult?.("queued"); return Promise.resolve(); }
      options.preflightResult?.("started");
      streaming = true;
      listener({ type: "agent_start" });
      sm.appendMessage({ role: "user", content: message, timestamp: Date.now() });
      return new Promise((resolve, reject) => { resolvePrompt = resolve; rejectPrompt = reject; });
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  const oldTimeout = process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS;
  process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS = "0";
  wrapper.onEvent(event => events.push(event)); wrapper.start();
  t.after(() => { wrapper.destroy(); if (oldTimeout === undefined) delete process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS; else process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS = oldTimeout; });
  const appendAssistant = (text = "done") => sm.appendMessage({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
  const records = () => sm.getEntries().filter(e => e.type === "custom" && e.customType === "pi-web:run-timing");
  const finish = async ({ aborted = false, error = false, settled = true, assistant = true } = {}) => {
    if (assistant) appendAssistant(error ? "error" : "done");
    streaming = false;
    listener({ type: "agent_end" });
    if (settled) listener({ type: "agent_settled", aborted });
    if (error) rejectPrompt?.(new Error("runtime failed")); else resolvePrompt?.();
    resolvePrompt = undefined; rejectPrompt = undefined;
    await flush();
  };
  return { sm, inner, wrapper, events, appendAssistant, records, finish, emit: e => listener(e), setStreaming: value => { streaming = value; }, mode: value => { mode = value; } };
}

test("RPC and running API keep one start through retry/queued prompts, then persist final timing", async t => {
  const f = fixture(t);
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[f.inner.sessionId, f.wrapper]]);
  t.after(() => { globalThis.__piSessions = previous; });
  await f.wrapper.send({ type: "prompt", message: "work", promptToken: "one" });
  const startedAt = f.wrapper.getRunningStartedAt();
  assert.equal(typeof startedAt, "number");
  const state = await f.wrapper.send({ type: "get_state" });
  assert.equal(state.runStartedAt, startedAt);
  assert.equal(getRunningRpcSessionStartedAt()[f.inner.sessionId], startedAt);
  assert.equal((await (await GET()).json()).runningSessionStartedAt[f.inner.sessionId], startedAt);
  f.appendAssistant("intermediate attempt");
  f.emit({ type: "agent_end" });
  f.emit({ type: "auto_compaction_start" });
  f.emit({ type: "auto_compaction_end" });
  f.emit({ type: "agent_start" });
  await f.wrapper.send({ type: "prompt", message: "queued addition", streamingBehavior: "followUp", promptToken: "queued" });
  await flush();
  assert.equal(f.wrapper.getRunningStartedAt(), startedAt);
  assert.equal(f.records().length, 0);
  await f.finish();
  assert.equal(f.records().length, 1);
  const record = f.records()[0].data;
  assert.equal(record.startedAt, startedAt);
  assert.equal(record.aborted, false);
  assert.equal(f.wrapper.getRunningStartedAt(), null);
  assert.equal((await f.wrapper.send({ type: "get_state" })).runStartedAt, null);
  const history = buildSessionHistory(f.sm.getEntries());
  const answers = history.messages.filter(m => m.role === "assistant");
  assert.equal(answers.at(-1).runDurationMs, record.durationMs);
  assert.equal(answers.at(-1).runDurationEstimated, false);
  assert.equal(answers[0].runDurationMs, undefined);
  assert.deepEqual(f.sm.buildSessionContext().messages.map(m => m.role), ["user", "assistant", "assistant"]);
});

test("later success, abort, error and legacy settlement each own a separate completed record", async t => {
  const f = fixture(t);
  for (const options of [{}, { aborted: true }, { error: true }, { settled: false }]) {
    await f.wrapper.send({ type: "prompt", message: "new run" });
    await f.finish(options);
  }
  assert.equal(f.records().length, 4);
  assert.equal(new Set(f.records().map(r => r.data.runId)).size, 4);
  assert.deepEqual(f.records().map(r => r.data.aborted), [false, true, false, false]);
  assert.equal(f.events.filter(e => e.type === "prompt_error").length, 1);
});

test("preflight rejection, handled commands and runs without an assistant leave no false timing", async t => {
  const f = fixture(t);
  f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: Date.now() });
  f.mode("reject");
  await assert.rejects(f.wrapper.send({ type: "prompt", message: "denied" }), /preflight denied/);
  assert.equal(f.wrapper.getRunningStartedAt(), null);
  f.mode("handled");
  await f.wrapper.send({ type: "prompt", message: "/command" });
  await flush();
  assert.equal(f.records().length, 0);
  f.mode("normal");
  await f.wrapper.send({ type: "prompt", message: "cancel before output" });
  await f.finish({ aborted: true, assistant: false });
  assert.equal(f.records().length, 0);
});

test("independent extension runs get new timing and late original prompt completion cannot finish them", async t => {
  const f = fixture(t);
  await f.wrapper.send({ type: "prompt", message: "initial" });
  f.appendAssistant("initial answer");
  f.setStreaming(false);
  f.emit({ type: "agent_settled" });
  const originalId = f.records()[0].data.runId;
  f.setStreaming(true);
  f.emit({ type: "agent_start" });
  const extensionStartedAt = f.wrapper.getRunningStartedAt();
  // Resolving the original prompt while an autonomous new run is streaming
  // must not discard/settle that new timer.
  await f.finish({ assistant: false, settled: false });
  f.setStreaming(true);
  assert.equal(f.wrapper.getRunningStartedAt(), extensionStartedAt);
  assert.equal(f.records().length, 1);
  f.appendAssistant("extension answer");
  f.setStreaming(false);
  f.emit({ type: "agent_settled" });
  assert.equal(f.records().length, 2);
  assert.notEqual(f.records()[1].data.runId, originalId);
});

test("destroy prevents late SDK completion from writing metadata", async t => {
  const f = fixture(t);
  await f.wrapper.send({ type: "prompt", message: "shutdown" });
  f.wrapper.destroy();
  await f.finish();
  assert.equal(f.records().length, 0);
  assert.equal(f.wrapper.getRunningStartedAt(), null);
});
