import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseFallbackModel, parseModelFallbackNotice } = await jiti.import("../lib/model-fallback.ts");
const { normalizeThinkingLevelOption } = await jiti.import("../lib/thinking-level-options.ts");
const source = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
(function visit(node) { nodes.push(node); ts.forEachChild(node, visit); })(source);
function callback(name) {
  const node = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(node, name);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
const primary = { provider: "fixture", modelId: "gpt-sol", thinkingLevel: "xhigh" };
const backup = { provider: "fixture", modelId: "deepseek", thinkingLevel: "low" };
const notice = { from: { provider: primary.provider, modelId: primary.modelId }, to: { provider: backup.provider, modelId: backup.modelId }, ruleId: "portable.usage_limit_reached", kind: "subscription-limit", timestamp: 123 };
function fixture() {
  const writes = { models: [], levels: [], runtime: [], notices: [], errors: [], backup: [] };
  const context = createContext({
    parseFallbackModel, parseModelFallbackNotice, normalizeThinkingLevelOption, URLSearchParams,
    parseRuntimeModel: (value) => value?.provider && value?.id ? { provider: value.provider, modelId: value.id } : null,
    modelSwitchPendingRef: { current: false }, fallbackChangePendingRef: { current: false },
    modelThinkingLevelsRef: { current: { "fixture:gpt-sol": ["off", "high", "xhigh"], "fixture:deepseek": ["low", "high"] } },
    modelThinkingLevelPinsRef: { current: { "fixture/deepseek": "high" } },
    fallbackModelRef: { current: backup }, fallbackPreferenceInitializedRef: { current: false }, fallbackSelectionKnownRef: { current: false },
    fallbackNoticeTimestampRef: { current: -1 }, fallbackNoticeFingerprintRef: { current: null },
    fallbackNoticeAnnouncementRef: { current: { initialized: false, fingerprint: null } },
    displayModelRef: { current: primary }, contextModelRef: { current: primary }, modelListRef: { current: [] },
    sessionIdRef: { current: "session" }, sessionHookMountedRef: { current: true }, agentRunningRef: { current: true },
    promptRunIdRef: { current: 1 }, contextUsageRequestIdRef: { current: 0 }, contextUsageAppliedIdRef: { current: 0 }, contextUsageRef: { current: null },
    promptTokenOwnerRef: { current: "hook" }, activePromptTokenRef: { current: "hook:1" },
    isStaleLocalPromptToken: (token, owner, active) => token?.startsWith(`${owner}:`) && token !== active,
    setCurrentModelOverride: (value) => { if (typeof value !== "function") writes.models.push(value); },
    setThinkingLevel: (value) => writes.levels.push(value), setRuntimeModel: (value) => writes.runtime.push(value),
    setFallbackModelState: (value) => writes.backup.push(value),
    dispatchNotice: (value) => writes.notices.push(value), createNoticeId: () => "notice", t: (key) => key,
    applyContextUsage() {}, setLoading() {}, setData() {}, setActiveLeafId() {}, setMessages() {}, setEntryIds() {}, setHistoryCursor() {},
    setHasEarlierMessages() {}, setFirstEntryParentId() {}, setTurnIndex() {}, setToolPresetState() {},
    setError: (value) => { if (value) writes.errors.push(value); },
    calculateActiveContextTokens: () => ({ tokens: 0 }), resolveModelContextWindow: () => 100000,
    setAgentRunning() {}, setAgentPhase() {}, setRetryInfo() {}, setActiveToolResults() {}, dispatch() {},
  });
  for (const name of ["applyPrimaryThinkingLevel", "applyPrimaryModelSelection", "applyRuntimeModel", "applyFallbackModelSelection", "applyFallbackNotice", "applyAgentStateMetadata", "settleUiStage", "loadSession"]) context[name] = callback(name).runInContext(context);
  const node = nodes.find((node) => ts.isCaseClause(node) && node.expression.getText(source) === '"model_fallback"');
  const eventScript = new Script(ts.transpileModule(`(() => { switch(event.type) { ${node.getText(source)} } })()`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  return { context, writes, emit: (event) => { context.event = event; eventScript.runInContext(context); } };
}

test("fallback SSE updates execution only and keeps GPT primary xhigh, not backup low or its high pin", () => {
  const f = fixture();
  f.emit({ type: "model_fallback", notice, thinkingLevel: "low", primaryModel: primary, promptToken: "hook:1" });
  assert.deepEqual(f.writes.models, [primary]);
  assert.deepEqual(f.writes.levels, ["xhigh"]);
  assert.equal(f.writes.runtime[0].modelId, backup.modelId);
  assert.deepEqual(f.writes.backup, []);
  assert.equal(f.writes.notices.length, 1);
  f.emit({ type: "model_fallback", notice, thinkingLevel: "low", primaryModel: primary, promptToken: "hook:1" });
  assert.equal(f.writes.models.length, 1, "replayed audit event is not a new configuration or execution change");
});

test("poll/reconnect metadata separates primary controls from actual backup execution", () => {
  const f = fixture();
  f.context.applyAgentStateMetadata({ model: { provider: backup.provider, id: backup.modelId }, thinkingLevel: "low", primaryModel: primary, fallbackModel: backup, fallbackNotice: notice });
  assert.deepEqual(f.writes.models, [primary]);
  assert.deepEqual(f.writes.levels, ["xhigh"]);
  assert.equal(f.context.contextModelRef.current.modelId, backup.modelId);
  assert.deepEqual(f.writes.backup, [backup]);
  f.context.applyAgentStateMetadata({ model: { provider: primary.provider, id: primary.modelId }, thinkingLevel: "xhigh", primaryModel: primary, fallbackNotice: notice });
  assert.equal(f.writes.notices.length, 0, "snapshot reads do not replay persisted audits as warnings");
  assert.equal(f.writes.models.at(-1).modelId, primary.modelId);
});

test("historical or old-server fallback notice alone never replaces primary or its thinking", () => {
  const f = fixture();
  f.context.applyFallbackNotice(notice, false, true);
  f.context.applyAgentStateMetadata({ model: { provider: backup.provider, id: backup.modelId }, thinkingLevel: "low", fallbackNotice: notice });
  assert.deepEqual(f.writes.models, []);
  assert.deepEqual(f.writes.levels, []);
  assert.equal(f.writes.runtime.at(-1).modelId, backup.modelId);
  assert.deepEqual(f.writes.notices, []);
});

test("session detail reload uses primary snapshot even while raw SDK context says backup low", async () => {
  const f = fixture();
  f.context.fetch = async () => Response.json({ sessionId: "session", leafId: "leaf", context: { model: { provider: backup.provider, modelId: backup.modelId }, thinkingLevel: "low", messages: [], entryIds: [] }, primaryModel: primary, fallbackModel: backup, fallbackNotice: notice });
  await f.context.loadSession("session");
  assert.deepEqual(f.writes.errors, []);
  assert.deepEqual(f.writes.models, [primary]);
  assert.deepEqual(f.writes.levels, ["xhigh"]);
  assert.equal(f.context.contextModelRef.current.modelId, backup.modelId);
});

test("settlement clears temporary execution, returning context limits to the primary", () => {
  const f = fixture();
  f.context.applyRuntimeModel(backup);
  f.context.settleUiStage();
  assert.equal(f.context.agentRunningRef.current, false);
  assert.deepEqual(f.writes.runtime, [backup, null]);
  assert.deepEqual(f.context.contextModelRef.current, primary);
  assert.deepEqual(f.writes.levels, []);
});

test("stale local fallback events and pending manual selections cannot overwrite a newer choice", () => {
  const f = fixture();
  f.emit({ type: "model_fallback", notice, primaryModel: primary, promptToken: "hook:0" });
  assert.deepEqual(f.writes.models, []);
  assert.deepEqual(f.writes.runtime, []);
  f.context.modelSwitchPendingRef.current = true;
  f.context.applyAgentStateMetadata({ model: { provider: backup.provider, id: backup.modelId }, primaryModel: primary, thinkingLevel: "low" });
  assert.deepEqual(f.writes.models, []);
  assert.deepEqual(f.writes.levels, []);
  f.context.modelSwitchPendingRef.current = false;
  f.context.contextUsageAppliedIdRef.current = 10;
  f.context.applyAgentStateMetadata({ model: { provider: backup.provider, id: backup.modelId }, primaryModel: primary, thinkingLevel: "low" }, true, 9);
  assert.deepEqual(f.writes.runtime, [], "older polls cannot replace the newer execution/context snapshot");
});

const primaryState = (fallbackNotice = notice) => ({ model: { provider: primary.provider, id: primary.modelId }, thinkingLevel: "xhigh", primaryModel: primary, fallbackModel: backup, fallbackNotice, isStreaming: false, isPromptRunning: false });
const backupState = (fallbackNotice = notice) => ({ ...primaryState(fallbackNotice), model: { provider: backup.provider, id: backup.modelId }, thinkingLevel: "low", isStreaming: true });
const detail = () => ({ sessionId: "session", leafId: "leaf", context: { model: primary, thinkingLevel: "xhigh", messages: [], entryIds: [] }, primaryModel: primary, fallbackModel: backup, fallbackNotice: notice });

test("opening a restored session repeatedly initializes file and live metadata silently", async () => {
  for (let visit = 0; visit < 3; visit++) {
    const f = fixture();
    f.context.agentRunningRef.current = false;
    f.context.fetch = async (url) => Response.json(url.endsWith("/state") ? { running: true, state: primaryState() } : detail());
    await f.context.loadSession("session", true, true);
    assert.deepEqual(f.writes.errors, []);
    assert.deepEqual(f.writes.notices, [], `visit ${visit} must not replay the historical quota toast`);
    assert.equal(f.writes.models.at(-1).modelId, primary.modelId);
    assert.equal(f.context.fallbackNoticeAnnouncementRef.current.initialized, true);
    assert.ok(f.context.fallbackNoticeFingerprintRef.current, "the audit is still read, not deleted");
  }
});

test("first state snapshots are silent even for a currently running backup", () => {
  for (const state of [primaryState(), backupState()]) {
    const f = fixture();
    f.context.applyAgentStateMetadata(state, true);
    assert.deepEqual(f.writes.notices, [], "initial snapshot is a history baseline, not a fresh switch");
  }
});

test("idle, restored and stale-primary audits cannot create a fresh fallback warning during polling", () => {
  const f = fixture();
  f.context.applyAgentStateMetadata(primaryState(null));
  for (const state of [primaryState(), { ...backupState(), isStreaming: false }, { ...primaryState(), isStreaming: true }, backupState({ ...notice, from: { provider: primary.provider, modelId: "previous-primary" } })]) {
    f.context.applyAgentStateMetadata(state, true);
  }
  assert.deepEqual(f.writes.notices, []);
});

test("a genuinely new live switch still warns once after history was loaded, and later runs can warn again", () => {
  const f = fixture();
  f.context.applyAgentStateMetadata(primaryState());
  const newer = { ...notice, timestamp: notice.timestamp + 1 };
  f.emit({ type: "model_fallback", notice: newer, primaryModel: primary, promptToken: "hook:1" });
  f.emit({ type: "model_fallback", notice: newer, primaryModel: primary, promptToken: "hook:1" });
  f.context.applyAgentStateMetadata(backupState(newer), true);
  assert.equal(f.writes.notices.length, 1);
  f.context.applyAgentStateMetadata(primaryState(newer), true);
  f.emit({ type: "model_fallback", notice: { ...newer, timestamp: newer.timestamp + 1 }, primaryModel: primary, promptToken: "hook:1" });
  assert.equal(f.writes.notices.length, 2, "deduplication must not disable future real fallback notices");
});

test("silent mid-run file reads do not swallow the subsequent live switch warning", async () => {
  const f = fixture();
  f.context.applyAgentStateMetadata(primaryState(null));
  f.context.fetch = async () => Response.json({ ...detail(), context: { ...detail().context, model: backup, thinkingLevel: "low" } });
  await f.context.loadSession("session");
  assert.deepEqual(f.writes.notices, []);
  f.emit({ type: "model_fallback", notice, primaryModel: primary, promptToken: "hook:1" });
  assert.equal(f.writes.notices.length, 1, "history sync is not the announcement watermark");
});

test("running-state reconciliation catches a new missed SSE once, without replay on SSE reconnect", () => {
  const f = fixture();
  f.context.applyAgentStateMetadata(primaryState(null));
  f.context.applyAgentStateMetadata(backupState(), true);
  f.context.applyAgentStateMetadata(backupState(), true);
  f.emit({ type: "model_fallback", notice, primaryModel: primary, promptToken: "hook:1" });
  assert.equal(f.writes.notices.length, 1);
});

test("late idle SSE and reconnect replay of the opening history baseline are silent", () => {
  const f = fixture();
  f.context.agentRunningRef.current = false;
  f.emit({ type: "model_fallback", notice, primaryModel: primary });
  assert.deepEqual(f.writes.notices, []);
  assert.deepEqual(f.writes.runtime, []);
  f.context.applyAgentStateMetadata(primaryState());
  f.context.agentRunningRef.current = true;
  f.emit({ type: "model_fallback", notice, primaryModel: primary });
  assert.deepEqual(f.writes.notices, []);
});
