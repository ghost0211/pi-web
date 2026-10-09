import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
function callback(name) {
  const node = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(node, `missing ${name}`);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
function setup() {
  const writes = [];
  const requests = [];
  const context = createContext({
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "a" },
    promptRunIdRef: { current: 1 }, contextUsageRequestIdRef: { current: 0 }, contextUsageAppliedIdRef: { current: 0 },
    agentRunningRef: { current: true }, sdkAgentActiveRef: { current: true }, rpcPromptPendingRef: { current: true },
    setContextUsage: (value) => writes.push(value),
    fetch: (url) => { const request = Promise.withResolvers(); requests.push({ ...request, url }); return request.promise; },
    syncLiveModel() {}, applyAgentStateMetadata() {}, setIsCompacting() {}, setAutoCompactionEnabled() {}, setQueuedMessages() {},
    normalizeQueuedMessages: (value) => value, finishPromptWithoutStream: () => { throw new Error("busy run settled"); },
  });
  context.applyContextUsage = callback("applyContextUsage").runInContext(context);
  context.refreshContextUsage = callback("refreshContextUsage").runInContext(context);
  context.reconcileAgentState = callback("reconcileAgentState").runInContext(context);
  const reply = (index, usage, busy = true) => requests[index].resolve(Response.json({ running: busy, state: { contextUsage: usage, isStreaming: busy, isPromptRunning: busy } }));
  return { context, writes, requests, reply };
}
const usage = (tokens) => ({ percent: tokens / 100, contextWindow: 10_000, tokens });

test("a busy reconciliation refreshes context usage without settling the run", async () => {
  const state = setup();
  const pending = state.context.reconcileAgentState("a");
  state.reply(0, usage(100));
  await pending;
  assert.deepEqual(state.writes, [usage(100)]);
  assert.equal(state.context.agentRunningRef.current, true);
});

test("a newer assistant usage read wins over a delayed poll", async () => {
  const state = setup();
  const poll = state.context.reconcileAgentState("a");
  const refresh = state.context.refreshContextUsage("a");
  state.reply(1, usage(200)); await refresh;
  state.reply(0, usage(100)); await poll;
  assert.deepEqual(state.writes, [usage(200)]);
});

test("a failed newer read does not discard an older poll's usage", async () => {
  const state = setup();
  const poll = state.context.reconcileAgentState("a");
  const refresh = state.context.refreshContextUsage("a");
  state.requests[1].resolve(new Response("Unavailable", { status: 503 })); await refresh;
  state.reply(0, usage(100)); await poll;
  assert.deepEqual(state.writes, [usage(100)]);
});

test("a newer empty state response does not discard an older usable usage read", async () => {
  const state = setup();
  const poll = state.context.reconcileAgentState("a");
  const refresh = state.context.refreshContextUsage("a");
  state.requests[1].resolve(Response.json({ state: {} }));
  await refresh;
  state.reply(0, usage(100));
  await poll;
  assert.deepEqual(state.writes, [usage(100)]);
});

test("a delayed file estimate cannot overwrite newer SDK usage", async () => {
  const state = setup();
  const estimateId = ++state.context.contextUsageRequestIdRef.current;
  const refresh = state.context.refreshContextUsage("a");
  state.reply(0, usage(200));
  await refresh;
  state.context.applyContextUsage({ contextUsage: usage(100) }, "a", 1, estimateId);
  assert.deepEqual(state.writes, [usage(200)]);
});

test("usage replies from an old run, another session or an unmounted hook are ignored", async () => {
  for (const invalidate of [
    (ctx) => { ctx.promptRunIdRef.current++; },
    (ctx) => { ctx.sessionIdRef.current = "b"; },
    (ctx) => { ctx.sessionHookMountedRef.current = false; },
    (ctx) => { ctx.contextUsageAppliedIdRef.current = ctx.contextUsageRequestIdRef.current; },
  ]) {
    const state = setup();
    const pending = state.context.refreshContextUsage("a");
    invalidate(state.context); state.reply(0, usage(100)); await pending;
    assert.deepEqual(state.writes, []);
  }
});

test("failed reads preserve usage and a subsequent read can recover", async () => {
  const state = setup();
  const failed = state.context.refreshContextUsage("a");
  state.requests[0].resolve(new Response("Unavailable", { status: 503 })); await failed;
  const broken = state.context.refreshContextUsage("a");
  state.requests[1].reject(new TypeError("offline")); await broken;
  assert.deepEqual(state.writes, []);
  const recovered = state.context.refreshContextUsage("a");
  state.reply(2, null); await recovered;
  assert.deepEqual(state.writes, [null]);
});

test("only completed assistant messages trigger an immediate usage read", () => {
  const messageEnd = nodes.find((node) => ts.isCaseClause(node) && node.expression.getText(source) === '"message_end"');
  const script = new Script(ts.transpileModule(`(() => { switch(event.type) { ${messageEnd.getText(source)} } })()`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  for (const role of ["assistant", "toolResult", "user", "system"]) {
    const reads = [];
    script.runInNewContext({
      event: { type: "message_end", message: { role, content: [] } },
      agentRunningRef: { current: true }, sessionIdRef: { current: "a" }, optimisticUserMessageKeyRef: { current: null },
      isSystemMessageEvent: (event) => event.message.role === "system",
      normalizeToolCalls: (message) => message, userMessageKey: () => "user", setMessages() {}, dispatch() {}, setAgentPhase() {},
      estimateContextAfterMessageRef: { current: false },
      refreshContextUsage: (sid) => reads.push(sid),
    });
    assert.deepEqual(reads, role === "assistant" ? ["a"] : []);
  }
});

test("the actual manual compact callback reloads and refreshes without waiting for another prompt", async () => {
  const state = setup();
  const busy = [];
  const loaded = [];
  state.context.isCompacting = false;
  state.context.setIsCompacting = (value) => busy.push(value);
  state.context.setCompactError = () => {};
  state.context.setCompactResult = () => {};
  state.context.sendAgentCommand = async (sid, command) => {
    assert.equal(sid, "a"); assert.equal(command.type, "compact"); return { summary: "summary" };
  };
  state.context.readCompactResult = (result) => result;
  state.context.loadSession = async (sid, showLoading) => loaded.push([sid, showLoading]);
  state.context.handleCompact = callback("handleCompact").runInContext(state.context);
  const oldPoll = state.context.reconcileAgentState("a");
  await state.context.handleCompact();
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(loaded, [["a", true]]);
  assert.equal(state.requests.length, 2, "the callback starts an immediate new usage fetch");
  state.reply(0, usage(900)); await oldPoll;
  assert.deepEqual(state.writes, []);
  state.reply(1, usage(150));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.writes, [usage(150)]);
});

test("manual compact invalidates in-flight poll responses and triggers fresh usage read", async () => {
  const state = setup();
  // An in-flight poll started before manual compact
  const poll = state.context.reconcileAgentState("a");
  assert.equal(state.context.contextUsageRequestIdRef.current, 1);

  // Manual compact advances request ID and marks prior reads as applied/stale
  const compactId = ++state.context.contextUsageRequestIdRef.current;
  state.context.contextUsageAppliedIdRef.current = compactId;
  assert.equal(compactId, 2);

  // A post-compact usage refresh is requested
  const freshRefresh = state.context.refreshContextUsage("a");
  assert.equal(state.context.contextUsageRequestIdRef.current, 3);

  // Even if the old poll resolves after compact started, its reply is dropped
  state.reply(0, usage(900));
  await poll;
  assert.deepEqual(state.writes, [], "stale pre-compact poll usage was ignored");

  // When fresh post-compact refresh resolves, it is accepted
  state.reply(1, usage(150));
  await freshRefresh;
  assert.deepEqual(state.writes, [usage(150)], "post-compact usage is applied");
});
