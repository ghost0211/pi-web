import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseFallbackModel } = await jiti.import("../lib/model-fallback.ts");
const { normalizeThinkingLevelOption } = await jiti.import("../lib/thinking-level-options.ts");
const source = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
(function visit(node) { nodes.push(node); ts.forEachChild(node, visit); })(source);
function callback(name) {
  const node = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(node, name);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
function setup() {
  const writes = { commands: [], primaryLevels: [], backup: [], preferences: [], notices: [], models: [] };
  const primary = { provider: "p", modelId: "primary" };
  const backup = { provider: "b", modelId: "backup", thinkingLevel: "low" };
  const levels = { "p:primary": ["off", "low", "high", "max"], "b:backup": ["low", "high"], "b:other": ["off", "medium"] };
  const context = createContext({
    parseFallbackModel, normalizeThinkingLevelOption,
    fallbackChangePendingRef: { current: false }, modelSwitchPendingRef: { current: false },
    agentRunningRef: { current: false }, bashRunningRef: { current: false }, isCompacting: false,
    fallbackModelRef: { current: backup }, fallbackPreferenceTouchedRef: { current: false },
    fallbackPreferenceInitializedRef: { current: false }, fallbackSelectionKnownRef: { current: true },
    fallbackChangeRequestRef: { current: 0 }, sessionIdRef: { current: "session" }, ensuringNewSessionRef: { current: null },
    modelThinkingLevelsRef: { current: levels }, modelThinkingLevels: levels, modelThinkingLevelPins: {}, modelThinkingLevelPinsRef: { current: {} },
    displayModelRef: { current: primary }, thinkingLevel: "max", isNew: false,
    thinkingLevelOverrideRef: { current: "max" }, newSessionModelOverrideRef: { current: primary },
    currentModelOverride: null,
    setFallbackModelState: (value) => writes.backup.push(value),
    setFallbackModelPreference: (value) => writes.preferences.push(value),
    setFallbackModelSwitching() {}, setModelSwitching() {},
    setThinkingLevel: (value) => writes.primaryLevels.push(value),
    setNewSessionModel: (value) => writes.models.push(value), setPendingModel() {}, setCurrentModelOverride() {},
    addNotice: (notice) => writes.notices.push(notice), loadSession: async () => {},
    sendAgentCommand: async (sid, command) => { writes.commands.push({ sid, command }); return command.model; },
  });
  for (const name of ["applyFallbackModelSelection", "applyFallbackThinkingLevel", "handleFallbackModelChange", "handleFallbackThinkingLevelChange", "handleThinkingLevelChange", "handleModelChange"]) {
    context[name] = callback(name).runInContext(context);
  }
  return { context, writes, backup };
}

test("backup thinking writes only backup configuration, not the primary thinking level", async () => {
  const { context, writes } = setup();
  await context.handleFallbackThinkingLevelChange("high");
  assert.equal(writes.commands.length, 1);
  assert.equal(writes.commands[0].command.type, "set_fallback_model");
  assert.equal(writes.commands[0].command.model.thinkingLevel, "high");
  assert.deepEqual(writes.primaryLevels, []);
  assert.equal(context.fallbackModelRef.current.thinkingLevel, "high");
});

test("primary thinking updates only the active model and leaves the backup preference alone", async () => {
  const { context, writes, backup } = setup();
  await context.handleThinkingLevelChange("high");
  assert.equal(writes.commands[0].command.type, "set_thinking_level");
  assert.equal(writes.commands[0].command.level, "high");
  assert.deepEqual(context.fallbackModelRef.current, backup);
  assert.deepEqual(writes.preferences, []);
});

test("no backup, unsupported backup levels and busy writes cannot change preferences", async () => {
  for (const [invalidate, level] of [
    [(ctx) => { ctx.fallbackModelRef.current = null; }, "high"],
    [() => {}, "max"],
    [(ctx) => { ctx.fallbackChangePendingRef.current = true; }, "high"],
    [(ctx) => { ctx.agentRunningRef.current = true; }, "high"],
  ]) {
    const { context, writes } = setup();
    invalidate(context);
    await context.handleFallbackThinkingLevelChange(level);
    assert.deepEqual(writes.commands, []);
  }
});

test("normalized server confirmation is the value saved for fresh-composer preferences", async () => {
  const { context, writes } = setup();
  context.sendAgentCommand = async () => ({ provider: "b", modelId: "backup", thinkingLevel: "auto" });
  await context.handleFallbackThinkingLevelChange("high");
  assert.equal(context.fallbackModelRef.current.thinkingLevel, "auto");
  assert.equal(writes.preferences.at(-1).thinkingLevel, "auto");
});

test("failed backup thinking writes roll back the whole previous configuration", async () => {
  const { context, writes, backup } = setup();
  context.sendAgentCommand = async () => { throw new Error("unavailable"); };
  await context.handleFallbackThinkingLevelChange("high");
  assert.deepEqual(context.fallbackModelRef.current, backup);
  assert.equal(writes.notices.length, 1);
  assert.deepEqual(writes.preferences, []);
  assert.deepEqual(writes.primaryLevels, []);
});

test("switching the backup resets its thinking default instead of carrying a different model's level", async () => {
  const { context, writes } = setup();
  await context.handleFallbackModelChange({ provider: "b", modelId: "other" });
  assert.equal(context.fallbackModelRef.current.thinkingLevel, undefined);
  assert.equal(writes.commands[0].command.type, "set_fallback_model");
  assert.deepEqual(writes.primaryLevels, []);
});

test("a draft primary model switch clears incompatible explicit thinking from startup", async () => {
  const { context, writes } = setup();
  context.isNew = true;
  context.sessionIdRef.current = null;
  await context.handleModelChange("b", "other");
  assert.equal(context.thinkingLevelOverrideRef.current, null);
  assert.deepEqual(writes.primaryLevels, ["auto"]);
  assert.deepEqual(writes.commands, []);
});

test("reported backup thinking wins over its implicit scope pin", () => {
  const { context, writes, backup } = setup();
  context.modelThinkingLevelPinsRef.current["b/backup"] = "high";
  context.applyFallbackThinkingLevel("low", backup);
  assert.deepEqual(writes.primaryLevels, ["low"]);
  context.applyFallbackThinkingLevel(undefined, backup);
  assert.deepEqual(writes.primaryLevels, ["low", "high"], "only absent runtime levels fall back to pins");
});

test("failed primary thinking restores its level without touching backup state", async () => {
  const { context, writes, backup } = setup();
  context.sendAgentCommand = async () => { throw new Error("failed"); };
  await context.handleThinkingLevelChange("high");
  assert.deepEqual(writes.primaryLevels, ["high", "max"]);
  assert.deepEqual(context.fallbackModelRef.current, backup);
  assert.equal(writes.notices.length, 1);
  assert.equal(context.modelSwitchPendingRef.current, false);
});

test("scope pins update a draft menu without becoming explicit global startup preferences", async () => {
  const { context, writes } = setup();
  context.isNew = true;
  context.sessionIdRef.current = null;
  context.modelThinkingLevelPins["b/other"] = "medium";
  await context.handleModelChange("b", "other");
  assert.equal(context.thinkingLevelOverrideRef.current, null);
  assert.deepEqual(writes.primaryLevels, ["medium"]);
});
