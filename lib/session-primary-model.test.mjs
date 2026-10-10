import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { readSessionPrimaryModel, readSessionTemporaryFallback, PRIMARY_MODEL_SNAPSHOT_TYPE } = await jiti.import("./session-primary-model.ts");
const { MODEL_FALLBACK_EVENT_TYPE } = await jiti.import("./session-model-fallback.ts");
const primary = { provider: "fixture", modelId: "gpt-sol", thinkingLevel: "xhigh" };
const backup = { provider: "fixture", modelId: "deepseek", thinkingLevel: "low" };
function manager() {
  const sm = SessionManager.inMemory(process.cwd());
  sm.appendModelChange(primary.provider, primary.modelId);
  sm.appendThinkingLevelChange(primary.thinkingLevel);
  return sm;
}
function legacySwitch(sm) {
  sm.appendModelChange(backup.provider, backup.modelId);
  sm.appendThinkingLevelChange("medium");
  sm.appendThinkingLevelChange(backup.thinkingLevel);
  sm.appendCustomEntry(MODEL_FALLBACK_EVENT_TYPE, { version: 1, notice: { from: { provider: primary.provider, modelId: primary.modelId }, to: { provider: backup.provider, modelId: backup.modelId }, kind: "subscription-limit", ruleId: "portable.usage_limit_reached", timestamp: 123 } });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "answered by backup" }], provider: backup.provider, model: backup.modelId, api: "openai-completions", stopReason: "stop", timestamp: 123 });
}

test("ordinary primary selection keeps thinking and ignores physical assistant dispatch metadata", () => {
  const sm = manager();
  sm.appendMessage({ role: "assistant", content: [], provider: backup.provider, model: backup.modelId, timestamp: 123 });
  assert.deepEqual(readSessionPrimaryModel(sm.getBranch()), primary);
  assert.equal(readSessionTemporaryFallback(sm.getBranch()), null);
});

test("checkpoint survives automatic model/level records and interrupted restoration until explicitly cleared", () => {
  const sm = manager();
  sm.appendCustomEntry(PRIMARY_MODEL_SNAPSHOT_TYPE, { version: 1, primary, backup });
  legacySwitch(sm);
  assert.deepEqual(readSessionPrimaryModel(sm.getBranch()), primary);
  sm.appendModelChange(primary.provider, primary.modelId);
  sm.appendThinkingLevelChange("medium");
  assert.deepEqual(readSessionPrimaryModel(sm.getBranch()), primary, "partial restoration must not lose xhigh");
  sm.appendThinkingLevelChange("xhigh");
  sm.appendCustomEntry(PRIMARY_MODEL_SNAPSHOT_TYPE, { version: 1, primary: null });
  assert.equal(readSessionTemporaryFallback(sm.getBranch()), null);
  assert.deepEqual(readSessionPrimaryModel(sm.getBranch()), primary);
  sm.appendThinkingLevelChange("high");
  assert.equal(readSessionPrimaryModel(sm.getBranch()).thinkingLevel, "high");
});

test("pre-checkpoint legacy quota switch recovers the primary's preceding xhigh, not backup defaults", () => {
  const sm = manager();
  legacySwitch(sm);
  assert.deepEqual(readSessionTemporaryFallback(sm.getBranch()), { primary, backup: { provider: backup.provider, modelId: backup.modelId } });
  assert.deepEqual(readSessionPrimaryModel(sm.getBranch()), primary);
});

test("manual model or thinking changes after a legacy audit supersede inference", () => {
  for (const edit of [(sm) => sm.appendModelChange("fixture", "manual"), (sm) => sm.appendThinkingLevelChange("high")]) {
    const sm = manager();
    legacySwitch(sm);
    edit(sm);
    assert.equal(readSessionTemporaryFallback(sm.getBranch()), null);
    assert.notEqual(readSessionPrimaryModel(sm.getBranch()).modelId, primary.modelId);
  }
});

test("branch readers never recover another branch's audit/checkpoint", () => {
  const sm = manager();
  const originalLeaf = sm.getLeafId();
  legacySwitch(sm);
  const backupLeaf = sm.getLeafId();
  sm.branch(originalLeaf);
  sm.appendModelChange("fixture", "sibling");
  sm.appendThinkingLevelChange("high");
  assert.equal(readSessionTemporaryFallback(sm.getBranch()), null);
  assert.equal(readSessionPrimaryModel(sm.getBranch()).modelId, "sibling");
  assert.deepEqual(readSessionPrimaryModel(sm.getBranch(backupLeaf)), primary);
});

test("malformed or cleared checkpoints fail closed and do not resurrect old audits", () => {
  const sm = manager();
  legacySwitch(sm);
  sm.appendCustomEntry(PRIMARY_MODEL_SNAPSHOT_TYPE, { version: 1, primary: { ...primary, apiKey: "not-allowed" }, backup });
  assert.equal(readSessionTemporaryFallback(sm.getBranch()), null);
  sm.appendCustomEntry(PRIMARY_MODEL_SNAPSHOT_TYPE, { version: 1, primary: null });
  assert.equal(readSessionTemporaryFallback(sm.getBranch()), null);
});
